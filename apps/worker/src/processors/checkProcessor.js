'use strict';

const { db } = require('../../../api/src/db');
const logger = require('../../../api/src/utils/logger');
const { runCheck } = require('../services/httpChecker');
const { persistResult } = require('../services/resultStore');
const { evaluateAfterCheck } = require('../../../api/src/modules/incidents/incidents.service');

/**
 * Processes a single monitor-check job. Loads the monitor, runs the SSRF-safe
 * checker, and persists the result idempotently.
 *
 * Job data: { monitorId, organizationId, checkId }
 * @param {import('bullmq').Job} job
 */
async function processCheckJob(job) {
  const { monitorId, organizationId, checkId } = job.data;

  const [rows] = await db.query(
    `SELECT id, organization_id, target_url, method, timeout_ms,
            expected_status_min, expected_status_max, request_headers, status
     FROM monitors WHERE id = ?`,
    [monitorId]
  );
  const monitor = rows[0];

  // Monitor may have been deleted or paused between enqueue and processing.
  if (!monitor) {
    logger.warn('Check job for missing monitor; skipping', { monitorId, checkId });
    return { skipped: 'monitor_not_found' };
  }
  if (monitor.status !== 'active') {
    logger.debug('Check job for non-active monitor; skipping', { monitorId, status: monitor.status });
    return { skipped: 'monitor_not_active' };
  }

  const result = await runCheck({
    url: monitor.target_url,
    method: monitor.method,
    timeoutMs: monitor.timeout_ms,
    expectedStatusMin: monitor.expected_status_min,
    expectedStatusMax: monitor.expected_status_max,
    requestHeaders: monitor.request_headers || undefined,
  });

  const { inserted } = await persistResult({
    organizationId: organizationId ?? monitor.organization_id,
    monitorId: monitor.id,
    checkId,
    result,
  });

  // Only evaluate incidents when a new result was persisted (a duplicate retry
  // must not double-count toward the failure/recovery thresholds).
  if (inserted) {
    try {
      await evaluateAfterCheck({
        monitorId: monitor.id,
        organizationId: organizationId ?? monitor.organization_id,
      });
    } catch (error) {
      // Never let incident evaluation failure block the check pipeline.
      logger.error('Incident evaluation failed', {
        monitorId: monitor.id,
        checkId,
        message: error.message,
      });
    }
  }

  logger.info('Check completed', {
    monitorId: monitor.id,
    checkId,
    status: result.status,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
  });

  return result;
}

module.exports = { processCheckJob };
