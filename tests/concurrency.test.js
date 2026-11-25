'use strict';

/**
 * Concurrency & idempotency guarantees under parallel job execution.
 *
 * Directly invokes processCheckJob many times in parallel with the SAME
 * check_id (simulating a duplicated/retried job), and against many parallel
 * distinct check_ids (simulating multiple workers), then verifies that:
 *   - Duplicate check_ids never insert a second monitor_check_results row
 *     (idempotent persistence).
 *   - Parallel failing checks open at most ONE open incident for the monitor
 *     (SELECT ... FOR UPDATE on the monitor row plus the UNIQUE (org,
 *     dedupe_key, status) constraint prevent races).
 */

const http = require('http');
const { db } = require('../apps/api/src/db');
const { generatePublicId } = require('../apps/api/src/utils/ids');
const { processCheckJob } = require('../apps/worker/src/processors/checkProcessor');

async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

function startFailingServer() {
  const server = http.createServer((_req, res) => res.writeHead(500).end('down'));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

async function setup(targetUrl) {
  const orgPub = generatePublicId();
  const [org] = await db.query(
    "INSERT INTO organizations (public_id, name, slug, status) VALUES (?, ?, ?, 'active')",
    [orgPub, 'Conc', orgPub.toLowerCase()]
  );
  const [proj] = await db.query(
    "INSERT INTO projects (public_id, organization_id, name, environment, status) VALUES (?, ?, 'C', 'p', 'active')",
    [generatePublicId(), org.insertId]
  );
  const [mon] = await db.query(
    `INSERT INTO monitors
       (public_id, organization_id, project_id, name, target_url, method,
        interval_seconds, timeout_ms, expected_status_min, expected_status_max, status)
     VALUES (?, ?, ?, 'M', ?, 'GET', 60, 3000, 200, 299, 'active')`,
    [generatePublicId(), org.insertId, proj.insertId, targetUrl]
  );
  return { orgId: org.insertId, projectId: proj.insertId, monitorId: mon.insertId };
}

describe('Check-processing concurrency & idempotency', () => {
  let available = false;
  let target;
  const orgsCreated = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping concurrency tests: MySQL not reachable.');
      return;
    }
    target = await startFailingServer();
  });

  afterAll(async () => {
    if (target) target.server.close();
    if (!available) return;
    for (const orgId of orgsCreated) {
      await db.query('DELETE FROM organizations WHERE id = ?', [orgId]);
    }
  });

  test('a duplicated job (same check_id) is idempotent: only one result row', async () => {
    if (!available) return;
    const ctx = await setup(target.url);
    orgsCreated.push(ctx.orgId);
    const checkId = generatePublicId();

    // Run the same job 5x in parallel. INSERT IGNORE on the unique check_id
    // must keep the result count at exactly 1.
    const jobs = Array.from({ length: 5 }, () =>
      processCheckJob({
        data: { monitorId: ctx.monitorId, organizationId: ctx.orgId, checkId },
      })
    );
    await Promise.all(jobs);

    const [rows] = await db.query(
      'SELECT COUNT(*) AS c FROM monitor_check_results WHERE check_id = ?',
      [checkId]
    );
    expect(rows[0].c).toBe(1);
  });

  test('parallel failing checks open exactly one incident (no duplicates)', async () => {
    if (!available) return;
    const ctx = await setup(target.url);
    orgsCreated.push(ctx.orgId);

    // Run 12 distinct parallel jobs. With the failure threshold of 3, after
    // enough failures accumulate an incident should open — and only one.
    const jobs = Array.from({ length: 12 }, () =>
      processCheckJob({
        data: {
          monitorId: ctx.monitorId,
          organizationId: ctx.orgId,
          checkId: generatePublicId(),
        },
      })
    );
    await Promise.all(jobs);

    const [openRows] = await db.query(
      "SELECT COUNT(*) AS c FROM incidents WHERE monitor_id = ? AND status = 'open'",
      [ctx.monitorId]
    );
    expect(openRows[0].c).toBe(1);

    const [totalRows] = await db.query(
      'SELECT COUNT(*) AS c FROM incidents WHERE monitor_id = ?',
      [ctx.monitorId]
    );
    // Only one incident total (open), never a duplicate.
    expect(totalRows[0].c).toBe(1);

    // Results count = 12 (each parallel run inserted its own row).
    const [resRows] = await db.query(
      'SELECT COUNT(*) AS c FROM monitor_check_results WHERE monitor_id = ?',
      [ctx.monitorId]
    );
    expect(resRows[0].c).toBe(12);
  });
});
