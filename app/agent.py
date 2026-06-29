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

import os
from dotenv import load_dotenv

from google.adk.agents import Agent
from google.adk.apps import App
from google.adk.agents.context_cache_config import ContextCacheConfig
from google.adk.apps.app import EventsCompactionConfig
from google.adk.models import Gemini
from google.genai import types

from app.agent_instruction import BASE_INSTRUCTION, SECURITY_GUARDRAILS, BEST_PRACTICES
from app.tools import read_uploaded_sql, read_best_practices, dry_run_query

# Load environment variables from .env file
load_dotenv()

# ---------------------------------------------------------------------------
# Configuration validation (A3)
# ---------------------------------------------------------------------------
# Fail fast at startup with a clear error rather than at first agent call.
model_name = os.environ.get("GEMINI_MODEL")
if not model_name:
    raise RuntimeError(
        "GEMINI_MODEL environment variable is required but not set. "
        "Set it in your .env file (e.g., GEMINI_MODEL=\"gemini-2.0-flash-001\")."
    )

# ---------------------------------------------------------------------------
# Agent instruction
# ---------------------------------------------------------------------------
# The base instruction, security guardrails, and static best practices are
# concatenated here in agent.py. 
#
# Designing it this way:
# 1. Enforces safety — a base prompt edit cannot strip the SECURITY_GUARDRAILS.
# 2. Maximizes caching — loading BEST_PRACTICES into the static_instruction 
#    at startup enables immediate global cross-session context caching on Turn 1.
agent_instruction = f"{BASE_INSTRUCTION}\n\n{SECURITY_GUARDRAILS}\n\n{BEST_PRACTICES}"


bq_tuner_agent = Agent(
    name="bq_tuner_agent",
    description="An expert BigQuery SQL tuning and optimization assistant.",
    model=Gemini(
        model=model_name,
        retry_options=types.HttpRetryOptions(attempts=3),
    ),
    generate_content_config=types.GenerateContentConfig(
        temperature=0.3,
        top_p=0.95,
        top_k=40,
        max_output_tokens=16384,
    ),
    static_instruction=agent_instruction,
    tools=[read_uploaded_sql, read_best_practices, dry_run_query],
)

app = App(
    root_agent=bq_tuner_agent,
    name="app",
    context_cache_config=ContextCacheConfig(
        min_tokens=2048,     # only cache if context exceeds this
        ttl_seconds=3600,    # cache lifetime (1 hour)
    ),
    events_compaction_config=EventsCompactionConfig(
        compaction_interval=10,
        overlap_size=2
    ),
)
