'use strict';

const { db } = require('../../db');
const { env } = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { generatePublicId } = require('../../utils/ids');
const { paginated } = require('../../utils/pagination');
const { assertSafeUrl, SsrfError } = require('../../utils/ssrf');
const { requireProjectInOrg } = require('../projects/projects.service');
const { enqueueCheck } = require('../../queues/checkQueue');

function toPublicMonitor(row) {
  return {
    id: row.public_id,
    name: row.name,
    url: row.target_url,
    method: row.method,
    intervalSeconds: row.interval_seconds,
    timeoutMs: row.timeout_ms,
    expectedStatusMin: row.expected_status_min,
    expectedStatusMax: row.expected_status_max,
    status: row.status,
    requestHeaders: row.request_headers ?? null,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Validates a monitor target URL, translating SSRF failures into a 400.
 * @param {string} url
 */
async function validateTarget(url) {
  try {
    await assertSafeUrl(url);
  } catch (error) {
    if (error instanceof SsrfError) {
      throw ApiError.badRequest(`Unsafe monitor target: ${error.message}`, {
        code: 'UNSAFE_TARGET',
      });
    }
    throw error;
  }
}

/**
 * Loads a monitor by public_id constrained to org + project (the ownership
 * boundary). Throws 404 otherwise.
 */
async function requireMonitor(organizationId, projectId, monitorPublicId) {
  const [rows] = await db.query(
    `SELECT * FROM monitors
     WHERE public_id = ? AND organization_id = ? AND project_id = ?`,
    [monitorPublicId, organizationId, projectId]
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Monitor not found');
  }
  return rows[0];
}

async function list(organizationId, projectPublicId, pagination, filters = {}) {
  const project = await requireProjectInOrg(organizationId, projectPublicId);

  const where = ['organization_id = ?', 'project_id = ?'];
  const params = [organizationId, project.id];
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  const whereSql = where.join(' AND ');

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM monitors WHERE ${whereSql}`,
    params
  );
  const total = countRows[0].total;

  const [rows] = await db.query(
    `SELECT * FROM monitors WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pagination.limit, pagination.offset]
  );
  return paginated(rows.map(toPublicMonitor), pagination, total);
}

async function getById(organizationId, projectPublicId, monitorPublicId) {
  const project = await requireProjectInOrg(organizationId, projectPublicId);
  const row = await requireMonitor(organizationId, project.id, monitorPublicId);
  return toPublicMonitor(row);
}

async function create(organizationId, projectPublicId, input) {
  const project = await requireProjectInOrg(organizationId, projectPublicId);

  // Enforce per-project quota.
  const [countRows] = await db.query(
    'SELECT COUNT(*) AS total FROM monitors WHERE project_id = ?',
    [project.id]
  );
  if (countRows[0].total >= env.MONITOR_MAX_PER_PROJECT) {
    throw ApiError.badRequest(
      `Project monitor limit reached (${env.MONITOR_MAX_PER_PROJECT})`,
      { code: 'MONITOR_QUOTA_EXCEEDED' }
    );
  }

  await validateTarget(input.url);

  const publicId = generatePublicId();
  const [result] = await db.query(
    `INSERT INTO monitors
       (public_id, organization_id, project_id, name, target_url, method,
        interval_seconds, timeout_ms, expected_status_min, expected_status_max,
        request_headers, status, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', UTC_TIMESTAMP(3))`,
    [
      publicId,
      organizationId,
      project.id,
      input.name,
      input.url,
      input.method,
      input.intervalSeconds,
      input.timeoutMs,
      input.expectedStatusMin,
      input.expectedStatusMax,
      input.requestHeaders ? JSON.stringify(input.requestHeaders) : null,
    ]
  );
  logger.info('Monitor created', { organizationId, projectId: project.id, monitorId: result.insertId });
  return toPublicMonitor(await requireMonitor(organizationId, project.id, publicId));
}

async function update(organizationId, projectPublicId, monitorPublicId, input) {
  const project = await requireProjectInOrg(organizationId, projectPublicId);
  const monitor = await requireMonitor(organizationId, project.id, monitorPublicId);

  if (input.url !== undefined && input.url !== monitor.target_url) {
    await validateTarget(input.url);
  }

  // Cross-field guard when only one bound is supplied.
  const nextMin = input.expectedStatusMin ?? monitor.expected_status_min;
  const nextMax = input.expectedStatusMax ?? monitor.expected_status_max;
  if (nextMin > nextMax) {
    throw ApiError.badRequest('expectedStatusMin must be <= expectedStatusMax', {
      code: 'VALIDATION_ERROR',
    });
  }

  // If the interval changes on an active monitor, re-arm next_run_at so the
  // new cadence takes effect promptly instead of waiting for the old interval.
  const intervalChanged =
    input.intervalSeconds !== undefined && input.intervalSeconds !== monitor.interval_seconds;
  const reArmSql = intervalChanged && monitor.status === 'active'
    ? ', next_run_at = UTC_TIMESTAMP(3)'
    : '';

  await db.query(
    `UPDATE monitors SET
       name = COALESCE(?, name),
       target_url = COALESCE(?, target_url),
       method = COALESCE(?, method),
       interval_seconds = COALESCE(?, interval_seconds),
       timeout_ms = COALESCE(?, timeout_ms),
       expected_status_min = COALESCE(?, expected_status_min),
       expected_status_max = COALESCE(?, expected_status_max),
       request_headers = COALESCE(?, request_headers)
       ${reArmSql}
     WHERE id = ?`,
    [
      input.name ?? null,
      input.url ?? null,
      input.method ?? null,
      input.intervalSeconds ?? null,
      input.timeoutMs ?? null,
      input.expectedStatusMin ?? null,
      input.expectedStatusMax ?? null,
      input.requestHeaders !== undefined ? JSON.stringify(input.requestHeaders) : null,
      monitor.id,
    ]
  );
  return toPublicMonitor(await requireMonitor(organizationId, project.id, monitorPublicId));
}

/**
 * Sets monitor status. Used by pause (paused) and resume (active).
 * Resuming re-arms scheduling by setting next_run_at to now; pausing/disabling
 * clears next_run_at so the scheduler ignores it (it also filters on status).
 */
async function setStatus(organizationId, projectPublicId, monitorPublicId, status) {
  const project = await requireProjectInOrg(organizationId, projectPublicId);
  const monitor = await requireMonitor(organizationId, project.id, monitorPublicId);
  if (status === 'active') {
    await db.query(
      'UPDATE monitors SET status = ?, next_run_at = UTC_TIMESTAMP(3) WHERE id = ?',
      [status, monitor.id]
    );
  } else {
    await db.query('UPDATE monitors SET status = ?, next_run_at = NULL WHERE id = ?', [
      status,
      monitor.id,
    ]);
  }
  return toPublicMonitor(await requireMonitor(organizationId, project.id, monitorPublicId));
}

async function remove(organizationId, projectPublicId, monitorPublicId) {
  const project = await requireProjectInOrg(organizationId, projectPublicId);
  const monitor = await requireMonitor(organizationId, project.id, monitorPublicId);
  await db.query('DELETE FROM monitors WHERE id = ?', [monitor.id]);
  logger.info('Monitor deleted', { organizationId, projectId: project.id, monitorId: monitor.id });
}

/**
 * Enqueues an on-demand check for a monitor. Ownership is enforced. Returns the
 * generated check id and whether it was actually enqueued (queue may be off).
 */
async function runNow(organizationId, projectPublicId, monitorPublicId) {
  const project = await requireProjectInOrg(organizationId, projectPublicId);
  const monitor = await requireMonitor(organizationId, project.id, monitorPublicId);
  const { checkId, enqueued } = await enqueueCheck({
    monitorId: monitor.id,
    organizationId,
  });
  return { checkId, enqueued };
}

/**
 * Resolves a monitor by its public id, constrained to (orgId, projectPublicId).
 * Enforces the same ownership boundary used elsewhere and returns the raw row
 * so callers (metrics, incidents, etc.) can rely on a single source of truth.
 * @returns {Promise<object>} raw monitor row
 */
async function resolveMonitor(organizationId, projectPublicId, monitorPublicId) {
  const project = await requireProjectInOrg(organizationId, projectPublicId);
  return requireMonitor(organizationId, project.id, monitorPublicId);
}

module.exports = { list, getById, create, update, setStatus, remove, runNow, resolveMonitor };
