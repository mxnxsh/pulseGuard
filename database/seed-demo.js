'use strict';

/**
 * Rich demo seed. Exercises every UI surface in the frontend:
 *   - two organizations with shared + independent members
 *   - projects with multiple environments
 *   - monitors in every status (active, paused)
 *   - 24h of check results with realistic mix of statuses
 *   - one resolved incident with full timeline
 *   - one open incident still ringing
 *   - notification channels with sent + queued deliveries
 *
 * Idempotent: deletes anything owned by the demo users first, then inserts
 * fresh. Only demo accounts are affected — your personal / smoke-test data
 * and anything created via the UI stays untouched.
 *
 * Usage:   node database/seed-demo.js           (from inside backend/)
 *          npm run db:seed:demo
 */

const bcrypt = require('bcrypt');
const { db, disconnectDB } = require('../apps/api/src/db');
const { env, isProduction } = require('../apps/api/src/config/env');
const logger = require('../apps/api/src/utils/logger');
const { generatePublicId } = require('../apps/api/src/utils/ids');
const { generateUniqueOrgSlug } = require('../apps/api/src/utils/slug');

const DEMO_PASSWORD = 'Password123';

const USERS = [
  { email: 'alice@demo.pulseguard.test',   fullName: 'Alice Chen' },
  { email: 'bob@demo.pulseguard.test',     fullName: 'Bob Martinez' },
  { email: 'charlie@demo.pulseguard.test', fullName: 'Charlie Patel' },
];

async function wipeDemoUsers() {
  // ON DELETE CASCADE on users -> organization_members, refresh_tokens.
  // Orgs owned-by-user aren't cascaded (org has no owner FK), so we find and
  // delete those explicitly.
  for (const u of USERS) {
    const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [u.email]);
    if (rows.length === 0) continue;
    const userId = rows[0].id;
    const [orgs] = await db.query(
      `SELECT o.id FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
       WHERE m.user_id = ? AND m.role = 'owner'`,
      [userId]
    );
    await db.query('DELETE FROM users WHERE id = ?', [userId]);
    for (const org of orgs) {
      await db.query('DELETE FROM organizations WHERE id = ?', [org.id]);
    }
  }
}

async function createUser(email, fullName) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, env.BCRYPT_ROUNDS);
  const [res] = await db.query(
    `INSERT INTO users (public_id, email, password_hash, full_name, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [generatePublicId(), email, hash, fullName]
  );
  return res.insertId;
}

async function createOrg(name) {
  const slug = await generateUniqueOrgSlug(db, name);
  const [res] = await db.query(
    `INSERT INTO organizations (public_id, name, slug, status) VALUES (?, ?, ?, 'active')`,
    [generatePublicId(), name, slug]
  );
  return res.insertId;
}

async function addMember(orgId, userId, role) {
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role, status)
     VALUES (?, ?, ?, 'active')`,
    [orgId, userId, role]
  );
}

async function createProject(orgId, name, environment, createdBy) {
  const [res] = await db.query(
    `INSERT INTO projects (public_id, organization_id, name, environment, status, created_by)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [generatePublicId(), orgId, name, environment, createdBy]
  );
  return res.insertId;
}

async function createMonitor({
  orgId,
  projectId,
  name,
  url,
  intervalSeconds = 60,
  timeoutMs = 5000,
  status = 'active',
  createdBy,
}) {
  // Inline the next_run_at SQL expression based on status; values are code-controlled.
  const nextRunExpr = status === 'active' ? 'UTC_TIMESTAMP(3)' : 'NULL';
  const [res] = await db.query(
    `INSERT INTO monitors
       (public_id, organization_id, project_id, name, target_url, method,
        interval_seconds, timeout_ms, expected_status_min, expected_status_max,
        status, next_run_at, created_by, last_run_at)
     VALUES (?, ?, ?, ?, ?, 'GET', ?, ?, 200, 299, ?, ${nextRunExpr}, ?, UTC_TIMESTAMP(3))`,
    [generatePublicId(), orgId, projectId, name, url, intervalSeconds, timeoutMs, status, createdBy]
  );
  return res.insertId;
}

async function insertResult(orgId, monitorId, { status, httpStatus, latency, minutesAgo }) {
  await db.query(
    `INSERT INTO monitor_check_results
       (organization_id, monitor_id, check_id, region, status, http_status, latency_ms, checked_at)
     VALUES (?, ?, ?, 'default', ?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE))`,
    [orgId, monitorId, generatePublicId(), status, httpStatus, latency, minutesAgo]
  );
}

async function createIncident({
  orgId,
  projectId,
  monitorId,
  title,
  status = 'open',
  startedMinutesAgo,
  resolvedMinutesAgo = null,
  occurrenceCount = 1,
}) {
  // Dedupe key must respect the UNIQUE (org, dedupe_key, status) constraint.
  // Open incident: use the canonical "down" key. Resolved: append a timestamp
  // suffix, mirroring the production rotation.
  const dedupeKey =
    status === 'open'
      ? `monitor:${monitorId}:down`
      : `monitor:${monitorId}:down:r${Date.now() - resolvedMinutesAgo * 60_000}`;

  const resolvedExpr =
    resolvedMinutesAgo === null
      ? 'NULL'
      : `DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${resolvedMinutesAgo} MINUTE)`;

  const [res] = await db.query(
    `INSERT INTO incidents
       (public_id, organization_id, project_id, monitor_id, dedupe_key, title, severity, status,
        started_at, resolved_at, last_triggered_at, occurrence_count)
     VALUES (?, ?, ?, ?, ?, ?, 'high', ?,
             DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE),
             ${resolvedExpr},
             DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${resolvedMinutesAgo ?? Math.max(1, startedMinutesAgo - 5)} MINUTE),
             ?)`,
    [
      generatePublicId(),
      orgId,
      projectId,
      monitorId,
      dedupeKey,
      title,
      status,
      startedMinutesAgo,
      occurrenceCount,
    ]
  );
  return res.insertId;
}

async function addIncidentEvent(incidentId, orgId, { eventType, fromStatus, toStatus, message, minutesAgo }) {
  await db.query(
    `INSERT INTO incident_events
       (incident_id, organization_id, event_type, from_status, to_status, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE))`,
    [incidentId, orgId, eventType, fromStatus, toStatus, message, minutesAgo]
  );
}

async function createChannel(orgId, name, to) {
  const [res] = await db.query(
    `INSERT INTO notification_channels
       (organization_id, name, channel_type, config_encrypted, enabled)
     VALUES (?, ?, 'email', ?, 1)`,
    [orgId, name, JSON.stringify({ to })]
  );
  return res.insertId;
}

async function recordDelivery({ orgId, incidentId, channelId, event, status, minutesAgo }) {
  const dedupeKey = `incident:${incidentId}:${event}:channel:${channelId}`;
  if (status === 'sent') {
    await db.query(
      `INSERT INTO notification_deliveries
         (organization_id, incident_id, channel_id, dedupe_key, status, attempts, sent_at, created_at)
       VALUES (?, ?, ?, ?, 'sent', 1,
               DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE),
               DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE))`,
      [orgId, incidentId, channelId, dedupeKey, minutesAgo, minutesAgo + 1]
    );
  } else {
    await db.query(
      `INSERT INTO notification_deliveries
         (organization_id, incident_id, channel_id, dedupe_key, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 'queued', 0, UTC_TIMESTAMP(3),
               DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE))`,
      [orgId, incidentId, channelId, dedupeKey, minutesAgo]
    );
  }
}

async function seedDemo() {
  if (isProduction) {
    throw new Error('Refusing to run demo seed in production (NODE_ENV=production)');
  }

  logger.info('Demo seed: wiping prior demo accounts');
  await wipeDemoUsers();

  logger.info('Demo seed: creating users (password = "Password123" for all three)');
  const alice = await createUser('alice@demo.pulseguard.test',   'Alice Chen');
  const bob   = await createUser('bob@demo.pulseguard.test',     'Bob Martinez');
  const charlie = await createUser('charlie@demo.pulseguard.test', 'Charlie Patel');

  logger.info('Demo seed: creating organizations');
  const acme   = await createOrg('Acme Corp');
  const globex = await createOrg('Globex Monitoring');

  //  Alice owns Acme; Charlie is an engineer there. Bob owns Globex solo.
  await addMember(acme,   alice,   'owner');
  await addMember(acme,   charlie, 'engineer');
  await addMember(globex, bob,     'owner');

  logger.info('Demo seed: creating projects');
  const acmeProd    = await createProject(acme,   'Public Website',  'production', alice);
  const acmeStaging = await createProject(acme,   'Internal API',    'staging',    alice);
  const globexProd  = await createProject(globex, 'Customer API',    'production', bob);

  logger.info('Demo seed: creating monitors');
  const homepage = await createMonitor({
    orgId: acme, projectId: acmeProd, name: 'Homepage',
    url: 'https://example.com',
    createdBy: alice,
  });
  const statusPage = await createMonitor({
    orgId: acme, projectId: acmeProd, name: 'Status page',
    url: 'https://httpbin.org/status/200',
    createdBy: alice,
  });
  const flaky = await createMonitor({
    orgId: acme, projectId: acmeProd, name: 'Flaky endpoint',
    url: 'https://httpbin.org/status/500',
    createdBy: alice,
  });
  // A paused monitor so the UI shows the paused badge.
  await createMonitor({
    orgId: acme, projectId: acmeProd, name: 'Legacy service',
    url: 'https://example.org',
    status: 'paused',
    createdBy: alice,
  });
  // Staging project gets its own monitor.
  await createMonitor({
    orgId: acme, projectId: acmeStaging, name: 'Staging health',
    url: 'https://example.net',
    intervalSeconds: 300,
    createdBy: alice,
  });
  // One monitor under Globex so Bob's dashboard isn't empty.
  await createMonitor({
    orgId: globex, projectId: globexProd, name: 'Globex public API',
    url: 'https://example.com/api',
    createdBy: bob,
  });

  logger.info('Demo seed: generating 24h of check results');
  // Homepage: 90% success, p75 ~150ms, occasional failures.
  for (let i = 0; i < 48; i += 1) {
    const minutesAgo = (48 - i) * 30; // one result every 30 min for 24h
    const rand = Math.random();
    if (rand < 0.9) {
      await insertResult(acme, homepage, {
        status: 'success', httpStatus: 200,
        latency: 80 + Math.floor(Math.random() * 180),
        minutesAgo,
      });
    } else if (rand < 0.95) {
      await insertResult(acme, homepage, {
        status: 'failure', httpStatus: 503, latency: null, minutesAgo,
      });
    } else {
      await insertResult(acme, homepage, {
        status: 'timeout', httpStatus: null, latency: null, minutesAgo,
      });
    }
  }

  // Status page: 100% success, consistent ~100ms latency.
  for (let i = 0; i < 24; i += 1) {
    await insertResult(acme, statusPage, {
      status: 'success', httpStatus: 200,
      latency: 90 + Math.floor(Math.random() * 40),
      minutesAgo: (24 - i) * 60,
    });
  }

  // Flaky endpoint: alternating success/failure then recent run of consecutive failures.
  for (let i = 0; i < 24; i += 1) {
    const minutesAgo = (24 - i) * 60;
    // Last 4 results (closest to now) are all failures -> triggers the open incident below.
    const forceFailure = i >= 20;
    const status = forceFailure || Math.random() < 0.4 ? 'failure' : 'success';
    await insertResult(acme, flaky, {
      status,
      httpStatus: status === 'success' ? 200 : 500,
      latency: status === 'success' ? 120 + Math.floor(Math.random() * 60) : null,
      minutesAgo,
    });
  }

  logger.info('Demo seed: creating incidents + timeline events + deliveries');

  // --- Resolved incident on Homepage (happened two days ago, resolved same day) ---
  const resolvedIncident = await createIncident({
    orgId: acme, projectId: acmeProd, monitorId: homepage,
    title: 'Homepage was failing',
    status: 'resolved',
    startedMinutesAgo: 2 * 24 * 60,            // 2 days ago
    resolvedMinutesAgo: 2 * 24 * 60 - 45,      // resolved 45 minutes after it opened
    occurrenceCount: 5,
  });
  await addIncidentEvent(resolvedIncident, acme, {
    eventType: 'incident_opened', toStatus: 'open',
    message: 'Opened after 3 consecutive failures',
    minutesAgo: 2 * 24 * 60,
  });
  await addIncidentEvent(resolvedIncident, acme, {
    eventType: 'failure_recorded',
    message: 'Failure (failure) recorded',
    minutesAgo: 2 * 24 * 60 - 15,
  });
  await addIncidentEvent(resolvedIncident, acme, {
    eventType: 'incident_resolved', fromStatus: 'open', toStatus: 'resolved',
    message: 'Resolved after 2 consecutive successes',
    minutesAgo: 2 * 24 * 60 - 45,
  });

  // --- Open incident on Flaky endpoint (started 30 min ago, still ringing) ---
  const openIncident = await createIncident({
    orgId: acme, projectId: acmeProd, monitorId: flaky,
    title: 'Flaky endpoint is failing',
    status: 'open',
    startedMinutesAgo: 30,
    occurrenceCount: 8,
  });
  await addIncidentEvent(openIncident, acme, {
    eventType: 'incident_opened', toStatus: 'open',
    message: 'Opened after 3 consecutive failures',
    minutesAgo: 30,
  });
  await addIncidentEvent(openIncident, acme, {
    eventType: 'failure_recorded',
    message: 'Failure (failure) recorded',
    minutesAgo: 15,
  });
  await addIncidentEvent(openIncident, acme, {
    eventType: 'failure_recorded',
    message: 'Failure (failure) recorded',
    minutesAgo: 5,
  });

  logger.info('Demo seed: creating notification channels');
  const acmeOps     = await createChannel(acme, 'Ops team',          'alerts@acme.example');
  const acmeOncall  = await createChannel(acme, 'On-call rotation',  'oncall@acme.example');
  await createChannel(globex, 'Alerts',                               'alerts@globex.example');

  logger.info('Demo seed: recording notification deliveries');
  // Resolved incident -> both notifications were sent (opened + resolved).
  await recordDelivery({
    orgId: acme, incidentId: resolvedIncident, channelId: acmeOps,
    event: 'incident_opened',   status: 'sent', minutesAgo: 2 * 24 * 60 - 1,
  });
  await recordDelivery({
    orgId: acme, incidentId: resolvedIncident, channelId: acmeOps,
    event: 'incident_resolved', status: 'sent', minutesAgo: 2 * 24 * 60 - 46,
  });
  // Open incident -> deliveries are queued (dispatcher is off when the worker isn't running).
  await recordDelivery({
    orgId: acme, incidentId: openIncident, channelId: acmeOps,
    event: 'incident_opened', status: 'queued', minutesAgo: 30,
  });
  await recordDelivery({
    orgId: acme, incidentId: openIncident, channelId: acmeOncall,
    event: 'incident_opened', status: 'queued', minutesAgo: 30,
  });

  logger.info('Demo seed complete', {
    database: env.DB_NAME,
    users: USERS.length,
    orgs: 2,
    projects: 3,
    monitors: 6,
    incidents: 2,
    channels: 3,
    note: 'Log in with any demo email + password "Password123"',
  });
}

seedDemo()
  .then(() => disconnectDB())
  .catch(async (error) => {
    logger.error('Demo seed failed', { message: error.message, stack: error.stack });
    await disconnectDB().catch(() => {});
    process.exit(1);
  });
