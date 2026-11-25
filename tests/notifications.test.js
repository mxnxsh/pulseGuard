'use strict';

const request = require('supertest');
const { createApp } = require('../apps/api/src/app');
const { db } = require('../apps/api/src/db');
const { generatePublicId } = require('../apps/api/src/utils/ids');
const { evaluateAfterCheck } = require('../apps/api/src/modules/incidents/incidents.service');
const {
  dispatcherTick,
  enqueueForIncident,
} = require('../apps/api/src/modules/notifications/notifications.service');
const providerModule = require('../apps/api/src/modules/notifications/emailProvider');

async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

const app = createApp();
const uniqueEmail = () => `not_${Date.now()}_${Math.floor(Math.random() * 1e6)}@pulseguard.test`;
const PASSWORD = 'Password123';

async function registerWithOrgAdminRole(createdEmails) {
  const email = uniqueEmail();
  createdEmails.push(email);
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, fullName: 'Notif User' });
  const token = reg.body.accessToken;
  const orgs = await request(app)
    .get('/api/v1/organizations')
    .set('Authorization', `Bearer ${token}`);
  const orgPublicId = orgs.body.data[0].id;
  const [orgRow] = await db.query('SELECT id FROM organizations WHERE public_id = ?', [orgPublicId]);
  // Registration creates the caller as an 'owner' member — that's admin+.
  return { email, token, orgPublicId, orgInternalId: orgRow[0].id };
}

async function createIncidentDirectly(orgInternalId) {
  // Insert a project + monitor + open incident directly to keep the notification
  // tests decoupled from the check pipeline.
  const [proj] = await db.query(
    "INSERT INTO projects (public_id, organization_id, name, environment, status) VALUES (?, ?, 'N', 'p', 'active')",
    [generatePublicId(), orgInternalId]
  );
  const [mon] = await db.query(
    `INSERT INTO monitors
       (public_id, organization_id, project_id, name, target_url, method,
        interval_seconds, timeout_ms, expected_status_min, expected_status_max, status)
     VALUES (?, ?, ?, 'M', 'https://example.com', 'GET', 60, 5000, 200, 299, 'active')`,
    [generatePublicId(), orgInternalId, proj.insertId]
  );
  const dedupeKey = `monitor:${mon.insertId}:down`;
  const [inc] = await db.query(
    `INSERT INTO incidents
       (public_id, organization_id, project_id, monitor_id, dedupe_key, title,
        severity, status, started_at, last_triggered_at, occurrence_count)
     VALUES (?, ?, ?, ?, ?, 'Down', 'high', 'open', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 1)`,
    [generatePublicId(), orgInternalId, proj.insertId, mon.insertId, dedupeKey]
  );
  return { incidentId: inc.insertId, monitorId: mon.insertId, projectId: proj.insertId };
}

async function insertChannelDirectly(orgInternalId, { to, enabled = true } = {}) {
  const [res] = await db.query(
    `INSERT INTO notification_channels
       (organization_id, name, channel_type, config_encrypted, enabled)
     VALUES (?, 'Ops', 'email', ?, ?)`,
    [orgInternalId, JSON.stringify({ to: to || 'ops@example.com' }), enabled ? 1 : 0]
  );
  return res.insertId;
}

async function insertResult(monitorId, organizationId, status) {
  await db.query(
    `INSERT INTO monitor_check_results
       (organization_id, monitor_id, check_id, region, status, http_status, latency_ms, checked_at)
     VALUES (?, ?, ?, 'default', ?, NULL, NULL, UTC_TIMESTAMP(3))`,
    [organizationId, monitorId, generatePublicId(), status]
  );
}

describe('Notification service (enqueue + dispatcher)', () => {
  let available = false;
  const createdEmails = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping notification tests: MySQL not reachable.');
    }
  });

  afterAll(async () => {
    providerModule.setProvider(null);
    if (available) {
      for (const email of createdEmails) {
        const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (rows[0]) {
          const [orgs] = await db.query(
            `SELECT o.id FROM organizations o
             JOIN organization_members m ON m.organization_id = o.id
             WHERE m.user_id = ? AND m.role = 'owner'`,
            [rows[0].id]
          );
          await db.query('DELETE FROM users WHERE id = ?', [rows[0].id]);
          for (const org of orgs) {
            await db.query('DELETE FROM organizations WHERE id = ?', [org.id]);
          }
        }
      }
    }
  });

  test('enqueueForIncident creates a delivery per active email channel and is idempotent', async () => {
    if (!available) return;
    const user = await registerWithOrgAdminRole(createdEmails);
    const { incidentId } = await createIncidentDirectly(user.orgInternalId);
    await insertChannelDirectly(user.orgInternalId, { to: 'a@example.com' });
    await insertChannelDirectly(user.orgInternalId, { to: 'b@example.com' });
    await insertChannelDirectly(user.orgInternalId, { to: 'c@example.com', enabled: false });

    const first = await enqueueForIncident({
      incidentId,
      organizationId: user.orgInternalId,
      eventType: 'incident_opened',
    });
    expect(first.enqueued).toBe(2); // only the two enabled channels

    // Second call must not create duplicates.
    const second = await enqueueForIncident({
      incidentId,
      organizationId: user.orgInternalId,
      eventType: 'incident_opened',
    });
    expect(second.enqueued).toBe(0);

    const [rows] = await db.query(
      "SELECT COUNT(*) AS c FROM notification_deliveries WHERE incident_id = ? AND status = 'queued'",
      [incidentId]
    );
    expect(rows[0].c).toBe(2);
  });

  test('dispatcher sends via the injected provider and marks status=sent', async () => {
    if (!available) return;
    const user = await registerWithOrgAdminRole(createdEmails);
    const { incidentId } = await createIncidentDirectly(user.orgInternalId);
    await insertChannelDirectly(user.orgInternalId, { to: 'ops@example.com' });
    await enqueueForIncident({
      incidentId,
      organizationId: user.orgInternalId,
      eventType: 'incident_opened',
    });

    const sends = [];
    providerModule.setProvider({
      name: 'mock',
      async send(email) {
        sends.push(email);
        return { ok: true, providerResponse: 'mock-id' };
      },
    });

    // Other tests in this file may have left deliveries in various states, so
    // assert about THIS incident specifically instead of the global tick count.
    const result = await dispatcherTick();
    expect(result.processed).toBeGreaterThanOrEqual(1);
    const sentForOurIncident = sends.find(
      (e) => e.to === 'ops@example.com' && e.subject.includes('Incident opened')
    );
    expect(sentForOurIncident).toBeDefined();

    const [rows] = await db.query(
      "SELECT status, sent_at FROM notification_deliveries WHERE incident_id = ?",
      [incidentId]
    );
    expect(rows[0].status).toBe('sent');
    expect(rows[0].sent_at).not.toBeNull();
  });

  test('failure retries with backoff until max attempts, then marks failed', async () => {
    if (!available) return;
    // Set attempts to 2 for a fast test by overriding via provider that always throws.
    const user = await registerWithOrgAdminRole(createdEmails);
    const { incidentId } = await createIncidentDirectly(user.orgInternalId);
    await insertChannelDirectly(user.orgInternalId, { to: 'flake@example.com' });
    await enqueueForIncident({
      incidentId,
      organizationId: user.orgInternalId,
      eventType: 'incident_opened',
    });

    providerModule.setProvider({
      name: 'mock',
      async send() {
        throw new Error('SMTP unavailable');
      },
    });

    // Read the configured max attempts so we know how many ticks are needed.
    const { env } = require('../apps/api/src/config/env');
    const maxAttempts = env.NOTIFICATION_MAX_ATTEMPTS;

    // Force each retry to be due immediately by clearing next_attempt_at.
    for (let i = 0; i < maxAttempts; i += 1) {
      await db.query(
        "UPDATE notification_deliveries SET status='queued', next_attempt_at = UTC_TIMESTAMP(3) WHERE incident_id = ?",
        [incidentId]
      );
      // On the last tick the row should be marked 'failed' by the dispatcher itself;
      // do not force it back to queued after that.
      await dispatcherTick();
    }

    const [rows] = await db.query(
      "SELECT status, attempts, last_error FROM notification_deliveries WHERE incident_id = ?",
      [incidentId]
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].attempts).toBe(maxAttempts);
    expect(rows[0].last_error).toContain('SMTP unavailable');
  });

  test('dispatcher survives a provider that throws synchronously', async () => {
    if (!available) return;
    const user = await registerWithOrgAdminRole(createdEmails);
    const { incidentId } = await createIncidentDirectly(user.orgInternalId);
    await insertChannelDirectly(user.orgInternalId, { to: 'x@example.com' });
    await enqueueForIncident({
      incidentId,
      organizationId: user.orgInternalId,
      eventType: 'incident_opened',
    });

    providerModule.setProvider({
      name: 'mock',
      // Throws before returning a promise.
      send() {
        throw new Error('boom');
      },
    });

    // Should resolve, not reject: the dispatcher catches per-row errors.
    await expect(dispatcherTick()).resolves.toBeDefined();
    const [rows] = await db.query(
      "SELECT status FROM notification_deliveries WHERE incident_id = ?",
      [incidentId]
    );
    // Depending on env attempts, this is either 'queued' (retrying) or 'failed'.
    expect(['queued', 'failed']).toContain(rows[0].status);
  });

  test('incident evaluation enqueues notifications on open and resolve', async () => {
    if (!available) return;
    const user = await registerWithOrgAdminRole(createdEmails);
    const [proj] = await db.query(
      "INSERT INTO projects (public_id, organization_id, name, environment, status) VALUES (?, ?, 'P', 'p', 'active')",
      [generatePublicId(), user.orgInternalId]
    );
    const [mon] = await db.query(
      `INSERT INTO monitors
         (public_id, organization_id, project_id, name, target_url, method,
          interval_seconds, timeout_ms, expected_status_min, expected_status_max, status)
       VALUES (?, ?, ?, 'M', 'https://example.com', 'GET', 60, 5000, 200, 299, 'active')`,
      [generatePublicId(), user.orgInternalId, proj.insertId]
    );
    await insertChannelDirectly(user.orgInternalId, { to: 'ops@example.com' });

    // Trigger an open incident by producing 3 consecutive failures.
    for (let i = 0; i < 3; i += 1) await insertResult(mon.insertId, user.orgInternalId, 'failure');
    await evaluateAfterCheck({ monitorId: mon.insertId, organizationId: user.orgInternalId });

    let [rows] = await db.query(
      "SELECT COUNT(*) AS c FROM notification_deliveries WHERE organization_id = ? AND status = 'queued'",
      [user.orgInternalId]
    );
    expect(rows[0].c).toBe(1);

    // Resolve with 2 consecutive successes -> second delivery enqueued.
    for (let i = 0; i < 2; i += 1) await insertResult(mon.insertId, user.orgInternalId, 'success');
    await evaluateAfterCheck({ monitorId: mon.insertId, organizationId: user.orgInternalId });

    [rows] = await db.query(
      "SELECT COUNT(*) AS c FROM notification_deliveries WHERE organization_id = ?",
      [user.orgInternalId]
    );
    expect(rows[0].c).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Channel CRUD API tests
// -----------------------------------------------------------------------------

describe('Notification channels API', () => {
  let available = false;
  const createdEmails = [];

  beforeAll(async () => {
    available = await databaseAvailable();
  });

  afterAll(async () => {
    if (available) {
      for (const email of createdEmails) {
        const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (rows[0]) {
          const [orgs] = await db.query(
            `SELECT o.id FROM organizations o
             JOIN organization_members m ON m.organization_id = o.id
             WHERE m.user_id = ? AND m.role = 'owner'`,
            [rows[0].id]
          );
          await db.query('DELETE FROM users WHERE id = ?', [rows[0].id]);
          for (const org of orgs) {
            await db.query('DELETE FROM organizations WHERE id = ?', [org.id]);
          }
        }
      }
    }
  });

  test('owner can create, read, update, and delete a channel; recipient is redacted in responses', async () => {
    if (!available) return;
    const user = await registerWithOrgAdminRole(createdEmails);

    const create = await request(app)
      .post(`/api/v1/organizations/${user.orgPublicId}/notification-channels`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ name: 'Ops', config: { to: 'ops@example.com' } });
    expect(create.status).toBe(201);
    expect(create.body.channel.name).toBe('Ops');
    // Redaction: first char + *** + @ + domain.
    expect(create.body.channel.config.to).toMatch(/^o\*\*\*@example\.com$/);

    const channelId = create.body.channel.id;
    const get = await request(app)
      .get(`/api/v1/organizations/${user.orgPublicId}/notification-channels/${channelId}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(get.status).toBe(200);

    const upd = await request(app)
      .patch(`/api/v1/organizations/${user.orgPublicId}/notification-channels/${channelId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ enabled: false });
    expect(upd.status).toBe(200);
    expect(upd.body.channel.enabled).toBe(false);

    const del = await request(app)
      .delete(`/api/v1/organizations/${user.orgPublicId}/notification-channels/${channelId}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(del.status).toBe(204);
  });

  test('cross-org access is denied (404)', async () => {
    if (!available) return;
    const alice = await registerWithOrgAdminRole(createdEmails);
    const bob = await registerWithOrgAdminRole(createdEmails);
    const created = await request(app)
      .post(`/api/v1/organizations/${alice.orgPublicId}/notification-channels`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'A', config: { to: 'a@example.com' } });
    const id = created.body.channel.id;
    const cross = await request(app)
      .get(`/api/v1/organizations/${alice.orgPublicId}/notification-channels/${id}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(cross.status).toBe(404);
  });
});
