# PulseGuard — Backend Security Review

A record of the security decisions and defenses in the backend, aligned to the
plan's security requirements (section 5). Use it as a checklist before major
releases and to onboard reviewers.

## 1. Authentication & session management

- Passwords hashed with **bcrypt** (cost configurable via `BCRYPT_ROUNDS`,
  default 12). Never stored or returned in plaintext.
- Access tokens are short-lived **JWTs** signed with `JWT_SECRET`, with
  explicit `iss` / `aud` claims. TTL configurable (default 15 min).
- Refresh tokens are opaque random values returned to the client; only their
  **SHA-256 hash** is stored (`refresh_tokens.token_hash`).
- **Rotation with reuse detection:** every refresh issues a new token and
  revokes the previous one in the same `family_id`. Presenting an already-
  rotated (revoked) token revokes the whole family — a committed side effect,
  independent of the rejected transaction. Verified in `tests/auth.test.js`.
- Login uses a constant-ish password compare to reduce timing signal
  (`auth.service.js`).
- `POST /auth/logout` revokes the family without leaking whether a token was
  valid.
- Rate limits: 20/15m on `/auth/register`, `/auth/login`, `/auth/refresh`
  (`middleware/authRateLimiter.js`).
- Env validation refuses to start with a weak `JWT_SECRET` in production
  (`< 32 chars` or the dev default).

## 2. Tenant isolation

- Every org-scoped resource is queried constrained to the caller's
  `organizationId` at the SQL boundary — never trusts the frontend.
- Membership resolves via `requireOrgMembership` middleware; non-members
  receive **404** (not 403) so org existence is not revealed
  (`modules/authz/authz.js`).
- Role hierarchy `viewer < engineer < admin < owner` enforced via
  `requireOrgRole`.
- Cross-org access is exhaustively tested for orgs, projects, monitors,
  incidents, notification channels, and metrics (`tests/*.test.js`).

## 3. SSRF protection

Monitors make outbound requests to user-configured URLs. This is the largest
security boundary.

- **Validation at create/update:** `utils/ssrf.js`
  - `http` / `https` only; no credentials in URL; not malformed.
  - IP-literal targets checked directly.
  - DNS resolution + rejection if any resolved address is in a blocked range
    (private, loopback, link-local incl. cloud metadata `169.254.169.254`,
    multicast, reserved, CGNAT) for IPv4 **and** IPv6 (incl. IPv4-mapped).
- **Validation at connection time:** the worker's HTTP checker uses a custom
  `dns.lookup` hook that revalidates every connection, plus a pre-check for
  IP-literal hosts (which bypass the DNS hook). This defends against DNS
  rebinding.
  (`apps/worker/src/services/httpChecker.js`).
- **Manual redirect handling:** each redirect hop is revalidated. Redirect
  count bounded by `CHECK_MAX_REDIRECTS`.
- **Strict per-request timeout** (`monitor.timeout_ms`) and **response-size
  cap** (`CHECK_MAX_RESPONSE_BYTES`, default 1 MiB). Oversize responses abort
  the socket and are recorded as `SIZE_LIMIT`.
- **No forwarding of auth headers** — the checker only sends the `User-Agent`
  it sets plus explicit per-monitor `request_headers`.
- `MONITOR_ALLOW_PRIVATE_TARGETS` is a dev/test-only escape hatch; env
  validation refuses to start with it enabled in production.

## 4. Input validation & SQL safety

- All request bodies and query strings are validated with **Zod** schemas;
  invalid input becomes a 400 `VALIDATION_ERROR` with structured details.
- **All SQL is parameterized** via `mysql2/promise`. No string interpolation
  of user input into SQL anywhere in the codebase (the one inlined interval
  clause in the metrics service is from a closed enum, not user input).
- Body size capped at 1 MiB (`express.json({ limit: '1mb' })`).

## 5. Rate limiting

- Baseline: `express-rate-limit` mounted globally (100 req/min by default,
  configurable via `RATE_LIMIT_*`).
- Stricter limit for `/auth/*` (20/15m).
- Note: in-memory store. In a multi-instance API deployment, move to a Redis-
  backed store (tracked in `docs/FUTURE_SUGGESTIONS.md`).

## 6. Secure headers & CORS

- **Helmet** applied globally.
- `x-powered-by` disabled.
- CORS is an **explicit allow list** from `CORS_ORIGINS`; empty means
  no cross-origin access. `credentials: true` is enabled only for allow-listed
  origins.

## 7. Error handling

- Central error handler normalizes throwables to a consistent JSON envelope
  `{ error: { code, message, requestId, details? } }`.
- Stack traces are only exposed for 5xx responses when
  `NODE_ENV !== 'production'`.
- ZodError becomes a 400 `VALIDATION_ERROR` automatically.

## 8. Log discipline

- Structured JSON in production; readable format in dev.
- Recipient emails redacted (`x***@domain`) before logging.
- Passwords, JWT secrets, refresh tokens, SMTP credentials, and full provider
  response bodies are never logged. `last_error` on delivery rows is truncated
  to 500 chars.
- Every request logs `requestId`, `method`, `path`, `status`, `durationMs` —
  no headers or bodies.

## 9. Reliability & concurrency

- Every mutation happens in a MySQL transaction where multi-step consistency
  matters (registration, incident evaluation, scheduler claim, notification
  claim).
- Duplicate/retried jobs are idempotent: `monitor_check_results.check_id`
  UNIQUE + `INSERT IGNORE` (verified in `tests/concurrency.test.js`).
- Duplicate open incidents are prevented by `SELECT ... FOR UPDATE` on the
  monitor row **plus** the UNIQUE `(organization_id, dedupe_key, status)`
  constraint (`tests/concurrency.test.js` — parallel jobs open exactly one
  incident).
- Reuse of a revoked refresh token revokes the entire token family; this
  revocation is committed even though the request rejects.
- Notification retries are bounded (`NOTIFICATION_MAX_ATTEMPTS`) with
  exponential backoff. A provider that throws does not crash the loop.
- Graceful shutdown: API drains in-flight requests, worker awaits active jobs
  + scheduler tick + notification dispatcher tick, then closes DB and Redis.

## 10. Known limitations (accepted for MVP)

- In-memory rate limit store — replace with Redis before multi-instance API.
- `config_encrypted` in `notification_channels` stores JSON in the clear —
  add real encryption before storing sensitive channel configs.
- P50/P95 latency percentiles not exposed (MySQL 8 has no native aggregate;
  rollup tables are the future direction — see `docs/FUTURE_SUGGESTIONS.md`).
- No CSRF middleware; the API is intended for bearer-token clients, not
  cookie-authenticated browsers. If cookie auth is added later, CSRF must be
  addressed.
- OpenAPI spec is hand-authored (`apps/api/src/docs/openapi.yaml`) and served
  at `GET /api/v1/openapi.yaml`. Zod-to-OpenAPI generation is a future
  improvement.

## 11. Pre-release checklist

Before promoting a build to production:

- [ ] `npm test` passes end-to-end (main + SSRF passes).
- [ ] `npm run lint` clean.
- [ ] `npm audit` reviewed; documented risks accepted.
- [ ] `.env` values reviewed: strong `JWT_SECRET`, explicit `CORS_ORIGINS`,
      `MONITOR_ALLOW_PRIVATE_TARGETS=false`, non-empty `DB_PASSWORD`, SMTP
      credentials present if `EMAIL_PROVIDER=smtp`.
- [ ] Database migration applied (`npm run db:status` shows no pending).
- [ ] Backup taken.
- [ ] `GET /api/v1/health/ready` returns 200 post-deploy.
- [ ] CORS `CORS_ORIGINS` set to the exact production frontend origin(s); no `*`.
- [ ] TLS terminated at the edge; HSTS set at the edge.
- [ ] `TRUST_PROXY=true` when running behind a load balancer / CDN.
- [ ] Secrets sourced from a managed store, not image env vars or source.
- [ ] Registry credentials in CI use a scoped token, not a user password.
