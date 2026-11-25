'use strict';

const request = require('supertest');
const { createApp } = require('../apps/api/src/app');

describe('Health endpoints', () => {
  const app = createApp();

  test('GET /api/v1/health/live returns 200 ok', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('GET /api/v1/health/ready reports uptime and a database check', async () => {
    const res = await request(app).get('/api/v1/health/ready');
    // 200 when the database is reachable, 503 when it is not. Both are valid
    // responses; the smoke test does not require a running database.
    expect([200, 503]).toContain(res.status);
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(res.body.checks).toHaveProperty('database');
    expect(['ok', 'unavailable']).toContain(res.body.checks.database);
  });

  // Pool is closed once globally in tests/teardown.js.

  test('sets an X-Request-Id response header', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  test('echoes an incoming X-Request-Id', async () => {
    const res = await request(app)
      .get('/api/v1/health/live')
      .set('X-Request-Id', 'test-correlation-123');
    expect(res.headers['x-request-id']).toBe('test-correlation-123');
  });
});

describe('OpenAPI spec', () => {
  const app = createApp();
  test('GET /api/v1/openapi.yaml serves an OpenAPI 3 document', async () => {
    const res = await request(app).get('/api/v1/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
    expect(res.text).toMatch(/^openapi:\s*3\./m);
    expect(res.text).toContain('title: PulseGuard API');
  });
});

describe('Not found handling', () => {
  const app = createApp();

  test('unknown route returns a 404 JSON error with requestId', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.error.message).toContain('/api/v1/does-not-exist');
  });
});
