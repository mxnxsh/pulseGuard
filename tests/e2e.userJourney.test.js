'use strict';

/**
 * End-to-end user journey.
 *
 * Exercises the full backend pipeline in one test, bypassing only BullMQ (calls
 * the processor directly since Redis is not required for the flow-level
 * assertion). Every other component is real: registration -> org -> project ->
 * monitor -> checker -> results persistence -> incident detection ->
 * notification enqueue -> dispatcher -> mock provider delivery.
 */

const http = require('http');
const request = require('supertest');
const { createApp } = require('../apps/api/src/app');
const { db } = require('../apps/api/src/db');
const { generatePublicId } = require('../apps/api/src/utils/ids');
const { processCheckJob } = require('../apps/worker/src/processors/checkProcessor');
const { dispatcherTick } = require('../apps/api/src/modules/notifications/notifications.service');
const providerModule = require('../apps/api/src/modules/notifications/emailProvider');

async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

function startTargetServer() {
  // Handler is mutable so a single test can flip the target from 500 to 200.
  const state = { handler: (_req, res) => res.writeHead(500).end('down') };
  const server = http.createServer((req, res) => state.handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}/`,
        setHandler(h) {
          state.handler = h;
        },
      });
    });
  });
}

async function fakeJob(monitorInternalId, organizationInternalId) {
  return processCheckJob({
    data: {
      monitorId: monitorInternalId,
      organizationId: organizationInternalId,
      checkId: generatePublicId(),
    },
  });
}

const app = createApp();
const uniqueEmail = () => `e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}@pulseguard.test`;
const PASSWORD = 'Password123';

describe('End-to-end user journey', () => {
  let available = false;
  let target;
  const cleanupEmails = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping E2E: MySQL not reachable.');
      return;
    }
    target = await startTargetServer();
  });

  afterAll(async () => {
    if (target) target.server.close();
    providerModule.setProvider(null);
    if (!available) return;
    for (const email of cleanupEmails) {
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
  });

  test('register -> monitor -> outage -> recovery -> notifications delivered', async () => {
    if (!available) return;

    // 1. Register a user (auto-creates their org + owner membership).
    const email = uniqueEmail();
    cleanupEmails.push(email);
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, fullName: 'E2E User' });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken;

    // 2. Resolve the auto-created org so we can nest resources under it.
    const orgs = await request(app)
      .get('/api/v1/organizations')
      .set('Authorization', `Bearer ${token}`);
    const orgPublicId = orgs.body.data[0].id;
    const [orgRow] = await db.query('SELECT id FROM organizations WHERE public_id = ?', [
      orgPublicId,
    ]);

    // 3. Create a project.
    const proj = await request(app)
      .post(`/api/v1/organizations/${orgPublicId}/projects`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E', environment: 'prod' });
    expect(proj.status).toBe(201);
    const projectPublicId = proj.body.project.id;

    // 4. Create a monitor pointing at our local server.
    const mon = await request(app)
      .post(`/api/v1/organizations/${orgPublicId}/projects/${projectPublicId}/monitors`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'API health',
        url: target.url,
        intervalSeconds: 60,
        timeoutMs: 3000,
        expectedStatusMin: 200,
        expectedStatusMax: 299,
      });
    expect(mon.status).toBe(201);
    const monitorPublicId = mon.body.monitor.id;
    const [monRow] = await db.query('SELECT id FROM monitors WHERE public_id = ?', [
      monitorPublicId,
    ]);
    const monitorInternalId = monRow[0].id;

    // 5. Set up a notification channel and swap in the mock provider.
    const chan = await request(app)
      .post(`/api/v1/organizations/${orgPublicId}/notification-channels`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ops', config: { to: 'oncall@example.com' } });
    expect(chan.status).toBe(201);

    const deliveries = [];
    providerModule.setProvider({
      name: 'mock',
      async send(payload) {
        deliveries.push(payload);
        return { ok: true, providerResponse: 'mock' };
      },
    });

    // 6. Run three checks against the failing target. After the 3rd, an
    //    incident must open and a notification must be enqueued.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fakeJob(monitorInternalId, orgRow[0].id);
      expect(res.status).toBe('failure');
    }

    let incidentsRes = await request(app)
      .get(`/api/v1/organizations/${orgPublicId}/incidents?status=open`)
      .set('Authorization', `Bearer ${token}`);
    expect(incidentsRes.status).toBe(200);
    expect(incidentsRes.body.data.length).toBe(1);
    expect(incidentsRes.body.data[0].monitorId).toBe(monitorPublicId);

    // 7. Dispatch pending notifications -> mock provider receives an "opened" email.
    await dispatcherTick();
    const openedMail = deliveries.find((d) => d.subject.includes('Incident opened'));
    expect(openedMail).toBeDefined();
    expect(openedMail.to).toBe('oncall@example.com');

    // 8. Flip target to healthy and run two successful checks to trigger resolution.
    target.setHandler((_req, res) => res.writeHead(200).end('ok'));
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fakeJob(monitorInternalId, orgRow[0].id);
      expect(res.status).toBe('success');
    }

    // Incident is now resolved and a second notification is enqueued+sent.
    incidentsRes = await request(app)
      .get(`/api/v1/organizations/${orgPublicId}/incidents?status=open`)
      .set('Authorization', `Bearer ${token}`);
    expect(incidentsRes.body.data.length).toBe(0);

    await dispatcherTick();
    const resolvedMail = deliveries.find((d) => d.subject.includes('Incident resolved'));
    expect(resolvedMail).toBeDefined();

    // 9. Summary endpoint reflects the mixed results (3 failures + 2 successes).
    const summary = await request(app)
      .get(
        `/api/v1/organizations/${orgPublicId}/projects/${projectPublicId}/monitors/${monitorPublicId}/summary?window=1h`
      )
      .set('Authorization', `Bearer ${token}`);
    expect(summary.status).toBe(200);
    expect(summary.body.totalChecks).toBe(5);
    expect(summary.body.counts.success).toBe(2);
    expect(summary.body.counts.failure).toBe(3);
    // 2/5 = 40.00 %
    expect(summary.body.uptimePercent).toBe(40);
    expect(summary.body.latencyMs.avg).toBeGreaterThanOrEqual(0);
  });
});
