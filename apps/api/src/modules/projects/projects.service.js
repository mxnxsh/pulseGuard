'use strict';

const { db } = require('../../db');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { generatePublicId } = require('../../utils/ids');
const { paginated } = require('../../utils/pagination');

function toPublicProject(row) {
  return {
    id: row.public_id,
    name: row.name,
    environment: row.environment,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Resolves a project by public_id constrained to a specific organization. This
 * is the ownership boundary: a project from another org is simply "not found".
 * @param {number} organizationId
 * @param {string} projectPublicId
 * @returns {Promise<object>} raw project row
 */
async function requireProjectInOrg(organizationId, projectPublicId) {
  const [rows] = await db.query(
    `SELECT id, public_id, name, environment, status, created_at, updated_at
     FROM projects
     WHERE public_id = ? AND organization_id = ?`,
    [projectPublicId, organizationId]
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Project not found');
  }
  return rows[0];
}

/**
 * Lists projects within an organization, paginated.
 */
async function list(organizationId, pagination) {
  const [countRows] = await db.query(
    'SELECT COUNT(*) AS total FROM projects WHERE organization_id = ?',
    [organizationId]
  );
  const total = countRows[0].total;

  const [rows] = await db.query(
    `SELECT public_id, name, environment, status, created_at, updated_at
     FROM projects
     WHERE organization_id = ?
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [organizationId, pagination.limit, pagination.offset]
  );
  return paginated(rows.map(toPublicProject), pagination, total);
}

async function getById(organizationId, projectPublicId) {
  const row = await requireProjectInOrg(organizationId, projectPublicId);
  return toPublicProject(row);
}

/**
 * Creates a project within an organization. Enforces the unique
 * (organization_id, name, environment) constraint with a friendly error.
 */
async function create(organizationId, userId, { name, environment }) {
  const [existing] = await db.query(
    'SELECT 1 FROM projects WHERE organization_id = ? AND name = ? AND environment = ? LIMIT 1',
    [organizationId, name, environment]
  );
  if (existing.length > 0) {
    throw ApiError.badRequest('A project with this name and environment already exists', {
      code: 'PROJECT_EXISTS',
    });
  }

  const publicId = generatePublicId();
  const [result] = await db.query(
    `INSERT INTO projects (public_id, organization_id, name, environment, status, created_by)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [publicId, organizationId, name, environment, userId]
  );
  logger.info('Project created', { organizationId, projectId: result.insertId });
  return getById(organizationId, publicId);
}

/**
 * Updates a project within an organization.
 */
async function update(organizationId, projectPublicId, { name, environment, status }) {
  const project = await requireProjectInOrg(organizationId, projectPublicId);

  // Guard the unique constraint when name/environment change.
  const nextName = name ?? project.name;
  const nextEnv = environment ?? project.environment;
  if (nextName !== project.name || nextEnv !== project.environment) {
    const [clash] = await db.query(
      `SELECT 1 FROM projects
       WHERE organization_id = ? AND name = ? AND environment = ? AND id <> ? LIMIT 1`,
      [organizationId, nextName, nextEnv, project.id]
    );
    if (clash.length > 0) {
      throw ApiError.badRequest('A project with this name and environment already exists', {
        code: 'PROJECT_EXISTS',
      });
    }
  }

  await db.query(
    `UPDATE projects
     SET name = COALESCE(?, name),
         environment = COALESCE(?, environment),
         status = COALESCE(?, status)
     WHERE id = ?`,
    [name ?? null, environment ?? null, status ?? null, project.id]
  );
  return getById(organizationId, projectPublicId);
}

module.exports = { list, getById, create, update, requireProjectInOrg };
