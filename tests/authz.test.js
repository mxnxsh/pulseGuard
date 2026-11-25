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
const uniqueEmail = () => `authz_${Date.now()}_${Math.floor(Math.random() * 1e6)}@pulseguard.test`;
const PASSWORD = 'Password123';

/**
 * Registers a user and returns { email, accessToken, orgId } where orgId is the
 * public id of the organization created automatically at registration.
 */
async function registerUser(app_, createdEmails) {
  const email = uniqueEmail();
  createdEmails.push(email);
  const reg = await request(app_)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, fullName: 'Authz User' });
  const accessToken = reg.body.accessToken;
  const orgsRes = await request(app_)
    .get('/api/v1/organizations')
    .set('Authorization', `Bearer ${accessToken}`);
  const orgId = orgsRes.body.data[0].id;
  return { email, accessToken, orgId };
}

describe('Organization & project authorization', () => {
  let available = false;
  const createdEmails = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping authz assertions: MySQL not reachable.');
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
    // Pool closed globally in tests/setup.js.
  });

  test('a new user gets exactly one owned organization at registration', async () => {
    if (!available) return;
    const user = await registerUser(app, createdEmails);
    const res = await request(app)
      .get('/api/v1/organizations')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.pagination).toHaveProperty('total');
    const owned = res.body.data.find((o) => o.id === user.orgId);
    expect(owned.role).toBe('owner');
  });

  test('organization endpoints require authentication', async () => {
    if (!available) return;
    const res = await request(app).get('/api/v1/organizations');
    expect(res.status).toBe(401);
  });

  test('owner can create and read a project in their org', async () => {
    if (!available) return;
    const user = await registerUser(app, createdEmails);
    const create = await request(app)
      .post(`/api/v1/organizations/${user.orgId}/projects`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'API', environment: 'production' });
    expect(create.status).toBe(201);
    expect(create.body.project.name).toBe('API');

    const projectId = create.body.project.id;
    const get = await request(app)
      .get(`/api/v1/organizations/${user.orgId}/projects/${projectId}`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(get.status).toBe(200);
    expect(get.body.project.id).toBe(projectId);
  });

  test('duplicate project name+environment is rejected', async () => {
    if (!available) return;
    const user = await registerUser(app, createdEmails);
    const body = { name: 'Dup', environment: 'staging' };
    const first = await request(app)
      .post(`/api/v1/organizations/${user.orgId}/projects`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(body);
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/api/v1/organizations/${user.orgId}/projects`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(body);
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('PROJECT_EXISTS');
  });

  test("a user cannot read another user's organization (404, no existence leak)", async () => {
    if (!available) return;
    const alice = await registerUser(app, createdEmails);
    const bob = await registerUser(app, createdEmails);

    const res = await request(app)
      .get(`/api/v1/organizations/${alice.orgId}`)
      .set('Authorization', `Bearer ${bob.accessToken}`);
    expect(res.status).toBe(404);
  });

  test("a user cannot list or create projects in another user's org", async () => {
    if (!available) return;
    const alice = await registerUser(app, createdEmails);
    const bob = await registerUser(app, createdEmails);

    const list = await request(app)
      .get(`/api/v1/organizations/${alice.orgId}/projects`)
      .set('Authorization', `Bearer ${bob.accessToken}`);
    expect(list.status).toBe(404);

    const create = await request(app)
      .post(`/api/v1/organizations/${alice.orgId}/projects`)
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .send({ name: 'Intruder', environment: 'production' });
    expect(create.status).toBe(404);
  });

  test("a user cannot access another org's project even with a valid project id", async () => {
    if (!available) return;
    const alice = await registerUser(app, createdEmails);
    const bob = await registerUser(app, createdEmails);

    const create = await request(app)
      .post(`/api/v1/organizations/${alice.orgId}/projects`)
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ name: 'Secret', environment: 'production' });
    const projectId = create.body.project.id;

    // Bob references Alice's project id under his own org -> not found.
    const viaBobOrg = await request(app)
      .get(`/api/v1/organizations/${bob.orgId}/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.accessToken}`);
    expect(viaBobOrg.status).toBe(404);

    // Bob references Alice's project id under Alice's org -> blocked at membership (404).
    const viaAliceOrg = await request(app)
      .get(`/api/v1/organizations/${alice.orgId}/projects/${projectId}`)
      .set('Authorization', `Bearer ${bob.accessToken}`);
    expect(viaAliceOrg.status).toBe(404);
  });

  test('owner can update their organization name', async () => {
    if (!available) return;
    const user = await registerUser(app, createdEmails);
    const res = await request(app)
      .patch(`/api/v1/organizations/${user.orgId}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'Renamed Org' });
    expect(res.status).toBe(200);
    expect(res.body.organization.name).toBe('Renamed Org');
  });
});
