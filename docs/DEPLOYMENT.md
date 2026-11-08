# GoGo Central Backend — Deployment Guide (`docs/DEPLOYMENT.md`)

Zero/minimal-cost production deployment for the GoGo Central notification backend:
**Cloud Run (min-instances 0) + Neon PostgreSQL free tier + Google Secret Manager**.

> **Nothing in this repository is auto-deployed.** Every step below is a manual,
> owner-executed action. The agent never creates cloud resources, never enables
> billing, and never deploys without explicit owner approval (₹0 mandate).

---

## 1. Architecture

| Component | Provider | Tier | Notes |
| --- | --- | --- | --- |
| API + Admin dashboard | Google Cloud Run | Free tier (2M req/mo, 360k GB-s) | min-instances 0, scales to zero |
| PostgreSQL 18 | Neon (neon.tech) | Free plan | 0.5 GB storage, autosuspend; connection string over TLS |
| Secrets | Google Secret Manager | Free (6 active versions) | SQL password + Firebase service-account JSON |
| Push delivery | Firebase Cloud Messaging | Free | FCM v1 via firebase-admin |

**Cost warnings (honest):**
- Cloud Run requires a GCP project with a **billing account linked**, even if
  usage stays inside the free tier. Without billing, Cloud Run cannot be used.
  Within free-tier quotas the charge is ₹0, but free tiers and quotas can change;
  never assume permanently free hosting.
- Neon free plan limits (storage, compute hours, autosuspend gaps) change over
  time; check the current plan page before relying on them.
- Secret Manager bills per active secret version above the free allowance.
- Cloud Build free tier has a per-day build quota; the image is small, so the
  build stays inside it in normal use.

---

## 2. Prerequisites (owner, one time)

1. GCP project (existing Firebase project `gen-lang-client-0566323659` can host
   the Cloud Run service) with a billing account attached.
2. `gcloud` CLI installed and authenticated (`gcloud auth login`).
3. Enable APIs:
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
   ```
4. A Neon account (github sign-in works) with a project created; copy the
   **connection string** (it looks like
   `postgresql://user:password@ep-xxx.aws.neon.tech/neondb?sslmode=require`).

---

## 3. Secrets (Google Secret Manager)

Create exactly two secrets; never put these values in files or CI variables:

```bash
# 3.1 PostgreSQL password (the password part of the Neon connection string)
printf '%s' 'NEON_SQL_PASSWORD' | gcloud secrets create gogo-sql-password --data-file=-

# 3.2 Firebase service-account JSON
# Firebase Console -> Project settings -> Service accounts -> Generate new private key
gcloud secrets create firebase-service-account --data-file=firebase-service-account.json
```

Grant the Cloud Run runtime service account access:

```bash
gcloud projects add-iam-policy-binding YOUR_GCP_PROJECT_ID \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 4. Deploy

The helper script encodes the full sequence (build, deploy, probe) — read it
before running; it never runs from CI:

```bash
# Fill the variables at the top of the script first.
bash scripts/deploy-cloudrun.sh
```

Equivalent manual steps:

```bash
# 4.1 Build & push the image
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/gogo-central/backend:latest .

# 4.2 Deploy (secrets mounted, min instances 0)
gcloud run deploy gogo-central-backend \
  --image REGION-docker.pkg.dev/PROJECT_ID/gogo-central/backend:latest \
  --region REGION --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,PORT=3000,FCM_DRY_RUN=false,SQL_HOST=...,SQL_PORT=5432,SQL_DB_NAME=...,SQL_USER=... \
  --set-secrets SQL_PASSWORD=gogo-sql-password:latest,GOOGLE_APPLICATION_CREDENTIALS=/secrets/firebase-sa/firebase-service-account.json \
  --set-secrets /secrets/firebase-sa=firebase-service-account:latest \
  --min-instances 0 --max-instances 3 --memory 512Mi --cpu 1
```

Notes:
- `--allow-unauthenticated` is safe: every API route requires a verified
  Firebase ID token (or admin role) server-side; only the health probes and the
  static admin SPA are public.
- `FCM_DRY_RUN=false` enables REAL FCM delivery. Start with `true`, verify the
  whole chain with dry-run receipts, then flip to `false` (the admin panel shows
  the mode badge from `GET /api/v1/overview`).
- Migrations run automatically at startup under `pg_advisory_lock` (safe across
  multiple instances). A manual option exists: `npm run db:migrate` with the
  same SQL_* env pointing at Neon.

---

## 5. Post-deploy verification

```bash
SERVICE=https://gogo-central-backend-XXXX-REGION.a.run.app
curl -s ${SERVICE}/api/v1/health/live    # {"status":"ok"}
curl -s ${SERVICE}/api/v1/health/ready   # {"status":"ok","database":"connected"}
```

Then in the admin dashboard (served at the service URL): sign in with the
root-admin Google account, confirm the badge shows **Dry-Run** or **Live**
matching `FCM_DRY_RUN`, send a product-scoped dry-run campaign to your own
device, and check the receipts (they carry `dryrun:`-prefixed message IDs in
dry-run mode — those are NOT real deliveries).

---

## 6. Backup & restore (Neon)

```bash
# Backup (custom format, never commit backups/)
bash scripts/backup-restore.sh backup
# Restore into a disposable database first; verify, then restore target
bash scripts/backup-restore.sh restore backups/<file>.dump
```
The script wraps `pg_dump`/`pg_restore` against the `SQL_*` environment.

---

## 7. Rollback

Cloud Run keeps revision history:

```bash
gcloud run revisions list --service gogo-central-backend --region REGION
gcloud run services update-traffic gogo-central-backend --to-revisions REVISION=100 --region REGION
```
Database migrations are forward-only by design; restore via pg_dump if ever needed.

---

## 8. Remaining manual checklist (exact steps)

Backend / cloud:
1. GCP: link a billing account to the project (required for Cloud Run even on the free tier).
2. Create the two Secret Manager secrets (SQL password, Firebase service-account JSON).
3. Fill `scripts/deploy-cloudrun.sh` variables; run it; verify health endpoints.
4. Set `CORS_ALLOWED_ORIGINS` to include the frontend origin if it differs from `https://gogocompany.in`.

Firebase Console (project `gen-lang-client-0566323659`):
5. Authentication -> Sign-in method: enable **Anonymous** (device registration
   on non-portal sites uses `signInAnonymously`; the backend stores these users
   as `anonymous_guest`) and keep **Google** enabled.
6. Authentication -> Settings -> Authorized domains: ensure `gogocompany.in`.
7. Project settings -> Cloud Messaging: generate the **Web Push certificate
   (VAPID key pair)**; copy the public key.

Per-site integration (in the five website repos):
8. After the backend is live, fill each site's `API_BASE` (Cloud Run URL) and
   `VAPID_PUBLIC_KEY` placeholders in the notifications module
   (`gogo-notifications.js`). The module is fail-closed while they are empty.
9. For Arrow Out, add the backend URL to the site's CSP `connect-src`.

Verification (real device):
10. On an Android Chrome device, opt in on each site, confirm the device appears
    in the admin Devices table with the correct appId, then send a product
    dry-run and a real send and observe the notification. Only this step
    constitutes live-delivery evidence; CI tests are MOCKED and prove no such
    thing.
