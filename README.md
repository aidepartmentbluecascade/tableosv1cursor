# Tabula

Airtable-class collaborative database platform. Normative architecture lives in [`architecture/`](architecture/README.md).

This repo implements the **Phase 0–1 MVP skeleton** toward [architecture §55.1 MVP scope](architecture/29-roadmap-and-scope.md#551-mvp-private-beta-m3): modular monolith (Fastify + Kysely), hybrid JSONB record storage, field registry, filter/formula packages, session auth, realtime/worker/relay roles, and React grid SPAs.

## Stack

| Layer | Choice |
|---|---|
| Monorepo | pnpm 9 + Turborepo |
| API | Node 22, TypeScript, Fastify, Kysely |
| DB | PostgreSQL 16 (`core` / `data` / `audit` schemas) |
| Cache/jobs | Redis 7 + BullMQ |
| Object storage | Google Cloud Storage |
| Web | React 19, Vite, TanStack Router/Query, Zustand |
| IDs | UUIDv7 + prefixed public IDs (`bas_…`, `rec_…`, …) |

## Architecture MVP scope (§55.1)

Full criteria: [`architecture/29-roadmap-and-scope.md` §55.1](architecture/29-roadmap-and-scope.md#551-mvp-private-beta-m3).

**Product goal:** a small team can replace a shared spreadsheet + simple tracker — structured data with relations, multiple views, realtime collaboration, forms, sharing, import/export.

| Area | MVP target | This repo today |
|---|---|---|
| Accounts | Email/password, Google OAuth, MFA (TOTP), orgs/workspaces, invites | Email/password, sessions; OAuth/MFA wired when env set |
| Data model | Bases, tables, ~25 field types | Bases/tables/fields CRUD; 18 field types in engine |
| Records | CRUD, batch, history, undo, trash | CRUD, `change_seq`, catch-up polling |
| Links & computed | Links, lookups, rollups, formulas | Packages + partial server integration |
| Views | Grid, form, gallery, kanban, calendar | Grid DOM v0 |
| Collaboration | Realtime, presence, comments | Realtime gateway + worker handlers (in progress) |
| Attachments | Upload, scan, previews | GCS signed URLs via `@tabula/storage` |
| Sharing & forms | Share views, public forms | `@tabula/public` app (port 5174) |
| Import/export | CSV/XLSX | Planned |
| Search | Postgres FTS | Worker indexing hooks |
| Automations | Out of MVP (hooks only) | Outbox + relay role |
| Public API | First-party REST, PATs off | Same REST under `/v1` |
| Billing | Free/Team plan limits | In-app upgrade (no Stripe) |
| Platform | Single shard, BullMQ profile | One shard, relay + worker |

## Prerequisites

- Node.js 22+
- pnpm 9 (`npx pnpm@9.15.0` works if not installed globally)
- Docker Desktop (Postgres, Redis)
- GCP project + GCS bucket + service account (for attachments)

## Quick start (API + web only)

```powershell
# 1) Infra
docker compose -f infra/docker/docker-compose.yml up -d
Copy-Item .env.example .env   # or: cp .env.example .env

# 2) Install & build
npx pnpm@9.15.0 install
npx pnpm@9.15.0 build

# 3) Migrate + seed default shard
npx pnpm@9.15.0 db:migrate
npx pnpm@9.15.0 db:seed

# 4) API + web + public (one terminal)
npx pnpm@9.15.0 dev
```

- Web: http://localhost:5173  
- Public forms/shares app: http://localhost:5174  
- API health: http://localhost:3000/health  

Sign up → create a base → edit cells in the grid.

## Dogfood (full local stack)

Dogfood runs **infra in Docker** and **app processes on the host** (lighter than containerizing every Node role).

```powershell
# Cross-platform (recommended)
npx pnpm@9.15.0 dogfood

# Or wrappers
.\scripts\dogfood.ps1      # Windows
./scripts/dogfood.sh       # macOS/Linux
```

What `pnpm dogfood` does:

1. `docker compose up -d postgres redis` (waits until healthy / reachable)
2. Copies `.env.example` → `.env` if missing
3. `pnpm install`, `pnpm build`, `pnpm db:migrate`, `pnpm db:seed`
4. Starts **api**, **realtime**, **worker**, **relay**, **web**, **public** in one terminal (Ctrl+C stops all)

Optional isolated Compose project name:

```powershell
docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.dogfood.yml up -d --wait
```

Infra only (no app processes):

```powershell
docker compose -f infra/docker/docker-compose.yml up -d postgres redis
```

### Process roles and ports

| Process | `ROLE` / script | Port | Notes |
|---|---|---:|---|
| HTTP API | `api` / `pnpm dev:api` | **3000** | REST `/v1`, `/health` |
| Realtime WS | `realtime` / `pnpm dev:realtime` | **3002** | Web proxies `/ws` → gateway |
| Worker | `worker` / `pnpm dev:worker` | — | BullMQ consumers |
| Relay | `relay` / `pnpm dev:relay` | — | Outbox → event bus |
| Web SPA | `pnpm dev:web` | **5173** | Authenticated app |
| Public SPA | `pnpm dev:public` | **5174** | Forms / shared views |
| PostgreSQL | Docker | **5432** | `tabula` / `tabula` |
| Redis | Docker | **6379** | |
| Attachments | GCS | — | Set `GCS_BUCKET` (+ credentials) |

Default dev without dogfood: `pnpm dev` runs **api + web + public** in parallel via Turborepo.

Individual processes:

```powershell
pnpm dev:api
pnpm dev:realtime
pnpm dev:worker
pnpm dev:relay
pnpm dev:web
pnpm dev:public
```

## Environment variables

Copy [`.env.example`](.env.example) to `.env`. Keys consumed by `@tabula/config`:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `REDIS_URL` | yes | Redis / BullMQ |
| `SESSION_SECRET` | yes | Session cookie signing (≥16 chars) |
| `APP_URL` | yes | Browser origin (web app) |
| `API_URL` | yes | Public API base URL |
| `PORT` | no (3000) | API listen port |
| `REALTIME_PORT` | no (3002) | Realtime gateway port |
| `ROLE` | no (`api`) | Process role: `api`, `realtime`, `worker`, `scheduler`, `relay` |
| `WS_TICKET_SECRET` | no | WS ticket HMAC; defaults to `SESSION_SECRET` |
| `GCS_BUCKET` | for uploads | GCS bucket name |
| `GCS_PROJECT_ID` | recommended | GCP project id |
| `GCS_KEY_FILE` or `GOOGLE_APPLICATION_CREDENTIALS` | for uploads | Path to service-account JSON |
| `GCS_CREDENTIALS_JSON` | alt | Inline service-account JSON |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Google OAuth login |
| `MFA_ENCRYPTION_KEY` | no | TOTP secret encryption at rest |
| `NODE_ENV` | no | `development` / `test` / `production` |

## Feature matrix (implementation vs §55.1)

| Feature | Status |
|---|---|
| Signup / login (Argon2id + session cookie) | Works |
| Org + Home workspace on signup | Works |
| Bases, default table, Name field, grid view | Works |
| Tables / fields / records CRUD + `records:query` | Works |
| Kernel mutations (`change_seq`, `base_changes`, `outbox_events`) | Works |
| Change catch-up `GET /v1/bases/:id/changes?afterSeq=` | Works |
| Field engine (18 types), filter AST, formula parser | Packages + partial UI |
| DOM spreadsheet grid (inline edit, add row/field) | Works |
| Realtime co-editing / presence | Gateway + client (dogfood: enable `dev:realtime`) |
| Worker (search, compute, notifications, file scan) | Dogfood: `dev:worker` |
| Outbox relay | Dogfood: `dev:relay` |
| Attachments to GCS | When `GCS_BUCKET` + credentials set |
| Plan upgrade (Free → Team) | `POST /v1/billing/upgrade` (no Stripe) |
| Google OAuth / MFA | Requires optional env |
| Automations, interfaces GA, public API docs | Not yet (architecture hooks present) |

## E2E smoke tests (optional)

Playwright smoke tests live in `apps/web/e2e/`. They **skip** if the API health check fails (no server required for a green CI lint-only run).

```powershell
# With stack running (dogfood or dev:api + dev:web)
cd apps/web
npx playwright install chromium
pnpm test:e2e

# From repo root
pnpm test:e2e
```

Environment:

- `PLAYWRIGHT_BASE_URL` — default `http://localhost:5173`
- `PLAYWRIGHT_API_URL` — default `http://localhost:3000`
- `PLAYWRIGHT_SKIP_WEBSERVER=1` — do not start Vite (use existing dev server)

## Repository layout

```
apps/
  server/     # modular monolith entrypoints: api, realtime, worker, scheduler, relay
  web/        # authenticated Vite SPA + grid
  public/     # public forms / shared views SPA
packages/
  types/ config/ db/ auth/ fields/ filter/ formula/
  permissions/ observability/ ui/ jobs/ events/ …
architecture/ # full platform design (35 docs)
infra/docker/ # Postgres 16, Redis 7
scripts/      # dogfood.mjs, dogfood.ps1, dogfood.sh
```

## Scripts reference

| Script | Description |
|---|---|
| `pnpm dev` | Turbo parallel: API + web + public |
| `pnpm dogfood` | Full local stack (infra + migrate + all roles) |
| `pnpm build` | Build all packages/apps |
| `pnpm db:migrate` / `pnpm db:seed` | Database migrate and seed |
| `pnpm test:e2e` | Playwright smoke (skips if API down) |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Turbo tasks |

## Next (per architecture build order)

Realtime polish, canvas grid, links/formulas compute, automations, interfaces, public API GA — see [`architecture/34-self-review-risk-register-build-order.md`](architecture/34-self-review-risk-register-build-order.md) and [`architecture/29-roadmap-and-scope.md`](architecture/29-roadmap-and-scope.md).
