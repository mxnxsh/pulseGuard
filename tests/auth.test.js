'use strict';

const request = require('supertest');
const { createApp } = require('../apps/api/src/app');
const { db } = require('../apps/api/src/db');

/**
 * These tests exercise the real auth flow against MySQL. When the database is
 * not reachable, they skip cleanly so `npm test` stays green without infra.
 */
async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

const app = createApp();

// Unique email per run to avoid collisions with prior runs / seed data.
const uniqueEmail = () => `test_${Date.now()}_${Math.floor(Math.random() * 1e6)}@pulseguard.test`;

const validPassword = 'Password123';

describe('Auth & user APIs', () => {
  let available = false;
  const createdEmails = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping auth integration assertions: MySQL not reachable.');
    }
  });

  afterAll(async () => {
    if (available && createdEmails.length > 0) {
      // Clean up test users (cascades to org membership, refresh tokens, and
      // the owned organization via ON DELETE CASCADE).
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
    // Pool is closed once globally in tests/teardown.js.
  });

  async function registerUser(overrides = {}) {
    const email = overrides.email || uniqueEmail();
    createdEmails.push(email);
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: validPassword, fullName: 'Test User', ...overrides });
    return { email, res };
  }

  test('register creates a user and returns tokens', async () => {
    if (!available) return;
    const { email, res } = await registerUser();
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  test('register rejects invalid input with 400 VALIDATION_ERROR', async () => {
    if (!available) return;
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short', fullName: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  test('register rejects a duplicate email', async () => {
    if (!available) return;
    const { email } = await registerUser();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: validPassword, fullName: 'Dupe' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test('login succeeds with correct credentials', async () => {
    if (!available) return;
    const { email } = await registerUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: validPassword });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  test('login fails with wrong password', async () => {
    if (!available) return;
    const { email } = await registerUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPassword123' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('login fails for unknown email', async () => {
    if (!available) return;
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: validPassword });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('GET /users/me requires authentication', async () => {
    if (!available) return;
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  test('GET /users/me returns the profile with a valid token', async () => {
    if (!available) return;
    const { email, res: reg } = await registerUser();
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${reg.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });

  test('GET /users/me rejects a malformed token', async () => {
    if (!available) return;
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer not.a.valid.jwt');
    expect(res.status).toBe(401);
  });

  test('refresh rotates the token and invalidates the old one (reuse detection)', async () => {
    if (!available) return;
    const { res: reg } = await registerUser();
    const original = reg.body.refreshToken;

    // First rotation succeeds.
    const first = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: original });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).toBeDefined();
    expect(first.body.refreshToken).not.toBe(original);

    // Reusing the original (now revoked) token is rejected.
    const reuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: original });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REVOKED');

    // The rotated token issued by the reused one should also be revoked (family compromise).
    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refreshToken });
    expect(rotated.status).toBe(401);
  });

  test('logout revokes the refresh token', async () => {
    if (!available) return;
    const { res: reg } = await registerUser();
    const token = reg.body.refreshToken;

    const out = await request(app).post('/api/v1/auth/logout').send({ refreshToken: token });
    expect(out.status).toBe(204);

    const after = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: token });
    expect(after.status).toBe(401);
  });

  test('refresh rejects an unknown token', async () => {
    if (!available) return;
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'totally-invalid-token' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});
