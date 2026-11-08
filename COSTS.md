# GoGo Central Backend — Official Cloud Cost Analysis & ₹0 Strategy (`COSTS.md`)

> **Important Cost Governance Policy**:
> 1. **Never assume Cloud SQL or Google Cloud services are lifetime-free.**
> 2. **₹0 Local & Free-Tier Priority**: Because Google Cloud SQL Developer Edition was unavailable on the current unbilled workspace (`NO_VALID_PROJECT`), no paid Cloud SQL resources were created.
> 3. **Provider-Independent ₹0 Path**: The backend's provider-independent PostgreSQL configuration (`src/db/postgres-config.ts`) allows you to run PostgreSQL 18 at **₹0/month** locally (Docker Compose or Android Termux) AND deploy to cloud production at **₹0/month** using **Neon Serverless PostgreSQL Free Tier** + **Cloud Run Free Tier (`--min-instances=0`)** until you choose to provision Cloud SQL.

---

## 1. PostgreSQL Provider Cost Comparison (in INR `₹`)

| PostgreSQL Provider (`PG_PROVIDER`) | Monthly Compute & Storage Allowance | Monthly Cost (INR `₹`) | Suitability |
| :--- | :--- | :--- | :--- |
| **`local` (Docker Compose `postgres:18-alpine` or Android Termux)** | Unlimited local disk & CPU | **₹0 / month** | Ideal for local development, schema migrations, and CI testing (`npm test`). |
| **`neon` (Neon Serverless PostgreSQL Free Tier)** | **0.5 GB storage**, **100 CU-hours/month** (scales to zero after 5 min idle), Point-in-Time Restore (24h) | **₹0 / month** | Ideal ₹0 cloud PostgreSQL database when Cloud SQL Starter Tier is unavailable. |
| **`cloudsql` (Cloud SQL Developer Edition Starter Tier)** | Free Starter quota (max 2 instances per eligible GCP project, scale-to-zero) | **₹0 / month** *(if eligible)* | Requires a GCP project that passes `CLOUD_SQL_DEVELOPER_EDITION` eligibility. |
| **`cloudsql` (Standard Paid Cloud SQL `db-f1-micro` + 10 GB SSD)** | No permanent Always-Free tier | **~₹1,204 / month** *(incl. 18% GST)* | Only if you explicitly approve paid 24/7 dedicated GCP Cloud SQL in the future. |

---

## 2. Full Stack Monthly Cost Scenarios (in INR `₹`)

### Scenario A: Local Development on PC (Docker Compose) or Android (Termux)
- **PostgreSQL 18 (`PG_PROVIDER=local`)**: `₹0`
- **Node.js 22 + Express + Admin Dashboard**: `₹0`
- **Firebase Auth (< 50k MAUs) + FCM (Unlimited)**: `₹0`
- **Total Monthly Cost**: **₹0 / month**.

### Scenario B: ₹0 Cloud Production Stack (Cloud Run Scale-to-Zero + Neon Free Tier PostgreSQL)
> **Status update (v2.0.0)**: the backend runtime now actually reads/writes PostgreSQL through the repository layer, so Neon (or any configured PostgreSQL provider) is genuinely used at runtime with durable persistence across restarts. Costs remain ₹0 on the Neon Free Tier. Remaining caveats before live traffic: Firebase credentials must be configured, and Cloud Run deployment itself is documented but not yet provisioned (₹0 mandate — nothing was deployed or billed automatically).
- **Google Cloud Run (`--min-instances=0`, < 2M req/mo)**: `₹0`
- **Neon Serverless PostgreSQL (`PG_PROVIDER=neon`, 0.5 GB, scale-to-zero)**: `₹0`
- **Firebase Auth (< 50k MAUs) + FCM (Unlimited)**: `₹0`
- **Google Secret Manager (≤ 6 secrets) + Cloud Logging (< 50 GiB/mo)**: `₹0`
- **Total Monthly Cost**: **₹0 / month**.

### Scenario C: Paid Cloud SQL Production Stack (Only If Explicitly Approved Later)
- **Google Cloud Run (`--min-instances=0`) + Firebase Auth + FCM**: `₹0`
- **Cloud SQL PostgreSQL (`db-f1-micro`, 10 GB SSD, 7-day backups)**: `₹970` + `₹50` egress = `₹1,020` (+ 18% GST)
- **Total Monthly Cost**: **~₹1,204 / month**.
