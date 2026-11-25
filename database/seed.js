'use strict';

/**
 * Development seed data for PulseGuard.
 *
 * Idempotent: uses existence checks / ON DUPLICATE KEY UPDATE so it can be run
 * repeatedly without creating duplicates. Local development only; refuses to run
 * with NODE_ENV=production.
 *
 * Note: proper password hashing (bcrypt) is introduced in Phase 3. The seed
 * user's password_hash below is a clearly-marked non-functional placeholder and
 * cannot be used to authenticate.
 *
 * public_id columns use a 26-char ULID-like identifier. A simple generator is
 * used here to avoid adding a dependency during Phase 2.
 *
 * Usage: node database/seed.js
 */

const crypto = require('crypto');
const { db, disconnectDB } = require('../apps/api/src/db');
const { env, isProduction } = require('../apps/api/src/config/env');
const logger = require('../apps/api/src/utils/logger');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generates a 26-character Crockford-base32 identifier (ULID-shaped). Not a
 * spec-perfect ULID, but unique and suitable for seed data.
 * @returns {string}
 */
function publicId() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out += CROCKFORD[bytes[i % bytes.length] % 32];
  }
  return out;
}

const SEED_EMAIL = 'dev@pulseguard.local';
const PLACEHOLDER_HASH = 'SEED_PLACEHOLDER_NOT_A_VALID_HASH';

async function seed() {
  if (isProduction) {
    throw new Error('Refusing to run seed in production (NODE_ENV=production)');
  }

  // 1. Seed user (idempotent on unique email).
  const [existingUser] = await db.query('SELECT id FROM users WHERE email = ?', [SEED_EMAIL]);
  let userId;
  if (existingUser.length > 0) {
    userId = existingUser[0].id;
  } else {
    const [result] = await db.query(
      `INSERT INTO users (public_id, email, password_hash, full_name, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [publicId(), SEED_EMAIL, PLACEHOLDER_HASH, 'Dev User']
    );
    userId = result.insertId;
  }

  // 2. Seed an organization (idempotent on unique slug).
  const orgSlug = 'dev-org';
  const [existingOrg] = await db.query('SELECT id FROM organizations WHERE slug = ?', [orgSlug]);
  let organizationId;
  if (existingOrg.length > 0) {
    organizationId = existingOrg[0].id;
  } else {
    const [result] = await db.query(
      `INSERT INTO organizations (public_id, name, slug, status)
       VALUES (?, ?, ?, 'active')`,
      [publicId(), 'Dev Organization', orgSlug]
    );
    organizationId = result.insertId;
  }

  // 3. Ensure the user is an owner-member of the org (idempotent on unique pair).
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role, status)
     VALUES (?, ?, 'owner', 'active')
     ON DUPLICATE KEY UPDATE role = VALUES(role), status = VALUES(status)`,
    [organizationId, userId]
  );

  // 4. Seed a project under the org (idempotent on unique org+name+environment).
  const [existingProject] = await db.query(
    'SELECT id FROM projects WHERE organization_id = ? AND name = ? AND environment = ?',
    [organizationId, 'Dev Project', 'development']
  );
  let projectId;
  if (existingProject.length > 0) {
    projectId = existingProject[0].id;
  } else {
    const [result] = await db.query(
      `INSERT INTO projects (public_id, organization_id, name, environment, status, created_by)
       VALUES (?, ?, ?, 'development', 'active', ?)`,
      [publicId(), organizationId, 'Dev Project', userId]
    );
    projectId = result.insertId;
  }

  logger.info('Seed complete', {
    database: env.DB_NAME,
    userId,
    organizationId,
    projectId,
  });
}

seed()
  .then(() => disconnectDB())
  .catch(async (error) => {
    logger.error('Seed failed', { message: error.message });
    await disconnectDB().catch(() => {});
    process.exit(1);
  });
