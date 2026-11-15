# Deployment Safety Gate

## Current state

- Production runs on Render (free tier): https://gogo-central-backend-mg6z.onrender.com
- CI (`.github/workflows/ci.yml`) runs: TypeScript strict, security rules,
  REG/PGT/MX suites, Docker Compose runtime probes, lockfile verification,
  npm audit (report-only), Gitleaks.
- Neon workflow creates a preview branch per PR and deletes it after merge.

## The risk

If Render auto-deploy tracks `main`, every merge reaches production even
when CI is red on the merged commit. Failed CI must never reach production.

## Required gate (manual, Render-side — no Render API access from CI)

1. Render Dashboard → gogo-central-backend → Settings → Build & Deploy.
2. Set Auto-Deploy to "Deploy on Push" ONLY with the "Wait for CI" option
   enabled, or turn Auto-Deploy OFF entirely and deploy manually
   ("Manual Deploy → Deploy latest commit") after CI is green.
3. Recommended: enable "Deploy Hook" + branch restriction so only `main`
   can ever be deployed.

## GitHub-side guardrails already in place / recommended

- Branch protection on `main` (recommended, Settings → Branches):
  - Require pull request reviews before merging.
  - Require status checks: "TypeScript Strict, Security Rules & Automated
    Tests", "Docker Compose Runtime (live probes, PG restart, graceful stop)",
    "Generate & Verify package-lock.json (npm ci reproducibility)", Gitleaks.
  - Require branches up to date before merging.
- This repo never self-merges; all merges are explicit human actions.

## Rollback procedure

1. Render → Manual Deploy → pick the last known-good commit.
2. Database: Neon point-in-time restore if a bad migration landed
   (migrations are additive by policy; see migrations/).

## Verification checklist before any production deploy

- [ ] CI green on the exact commit being deployed.
- [ ] Migrations reviewed (additive only).
- [ ] Secrets unchanged (Gitleaks green).
- [ ] Post-deploy: /api/v1/health/ready returns 200 with database=connected.

