'use strict';

const { db } = require('../apps/api/src/db');
const { generatePublicId } = require('../apps/api/src/utils/ids');
const { claimAndEnqueueDue } = require('../apps/api/src/modules/scheduler/scheduler.service');

async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

async function insertOrgAndProject() {
  const orgPub = generatePublicId();
  const [org] = await db.query(
    "INSERT INTO organizations (public_id, name, slug, status) VALUES (?, ?, ?, 'active')",
    [orgPub, 'Sched Test', orgPub.toLowerCase()]
  );
  const [proj] = await db.query(
    "INSERT INTO projects (public_id, organization_id, name, environment, status) VALUES (?, ?, ?, 'dev', 'active')",
    [generatePublicId(), org.insertId, 'Sched']
  );
  return { orgId: org.insertId, projectId: proj.insertId };
}

/**
 * Inserts a monitor with a specific status and next_run_at offset (seconds
 * relative to now; negative = due in the past).
 */
async function insertMonitor({ orgId, projectId, status = 'active', nextOffsetSeconds = -1, intervalSeconds = 60 }) {
  const publicId = generatePublicId();
  const [result] = await db.query(
    `INSERT INTO monitors
       (public_id, organization_id, project_id, name, target_url, method,
        interval_seconds, timeout_ms, expected_status_min, expected_status_max, status, next_run_at)
     VALUES (?, ?, ?, ?, 'https://example.com', 'GET', ?, 5000, 200, 299, ?,
             ${nextOffsetSeconds === null ? 'NULL' : `DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${nextOffsetSeconds} SECOND)`})`,
    [publicId, orgId, projectId, publicId, intervalSeconds, status]
  );
  return result.insertId;
}

describe('Scheduler service', () => {
  let available = false;
  const orgsCreated = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping scheduler assertions: MySQL not reachable.');
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
    const { orgId, projectId } = await insertOrgAndProject();
    orgsCreated.push(orgId);
    return { orgId, projectId };
  }

  test('claims only active monitors whose next_run_at is due', async () => {
    if (!available) return;
    const { orgId, projectId } = await setup();

    const dueActive = await insertMonitor({ orgId, projectId, status: 'active', nextOffsetSeconds: -10 });
    const futureActive = await insertMonitor({ orgId, projectId, status: 'active', nextOffsetSeconds: 300 });
    const paused = await insertMonitor({ orgId, projectId, status: 'paused', nextOffsetSeconds: -10 });
    const disabled = await insertMonitor({ orgId, projectId, status: 'disabled', nextOffsetSeconds: -10 });
    const nullNext = await insertMonitor({ orgId, projectId, status: 'active', nextOffsetSeconds: null });

    const result = await claimAndEnqueueDue(100);
    expect(result.claimed).toBe(1);

    // Verify next_run_at advanced only for the due active monitor.
    const [rows] = await db.query(
      'SELECT id, next_run_at, status FROM monitors WHERE id IN (?, ?, ?, ?, ?)',
      [dueActive, futureActive, paused, disabled, nullNext]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // Due active: next_run_at is now ~60s in the future (interval).
    expect(new Date(byId[dueActive].next_run_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Others untouched.
    expect(byId[nullNext].next_run_at).toBeNull();
    expect(byId[paused].status).toBe('paused');
  });

  test('advances next_run_at by each monitor\'s own interval', async () => {
    if (!available) return;
    const { orgId, projectId } = await setup();
    const fast = await insertMonitor({ orgId, projectId, nextOffsetSeconds: -1, intervalSeconds: 30 });
    const slow = await insertMonitor({ orgId, projectId, nextOffsetSeconds: -1, intervalSeconds: 600 });

    await claimAndEnqueueDue(100);

    const [rows] = await db.query('SELECT id, next_run_at FROM monitors WHERE id IN (?, ?)', [
      fast,
      slow,
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const now = Date.now();
    const fastMs = new Date(byId[fast].next_run_at).getTime() - now;
    const slowMs = new Date(byId[slow].next_run_at).getTime() - now;
    // Allow generous slack for test timing; the point is fast < slow.
    expect(fastMs).toBeGreaterThan(10_000);
    expect(fastMs).toBeLessThan(60_000);
    expect(slowMs).toBeGreaterThan(500_000);
  });

  test('a second immediate tick does not re-enqueue the same monitors', async () => {
    if (!available) return;
    const { orgId, projectId } = await setup();
    await insertMonitor({ orgId, projectId, nextOffsetSeconds: -1, intervalSeconds: 300 });
    await insertMonitor({ orgId, projectId, nextOffsetSeconds: -1, intervalSeconds: 300 });

    const first = await claimAndEnqueueDue(100);
    const second = await claimAndEnqueueDue(100);
    expect(first.claimed).toBe(2);
    // next_run_at was pushed to now+300s, so nothing is due now.
    expect(second.claimed).toBe(0);
  });

  test('respects the batch size', async () => {
    if (!available) return;
    const { orgId, projectId } = await setup();
    for (let i = 0; i < 5; i += 1) {
      await insertMonitor({ orgId, projectId, nextOffsetSeconds: -1 });
    }
    const result = await claimAndEnqueueDue(3);
    expect(result.claimed).toBe(3);
    // Remaining 2 are still due.
    const remaining = await claimAndEnqueueDue(10);
    expect(remaining.claimed).toBe(2);
  });
});
