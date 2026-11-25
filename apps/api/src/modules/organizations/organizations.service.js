'use strict';

const { db, withTransaction } = require('../../db');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { generatePublicId } = require('../../utils/ids');
const { generateUniqueOrgSlug } = require('../../utils/slug');
const { paginated } = require('../../utils/pagination');

/**
 * Shapes an organization row (joined with the caller's role) for API responses.
 */
function toPublicOrg(row) {
  return {
    id: row.public_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lists organizations the user is an active member of, paginated.
 * @param {number} userId
 * @param {{ page: number, pageSize: number, limit: number, offset: number }} pagination
 */
async function listForUser(userId, pagination) {
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM organizations o
     JOIN organization_members m ON m.organization_id = o.id
     WHERE m.user_id = ? AND m.status = 'active' AND o.status <> 'deleted'`,
    [userId]
  );
  const total = countRows[0].total;

  const [rows] = await db.query(
    `SELECT o.public_id, o.name, o.slug, o.status, m.role, o.created_at, o.updated_at
     FROM organizations o
     JOIN organization_members m ON m.organization_id = o.id
     WHERE m.user_id = ? AND m.status = 'active' AND o.status <> 'deleted'
     ORDER BY o.id DESC
     LIMIT ? OFFSET ?`,
    [userId, pagination.limit, pagination.offset]
  );

  return paginated(rows.map(toPublicOrg), pagination, total);
}

/**
 * Returns a single organization the caller belongs to.
 * @param {number} organizationId internal id (from membership)
 * @param {string} role caller's role
 */
async function getById(organizationId, role) {
  const [rows] = await db.query(
    `SELECT public_id, name, slug, status, created_at, updated_at
     FROM organizations WHERE id = ? AND status <> 'deleted'`,
    [organizationId]
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Organization not found');
  }
  return toPublicOrg({ ...rows[0], role });
}

/**
 * Creates a new organization owned by the user (transactional: org + owner
 * membership).
 * @param {number} userId
 * @param {{ name: string }} input
 */
async function create(userId, { name }) {
  const org = await withTransaction(async (conn) => {
    const slug = await generateUniqueOrgSlug(conn, name);
    const publicId = generatePublicId();
    const [result] = await conn.query(
      `INSERT INTO organizations (public_id, name, slug, status) VALUES (?, ?, ?, 'active')`,
      [publicId, name, slug]
    );
    await conn.query(
      `INSERT INTO organization_members (organization_id, user_id, role, status)
       VALUES (?, ?, 'owner', 'active')`,
      [result.insertId, userId]
    );
    const [rows] = await conn.query(
      `SELECT public_id, name, slug, status, created_at, updated_at FROM organizations WHERE id = ?`,
      [result.insertId]
    );
    return rows[0];
  });

  logger.info('Organization created', { userId, slug: org.slug });
  return toPublicOrg({ ...org, role: 'owner' });
}

/**
 * Updates an organization's mutable fields. Caller authorization (admin+) is
 * enforced by route middleware.
 * @param {number} organizationId
 * @param {string} role
 * @param {{ name?: string }} input
 */
async function update(organizationId, role, { name }) {
  const [result] = await db.query(
    `UPDATE organizations SET name = COALESCE(?, name) WHERE id = ? AND status <> 'deleted'`,
    [name ?? null, organizationId]
  );
  if (result.affectedRows === 0) {
    throw ApiError.notFound('Organization not found');
  }
  return getById(organizationId, role);
}

module.exports = { listForUser, getById, create, update };
