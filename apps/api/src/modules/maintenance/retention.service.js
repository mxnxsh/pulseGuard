'use strict';

const { db } = require('../../db');
const { env } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Retention pruning.
 *
 * Deletes rows older than the configured retention windows. Batches large
 * deletes to keep the transaction/replication footprint small; a single call
 * caps at BATCH_SIZE * MAX_BATCHES rows per table.
 *
 * Intended to be run periodically via `npm run maintenance:prune` (a cron job
 * or scheduled task in production). Idempotent and safe to run concurrently
 * on a single row set — each DELETE takes brief row locks only.
 */

const BATCH_SIZE = 5_000;
const MAX_BATCHES = 100;

async function deleteInBatches(sql, params) {
  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [result] = await db.query(`${sql} LIMIT ${BATCH_SIZE}`, params);
    totalDeleted += result.affectedRows;
    if (result.affectedRows < BATCH_SIZE) break;
  }
  return totalDeleted;
}

/** Delete check results older than CHECK_RESULT_RETENTION_DAYS. */
async function pruneOldCheckResults() {
  const days = env.CHECK_RESULT_RETENTION_DAYS;
  const deleted = await deleteInBatches(
    `DELETE FROM monitor_check_results
     WHERE checked_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)`,
    [days]
  );
  logger.info('Pruned old monitor_check_results', { days, deleted });
  return deleted;
}

/**
 * Delete refresh tokens that are already expired OR were revoked more than
 * REFRESH_TOKEN_RETENTION_DAYS ago. Active tokens are always preserved.
 */
async function pruneRefreshTokens() {
  const days = env.REFRESH_TOKEN_RETENTION_DAYS;
  const deleted = await deleteInBatches(
    `DELETE FROM refresh_tokens
     WHERE expires_at < UTC_TIMESTAMP(3)
        OR (revoked_at IS NOT NULL
            AND revoked_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))`,
    [days]
  );
  logger.info('Pruned refresh_tokens', { days, deleted });
  return deleted;
}

/**
 * Delete completed notification deliveries older than the retention window
 * (sent + failed rows only; 'queued' and 'sending' are never touched).
 */
async function pruneNotificationDeliveries() {
  const days = env.NOTIFICATION_DELIVERY_RETENTION_DAYS;
  const deleted = await deleteInBatches(
    `DELETE FROM notification_deliveries
     WHERE status IN ('sent', 'failed', 'cancelled')
       AND created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)`,
    [days]
  );
  logger.info('Pruned notification_deliveries', { days, deleted });
  return deleted;
}

async function pruneAll() {
  const checks = await pruneOldCheckResults();
  const tokens = await pruneRefreshTokens();
  const notifications = await pruneNotificationDeliveries();
  return { checks, tokens, notifications };
}

module.exports = {
  pruneOldCheckResults,
  pruneRefreshTokens,
  pruneNotificationDeliveries,
  pruneAll,
};
