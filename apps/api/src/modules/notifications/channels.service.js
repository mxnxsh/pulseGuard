'use strict';

const { db } = require('../../db');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { paginated } = require('../../utils/pagination');
const { redactEmail } = require('./emailProvider');

/**
 * Notification channels are a small CRUD, org-scoped. Config is stored in
 * `config_encrypted` (see FUTURE_SUGGESTIONS.md for real encryption). API
 * responses REDACT the recipient email so channels can be listed safely.
 */

function toPublicChannel(row) {
  const config = normalizeConfig(row.config_encrypted);
  return {
    id: row.id_public,
    name: row.name,
    type: row.channel_type,
    enabled: !!row.enabled,
    // Never echo the raw recipient; always redact.
    config: {
      to: config.to ? redactEmail(config.to) : null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeConfig(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return {};
  }
}

/** Loads a channel by its public row id + org. 404 otherwise. */
async function requireChannel(organizationId, publicId) {
  const [rows] = await db.query(
    `SELECT id, id AS id_public, organization_id, name, channel_type, config_encrypted,
            enabled, created_at, updated_at
     FROM notification_channels WHERE organization_id = ? AND id = ?`,
    [organizationId, publicId]
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Notification channel not found');
  }
  return rows[0];
}

async function list(organizationId, pagination) {
  const [countRows] = await db.query(
    'SELECT COUNT(*) AS total FROM notification_channels WHERE organization_id = ?',
    [organizationId]
  );
  const total = countRows[0].total;
  const [rows] = await db.query(
    `SELECT id AS id_public, name, channel_type, config_encrypted, enabled, created_at, updated_at
     FROM notification_channels
     WHERE organization_id = ?
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [organizationId, pagination.limit, pagination.offset]
  );
  return paginated(rows.map(toPublicChannel), pagination, total);
}

async function getById(organizationId, id) {
  const row = await requireChannel(organizationId, id);
  return toPublicChannel(row);
}

async function create(organizationId, { name, type, config, enabled }) {
  const [result] = await db.query(
    `INSERT INTO notification_channels
       (organization_id, name, channel_type, config_encrypted, enabled)
     VALUES (?, ?, ?, ?, ?)`,
    [organizationId, name, type, JSON.stringify(config), enabled ? 1 : 0]
  );
  logger.info('Notification channel created', { organizationId, channelId: result.insertId });
  return getById(organizationId, result.insertId);
}

async function update(organizationId, id, { name, config, enabled }) {
  const existing = await requireChannel(organizationId, id);
  await db.query(
    `UPDATE notification_channels
     SET name = COALESCE(?, name),
         config_encrypted = COALESCE(?, config_encrypted),
         enabled = COALESCE(?, enabled)
     WHERE id = ?`,
    [
      name ?? null,
      config ? JSON.stringify(config) : null,
      typeof enabled === 'boolean' ? (enabled ? 1 : 0) : null,
      existing.id,
    ]
  );
  return getById(organizationId, existing.id);
}

async function remove(organizationId, id) {
  const existing = await requireChannel(organizationId, id);
  await db.query('DELETE FROM notification_channels WHERE id = ?', [existing.id]);
  logger.info('Notification channel deleted', { organizationId, channelId: existing.id });
}

module.exports = { list, getById, create, update, remove };
