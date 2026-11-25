'use strict';

const request = require('supertest');
const { createApp } = require('../apps/api/src/app');
const { db } = require('../apps/api/src/db');

async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

const app = createApp();
const uniqueEmail = () => `mon_${Date.now()}_${Math.floor(Math.random() * 1e6)}@pulseguard.test`;
const PASSWORD = 'Password123';

async function setupUserWithProject(createdEmails) {
  const email = uniqueEmail();
  createdEmails.push(email);
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, fullName: 'Monitor User' });
  const token = reg.body.accessToken;
  const orgs = await request(app)
    .get('/api/v1/organizations')
    .set('Authorization', `Bearer ${token}`);
  const orgId = orgs.body.data[0].id;
  const proj = await request(app)
    .post(`/api/v1/organizations/${orgId}/projects`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Monitors', environment: 'production' });
  return { token, orgId, projectId: proj.body.project.id };
}

function authGet(url, token) {
  return request(app).get(url).set('Authorization', `Bearer ${token}`);
}
function authPost(url, token, body) {
  return request(app).post(url).set('Authorization', `Bearer ${token}`).send(body);
}

describe('Monitor management APIs', () => {
  let available = false;
  const createdEmails = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping monitor assertions: MySQL not reachable.');
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

  const base = (orgId, projectId) =>
    `/api/v1/organizations/${orgId}/projects/${projectId}/monitors`;

  test('full CRUD lifecycle', async () => {
    if (!available) return;
    const { token, orgId, projectId } = await setupUserWithProject(createdEmails);
    const url = base(orgId, projectId);

    // Create
    const create = await authPost(url, token, {
      name: 'Homepage',
      url: 'https://example.com/health',
      intervalSeconds: 60,
      timeoutMs: 5000,
    });
    expect(create.status).toBe(201);
    expect(create.body.monitor.status).toBe('active');
    const monitorId = create.body.monitor.id;

    // Read one
    const get = await authGet(`${url}/${monitorId}`, token);
    expect(get.status).toBe(200);
    expect(get.body.monitor.url).toBe('https://example.com/health');

    // List
    const list = await authGet(url, token);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(1);
    expect(list.body.pagination.total).toBe(1);

    // Update
    const upd = await request(app)
      .patch(`${url}/${monitorId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Homepage v2', intervalSeconds: 120 });
    expect(upd.status).toBe(200);
    expect(upd.body.monitor.name).toBe('Homepage v2');
    expect(upd.body.monitor.intervalSeconds).toBe(120);

    // Pause / resume
    const paused = await authPost(`${url}/${monitorId}/pause`, token);
    expect(paused.body.monitor.status).toBe('paused');
    const resumed = await authPost(`${url}/${monitorId}/resume`, token);
    expect(resumed.body.monitor.status).toBe('active');

    // Delete
    const del = await request(app)
      .delete(`${url}/${monitorId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
    const gone = await authGet(`${url}/${monitorId}`, token);
    expect(gone.status).toBe(404);
  });

  test('rejects an unsafe target scheme', async () => {
    if (!available) return;
    const { token, orgId, projectId } = await setupUserWithProject(createdEmails);
    // Passes Zod URL check but fails SSRF scheme allowlist in the service.
    const res = await authPost(base(orgId, projectId), token, {
      name: 'Bad',
      url: 'ftp://example.com/resource',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSAFE_TARGET');
  });

  test('rejects invalid interval and timeout', async () => {
    if (!available) return;
    const { token, orgId, projectId } = await setupUserWithProject(createdEmails);
    const tooShort = await authPost(base(orgId, projectId), token, {
      name: 'X',
      url: 'https://example.com',
      intervalSeconds: 1,
    });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error.code).toBe('VALIDATION_ERROR');

    const tooLongTimeout = await authPost(base(orgId, projectId), token, {
      name: 'X',
      url: 'https://example.com',
      timeoutMs: 10_000_000,
    });
    expect(tooLongTimeout.status).toBe(400);
  });

  test('create sets next_run_at, pause clears it, resume re-arms it', async () => {
    if (!available) return;
    const { token, orgId, projectId } = await setupUserWithProject(createdEmails);
    const create = await authPost(base(orgId, projectId), token, {
      name: 'Sched',
      url: 'https://example.com',
    });
    const monitorId = create.body.monitor.id;

    // Read internal state directly from the DB to verify next_run_at handling.
    async function nextRunAt() {
      const [rows] = await db.query('SELECT next_run_at, status FROM monitors WHERE public_id = ?', [
        monitorId,
      ]);
      return rows[0];
    }

    let row = await nextRunAt();
    expect(row.status).toBe('active');
    expect(row.next_run_at).not.toBeNull();

    await authPost(`${base(orgId, projectId)}/${monitorId}/pause`, token);
    row = await nextRunAt();
    expect(row.status).toBe('paused');
    expect(row.next_run_at).toBeNull();

    await authPost(`${base(orgId, projectId)}/${monitorId}/resume`, token);
    row = await nextRunAt();
    expect(row.status).toBe('active');
    expect(row.next_run_at).not.toBeNull();
  });

  test("cannot create or read monitors in another org's project", async () => {
    if (!available) return;
    const alice = await setupUserWithProject(createdEmails);
    const bob = await setupUserWithProject(createdEmails);

    // Bob tries to create under Alice's org/project.
    const create = await authPost(base(alice.orgId, alice.projectId), bob.token, {
      name: 'Intruder',
      url: 'https://example.com',
    });
    expect(create.status).toBe(404);

    // Alice creates a monitor; Bob tries to read it via Alice's path.
    const made = await authPost(base(alice.orgId, alice.projectId), alice.token, {
      name: 'Private',
      url: 'https://example.com',
    });
    const read = await authGet(
      `${base(alice.orgId, alice.projectId)}/${made.body.monitor.id}`,
      bob.token
    );
    expect(read.status).toBe(404);
  });
});
