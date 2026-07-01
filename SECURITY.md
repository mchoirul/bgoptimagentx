# Security and Least-Privilege IAM Setup

This document outlines the security architecture of the BigQuery Optimization Studio and how to configure Google Cloud Platform (GCP) IAM permissions with **Least Privilege** to guarantee absolute safety in production.

---

## 1. Security Architecture (Immutable Dry-Runs)

The application is built strictly to perform query optimization, syntax checking, and cost dry-runs. It **never** executes queries or commits changes to your database. 

To achieve this, we enforce a strict defense-in-depth safety design:

1. **Immutable Application Settings**: The BigQuery client configuration inside `app/tools.py` strictly hardcodes `dry_run=True`. An assertion guarantees that this flag cannot be bypassed:
   ```python
   job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
   assert job_config.dry_run is True, "CRITICAL: Dry-run configuration was bypassed."
   ```
2. **GCP IAM Boundary (Strongest Guardrail)**: Even if the code is maliciously altered or a bug is introduced that attempts to bypass the dry-run setting, GCP IAM permissions will physically block any write, create, or delete operations.

---

## 2. Recommended Least-Privilege IAM Roles

When deploying this application, do **not** use high-privilege roles like `BigQuery Admin` or `BigQuery Data Editor`. Instead, grant the Service Account representing the application the following two roles:

### Role 1: `BigQuery Job User` (`roles/bigquery.jobUser`)
* **Scope**: Project-level.
* **Why it's needed**: Allows the service account to submit query jobs (dry-runs are still query jobs processed by the BigQuery engine).
* **Permissions granted**: `bigquery.jobs.create` (Allows initiating a query job).
* **What it blocks**: On its own, it does not grant access to read or write any actual data in your datasets or tables.

### Role 2: `BigQuery Data Viewer` (`roles/bigquery.dataViewer`)
* **Scope**: Dataset-level (or project-level if you want it to scan all datasets).
* **Why it's needed**: Allows the service account to view table schemas, which is required by the query planner to validate DML, DDL, and SELECT queries during a dry-run.
* **Permissions granted**: `bigquery.tables.get`, `bigquery.tables.list` (Allows reading table metadata/schemas).
* **What it blocks**: **This role has 0 write permissions.** It cannot create datasets, create tables, insert data, or delete data.

---

## 3. Threat Model & Bypasses Checked

| Scenario / Threat | How It's Mitigated |
| :--- | :--- |
| **User dry-runs a destructive `DELETE` or `DROP TABLE` query** | **Allowed (Safe)**: The dry-run succeeds, showing syntax validity and estimated cost. No data is actually deleted or dropped since `dry_run=True` is enforced. |
| **A bug accidentally disables `dry_run=True`** | **Blocked**: The GCP service account lacks the `BigQuery Data Editor` / write permissions. GCP BigQuery will immediately reject the write operation with a `403 Access Denied` error. |
| **A massive query causes Denial of Service or runaway costs** | **Mitigated**: Dry-runs are free and do not scan actual physical data in BigQuery. Additionally, a strict 30-second timeout is placed on the dry-run call (`DRY_RUN_TIMEOUT_SECONDS`). |
| **Query Injection attempting to read sensitive data** | **Mitigated**: Since the app only returns dry-run metadata (bytes scanned) and **never** fetches or displays the actual rows of a query, users can never read table rows. |

---

## 4. Setting up the GCP Service Account

To configure this in the Google Cloud Console or via CLI:

1. Create a service account:
   ```bash
   gcloud iam service-accounts create bq-optim-studio-sa \
       --display-name="BigQuery Optim Studio Service Account"
   ```

2. Grant the project-level **Job User** role:
   ```bash
   gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
       --member="serviceAccount:bq-optim-studio-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
       --role="roles/bigquery.jobUser"
   ```

3. Grant the dataset-level **Data Viewer** role:
   ```bash
   gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
       --member="serviceAccount:bq-optim-studio-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
       --role="roles/bigquery.dataViewer"
   ```
