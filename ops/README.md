# ops/

Local development stack for FilsPay: Postgres plus the three services that
talk to it directly (apps/api, apps/settlement, apps/reporting). The hosted
demo instance uses the same compose file with a different `.env`.

## Quick start

```
docker compose -f ops/docker-compose.yml up -d postgres
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml run --rm seed
docker compose -f ops/docker-compose.yml up api settlement reporting
```

apps/web and apps/admin aren't part of this compose file — they're plain
Vite dev servers that talk to apps/api over HTTP (`npm run dev` inside
each package), not services with their own database connection.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack |
| `.env.docker` | api secrets (`ACQUIRER_CALLBACK_SIGNING_SECRET`, `SMTP_URL`, …), loaded via `env_file`. **Not committed** — copy `.env.docker.example` |
| `.env.docker.example` | template for the above |
| `Dockerfile.node` | image for api, reporting, migrate and seed (`node:24`, runs TypeScript with tsx) |
| `Dockerfile.go` | multi-stage build of `apps/settlement` (distroless, non-root) |

The Dockerfiles were missing from the repo until 2026-10-30 (nothing could
be built); they were never in the initial ops commit.

`.env.docker` used to be committed with the acquirer signing secret in it
(`.gitignore` only matched `.env`). It is untracked now, but the secret is
still in git history: **rotate it** with the acquirer.

## Database

Every service, plus the one-off `migrate`/`seed` jobs, connects with the
same `filspay` role and the same `DATABASE_URL`
(`postgres://filspay:filspay_dev_password@postgres:5432/filspay?sslmode=disable`).
One role keeps local setup to a single password instead of hand-rolling
per-service grants for a stack this size. `sslmode=disable` is safe here:
Postgres and every service run on the same Docker Compose bridge network,
which never carries traffic outside the host, so there's no untrusted hop
for a connection to cross.

The settlement worker can be given a second connection string,
`PGCONN_SETTLEMENT`, for its batch-close pool. It only takes effect when
`DATABASE_URL` is unset.

To reset the database to a clean, freshly-seeded state at any point, re-run
the `seed` job above — `db/seed/index.ts` truncates and regenerates its
fixture tables on every invocation; it doesn't need the volume removed
first.

## Required settings per service

| Service | Needs | Where it comes from in compose |
|---|---|---|
| api | `DATABASE_URL`, `SETTLEMENT_INTERNAL_URL` | `environment:` |
| api | `WEBHOOK_SECRET_ENCRYPTION_KEY` | only outside dev; a dev key is used otherwise |
| api | `ACQUIRER_CALLBACK_SIGNING_SECRET`, `NODE_ENV` | `.env.docker` (`env_file`) |
| api, settlement | `SETTLEMENT_INTERNAL_TOKEN` (must match) | `environment:`; defaults to `dev-token` — set a real one when hosted |
| api | `SMTP_URL` (and optional `OTP_FROM_EMAIL`) | **required in production** unless `OTP_SHOW_ON_SCREEN=true` (demo only: codes appear on the login screen, so a password alone signs in; the API logs a warning at boot). Local: run Mailpit (`docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit:v1.20.4`), set `SMTP_URL=smtp://localhost:1025`, read codes at http://localhost:8025 |
| settlement | `DATABASE_URL` | `environment:` |
| reporting | `DATABASE_URL` | `environment:`; runs `worker` by default |

> **MK:** the api won't boot without WEBHOOK_SECRET_ENCRYPTION_KEY in any environment. set it on the hosted box.

## Resource sizing

The hosted demo box is 0.5 vCPU / 2 GB RAM / 2 GB disk; the API container is
limited to 512 MB. Postgres defaults are fine at this size. The settlement
image is built on the box with `go build` from `Dockerfile.go`.

> **AM:** first build on the box filled the disk (go build cache). cleared it and it went through on the second try

## Production stack (`docker-compose.prod.yml`)

```
Internet ─TLS─▶ platform edge ─▶ proxy :8080 (nginx, ops/nginx/filspay.conf)
                                   ├─ /, /pay/*, /dashboard/*  → apps/web build
                                   ├─ /admin/*                 → apps/admin build
                                   └─ /v1/*, /healthz          → api:3000
   internal network only (no internet route, no published ports):
     api :3000 · settlement :8091 · reporting · postgres :5432
```

| Concern | How |
|---|---|
| Redeploy | `ops/deploy.sh` — builds first, migrates, rolls out, waits for health |
| Secrets | `ops/.env.prod` on the server (never committed; template `.env.prod.example`); compose refuses to start if one is missing |
| Exposure | Only `proxy` publishes a port (`PUBLIC_BIND`, default 127.0.0.1). Postgres, api, settlement and reporting have none; the `internal` network has no internet route |
| Overload | nginx per-IP limits: `/v1` 20 r/s (burst 40), `/v1/(admin/)auth` 10 r/min (burst 10), public checkout 5 r/s (burst 20), 50 connections/IP → **429** + `Retry-After`. API down or slow → **503** + `Retry-After` within 3 s. POSTs are never retried upstream |
| Health | api `/readyz`, settlement `./settlement healthcheck` (→ `/healthz`, pings the DB), proxy `/healthz`, postgres `pg_isready`; all `restart: unless-stopped` |
| Settlement during redeploy | SIGTERM → the merchant in progress finishes, the run stops (`stop_grace_period: 10m`); runs are an advisory-locked singleton, so the new daemon can't overlap (#82) |
| Headers | HSTS, CSP, `X-Frame-Options: DENY`, `nosniff`, Referrer/Permissions policies on every response |
| Client IP | nginx sets `X-Forwarded-For`; api `TRUST_PROXY_HOPS=1` so audit rows record the client, not the proxy |
| Resources | api 0.5 vCPU / 512 MB, proxy 0.25 vCPU / 128 MB; logs rotated (5 × 10 MB) |

The admin console is built with `--base=/admin/`; its router also needs
`basename: "/admin"` (frontend change, pending).
