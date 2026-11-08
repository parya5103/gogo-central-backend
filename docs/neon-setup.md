# Neon Setup (GoGo Central Backend)

This repo is wired to consume the environment variables the Neon CLI
injects. Postgres connectivity resolves in this order:

1. Real environment variables (CI, Docker, Cloud Run)
2. `.env.local` (written by `neon deploy`)
3. `.env`

Connection settings resolve in this order:

1. Explicit `SQL_*` variables (`SQL_HOST`, `SQL_PORT`, `SQL_DB_NAME`,
   `SQL_USER`, `SQL_PASSWORD`, `PG_PROVIDER`)
2. Whatever `DATABASE_URL` provides for the fields `SQL_*` leaves unset

So a bare `DATABASE_URL` in `.env.local` is enough to run against Neon, and
Secret Manager values on Cloud Run continue to work unchanged.

## One-time setup (Android Termux or any machine with Node 20+)

```bash
npm i -g neon@latest        # if this fails, use: npx neon@latest ...
cd gogo-central-backend
git pull

neon init -y --org-id org-falling-pond-61172125 \
  --project-id rapid-flower-44795642 --branch production \
  --services postgres,realtime

neon deploy
```

Notes:

- If a Neon command opens a browser sign-in page, finish the login there
  and the command continues. If it times out, run `neon login` and retry.
- `neon init` scaffolds `neon.ts` (the declarative Neon config) and
  installs `@neon/config` locally. `neon.ts` is excluded from the app
  `tsc` build (see tsconfig.json) because the CLI loads it with its own
  runtime. Commit `neon.ts` after init; never commit `.env`/`.env.local`.
- `neon deploy` provisions the declared services (postgres is always on;
  realtime was declared via `--services realtime`) and writes their
  variables into `.env.local` (or `.env` if it exists):
  - `DATABASE_URL` (Postgres connection string, consumed by this app)
  - `NEON_REALTIME_URL`, `NEON_REALTIME_SECRET` (documented in
    `.env.example`; the backend does not consume them yet)

## Database name

`DATABASE_URL` decides which database is used (the last path segment,
e.g. `.../neondb`). All tables live in that one database and the schema
is created automatically on first boot, so either keep the default
`neondb` or create a `gogo_central` database in the Neon Console and put
it in the URL. Do not mix: pick one database and keep the URL unchanged.

## Verify end to end

```bash
npm install
npm run db:verify     # prints the resolved provider (should be "neon")
npm run db:migrate    # applies migrations/ (schema_migrations-tracked)
npm run build         # vite build must pass
npm run dev           # starts the server
curl http://localhost:3000/api/v1/health/ready
# expect: {"status":"ok","database":"connected",...}
```

First boot also applies migrations automatically (`resolveDataStore` runs
`runMigrations`), so `npm run db:migrate` is optional but a good explicit
check.

## Cloud Run (later step)

At deploy time set `DATABASE_URL` (recommended: via Secret Manager) or the
explicit `SQL_*` variables. The resolution order above applies unchanged,
so the same code runs locally against `.env.local` and on Cloud Run
against Secret Manager values.

## Cost

Neon Free Tier: 0.5 GB storage, 100 compute-hours per month. The pool is
already tuned for it (`PG_PROVIDER=neon`: pool max 5, 10s idle timeout,
TLS required).
