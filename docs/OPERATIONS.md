# PulseGuard — Operations Runbook

Operational reference for deploying, migrating, backing up, restoring, and
rolling back PulseGuard in a real environment. Development setup lives in the
top-level `README.md`; this document covers production concerns.

## 1. Deploy topology

Two processes from one image:

- **API** (`node apps/api/src/server.js`) — stateless; scale horizontally.
- **Worker** (`node apps/worker/src/worker.js`) — runs the BullMQ consumer, the
  scheduler tick, and the notification dispatcher. At least one instance must
  have `QUEUE_ENABLED=true`, `SCHEDULER_ENABLED=true`, `NOTIFICATIONS_ENABLED=true`.
  Multiple workers are safe (atomic claim via `FOR UPDATE SKIP LOCKED`).

Dependencies:

- **MySQL 8** with the `pulseguard_db` schema (or your `DB_NAME`).
- **Redis 7** (only required when the queue is enabled).

Optional extras used when configured:

- **SMTP relay** when `EMAIL_PROVIDER=smtp` (also requires the `nodemailer`
  npm dep to be installed on the image).

## 2. Environment configuration

All configuration comes from environment variables and is validated on startup
(Zod). Missing or invalid values cause the process to exit with a clear message.
See `.env.example` for the full list. Production must set at minimum:

- `NODE_ENV=production`
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `JWT_SECRET` — 32+ chars, random (env validation rejects a weak value in prod)
- `CORS_ORIGINS` — explicit allow list; never `*`
- `TRUST_PROXY=true` when behind a reverse proxy
- `REDIS_HOST` and `QUEUE_ENABLED=true` on at least one worker
- If using SMTP: `EMAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASSWORD`, `EMAIL_FROM`

Secrets should be sourced from a secrets manager (AWS Secrets Manager, Vault,
etc.) and injected as env vars — not committed anywhere.

## 3. Database migrations

Migrations live in `database/migrations/` and are managed by a dependency-free
runner (`database/migrate.js`).

```bash
npm run db:migrate     # apply all pending
npm run db:status      # show applied/pending
npm run db:rollback    # roll back the most recent
npm run db:reset       # drop + re-apply all (DANGEROUS in prod)
```

**Deployment order for a schema change:**

1. Ship the migration file in the release.
2. Deploy the new **worker** first (workers tolerate the old + new schema).
3. Run `npm run db:migrate` against production.
4. Deploy the API.
5. Verify `GET /api/v1/health/ready` and a smoke check journey.

Never run `db:reset` in production. To back out a bad migration use
`db:rollback`; if that is unsafe (data loss), restore from backup and forward
a compensating migration.

## 4. Backups

MySQL is the sole authoritative store. Redis holds only transient queue state
that can be regenerated.

**Recommended backup regime:**

- Full daily logical dump via `mysqldump` or a managed snapshot.
- Point-in-time recovery via binary logs enabled on the server.
- Backups shipped off-host to encrypted storage.

**Manual dump:**

```bash
mysqldump --single-transaction --routines --triggers \
  -u"$DB_USER" -p"$DB_PASSWORD" -h "$DB_HOST" "$DB_NAME" \
  > "backup-$(date +%F).sql"
```

**Restore:**

```bash
mysql -u"$DB_USER" -p"$DB_PASSWORD" -h "$DB_HOST" "$DB_NAME" < backup.sql
```

Tables holding lots of data (`monitor_check_results`, `notification_deliveries`)
have retention policies — see section 6.

## 5. Rollback

Rollback strategy differs by change type:

- **Code-only change:** redeploy the previous image tag; workers and API roll
  back independently.
- **Additive schema change** (new columns, indexes, tables): safe to leave the
  new schema in place while rolling back application code.
- **Destructive schema change:** use `db:rollback` to revert one migration.
  If forward-migration erased data, restore from the daily backup and replay
  binlogs to the desired point in time.

Verify after any rollback:

```bash
curl -sf http://<api-host>/api/v1/health/ready
```

## 6. Retention & cleanup

`monitor_check_results`, `refresh_tokens`, and `notification_deliveries` grow
over time. A pruning script trims them based on env retention windows:

```bash
npm run maintenance:prune
```

Configure via env:

- `CHECK_RESULT_RETENTION_DAYS` (default 90)
- `REFRESH_TOKEN_RETENTION_DAYS` (default 30 for revoked tokens; expired ones
  are always removed)
- `NOTIFICATION_DELIVERY_RETENTION_DAYS` (default 180; only touches `sent`,
  `failed`, `cancelled` rows)

Recommended cadence: daily off-peak. Schedule via cron, systemd timer, or your
platform's scheduled tasks; do not run it inline on the API.

## 7. Observability

Structured JSON logs go to stdout in production (Winston with JSON format).
Every request carries an `X-Request-Id` header (echoed to clients and included
in log lines). Key operational events include:

- `Incident opened` / `Incident resolved`
- `Notification sent` / `Notification failed`
- `Scheduler tick` (claimed / enqueued counts)
- `Check completed` (per job)

Log discipline: passwords, tokens, SMTP credentials, and full recipient emails
are never logged. Recipient addresses are redacted to `x***@domain` before
emission.

Health probes:

- `GET /api/v1/health/live` — process liveness.
- `GET /api/v1/health/ready` — DB (and Redis when queue is enabled). Returns
  503 when any dependency is unhealthy.

## 8. CI/CD

Reference workflows live in `.github/workflows/` (backend) and
`apps/web/.github/workflows/` (frontend). They are templates — the
`# CUSTOMIZE:` steps are the platform-specific bits you fill in.

**Backend CI (`backend-ci.yml`)** runs on every push/PR that touches backend
paths:

- Spins up a MySQL 8 service container.
- Applies migrations.
- Runs lint + the SSRF-blocking test pass + the main test pass.
- Verifies the Dockerfile builds (no push).

**Backend Deploy (`backend-deploy.yml`)** runs on tags matching `v*` or on
manual dispatch. It enforces the required order:

1. Build + push image to the registry.
2. Run `npm run db:migrate` against production using the pushed image's
   migration files.
3. Deploy the **worker** first (it tolerates both old + new schema).
4. Deploy the **API** second.
5. Verify `GET /api/v1/health/ready` returns 200 with
   `checks.database == 'ok'` (and `checks.redis == 'ok'` when the queue is on).

Fill in the `CUSTOMIZE:` steps for your target platform (ECS/EKS/Fly/Render/
bare Docker). The ordering is the correctness contract — keep it.

**Frontend CI/Deploy (`apps/web/.github/workflows/*.yml`)** are smaller:
lint + vitest + production build, then a Docker build of the nginx image with
`VITE_API_URL` baked in via `--build-arg`. The web container is stateless so
rolling it is safe at any time.

## 9. Secrets management

Never commit `.env.prod`. Source secrets from a managed store and inject at
container start:

- AWS: Secrets Manager / SSM Parameter Store → ECS Task Definition `secrets`.
- GCP: Secret Manager → Cloud Run env.
- Kubernetes: external-secrets or Sealed Secrets → Deployment envFrom.
- Fly.io / Render / Railway: their native secret UIs.

Env validation refuses to start when:

- `DB_PASSWORD` is empty
- `JWT_SECRET` is the dev default or < 32 chars
- `MONITOR_ALLOW_PRIVATE_TARGETS=true`
- `NOTIFICATIONS_ENABLED=true` + `EMAIL_PROVIDER=smtp` without `SMTP_HOST`

Generate a strong `JWT_SECRET`:

```bash
openssl rand -hex 32
```

Rotate it by (a) staging the new value alongside the old, (b) rolling the API
with both accepted (requires a code change — tracked as a future improvement),
or (c) accepting that all currently-issued tokens become invalid at the
rotation moment and users need to sign in again. Option (c) is the pragmatic
MVP choice.

## 10. TLS & edge configuration

Terminate TLS at the edge (CloudFront, Cloudflare, ALB, an ingress controller,
etc.):

- Set **HSTS** at the edge, not in the app. The nginx config inside the web
  container intentionally skips HSTS so it can be driven centrally.
- Set `TRUST_PROXY=true` on the API so it reads the real client IP from
  `X-Forwarded-For`. The rate limiter and audit logs depend on this.
- Set `CORS_ORIGINS` on the API to exactly your frontend origin(s), never `*`.

## 11. Monitoring PulseGuard itself

Operational signals to watch:

- API: 5xx rate, p95 latency, `/api/v1/health/ready` status.
- Worker: BullMQ queue depth (`monitor-checks`), job failure rate, scheduler
  tick age, notification dispatcher backlog (`notification_deliveries` where
  `status='queued'`).
- Database: connection count, slow queries on `monitor_check_results` (your
  high-volume table), replication lag if you add replicas.
- Redis: used memory, evictions.

Ship structured logs to a log aggregator (Datadog, Loki, CloudWatch Logs) and
alert on the queue depth + failure rate. PulseGuard explicitly does not
monitor itself in the MVP — bootstrapping that is a future improvement.

## 12. Disaster recovery drills

At a minimum, exercise the following on a schedule:

1. Restore the latest daily backup into a scratch database and run
   `npm run db:status` + a read-only smoke query.
2. Kill the worker(s) mid-tick and verify the scheduler resumes without
   duplicate enqueues (`schema_migrations` and pending-job counts).
3. Fail the SMTP relay and verify `notification_deliveries` retries with
   exponential backoff and eventually marks `failed` after
   `NOTIFICATION_MAX_ATTEMPTS` (does not crash the worker).

Document the results and adjust runbook items or thresholds as needed.
