'use strict';

const { db, withTransaction } = require('../../db');
const { env } = require('../../config/env');
const logger = require('../../utils/logger');
const { getProvider, redactEmail } = require('./emailProvider');

/**
 * Notification delivery pipeline.
 *
 * enqueueForIncident inserts one `notification_deliveries` row per active email
 * channel with a deterministic dedupe_key. The UNIQUE (dedupe_key) constraint
 * guarantees retried callers cannot double-enqueue.
 *
 * The dispatcher claims queued rows in batches via SELECT ... FOR UPDATE SKIP
 * LOCKED so multiple dispatchers can run in parallel. Each row is sent through
 * the configured provider; success -> status='sent'; failure -> attempts++,
 * next_attempt_at pushed with exponential backoff, until NOTIFICATION_MAX_ATTEMPTS
 * is reached at which point status='failed'.
 */

/** @typedef {'incident_opened'|'incident_resolved'} NotificationEvent */

/**
 * Enqueues deliveries for an incident transition. Idempotent: safe to call
 * from a retried job. Returns the number of rows inserted (0 when duplicates).
 * @param {object} params
 * @param {number} params.incidentId
 * @param {number} params.organizationId
 * @param {NotificationEvent} params.eventType
 * @returns {Promise<{ enqueued: number }>}
 */
async function enqueueForIncident({ incidentId, organizationId, eventType }) {
  // Load enabled email channels for the org. Only 'email' is supported in MVP.
  const [channels] = await db.query(
    `SELECT id FROM notification_channels
     WHERE organization_id = ? AND enabled = 1 AND channel_type = 'email'`,
    [organizationId]
  );
  if (channels.length === 0) {
    return { enqueued: 0 };
  }

  let enqueued = 0;
  for (const channel of channels) {
    const dedupeKey = buildDedupeKey({ incidentId, eventType, channelId: channel.id });
    const [result] = await db.query(
      `INSERT IGNORE INTO notification_deliveries
         (organization_id, incident_id, channel_id, dedupe_key, status,
          attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, 'queued', 0, UTC_TIMESTAMP(3))`,
      [organizationId, incidentId, channel.id, dedupeKey]
    );
    if (result.affectedRows === 1) enqueued += 1;
  }
  if (enqueued > 0) {
    logger.info('Notifications enqueued', { incidentId, eventType, enqueued });
  }
  return { enqueued };
}

function buildDedupeKey({ incidentId, eventType, channelId }) {
  // 64-char CHAR limit in schema; this fits comfortably.
  return `incident:${incidentId}:${eventType}:channel:${channelId}`;
}

/**
 * Runs one dispatcher tick: claims up to NOTIFICATION_BATCH_SIZE queued rows
 * whose next_attempt_at is due, sends each, and records the outcome.
 * @returns {Promise<{ processed: number, sent: number, retried: number, failed: number }>}
 */
async function dispatcherTick() {
  const claimed = await claimBatch();
  if (claimed.length === 0) return { processed: 0, sent: 0, retried: 0, failed: 0 };

  let sent = 0;
  let retried = 0;
  let failed = 0;

  const provider = getProvider();

  for (const row of claimed) {
    try {
      const email = buildEmailForRow(row);
      const result = await provider.send(email);
      await recordSuccess(row.id, result?.providerResponse);
      sent += 1;
    } catch (error) {
      const nextAction = await recordFailure(row, error);
      if (nextAction === 'retry') retried += 1;
      else failed += 1;
    }
  }
  return { processed: claimed.length, sent, retried, failed };
}

/**
 * Atomically claims a batch of due deliveries and transitions them to
 * 'sending' so no other dispatcher picks them up.
 */
async function claimBatch() {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT d.id, d.attempts, d.dedupe_key, d.channel_id,
              c.config_encrypted AS config, c.name AS channel_name,
              i.public_id AS incident_public_id, i.title AS incident_title,
              i.status AS incident_status
       FROM notification_deliveries d
       JOIN notification_channels c ON c.id = d.channel_id
       JOIN incidents i ON i.id = d.incident_id
       WHERE d.status = 'queued'
         AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= UTC_TIMESTAMP(3))
         AND c.enabled = 1
       ORDER BY d.next_attempt_at
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [env.NOTIFICATION_BATCH_SIZE]
    );

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    await conn.query(
      `UPDATE notification_deliveries SET status = 'sending' WHERE id IN (${placeholders})`,
      ids
    );
    return rows;
  });
}

async function recordSuccess(deliveryId, providerResponseId) {
  await db.query(
    `UPDATE notification_deliveries
     SET status = 'sent', sent_at = UTC_TIMESTAMP(3), last_error = NULL,
         next_attempt_at = NULL
     WHERE id = ?`,
    [deliveryId]
  );
  logger.info('Notification sent', { deliveryId, providerResponseId });
}

async function recordFailure(row, error) {
  const nextAttempts = row.attempts + 1;
  const maxAttempts = env.NOTIFICATION_MAX_ATTEMPTS;
  const errorMessage = truncate(error?.message || String(error), 500);
  if (nextAttempts >= maxAttempts) {
    await db.query(
      `UPDATE notification_deliveries
       SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = NULL
       WHERE id = ?`,
      [nextAttempts, errorMessage, row.id]
    );
    logger.warn('Notification permanently failed', {
      deliveryId: row.id,
      attempts: nextAttempts,
    });
    return 'failed';
  }
  const backoffMs = env.NOTIFICATION_BACKOFF_MS * 2 ** (nextAttempts - 1);
  await db.query(
    `UPDATE notification_deliveries
     SET status = 'queued', attempts = ?, last_error = ?,
         next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND)
     WHERE id = ?`,
    [nextAttempts, errorMessage, backoffMs * 1000, row.id]
  );
  logger.warn('Notification failed; will retry', {
    deliveryId: row.id,
    attempt: nextAttempts,
    backoffMs,
  });
  return 'retry';
}

function truncate(s, max) {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Extracts the recipient email from the channel's stored config and composes
 * the email body based on the incident state.
 */
function buildEmailForRow(row) {
  const config = normalizeConfig(row.config);
  if (!config.to || typeof config.to !== 'string') {
    // Configuration error: dispatcher will mark the delivery failed.
    throw new Error('Channel config missing "to"');
  }
  const opening = row.incident_status !== 'resolved';
  const subject = opening
    ? `[PulseGuard] Incident opened: ${row.incident_title}`
    : `[PulseGuard] Incident resolved: ${row.incident_title}`;
  const body = opening
    ? `An incident was opened for a monitored target.\n\nIncident: ${row.incident_public_id}\nTitle: ${row.incident_title}`
    : `A previously-open incident has been resolved.\n\nIncident: ${row.incident_public_id}\nTitle: ${row.incident_title}`;
  return {
    to: config.to,
    // For safety, also expose the redacted address to log-friendly consumers.
    toRedacted: redactEmail(config.to),
    subject,
    text: body,
  };
}

/**
 * The `config_encrypted` column stores JSON. MySQL's mysql2 driver returns it
 * as an already-parsed object for JSON columns, but tolerate a string too.
 */
function normalizeConfig(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return {};
  }
}

module.exports = { enqueueForIncident, dispatcherTick, buildEmailForRow, buildDedupeKey };
