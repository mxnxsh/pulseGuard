'use strict';

const request = require('supertest');
const { createApp } = require('../apps/api/src/app');
const { db } = require('../apps/api/src/db');
const { generatePublicId } = require('../apps/api/src/utils/ids');
const { evaluateAfterCheck } = require('../apps/api/src/modules/incidents/incidents.service');

async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

async function createOrgAndMonitor() {
  const orgPub = generatePublicId();
  const [org] = await db.query(
    "INSERT INTO organizations (public_id, name, slug, status) VALUES (?, ?, ?, 'active')",
    [orgPub, 'Inc Test', orgPub.toLowerCase()]
  );
  const [proj] = await db.query(
    "INSERT INTO projects (public_id, organization_id, name, environment, status) VALUES (?, ?, ?, 'dev', 'active')",
    [generatePublicId(), org.insertId, 'Inc']
  );
  const monPub = generatePublicId();
  const [mon] = await db.query(
    `INSERT INTO monitors
       (public_id, organization_id, project_id, name, target_url, method,
        interval_seconds, timeout_ms, expected_status_min, expected_status_max, status)
     VALUES (?, ?, ?, ?, 'https://example.com', 'GET', 60, 5000, 200, 299, 'active')`,
    [monPub, org.insertId, proj.insertId, 'M']
  );
  return { orgId: org.insertId, orgPublicId: orgPub, projectId: proj.insertId, monitorId: mon.insertId, monitorPublicId: monPub };
}

async function insertResult(monitorId, organizationId, status) {
  await db.query(
    `INSERT INTO monitor_check_results
       (organization_id, monitor_id, check_id, region, status, checked_at)
     VALUES (?, ?, ?, 'default', ?, UTC_TIMESTAMP(3))`,
    [organizationId, monitorId, generatePublicId(), status]
  );
}

/** Inserts a check result then triggers incident evaluation. */
async function checkAndEvaluate(monitorId, organizationId, status) {
  await insertResult(monitorId, organizationId, status);
  return evaluateAfterCheck({ monitorId, organizationId });
}

describe('Incident detection service', () => {
  let available = false;
  const orgsCreated = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping incident assertions: MySQL not reachable.');
    }
  });

  afterAll(async () => {
    if (available) {
      for (const orgId of orgsCreated) {
        await db.query('DELETE FROM organizations WHERE id = ?', [orgId]);
      }
    }
  });

  async function setup() {
    const ctx = await createOrgAndMonitor();
    orgsCreated.push(ctx.orgId);
    return ctx;
  }

  test('opens an incident after N consecutive failures (default 3)', async () => {
    if (!available) return;
    const { orgId, monitorId } = await setup();

    // Two failures alone should not open (below threshold).
    const r1 = await checkAndEvaluate(monitorId, orgId, 'failure');
    expect(r1.action).toBe('none');
    const r2 = await checkAndEvaluate(monitorId, orgId, 'failure');
    expect(r2.action).toBe('none');

    // Third failure crosses the threshold and opens.
    const r3 = await checkAndEvaluate(monitorId, orgId, 'failure');
    expect(r3.action).toBe('opened');

    const [rows] = await db.query(
      "SELECT status, occurrence_count FROM incidents WHERE monitor_id = ? AND status <> 'resolved'",
      [monitorId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('open');
  });

  test('subsequent failures increment the same open incident (no duplicate open row)', async () => {
    if (!available) return;
    const { orgId, monitorId } = await setup();

    for (let i = 0; i < 3; i += 1) await checkAndEvaluate(monitorId, orgId, 'failure');
    // Additional failures should increment, never create a second open incident.
    const r = await checkAndEvaluate(monitorId, orgId, 'failure');
    expect(r.action).toBe('incremented');

    const [openRows] = await db.query(
      "SELECT id, occurrence_count FROM incidents WHERE monitor_id = ? AND status <> 'resolved'",
      [monitorId]
    );
    expect(openRows.length).toBe(1);
    expect(openRows[0].occurrence_count).toBeGreaterThan(3);
  });

  test('flapping below threshold does not open an incident', async () => {
    if (!available) return;
    const { orgId, monitorId } = await setup();

    await checkAndEvaluate(monitorId, orgId, 'failure');
    await checkAndEvaluate(monitorId, orgId, 'success');
    await checkAndEvaluate(monitorId, orgId, 'failure');
    await checkAndEvaluate(monitorId, orgId, 'success');

    const [rows] = await db.query('SELECT COUNT(*) AS c FROM incidents WHERE monitor_id = ?', [
      monitorId,
    ]);
    expect(rows[0].c).toBe(0);
  });

  test('resolves an open incident after M consecutive successes (default 2)', async () => {
    if (!available) return;
    const { orgId, monitorId } = await setup();

    for (let i = 0; i < 3; i += 1) await checkAndEvaluate(monitorId, orgId, 'failure');

    // One success alone is not enough (below recovery threshold).
    const r1 = await checkAndEvaluate(monitorId, orgId, 'success');
    expect(r1.action).toBe('none');
    const [stillOpen] = await db.query(
      "SELECT status FROM incidents WHERE monitor_id = ? AND status <> 'resolved'",
      [monitorId]
    );
    expect(stillOpen[0].status).toBe('open');

    // Second consecutive success triggers resolution.
    const r2 = await checkAndEvaluate(monitorId, orgId, 'success');
    expect(r2.action).toBe('resolved');
    const [resolved] = await db.query(
      "SELECT status, resolved_at FROM incidents WHERE monitor_id = ?",
      [monitorId]
    );
    expect(resolved[0].status).toBe('resolved');
    expect(resolved[0].resolved_at).not.toBeNull();
  });

  test('a new outage after resolution opens a fresh incident without dedupe collision', async () => {
    if (!available) return;
    const { orgId, monitorId } = await setup();

    // First outage + recovery.
    for (let i = 0; i < 3; i += 1) await checkAndEvaluate(monitorId, orgId, 'failure');
    for (let i = 0; i < 2; i += 1) await checkAndEvaluate(monitorId, orgId, 'success');

    // Second outage.
    for (let i = 0; i < 3; i += 1) await checkAndEvaluate(monitorId, orgId, 'failure');

    const [rows] = await db.query(
      'SELECT status FROM incidents WHERE monitor_id = ? ORDER BY id ASC',
      [monitorId]
    );
    expect(rows.length).toBe(2);
    expect(rows[0].status).toBe('resolved');
    expect(rows[1].status).toBe('open');
  });
});

// -----------------------------------------------------------------------------
// API-level list/get tests, including cross-org isolation.
// -----------------------------------------------------------------------------

const app = createApp();
const uniqueEmail = () => `inc_${Date.now()}_${Math.floor(Math.random() * 1e6)}@pulseguard.test`;
const PASSWORD = 'Password123';

async function registerUserWithMonitor(createdEmails) {
  const email = uniqueEmail();
  createdEmails.push(email);
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, fullName: 'Inc User' });
  const token = reg.body.accessToken;
  const orgs = await request(app)
    .get('/api/v1/organizations')
    .set('Authorization', `Bearer ${token}`);
  const orgPublicId = orgs.body.data[0].id;
  const [orgRow] = await db.query('SELECT id FROM organizations WHERE public_id = ?', [orgPublicId]);
  const proj = await request(app)
    .post(`/api/v1/organizations/${orgPublicId}/projects`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'P', environment: 'prod' });
  const projectId = proj.body.project.id;
  const [projRow] = await db.query('SELECT id FROM projects WHERE public_id = ?', [projectId]);
  const monPub = generatePublicId();
  const [monRow] = await db.query(
    `INSERT INTO monitors
       (public_id, organization_id, project_id, name, target_url, method,
        interval_seconds, timeout_ms, expected_status_min, expected_status_max, status)
     VALUES (?, ?, ?, 'M', 'https://example.com', 'GET', 60, 5000, 200, 299, 'active')`,
    [monPub, orgRow[0].id, projRow[0].id]
  );
  return {
    email,
    token,
    orgPublicId,
    orgInternalId: orgRow[0].id,
    monitorInternalId: monRow.insertId,
    monitorPublicId: monPub,
  };
}

describe('Incident APIs (list/get, cross-org isolation)', () => {
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

  test('lists incidents scoped to the caller org and supports filtering', async () => {
    if (!available) return;
    const alice = await registerUserWithMonitor(createdEmails);
    // Cause an incident to open.
    for (let i = 0; i < 3; i += 1) {
      await insertResult(alice.monitorInternalId, alice.orgInternalId, 'failure');
    }
    await evaluateAfterCheck({
      monitorId: alice.monitorInternalId,
      organizationId: alice.orgInternalId,
    });

    const res = await request(app)
      .get(`/api/v1/organizations/${alice.orgPublicId}/incidents?status=open`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].status).toBe('open');
    expect(res.body.data[0].monitorId).toBe(alice.monitorPublicId);
  });

  test('cross-org list and get are blocked (no existence leak)', async () => {
    if (!available) return;
    const alice = await registerUserWithMonitor(createdEmails);
    const bob = await registerUserWithMonitor(createdEmails);

    for (let i = 0; i < 3; i += 1) {
      await insertResult(alice.monitorInternalId, alice.orgInternalId, 'failure');
    }
    await evaluateAfterCheck({
      monitorId: alice.monitorInternalId,
      organizationId: alice.orgInternalId,
    });

    // Bob asks for Alice's org -> 404 by membership.
    const list = await request(app)
      .get(`/api/v1/organizations/${alice.orgPublicId}/incidents`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(list.status).toBe(404);

    // Bob asks for a specific incident (public_id) under his own org -> 404 by scope.
    const [aliceIncidents] = await db.query(
      "SELECT public_id FROM incidents WHERE organization_id = ? LIMIT 1",
      [alice.orgInternalId]
    );
    const incPublicId = aliceIncidents[0].public_id;
    const cross = await request(app)
      .get(`/api/v1/organizations/${bob.orgPublicId}/incidents/${incPublicId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(cross.status).toBe(404);
  });

  test('get returns the incident and its timeline events', async () => {
    if (!available) return;
    const alice = await registerUserWithMonitor(createdEmails);
    for (let i = 0; i < 3; i += 1) {
      await insertResult(alice.monitorInternalId, alice.orgInternalId, 'failure');
    }
    await evaluateAfterCheck({
      monitorId: alice.monitorInternalId,
      organizationId: alice.orgInternalId,
    });

    const [rows] = await db.query(
      "SELECT public_id FROM incidents WHERE organization_id = ? LIMIT 1",
      [alice.orgInternalId]
    );
    const res = await request(app)
      .get(`/api/v1/organizations/${alice.orgPublicId}/incidents/${rows[0].public_id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.incident.status).toBe('open');
    expect(Array.isArray(res.body.incident.events)).toBe(true);
    expect(res.body.incident.events.length).toBeGreaterThan(0);
    expect(res.body.incident.events[0].eventType).toBe('incident_opened');
  });
});
