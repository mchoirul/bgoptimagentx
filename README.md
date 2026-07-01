# BQ Optim Agent 🚀

A highly-specialized BigQuery SQL Tuning Agent built using the Google Agent Development Kit (ADK). 

## What does it do?
This agent acts as an expert-level BigQuery SQL tuning assistant. When you provide a BigQuery GoogleSQL query, the agent analyzes it to identify anti-patterns, compares it against official Google Cloud best practices, and returns a fully refactored, optimized version of your query. 

## Why is it valuable?
Poorly written BigQuery SQL can incur massive scanning costs and exhaust slot quotas. This agent helps you automatically eliminate expensive anti-patterns (like aggressive wildcard scanning or materialized CTEs) to reduce both latency and cloud billing costs. It even features a built-in "Dry Run" function that interacts with the live BigQuery API to prove how much data your optimized query saves compared to your original!

## How does it work?
The agent runs on a decoupled RAG-lite architecture utilizing Gemini 3.5 Flash. It dynamically retrieves BigQuery best practices at runtime and employs Context Caching to drastically lower LLM costs while processing massive SQL files.

For a comprehensive technical deep-dive into how it is implemented, please see the [ARCHITECTURE_DESIGN.md](ARCHITECTURE_DESIGN.md).

---

## 🛠️ Prerequisites

Before you can run the agent locally on your machine, you must have the following installed:

1. **Git**: To clone the repository.
2. **Python 3.10+**: The agent is built with modern Python type hinting.
3. **Google Cloud SDK (`gcloud`)**: Required for BigQuery API authentication to perform Dry Runs. [Install here](https://cloud.google.com/sdk/docs/install).
4. **uv** (Recommended) or **pip**: For Python package management. [Install uv here](https://docs.astral.sh/uv/getting-started/installation/).
5. **Node.js & npm**: Required to build the custom Angular frontend for the BigQuery Tuning Studio (Option 1). [Install Node.js here](https://nodejs.org/en/download/).

---

## 🚀 Installation & Setup

### 1. Clone the Repository
Download the agent code to your local machine:
```bash
git clone https://github.com/<your-username>/bq-optim-agent.git
cd bq-optim-agent
```

### 2. Install Python Dependencies
We highly recommend using `uv` for lightning-fast dependency resolution.

**Using `uv` (Recommended):**
```bash
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt
```

**Using standard `python`:**
```bash
python -m venv .venv
source .venv/bin/activate  # On Windows use: .venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Configure Google Cloud Authentication
The agent requires a Google Cloud project to perform high-fidelity BigQuery API dry-runs. Authenticate your local environment:
```bash
gcloud auth application-default login
gcloud config set project <YOUR_GCP_PROJECT_ID>
```

### 4. Build the Angular Frontend
The Custom BigQuery Tuning Studio (Option 1) requires a pre-built Angular bundle. Install the frontend dependencies and compile the project:
```bash
cd frontend
npm install
npm run build
cd ..
```
This generates `frontend/dist/frontend/browser/` which is served by the FastAPI backend.

> **Note:** If you skip this step, the server will return a 404 error when accessing `/ui`. You can still use Option 2 (ADK Web UI) or Option 3 (Headless API) without building the frontend.

### 5. Setup Environment Variables
The agent uses strict environment isolation. Create a `.env` file in the root of the project:
```bash
touch .env
```
Open the `.env` file and configure your settings:
```env
# Target Model Selection
GEMINI_MODEL="gemini-3.5-flash"

# Google Cloud Project Configuration (Required for BigQuery API Dry Runs)
GOOGLE_CLOUD_PROJECT="your-gcp-project-id"

# --- Authentication Method ---
# Option 1: Vertex AI (Recommended)
GOOGLE_GENAI_USE_VERTEXAI="True"
GOOGLE_CLOUD_LOCATION="us"

# Option 2: Gemini API Key 
# If you are NOT using Vertex AI, comment out GOOGLE_GENAI_USE_VERTEXAI and set:
# GEMINI_API_KEY="your-gemini-api-key"
```

---

## 🔒 Security & Least Privilege

This application is designed strictly for query optimization, syntax validation, and dry-running. It **never** executes SQL queries or mutates any data. 

> [!IMPORTANT]
> **Recommended Least-Privilege GCP Setup**
> For maximum defense-in-depth security, configure the GCP Service Account with only these two roles:
> 1. **`BigQuery Job User`** (`roles/bigquery.jobUser`): Permits submitting query/dry-run jobs at the project level.
> 2. **`BigQuery Data Viewer`** (`roles/bigquery.dataViewer`): Permits reading metadata/schemas of the tables to dry-run.
>
> By leaving out write/edit roles (like `BigQuery Data Editor`), **GCP IAM will physically block any attempts to run actual DML/DDL modifications (e.g., `DELETE`, `UPDATE`, `CREATE TABLE` for real)**, even if the application's software dry-run guardrails are somehow bypassed.

For a detailed security overview, step-by-step setup commands, and a complete threat modeling analysis, see [SECURITY.md](SECURITY.md).

---

## 🎮 Running the Application

This project provides multiple ways to interact with the tuning agent, ranging from a premium custom web studio to a headless API.

### Option 1: The Custom BigQuery Tuning Studio (Recommended)
This project includes a custom-built, premium dark glassmorphic Angular frontend specifically tailored for SQL tuning (featuring side-by-side SQL workspace with original and optimized comparison views, session persistence, and on-demand dry runs).

1. Ensure your virtual environment is activated.
2. Run the underlying FastAPI server (which serves the pre-built Angular bundle):
   ```bash
   uv run python app/fast_api_app.py
   ```
3. Open your browser and navigate to: **`http://localhost:8000/ui`**

### Option 2: The Default ADK Web UI
If you prefer a simpler chat interface, you can use the standard Web UI built directly into the Google ADK.
1. Ensure your virtual environment is activated.
2. Run the `adk web` command:
   ```bash
   uv run adk web
   ```
3. This will launch a browser tab with the default ADK chat interface.

### Option 3: Headless API (REST)
If you want to integrate this agent programmatically into other systems, run the FastAPI server:
```bash
uv run python app/fast_api_app.py
```
This exposes the standard ADK endpoints at `http://localhost:8000` (e.g., `/run_sse` and `/apps/app/users/default_user/sessions`). You can explore the interactive API schema at `http://localhost:8000/docs`.

---

## 🛡️ Implementation Logs

### Completed Hardening & UX Upgrades:
- **[2026-06-28] ADK Context Caching**: Fully optimized using ADK's `static_instruction` rather than generic `instruction`, enabling global cross-session caching for maximum performance and minimum token costs.
- **[2026-06-28] SQLite Session Persistence**: Session history is stored locally in a persistent SQLite database (`sessions.db`) instead of ephemeral in-memory storage, meaning histories survive server restarts.
- **[2026-06-27] Prompt Isolation & Guardrails**: System instructions are decoupled from dynamic code, with rigid prompt injection filters and security guardrails compiled directly inside `app/agent.py`.
- **[2026-06-30] CORS & XSS Security**: Implemented default-deny CORS fallbacks on the FastAPI server and strict Angular HTML sanitization (`SecurityContext.HTML`) in the frontend.
- **[2026-06-30] Performance Optimizations**: Added stream buffering/throttling to eliminate O(n²) string concatenation overhead, and `WeakMap` memoization to eliminate redundant SQL regex re-evaluations during stream.
- **[2026-06-27] UX Enhancements**:
  - **[2026-06-27] Structured SQL Comparison**: Workspace always displays both slots—the Optimized SQL on top, and the Original SQL below—with proper fallback states.
  - **[2026-06-27] Inline Confirmations**: Replaced native browser `confirm()` with non-obtrusive inline confirmations.
  - **[2026-06-27] Toast Notifications**: Added real-time glassmorphic error/success snackbars.
  - **[2026-06-27] Onboarding Experience**: Welcomes first-time users with clean instructions instead of empty screens.
  - **[2026-06-27] Shortcut Keys**: Added `Ctrl+K` for new sessions, proper `Shift+Enter` multi-line handling, and `ArrowUp` to recall the last prompt.

