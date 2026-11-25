'use strict';

const { withTransaction } = require('../../db');
const { env } = require('../../config/env');
const logger = require('../../utils/logger');
const { enqueueCheck } = require('../../queues/checkQueue');

/**
 * Atomically claims up to `limit` monitors that are due (active + next_run_at
 * is in the past). For each claimed monitor, next_run_at is advanced by
 * interval_seconds, then a check job is enqueued.
 *
 * Uses SELECT ... FOR UPDATE SKIP LOCKED so multiple scheduler instances can
 * safely run in parallel: each row is claimed by exactly one scheduler per
 * tick. If SKIP LOCKED is unsupported by the MySQL version, the transaction
 * still serializes correctly (locks would wait rather than skip).
 *
 * Returns the list of claimed monitor ids for observability.
 * @param {number} limit
 * @returns {Promise<{ claimed: number, checkIds: string[] }>}
 */
async function claimAndEnqueueDue(limit = env.SCHEDULER_BATCH_SIZE) {
  const claimed = await withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT id, organization_id, interval_seconds
       FROM monitors
       WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= UTC_TIMESTAMP(3)
       ORDER BY next_run_at
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    if (rows.length === 0) return [];

    // Advance next_run_at in one bulk update so this transaction is short.
    const ids = rows.map((r) => r.id);
    // Build a CASE statement to advance by each row's own interval_seconds.
    const cases = rows
      .map((r) => `WHEN ${r.id} THEN DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${r.interval_seconds} SECOND)`)
      .join(' ');
    const placeholders = ids.map(() => '?').join(',');
    await conn.query(
      `UPDATE monitors
       SET next_run_at = CASE id ${cases} END
       WHERE id IN (${placeholders})`,
      ids
    );

    return rows;
  });

  // Enqueue outside the transaction so a slow queue doesn't hold row locks.
  const checkIds = [];
  for (const monitor of claimed) {
    const { checkId, enqueued } = await enqueueCheck({
      monitorId: monitor.id,
      organizationId: monitor.organization_id,
    });
    if (enqueued) checkIds.push(checkId);
  }

  if (claimed.length > 0) {
    logger.info('Scheduler tick', { claimed: claimed.length, enqueued: checkIds.length });
  }
  return { claimed: claimed.length, checkIds };
}

module.exports = { claimAndEnqueueDue };
