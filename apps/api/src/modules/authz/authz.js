'use strict';

const { db } = require('../../db');
const ApiError = require('../../utils/ApiError');

// Role hierarchy for organization membership. Higher number = more privilege.
const ROLE_RANK = {
  viewer: 1,
  engineer: 2,
  admin: 3,
  owner: 4,
};

/**
 * Loads an active membership row for a user in an organization identified by its
 * public_id. Returns null when the org does not exist or the user is not an
 * active member. Deliberately does not distinguish those cases to avoid leaking
 * organization existence to non-members.
 * @param {number} userId internal user id
 * @param {string} orgPublicId organization public_id
 * @returns {Promise<{ organizationId: number, orgPublicId: string, role: string }|null>}
 */
async function loadMembership(userId, orgPublicId) {
  const [rows] = await db.query(
    `SELECT o.id AS organization_id, o.public_id AS org_public_id, m.role AS role
     FROM organizations o
     JOIN organization_members m ON m.organization_id = o.id
     WHERE o.public_id = ?
       AND m.user_id = ?
       AND m.status = 'active'
       AND o.status <> 'deleted'
     LIMIT 1`,
    [orgPublicId, userId]
  );
  if (rows.length === 0) {
    return null;
  }
  return {
    organizationId: rows[0].organization_id,
    orgPublicId: rows[0].org_public_id,
    role: rows[0].role,
  };
}

/**
 * Requires that the authenticated user is an active member of the organization
 * named by the :orgId route param. Attaches req.membership on success.
 * Responds 404 (not 403) for non-members so org existence is not revealed.
 * @returns {import('express').RequestHandler}
 */
function requireOrgMembership() {
  return async function requireOrgMembershipMiddleware(req, _res, next) {
    try {
      const orgPublicId = req.params.orgId;
      const membership = await loadMembership(req.auth.userId, orgPublicId);
      if (!membership) {
        return next(ApiError.notFound('Organization not found'));
      }
      req.membership = membership;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Requires the authenticated user's role in the org to meet or exceed a minimum.
 * Must run after requireOrgMembership. Responds 403 when the member lacks the
 * required role (the resource is known to exist to them, so 403 is appropriate).
 * @param {'viewer'|'engineer'|'admin'|'owner'} minRole
 * @returns {import('express').RequestHandler}
 */
function requireOrgRole(minRole) {
  const required = ROLE_RANK[minRole];
  return function requireOrgRoleMiddleware(req, _res, next) {
    const membership = req.membership;
    if (!membership) {
      return next(ApiError.internal('requireOrgRole used without requireOrgMembership'));
    }
    if ((ROLE_RANK[membership.role] || 0) < required) {
      return next(ApiError.forbidden('Insufficient permissions for this action'));
    }
    return next();
  };
}

module.exports = { loadMembership, requireOrgMembership, requireOrgRole, ROLE_RANK };
