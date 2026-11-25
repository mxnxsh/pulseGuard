'use strict';

const { db, withTransaction } = require('../../db');
const { env } = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { generatePublicId } = require('../../utils/ids');
const { paginated } = require('../../utils/pagination');
const { enqueueForIncident } = require('../notifications/notifications.service');

/**
 * Deterministic dedupe key for a monitor's down-state incidents. The UNIQUE
 * (organization_id, dedupe_key, status) constraint on `incidents` prevents more
 * than one OPEN row for the same monitor at once. On resolution the key is
 * rotated (see rotatedDedupeKey) so historical resolved rows never collide with
 * a new open incident.
 */
function activeDedupeKey(monitorId) {
  return `monitor:${monitorId}:down`;
}

/**
 * A dedupe key with a per-resolution suffix. Applied when resolving so past
 * resolved rows do not collide with future incidents on the same monitor.
 */
function rotatedDedupeKey(monitorId) {
  return `monitor:${monitorId}:down:r${Date.now()}`;
}

function toPublicIncident(row) {
  return {
    id: row.public_id,
    monitorId: row.monitor_public_id ?? null,
    projectId: row.project_public_id ?? null,
    title: row.title,
    status: row.status,
    severity: row.severity,
    cause: row.cause ?? null,
    startedAt: row.started_at,
    lastTriggeredAt: row.last_triggered_at,
    resolvedAt: row.resolved_at,
    occurrenceCount: row.occurrence_count,
    resolutionNote: row.resolution_note ?? null,
  };
}

/**
 * Records a timeline event for an incident. Best-effort; failures are logged
 * but not thrown so evaluation still succeeds.
 */
async function recordEvent(conn, { incidentId, organizationId, eventType, fromStatus, toStatus, message, metadata }) {
  try {
    await conn.query(
      `INSERT INTO incident_events
         (incident_id, organization_id, event_type, from_status, to_status, message, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        incidentId,
        organizationId,
        eventType,
        fromStatus ?? null,
        toStatus ?? null,
        message ?? null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
  } catch (error) {
    logger.warn('Failed to record incident event', { message: error.message, eventType });
  }
}

/**
 * Evaluates incident state for a monitor after a check result has been
 * persisted. Opens a new incident (or increments an existing one) once
 * INCIDENT_FAILURE_THRESHOLD consecutive failures have occurred, and resolves
 * an open incident once INCIDENT_RECOVERY_THRESHOLD consecutive successes have
 * occurred. Idempotent: safe to call from a retried check job.
 *
 * @param {object} params
 * @param {number} params.monitorId internal monitor id
 * @param {number} params.organizationId
 * @returns {Promise<{ action: 'none'|'opened'|'incremented'|'resolved', incidentId?: number }>}
 */
async function evaluateAfterCheck({ monitorId, organizationId }) {
  const failureN = env.INCIDENT_FAILURE_THRESHOLD;
  const successM = env.INCIDENT_RECOVERY_THRESHOLD;
  const windowSize = Math.max(failureN, successM);

  const result = await withTransaction(async (conn) => {
    // Serialize concurrent evaluations for this monitor.
    const [monitorRows] = await conn.query(
      `SELECT id, organization_id, project_id, name FROM monitors WHERE id = ? FOR UPDATE`,
      [monitorId]
    );
    const monitor = monitorRows[0];
    if (!monitor) return { action: 'none' };

    // Load the last window results in reverse-chronological order.
    const [resultRows] = await conn.query(
      `SELECT status FROM monitor_check_results
       WHERE monitor_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [monitorId, windowSize]
    );
    const latestStatus = resultRows[0]?.status;
    if (!latestStatus) return { action: 'none' };

    // Look up an existing open incident for this monitor.
    const [openRows] = await conn.query(
      `SELECT * FROM incidents
       WHERE organization_id = ? AND dedupe_key = ? AND status <> 'resolved'
       LIMIT 1`,
      [organizationId, activeDedupeKey(monitorId)]
    );
    const openIncident = openRows[0];

    // --- Failure path ---
    if (latestStatus !== 'success') {
      // Only open if the last N results are all non-success and we have at least N.
      const lastN = resultRows.slice(0, failureN).map((r) => r.status);
      const allFailing = lastN.length >= failureN && lastN.every((s) => s !== 'success');

      if (openIncident) {
        // Increment occurrence count and refresh last_triggered_at.
        await conn.query(
          `UPDATE incidents
           SET occurrence_count = occurrence_count + 1,
               last_triggered_at = UTC_TIMESTAMP(3)
           WHERE id = ?`,
          [openIncident.id]
        );
        await recordEvent(conn, {
          incidentId: openIncident.id,
          organizationId,
          eventType: 'failure_recorded',
          message: `Failure (${latestStatus}) recorded`,
        });
        return { action: 'incremented', incidentId: openIncident.id };
      }

      if (!allFailing) {
        return { action: 'none' };
      }

      // Open a new incident. UNIQUE (org, dedupe_key, status) prevents
      // concurrent duplicates; the FOR UPDATE above already serialized us.
      const publicId = generatePublicId();
      const title = `${monitor.name} is failing`;
      const [insert] = await conn.query(
        `INSERT INTO incidents
           (public_id, organization_id, project_id, monitor_id, dedupe_key, title,
            severity, status, started_at, last_triggered_at, occurrence_count)
         VALUES (?, ?, ?, ?, ?, ?, 'high', 'open', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), ?)`,
        [
          publicId,
          organizationId,
          monitor.project_id,
          monitorId,
          activeDedupeKey(monitorId),
          title,
          failureN,
        ]
      );
      await recordEvent(conn, {
        incidentId: insert.insertId,
        organizationId,
        eventType: 'incident_opened',
        toStatus: 'open',
        message: `Opened after ${failureN} consecutive failures`,
      });
      logger.warn('Incident opened', { monitorId, incidentId: insert.insertId, publicId });
      return { action: 'opened', incidentId: insert.insertId };
    }

    // --- Success / recovery path ---
    if (!openIncident) {
      return { action: 'none' };
    }
    const lastM = resultRows.slice(0, successM).map((r) => r.status);
    const allRecovered = lastM.length >= successM && lastM.every((s) => s === 'success');
    if (!allRecovered) {
      return { action: 'none' };
    }

    // Rotate dedupe_key so historical resolved rows never collide with a future
    // open incident on this same monitor (the UNIQUE key includes status).
    await conn.query(
      `UPDATE incidents
       SET status = 'resolved',
           resolved_at = UTC_TIMESTAMP(3),
           dedupe_key = ?
       WHERE id = ?`,
      [rotatedDedupeKey(monitorId), openIncident.id]
    );
    await recordEvent(conn, {
      incidentId: openIncident.id,
      organizationId,
      eventType: 'incident_resolved',
      fromStatus: openIncident.status,
      toStatus: 'resolved',
      message: `Resolved after ${successM} consecutive successes`,
    });
    logger.info('Incident resolved', { monitorId, incidentId: openIncident.id });
    return { action: 'resolved', incidentId: openIncident.id };
  });

  // Notification enqueue happens AFTER commit so the delivery rows never
  // outlive a rolled-back incident change. Failures here must not break the
  // incident lifecycle -> caught and logged.
  if (result.action === 'opened' || result.action === 'resolved') {
    try {
      await enqueueForIncident({
        incidentId: result.incidentId,
        organizationId,
        eventType: result.action === 'opened' ? 'incident_opened' : 'incident_resolved',
      });
    } catch (error) {
      logger.error('Notification enqueue failed', {
        incidentId: result.incidentId,
        message: error.message,
      });
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// Read API used by the controller.
// -----------------------------------------------------------------------------

/**
 * Lists incidents in an organization, paginated. Optional filters: status,
 * monitorId (public id), projectId (public id).
 */
async function listInOrg(organizationId, pagination, filters = {}) {
  const where = ['i.organization_id = ?'];
  const params = [organizationId];

  if (filters.status) {
    where.push('i.status = ?');
    params.push(filters.status);
  }
  if (filters.monitorId) {
    where.push('m.public_id = ?');
    params.push(filters.monitorId);
  }
  if (filters.projectId) {
    where.push('p.public_id = ?');
    params.push(filters.projectId);
  }
  const whereSql = where.join(' AND ');

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM incidents i
     LEFT JOIN monitors m ON m.id = i.monitor_id
     LEFT JOIN projects p ON p.id = i.project_id
     WHERE ${whereSql}`,
    params
  );
  const total = countRows[0].total;

  const [rows] = await db.query(
    `SELECT i.*, m.public_id AS monitor_public_id, p.public_id AS project_public_id
     FROM incidents i
     LEFT JOIN monitors m ON m.id = i.monitor_id
     LEFT JOIN projects p ON p.id = i.project_id
     WHERE ${whereSql}
     ORDER BY i.last_triggered_at DESC, i.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pagination.limit, pagination.offset]
  );
  return paginated(rows.map(toPublicIncident), pagination, total);
}

/**
 * Loads a single incident constrained to the caller's organization. Includes
 * the incident's timeline events.
 */
async function getInOrg(organizationId, incidentPublicId) {
  const [rows] = await db.query(
    `SELECT i.*, m.public_id AS monitor_public_id, p.public_id AS project_public_id
     FROM incidents i
     LEFT JOIN monitors m ON m.id = i.monitor_id
     LEFT JOIN projects p ON p.id = i.project_id
     WHERE i.public_id = ? AND i.organization_id = ?
     LIMIT 1`,
    [incidentPublicId, organizationId]
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Incident not found');
  }
  const incident = rows[0];
  const [events] = await db.query(
    `SELECT event_type, from_status, to_status, message, metadata, created_at
     FROM incident_events
     WHERE incident_id = ?
     ORDER BY id ASC`,
    [incident.id]
  );
  return {
    ...toPublicIncident(incident),
    events: events.map((e) => ({
      eventType: e.event_type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      message: e.message,
      metadata: e.metadata,
      createdAt: e.created_at,
    })),
  };
}

module.exports = { evaluateAfterCheck, listInOrg, getInOrg };
