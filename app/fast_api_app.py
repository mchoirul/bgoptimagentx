# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
import asyncio
import os

import google.auth
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from google.adk.cli.fast_api import get_fast_api_app
from google.cloud import logging as google_cloud_logging
from pydantic import BaseModel, Field

import logging as standard_logging

from app.app_utils.telemetry import setup_telemetry
from app.app_utils.typing import Feedback

setup_telemetry()

# Fallback logger initialization
standard_logger = standard_logging.getLogger("bq-optim-studio")
standard_logging.basicConfig(level=standard_logging.INFO)

# Try to initialize Google Cloud Logging if credentials are available
gcp_logger = None
try:
    _, project_id = google.auth.default()
    logging_client = google_cloud_logging.Client()
    gcp_logger = logging_client.logger(__name__)
except Exception as e:
    standard_logger.info(
        "Google Cloud Logging is unavailable (running locally, offline, or with GEMINI_API_KEY only). "
        "Falling back to standard python logger. Error: %s", e
    )


# Create a unified logging wrapper so the app doesn't crash if GCP credentials are not present
class UnifiedLogger:
    def log_struct(self, data: dict, severity: str = "INFO"):
        if gcp_logger:
            try:
                gcp_logger.log_struct(data, severity=severity)
                return
            except Exception:
                pass
        # Translate GCP severity to python log levels
        lvl = standard_logging.INFO
        if severity == "ERROR":
            lvl = standard_logging.ERROR
        elif severity == "WARNING":
            lvl = standard_logging.WARNING
        standard_logger.log(lvl, str(data))

    def log_text(self, text: str, severity: str = "INFO"):
        if gcp_logger:
            try:
                gcp_logger.log_text(text, severity=severity)
                return
            except Exception:
                pass
        lvl = standard_logging.INFO
        if severity == "ERROR":
            lvl = standard_logging.ERROR
        elif severity == "WARNING":
            lvl = standard_logging.WARNING
        standard_logger.log(lvl, text)


# Instantiate the logger wrapper
app_logger = UnifiedLogger()

# ---------------------------------------------------------------------------
# CORS — default-deny (S2)
# ---------------------------------------------------------------------------
# An unset ALLOW_ORIGINS env var resolves to an empty list rather than None,
# preventing a permissive wildcard fallback in get_fast_api_app.
_raw_origins = os.getenv("ALLOW_ORIGINS", "").strip()
allow_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()] if _raw_origins else []

# Artifact bucket for ADK (created by Terraform, passed via env var)
logs_bucket_name = os.environ.get("LOGS_BUCKET_NAME")

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BROWSER_DIR = os.path.join(AGENT_DIR, "frontend", "dist", "frontend", "browser")

# ---------------------------------------------------------------------------
# Session storage
# ---------------------------------------------------------------------------
# ADK accepts a SQLAlchemy URI (e.g. "sqlite:///./sessions.db",
# "postgresql+psycopg://...") for persistent session history. When unset, it
# falls back to an in-memory store that loses all sessions on restart.
#
# Default behavior:
#   * If SESSION_SERVICE_URI is set, use it verbatim.
#   * Otherwise, use a local SQLite file under AGENT_DIR so chat history
#     survives restarts in dev/local runs.
#   * Set SESSION_SERVICE_URI="memory" to explicitly opt back into the
#     ephemeral in-memory store (useful for tests and stateless deploys).
_session_uri_env = os.environ.get("SESSION_SERVICE_URI", "").strip()
if _session_uri_env.lower() == "memory":
    session_service_uri = None
elif _session_uri_env:
    session_service_uri = _session_uri_env
else:
    _default_sqlite_path = os.path.join(AGENT_DIR, "sessions.db")
    session_service_uri = f"sqlite:///{_default_sqlite_path}"

artifact_service_uri = f"gs://{logs_bucket_name}" if logs_bucket_name else None

app: FastAPI = get_fast_api_app(
    agents_dir=AGENT_DIR,
    web=True,
    artifact_service_uri=artifact_service_uri,
    allow_origins=allow_origins,
    session_service_uri=session_service_uri,
    otel_to_cloud=True,
)
app.title = "bq-optim-agent"
app.description = "API for interacting with the Agent bq-optim-agent"


# ---------------------------------------------------------------------------
# Static assets for the Angular bundle (P5)
# ---------------------------------------------------------------------------
# Serve hashed asset files (JS/CSS/images) via Starlette's StaticFiles, which
# uses sendfile + ETag/Last-Modified. Only fall back to a Python handler for
# the SPA index.html.
if os.path.isdir(BROWSER_DIR):
    app.mount(
        "/ui/assets",
        StaticFiles(directory=os.path.join(BROWSER_DIR, "assets"), check_dir=False),
        name="ui-assets",
    )


@app.get("/ui")
def redirect_to_ui():
    return RedirectResponse(url="/ui/")


@app.get("/ui/{catchall:path}", response_class=HTMLResponse)
def serve_angular(catchall: str = ""):
    # Direct asset request (has a file extension) — serve from disk.
    if catchall and "." in catchall.split("/")[-1]:
        file_path = os.path.join(BROWSER_DIR, catchall)
        if os.path.exists(file_path):
            return FileResponse(file_path)

    # SPA fallback — serve index.html for any route.
    index_path = os.path.join(BROWSER_DIR, "index.html")
    if os.path.exists(index_path):
        # FileResponse is preferable to read+return: it streams and sets
        # Content-Type / Last-Modified headers automatically.
        return FileResponse(index_path, media_type="text/html")
    return HTMLResponse(
        "Angular build not found. Run 'npm run build' in 'frontend/'",
        status_code=404,
    )


@app.post("/feedback")
def collect_feedback(feedback: Feedback) -> dict[str, str]:
    """Collect and log feedback."""
    app_logger.log_struct(feedback.model_dump(), severity="INFO")
    return {"status": "success"}


# ---------------------------------------------------------------------------
# Dry run endpoint (A1 unified contract, P6 timeout)
# ---------------------------------------------------------------------------
# Hard server-side cap on SQL size to bound payload growth and protect the
# downstream BigQuery API call.
MAX_DRY_RUN_SQL_BYTES = int(os.environ.get("MAX_DRY_RUN_SQL_BYTES", 200_000))
DRY_RUN_ENDPOINT_TIMEOUT = float(os.environ.get("DRY_RUN_ENDPOINT_TIMEOUT", 35.0))


class DryRunRequest(BaseModel):
    sql: str = Field(..., min_length=1, max_length=MAX_DRY_RUN_SQL_BYTES)


@app.post("/api/dry_run")
async def api_dry_run(request: DryRunRequest):
    """Executes a dry run of the provided BigQuery SQL query.

    Always returns the unified tool contract shape:
        { "status": "success"|"error", "data"?: {...}, "error_message"?: "..." }

    When GCP project or credentials are not configured, returns HTTP 503 with
    a structured body including an ``error_code`` field so the frontend can
    distinguish "unavailable" from a genuine query failure.
    """
    from app.tools import dry_run_query, _classify_dry_run_error

    try:
        return await asyncio.wait_for(
            dry_run_query(request.sql),
            timeout=DRY_RUN_ENDPOINT_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail={
                "status": "error",
                "error_code": "timeout",
                "error_message": "Dry run timed out.",
            },
        )
    except ValueError as e:
        # GOOGLE_CLOUD_PROJECT not configured
        app_logger.log_text(f"/api/dry_run config error: {e}", severity="WARNING")
        raise HTTPException(
            status_code=503,
            detail={
                "status": "error",
                "error_code": "project_not_configured",
                "error_message": (
                    "BigQuery project not configured. "
                    "Set GOOGLE_CLOUD_PROJECT in your .env file to enable dry runs."
                ),
            },
        )
    except Exception as e:
        # Check for credentials error before generic 500
        msg = _classify_dry_run_error(e)
        if "credentials not found" in msg.lower():
            app_logger.log_text(f"/api/dry_run credentials error: {e}", severity="WARNING")
            raise HTTPException(
                status_code=503,
                detail={
                    "status": "error",
                    "error_code": "credentials_not_found",
                    "error_message": (
                        "GCP credentials not found. "
                        "Run 'gcloud auth application-default login' to enable dry runs."
                    ),
                },
            )
        # Generic query-level error (syntax, missing table, permission, etc.)
        app_logger.log_text(f"/api/dry_run error: {e}", severity="ERROR")
        raise HTTPException(
            status_code=500,
            detail={
                "status": "error",
                "error_code": "query_error",
                "error_message": msg,
            },
        )


# Main execution
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
