'use strict';

const { db } = require('../../db');
const { paginated } = require('../../utils/pagination');
const { resolveMonitor } = require('../monitors/monitors.service');

/**
 * Supported time windows. Each maps to a MySQL interval clause; keeping this a
 * closed set (rather than free-form) means the value can be safely inlined into
 * SQL without user input and lets the response document the exact semantics.
 */
const WINDOWS = {
  '1h': { intervalSql: 'INTERVAL 1 HOUR', label: '1h' },
  '24h': { intervalSql: 'INTERVAL 24 HOUR', label: '24h' },
  '7d': { intervalSql: 'INTERVAL 7 DAY', label: '7d' },
  '30d': { intervalSql: 'INTERVAL 30 DAY', label: '30d' },
};

function shapeResult(row) {
  return {
    id: row.check_id,
    status: row.status,
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    errorCode: row.error_code,
    checkedAt: row.checked_at,
  };
}

/**
 * Paginated list of a monitor's check history. Ownership is enforced by
 * resolving the monitor within (orgId, projectPublicId) first.
 * @param {number} organizationId
 * @param {string} projectPublicId
 * @param {string} monitorPublicId
 * @param {{ page:number, pageSize:number, limit:number, offset:number }} pagination
 * @param {{ status?: string }} filters
 */
async function getHistory(organizationId, projectPublicId, monitorPublicId, pagination, filters = {}) {
  const monitor = await resolveMonitor(organizationId, projectPublicId, monitorPublicId);

  const where = ['monitor_id = ?'];
  const params = [monitor.id];
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  const whereSql = where.join(' AND ');

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM monitor_check_results WHERE ${whereSql}`,
    params
  );
  const total = countRows[0].total;

  const [rows] = await db.query(
    `SELECT check_id, status, http_status, latency_ms, error_code, checked_at
     FROM monitor_check_results
     WHERE ${whereSql}
     ORDER BY checked_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, pagination.limit, pagination.offset]
  );
  return paginated(rows.map(shapeResult), pagination, total);
}

/**
 * Uptime + latency summary over a fixed window.
 *
 * Semantics:
 *   - `window` selects a rolling window ending at now (UTC): the query is
 *     `checked_at >= UTC_TIMESTAMP(3) - INTERVAL X`.
 *   - `totalChecks` counts every persisted result in the window regardless of
 *     status.
 *   - `successCount` counts rows with status='success'.
 *   - `uptimePercent` = successCount / totalChecks * 100, rounded to 2dp.
 *     Reported as `null` when there is no data (never a misleading 0 or 100).
 *   - Latency stats (min/avg/max, ms) are computed over successful checks only,
 *     so a timeout row's null latency does not skew averages. Reported as `null`
 *     when no successful checks fell in the window.
 *   - Counts by status are returned to help clients render breakdowns without
 *     issuing extra queries.
 *
 * P50/P95 latency is intentionally deferred (see docs/FUTURE_SUGGESTIONS.md):
 * MySQL 8 has no built-in percentile aggregate, and app-side percentiles would
 * require loading unbounded rows.
 *
 * @param {number} organizationId
 * @param {string} projectPublicId
 * @param {string} monitorPublicId
 * @param {'1h'|'24h'|'7d'|'30d'} windowKey
 */
async function getSummary(organizationId, projectPublicId, monitorPublicId, windowKey) {
  const monitor = await resolveMonitor(organizationId, projectPublicId, monitorPublicId);
  const window = WINDOWS[windowKey];
  // WINDOWS is a closed enum validated upstream; safe to inline.
  const intervalSql = window.intervalSql;

  const [aggRows] = await db.query(
    `SELECT
       COUNT(*) AS total_checks,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failure_count,
       SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeout_count,
       SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
       MIN(CASE WHEN status = 'success' THEN latency_ms END) AS min_latency,
       AVG(CASE WHEN status = 'success' THEN latency_ms END) AS avg_latency,
       MAX(CASE WHEN status = 'success' THEN latency_ms END) AS max_latency
     FROM monitor_check_results
     WHERE monitor_id = ?
       AND checked_at >= UTC_TIMESTAMP(3) - ${intervalSql}`,
    [monitor.id]
  );

  const agg = aggRows[0];
  const total = Number(agg.total_checks) || 0;
  const success = Number(agg.success_count) || 0;
  const failure = Number(agg.failure_count) || 0;
  const timeoutCount = Number(agg.timeout_count) || 0;
  const blocked = Number(agg.blocked_count) || 0;

  const uptimePercent = total === 0 ? null : Math.round((success / total) * 10_000) / 100;

  return {
    monitorId: monitor.public_id,
    window: window.label,
    totalChecks: total,
    counts: {
      success,
      failure,
      timeout: timeoutCount,
      blocked,
    },
    uptimePercent,
    latencyMs:
      success === 0
        ? { min: null, avg: null, max: null }
        : {
            min: agg.min_latency === null ? null : Number(agg.min_latency),
            avg: agg.avg_latency === null ? null : Math.round(Number(agg.avg_latency)),
            max: agg.max_latency === null ? null : Number(agg.max_latency),
          },
  };
}

module.exports = { getHistory, getSummary, WINDOWS };
