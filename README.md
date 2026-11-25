# PulseGuard — Backend

API monitoring and incident-management SaaS. **JavaScript CommonJS only** (no
TypeScript). This folder is the backend: Express API + BullMQ worker + MySQL
migrations + tests.

The web frontend lives in the sibling [`../frontend/`](../frontend) folder with
its own `package.json` and tooling.

See [`../PROJECT_MASTER_PLAN.md`](../PROJECT_MASTER_PLAN.md) for the full plan
and phase roadmap.

## Requirements

- Node.js 20+ (developed on Node 24).
- Docker (optional, for local MySQL + Redis).

## Setup

```bash
# From this folder (backend/)
npm install

# Create your local environment file
cp .env.example .env   # Windows: copy .env.example .env

# (Optional) start local MySQL + Redis via the bundled compose file
docker compose up -d
```

## Running

```bash
npm run dev     # start the API with auto-reload (nodemon)
npm start       # start the API once
```

The API listens on `PORT` (default `3000`).

## API contract & operational docs

- OpenAPI 3 spec: [`apps/api/src/docs/openapi.yaml`](./apps/api/src/docs/openapi.yaml)
  — also served live at `GET /api/v1/openapi.yaml`.
- Operations runbook: [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) — deploy,
  migrate, backup, restore, rollback, retention, observability, DR drills.
- Security review: [`docs/SECURITY_REVIEW.md`](./docs/SECURITY_REVIEW.md) —
  checklist across auth, tenancy, SSRF, rate limits, secrets, error handling,
  log discipline, and known limitations.
- Postman collection: [`docs/PulseGuard.postman_collection.json`](./docs/PulseGuard.postman_collection.json)
  and [`docs/PulseGuard.postman_environment.json`](./docs/PulseGuard.postman_environment.json)
  — import both, run **Auth → Register**, then everything else works (IDs are
  auto-captured by test scripts).
- Post-project backlog: [`../docs/FUTURE_SUGGESTIONS.md`](../docs/FUTURE_SUGGESTIONS.md).

## Retention & maintenance

`monitor_check_results`, `notification_deliveries`, and `refresh_tokens` grow
over time. A pruning script trims them based on env retention windows
(`CHECK_RESULT_RETENTION_DAYS`, `REFRESH_TOKEN_RETENTION_DAYS`,
`NOTIFICATION_DELIVERY_RETENTION_DAYS`):

```bash
npm run maintenance:prune
```

Run daily off-peak via cron / systemd timer / your scheduler.

## Production build

Multi-stage Dockerfile bundles both processes into one image:

```bash
docker build -t pulseguard-api:latest .
docker run --env-file .env.prod pulseguard-api:latest     # API
docker run --env-file .env.prod pulseguard-api:latest \
  node apps/worker/src/worker.js                          # Worker
```

See [`docker-compose.prod.yml`](./docker-compose.prod.yml) for a reference
topology and [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) for the runbook.

## Health endpoints

- `GET /api/v1/health/live` — liveness. Returns `{ "status": "ok" }`.
- `GET /api/v1/health/ready` — readiness. Returns status, uptime, and dependency
  checks (database always; Redis when the queue is enabled).

## API endpoints

All routes are prefixed with `/api/v1`. List endpoints accept `?page` and
`?pageSize` (max 100) and return `{ data, pagination }`.

### Auth (`/auth`)

- `POST /auth/register` — create account (also creates a default organization +
  owner membership), returns `{ user, accessToken, refreshToken }`.
- `POST /auth/login` — returns `{ user, accessToken, refreshToken }`.
- `POST /auth/refresh` — rotate refresh token, returns a new token pair.
- `POST /auth/logout` — revoke the presented refresh token's family (204).

### Users (`/users`)

- `GET /users/me` — authenticated user's profile.

### Organizations (`/organizations`) — "workspace" tenant boundary

- `GET /organizations` — organizations the caller is a member of (paginated).
- `POST /organizations` — create an organization (caller becomes `owner`).
- `GET /organizations/:orgId` — get one (members only; 404 for non-members).
- `PATCH /organizations/:orgId` — update (requires `admin`+).

### Projects (`/organizations/:orgId/projects`)

- `GET .../projects` — list projects in the org (members; paginated).
- `POST .../projects` — create (requires `engineer`+).
- `GET .../projects/:projectId` — get one.
- `PATCH .../projects/:projectId` — update (requires `engineer`+).

### Monitors (`/organizations/:orgId/projects/:projectId/monitors`)

- `GET .../monitors` — list monitors in the project (members; paginated; `?status=` filter).
- `POST .../monitors` — create (requires `engineer`+). Body: `name`, `url`,
  optional `method` (GET/HEAD/POST), `intervalSeconds`, `timeoutMs`,
  `expectedStatusMin/Max`, `requestHeaders`.
- `GET .../monitors/:monitorId` — get one.
- `PATCH .../monitors/:monitorId` — update (requires `engineer`+).
- `POST .../monitors/:monitorId/pause` — set status to `paused` (`engineer`+).
- `POST .../monitors/:monitorId/resume` — set status to `active` (`engineer`+).
- `POST .../monitors/:monitorId/run` — enqueue an on-demand check (`engineer`+).
  Returns `202` with `{ checkId, enqueued: true }` when the queue is enabled, or
  `200` with `enqueued: false` when it is disabled.
- `DELETE .../monitors/:monitorId` — delete (`engineer`+, 204).
- `GET .../monitors/:monitorId/checks` — paginated check history. Optional
  `?status=` filter (`success` / `failure` / `timeout` / `blocked`).
- `GET .../monitors/:monitorId/summary?window=1h|24h|7d|30d` — uptime %,
  latency min/avg/max, per-status counts over a rolling window. `uptimePercent`
  is `null` when the window has no data (never a misleading 0 or 100). Latency
  stats are computed over successful checks only, so timeouts don't skew the
  average.

Monitor targets are validated for SSRF safety at create/update: only
`http`/`https`, no embedded credentials, and the hostname is DNS-resolved with
every resolved IP checked against blocked ranges (private, loopback, link-local,
multicast, reserved, and cloud metadata `169.254.169.254`) for both IPv4 and
IPv6. Interval/timeout are bounded by `MONITOR_*` env limits, and each project
is capped at `MONITOR_MAX_PER_PROJECT` monitors. `MONITOR_ALLOW_PRIVATE_TARGETS=true`
(dev/test only; rejected in production) relaxes the IP-range checks for local testing.

### Incidents (`/organizations/:orgId/incidents`)

- `GET .../incidents` — list incidents in the org (members; paginated).
  Optional filters: `?status=open|acknowledged|investigating|resolved`,
  `?monitorId=<publicId>`, `?projectId=<publicId>`.
- `GET .../incidents/:incidentId` — detail plus timeline events.

Incidents are opened automatically by the check pipeline after
`INCIDENT_FAILURE_THRESHOLD` consecutive non-success results and resolved after
`INCIDENT_RECOVERY_THRESHOLD` consecutive successes. Duplicate open rows are
prevented by the UNIQUE `(organization_id, dedupe_key, status)` constraint; on
resolve the dedupe key is rotated with a timestamp suffix so a future outage on
the same monitor opens a fresh incident without colliding with historical
resolved rows.

### Notification channels (`/organizations/:orgId/notification-channels`)

- `GET .../notification-channels` — list channels (paginated).
- `POST .../notification-channels` — create (admin+). Body: `name`, `config.to`
  email, optional `enabled`.
- `GET .../notification-channels/:channelId` — get one.
- `PATCH .../notification-channels/:channelId` — update (admin+).
- `DELETE .../notification-channels/:channelId` — delete (admin+, 204).

The recipient email is always **redacted** in responses (`o***@domain`) so
channels can be listed safely in a shared UI.

## Alerts & notifications

When `NOTIFICATIONS_ENABLED=true`, incident state changes (open / resolve)
enqueue `notification_deliveries` rows — one per active email channel in the
org, dedup'd on the UNIQUE `dedupe_key = incident:{id}:{event}:channel:{id}`.
The worker process runs a dispatcher loop that claims queued rows via
`SELECT ... FOR UPDATE SKIP LOCKED`, sends through the configured provider, and
records the outcome:

- Success → `status='sent'`, `sent_at` recorded.
- Failure → attempt count incremented, `next_attempt_at` pushed with
  exponential backoff (`NOTIFICATION_BACKOFF_MS × 2^(attempt-1)`); once
  `NOTIFICATION_MAX_ATTEMPTS` is reached the row is marked `status='failed'`
  with a truncated `last_error`.

The email provider is pluggable:

- `EMAIL_PROVIDER=log` (default): writes intent to logs, never sends. Great for
  local dev.
- `EMAIL_PROVIDER=smtp`: uses **nodemailer** with the `SMTP_*` settings.
  Nodemailer is loaded lazily so it is only required when SMTP is actually
  enabled.

Log discipline: recipient emails are redacted (`x***@domain`) in logs, and SMTP
credentials and provider response bodies are never logged.

```bash
QUEUE_ENABLED=true NOTIFICATIONS_ENABLED=true npm run worker
```

### Authorization model

Access is enforced server-side at the query boundary. Membership is resolved
from the `:orgId` path param via `requireOrgMembership` (non-members receive
**404**, so org existence is not leaked). Role-gated actions use
`requireOrgRole` with the hierarchy `viewer < engineer < admin < owner`
(insufficient role receives **403**). Projects are always queried constrained
to the caller's organization, so cross-tenant ids resolve to "not found".

## Scripts

| Script                      | Purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `npm start`                 | Start the API server.                              |
| `npm run dev`               | Start the API with auto-reload.                    |
| `npm run worker`            | Start the worker process.                          |
| `npm run db:migrate`        | Apply all pending database migrations.             |
| `npm run db:rollback`       | Roll back the most recent migration.               |
| `npm run db:reset`          | Roll back all migrations, then re-apply.           |
| `npm run db:status`         | Show applied/pending migrations.                   |
| `npm run db:seed`           | Insert local development seed data.                |
| `npm run maintenance:prune` | Retention pruning (checks + tokens + deliveries).  |
| `npm test`                  | Run the Jest test suite (2-pass; SSRF + main).     |
| `npm run lint`              | Lint with ESLint.                                  |
| `npm run lint:fix`          | Lint and auto-fix.                                 |
| `npm run format`            | Format with Prettier.                              |
| `npm run format:check`      | Check formatting without writing.                  |

## Configuration

All configuration comes from environment variables, validated at startup with
Zod (`apps/api/src/config/env.js`). Invalid configuration causes the process to
exit with a clear message. See [`.env.example`](./.env.example) for the full
list, and [`.env.prod.example`](./.env.prod.example) for production-ready
defaults.

Security notes:

- Secrets live in `.env` (git-ignored), never in source control.
- An empty `DB_PASSWORD` is allowed for local development only; production
  requires a real secret.
- CORS allows only the origins listed in `CORS_ORIGINS`.

## Database

MySQL 8 accessed via `mysql2/promise` with a connection pool and
**parameterized SQL only** (no ORM). The pool and lifecycle helpers live in
`apps/api/src/db/index.js`, which exports `db` (the pool), `connectDB()`,
`disconnectDB()`, and `withTransaction()`. Timestamps are stored and interpreted
in UTC.

The API verifies the database is reachable at startup and closes the pool
during graceful shutdown. `GET /api/v1/health/ready` reports database health
(503 when unavailable).

### Migrations

Migrations are plain SQL files in `database/migrations/` named `NNN_name.sql`,
each with `-- @UP` and `-- @DOWN` sections. A dependency-free runner
(`database/migrate.js`) tracks applied migrations in a `schema_migrations`
table, so `db:migrate` is idempotent.

```bash
# Ensure the database exists (local Docker MySQL does this via MYSQL_DATABASE)
npm run db:migrate     # apply pending migrations
npm run db:status      # list applied/pending
npm run db:rollback    # roll back the most recent migration
npm run db:reset       # roll back everything, then re-apply from scratch
npm run db:seed        # insert local dev seed data (non-production only)
```

### Schema

The baseline schema is owned by `pulseguard_schema.sql` and applied via
`database/migrations/001_initial_schema.sql`. Uses an **organization → project
→ monitor** ownership hierarchy. Tables:

- Identity & tenancy: `organizations`, `users`, `organization_members`,
  `refresh_tokens`, `projects`, `api_keys`.
- Monitoring: `monitors`, `monitor_check_results`, `alert_rules`.
- Incidents & alerting: `incidents`, `incident_events`, `notification_channels`,
  `notification_deliveries`.
- Ingestion & ops (present in schema; not implemented in MVP scope):
  `telemetry_events`, `application_logs`, `ai_analyses`, `audit_logs`,
  `outbox_events`.

Migration `002_fk_and_index_refinements.sql` layers explicit `ON DELETE`
behavior onto the ownership foreign keys without modifying
`pulseguard_schema.sql`.

Identifiers: rows use auto-increment `id` for internal FKs and an opaque
`public_id` (CHAR(26), ULID-shaped) for external references. Timestamps are
`DATETIME(3)` in UTC.

### Retention

`monitor_check_results` (and the ingestion tables when turned on) are expected
to be high-volume. Run `npm run maintenance:prune` on a schedule to trim beyond
the configured retention windows (see env vars above).

## Worker & check pipeline

Checks run asynchronously through a BullMQ queue backed by Redis. Enable it
with `QUEUE_ENABLED=true` and run the worker alongside the API:

```bash
docker compose up -d      # start Redis (and MySQL)
QUEUE_ENABLED=true npm run worker
```

Flow: an enqueue (`POST .../monitors/:id/run`, or the scheduler) adds a job
with a generated `checkId` used as the BullMQ `jobId` for idempotency. The
worker loads the monitor, runs the SSRF-safe checker, and persists a row to
`monitor_check_results`.

The **HTTP checker** (`apps/worker/src/services/httpChecker.js`) defends
against SSRF at connection time, not just on the URL string:

- `http`/`https` only; no credentials in the URL.
- IP-literal targets are checked before connecting; hostnames are validated by
  a custom `dns.lookup` hook that rejects any resolved address in a blocked
  range (defends against DNS rebinding).
- Redirects are followed manually up to `CHECK_MAX_REDIRECTS`, and every hop
  is revalidated.
- Strict per-monitor timeout, a response-size cap (`CHECK_MAX_RESPONSE_BYTES`),
  and no forwarding of internal/authorization headers.

Reliability: jobs retry with bounded exponential backoff (`CHECK_JOB_ATTEMPTS`,
`CHECK_JOB_BACKOFF_MS`); result inserts are idempotent on the unique
`check_id`, so retried or duplicated jobs never create duplicate rows. The
worker drains active jobs on `SIGTERM`/`SIGINT` before exiting.

### Scheduler

When `SCHEDULER_ENABLED=true`, the worker process also runs a scheduler loop
that ticks every `SCHEDULER_TICK_MS` and enqueues checks for monitors whose
`next_run_at` is due. Claiming is atomic via
`SELECT ... FOR UPDATE SKIP LOCKED`, so multiple worker processes can run
schedulers safely — each row is claimed by exactly one. Each claim advances
that monitor's `next_run_at` by its own `interval_seconds`.

Lifecycle: creating a monitor sets `next_run_at=now` so it runs promptly.
Pausing or disabling clears `next_run_at`; resuming re-arms it to now. Changing
the interval on an active monitor re-anchors `next_run_at` so the new cadence
takes effect immediately. Because the DB is the sole source of truth (no
in-memory schedules), restarting the worker cleanly reconciles without
duplicate scheduling.

```bash
QUEUE_ENABLED=true SCHEDULER_ENABLED=true npm run worker
```

Testing note: the suite runs in two passes (`npm test`) — one with private
targets disabled to prove SSRF blocking, and the main pass with
`MONITOR_ALLOW_PRIVATE_TARGETS=true` so local-server checker tests can reach
`127.0.0.1`.

## Project structure

```text
backend/
├── apps/
│   ├── api/src/
│   │   ├── app.js            Express app factory (middleware + routes, no listener)
│   │   ├── server.js         HTTP server entry point + graceful shutdown
│   │   ├── config/env.js     Zod-validated environment configuration
│   │   ├── middleware/       requestId, httpLogger, notFound, errorHandler, authenticate, …
│   │   ├── modules/          auth, users, organizations, projects, monitors, metrics,
│   │   │                     incidents, notifications, health, authz, docs, scheduler, …
│   │   ├── utils/            logger, ApiError, ids, ssrf, pagination, slug, asyncHandler
│   │   ├── db/index.js       mysql2 pool + connectDB/disconnectDB/withTransaction
│   │   ├── redis/            ioredis connection + ping/disconnect
│   │   ├── queues/           BullMQ check queue + enqueueCheck
│   │   └── docs/openapi.yaml API contract (served at GET /api/v1/openapi.yaml)
│   └── worker/src/
│       ├── worker.js         BullMQ Worker entry + graceful shutdown
│       ├── scheduler.js      periodic tick loop (behind SCHEDULER_ENABLED)
│       ├── notificationDispatcher.js
│       ├── processors/       checkProcessor (load monitor, check, persist)
│       └── services/         httpChecker (SSRF-safe), resultStore (persistence)
├── database/
│   ├── migrate.js            dependency-free SQL migration runner
│   ├── seed.js               local development seed data
│   └── migrations/           versioned NNN_name.sql migrations
├── scripts/
│   └── prune.js              retention CLI
├── tests/                    Jest + Supertest tests
├── docs/                     OPERATIONS, SECURITY_REVIEW, Postman collection
├── .github/workflows/        backend-ci.yml, backend-deploy.yml
├── Dockerfile                multi-stage (one image, two commands: API or worker)
├── docker-compose.yml        local MySQL + Redis
├── docker-compose.prod.yml   reference production topology
├── pulseguard_schema.sql     owner-authored baseline schema
├── package.json
└── README.md
```
