'use strict';

const request = require('supertest');
const { createApp } = require('../apps/api/src/app');
const { db } = require('../apps/api/src/db');
const { generatePublicId } = require('../apps/api/src/utils/ids');

async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

const app = createApp();
const uniqueEmail = () => `met_${Date.now()}_${Math.floor(Math.random() * 1e6)}@pulseguard.test`;
const PASSWORD = 'Password123';

/**
 * Registers a user, creates a project, and inserts a monitor directly (bypassing
 * SSRF validation and quota checks — this test focuses on read-side metrics).
 * Returns ids needed for URLs and fixture inserts.
 */
async function setupMonitor(createdEmails) {
  const email = uniqueEmail();
  createdEmails.push(email);
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, fullName: 'Metrics User' });
  const token = reg.body.accessToken;
  const orgs = await request(app)
    .get('/api/v1/organizations')
    .set('Authorization', `Bearer ${token}`);
  const orgPublicId = orgs.body.data[0].id;
  const [orgRow] = await db.query('SELECT id FROM organizations WHERE public_id = ?', [orgPublicId]);
  const proj = await request(app)
    .post(`/api/v1/organizations/${orgPublicId}/projects`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Metrics', environment: 'prod' });
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
    projectPublicId: projectId,
    monitorInternalId: monRow.insertId,
    monitorPublicId: monPub,
  };
}

/**
 * Inserts a check result at an explicit checked_at (UTC). Latency is only
 * meaningful when status = success.
 */
async function insertResultAt(monitor, { status, latency, ago }) {
  await db.query(
    `INSERT INTO monitor_check_results
       (organization_id, monitor_id, check_id, region, status, http_status, latency_ms, checked_at)
     VALUES (?, ?, ?, 'default', ?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? SECOND))`,
    [
      monitor.orgInternalId,
      monitor.monitorInternalId,
      generatePublicId(),
      status,
      status === 'success' ? 200 : null,
      status === 'success' ? latency : null,
      ago,
    ]
  );
}

function base(orgPublicId, projectPublicId, monitorPublicId) {
  return `/api/v1/organizations/${orgPublicId}/projects/${projectPublicId}/monitors/${monitorPublicId}`;
}

describe('Metrics APIs (history + summary)', () => {
  let available = false;
  const createdEmails = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping metrics tests: MySQL not reachable.');
    }
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

  test('summary is empty (nulls) when there is no data in the window', async () => {
    if (!available) return;
    const m = await setupMonitor(createdEmails);
    const res = await request(app)
      .get(`${base(m.orgPublicId, m.projectPublicId, m.monitorPublicId)}/summary?window=1h`)
      .set('Authorization', `Bearer ${m.token}`);
    expect(res.status).toBe(200);
    expect(res.body.window).toBe('1h');
    expect(res.body.totalChecks).toBe(0);
    expect(res.body.uptimePercent).toBeNull();
    expect(res.body.latencyMs).toEqual({ min: null, avg: null, max: null });
  });

  test('summary computes uptime and latency stats from known fixtures', async () => {
    if (!available) return;
    const m = await setupMonitor(createdEmails);
    // 3 successes (latencies 100/200/300) + 1 failure + 1 timeout in the last hour.
    await insertResultAt(m, { status: 'success', latency: 100, ago: 60 });
    await insertResultAt(m, { status: 'success', latency: 200, ago: 120 });
    await insertResultAt(m, { status: 'success', latency: 300, ago: 180 });
    await insertResultAt(m, { status: 'failure', ago: 240 });
    await insertResultAt(m, { status: 'timeout', ago: 300 });

    const res = await request(app)
      .get(`${base(m.orgPublicId, m.projectPublicId, m.monitorPublicId)}/summary?window=1h`)
      .set('Authorization', `Bearer ${m.token}`);
    expect(res.status).toBe(200);
    expect(res.body.totalChecks).toBe(5);
    expect(res.body.counts).toEqual({ success: 3, failure: 1, timeout: 1, blocked: 0 });
    // 3/5 = 60.00 %
    expect(res.body.uptimePercent).toBe(60);
    expect(res.body.latencyMs.min).toBe(100);
    expect(res.body.latencyMs.max).toBe(300);
    // avg of [100,200,300] = 200
    expect(res.body.latencyMs.avg).toBe(200);
  });

  test('window filter excludes older results', async () => {
    if (!available) return;
    const m = await setupMonitor(createdEmails);
    // Inside 1h window.
    await insertResultAt(m, { status: 'success', latency: 100, ago: 60 });
    // Outside 1h window (2 hours ago).
    await insertResultAt(m, { status: 'failure', ago: 2 * 60 * 60 });

    const inHour = await request(app)
      .get(`${base(m.orgPublicId, m.projectPublicId, m.monitorPublicId)}/summary?window=1h`)
      .set('Authorization', `Bearer ${m.token}`);
    expect(inHour.body.totalChecks).toBe(1);
    expect(inHour.body.uptimePercent).toBe(100);

    const inDay = await request(app)
      .get(`${base(m.orgPublicId, m.projectPublicId, m.monitorPublicId)}/summary?window=24h`)
      .set('Authorization', `Bearer ${m.token}`);
    expect(inDay.body.totalChecks).toBe(2);
    expect(inDay.body.uptimePercent).toBe(50);
  });

  test('summary rejects an unknown window', async () => {
    if (!available) return;
    const m = await setupMonitor(createdEmails);
    const res = await request(app)
      .get(`${base(m.orgPublicId, m.projectPublicId, m.monitorPublicId)}/summary?window=42y`)
      .set('Authorization', `Bearer ${m.token}`);
    expect(res.status).toBe(400);
  });

  test('history is paginated and supports a status filter', async () => {
    if (!available) return;
    const m = await setupMonitor(createdEmails);
    for (let i = 0; i < 3; i += 1) {
      await insertResultAt(m, { status: 'success', latency: 100 + i, ago: 60 + i });
    }
    for (let i = 0; i < 2; i += 1) {
      await insertResultAt(m, { status: 'failure', ago: 200 + i });
    }

    const all = await request(app)
      .get(`${base(m.orgPublicId, m.projectPublicId, m.monitorPublicId)}/checks?pageSize=10`)
      .set('Authorization', `Bearer ${m.token}`);
    expect(all.status).toBe(200);
    expect(all.body.pagination.total).toBe(5);
    expect(all.body.data.length).toBe(5);

    const failuresOnly = await request(app)
      .get(`${base(m.orgPublicId, m.projectPublicId, m.monitorPublicId)}/checks?status=failure`)
      .set('Authorization', `Bearer ${m.token}`);
    expect(failuresOnly.body.pagination.total).toBe(2);
    for (const r of failuresOnly.body.data) {
      expect(r.status).toBe('failure');
    }
  });

  test("cross-org read is blocked (404, no existence leak)", async () => {
    if (!available) return;
    const alice = await setupMonitor(createdEmails);
    const bob = await setupMonitor(createdEmails);

    // Bob tries to read Alice's monitor summary via Alice's URL.
    const cross = await request(app)
      .get(`${base(alice.orgPublicId, alice.projectPublicId, alice.monitorPublicId)}/summary?window=24h`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(cross.status).toBe(404);

    // Bob tries via his own org URL with Alice's monitor id.
    const cross2 = await request(app)
      .get(`${base(bob.orgPublicId, bob.projectPublicId, alice.monitorPublicId)}/checks`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(cross2.status).toBe(404);
  });
});
