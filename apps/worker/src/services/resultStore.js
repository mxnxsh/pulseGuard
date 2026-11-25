'use strict';

const { db } = require('../../../api/src/db');
const logger = require('../../../api/src/utils/logger');

/**
 * Persists a single check result idempotently and updates the monitor's
 * last_run_at. The check_id column is UNIQUE, so a retried job that reuses the
 * same check_id will not create a duplicate row.
 *
 * @param {object} params
 * @param {number} params.organizationId
 * @param {number} params.monitorId
 * @param {string} params.checkId opaque id (also the BullMQ jobId)
 * @param {{ status: string, httpStatus: number|null, latencyMs: number|null, errorCode: string|null }} params.result
 * @param {string} [params.region]
 * @returns {Promise<{ inserted: boolean }>}
 */
async function persistResult({ organizationId, monitorId, checkId, result, region = 'default' }) {
  const [insert] = await db.query(
    `INSERT IGNORE INTO monitor_check_results
       (organization_id, monitor_id, check_id, region, status, http_status, latency_ms, error_code, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [
      organizationId,
      monitorId,
      checkId,
      region,
      result.status,
      result.httpStatus,
      result.latencyMs,
      result.errorCode,
    ]
  );

  const inserted = insert.affectedRows === 1;
  if (!inserted) {
    // Duplicate check_id (idempotent retry): do not double-update state.
    logger.debug('Duplicate check result ignored', { checkId });
    return { inserted: false };
  }

  await db.query('UPDATE monitors SET last_run_at = UTC_TIMESTAMP(3) WHERE id = ?', [monitorId]);
  return { inserted: true };
}

module.exports = { persistResult };
