'use strict';

const { db, withTransaction } = require('../../db');
const { env } = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { generatePublicId } = require('../../utils/ids');
const { generateUniqueOrgSlug } = require('../../utils/slug');
const { hashPassword, verifyPassword } = require('./password');
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} = require('./tokens');

/**
 * Converts a TTL in seconds into a MySQL DATETIME(3) UTC string.
 * @param {number} seconds
 * @returns {string} 'YYYY-MM-DD HH:MM:SS.mmm'
 */
function utcDatetimeFromNow(seconds) {
  const d = new Date(Date.now() + seconds * 1000);
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * Shapes a user row for API responses (never exposes password_hash).
 * @param {object} row
 */
function toPublicUser(row) {
  return {
    id: row.public_id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * Issues a fresh access token plus a new refresh token row for a user within a
 * given family. Returns the tokens and the inserted refresh token id.
 * @param {import('mysql2/promise').PoolConnection|import('mysql2/promise').Pool} conn
 * @param {{ id: number, public_id: string }} user
 * @param {string} familyId
 * @returns {Promise<{ accessToken: string, refreshToken: string, refreshTokenId: number }>}
 */
async function issueTokens(conn, user, familyId) {
  const accessToken = signAccessToken({ userId: user.id, publicId: user.public_id });
  const { token: refreshToken, tokenHash } = generateRefreshToken();
  const expiresAt = utcDatetimeFromNow(env.REFRESH_TOKEN_TTL_SECONDS);

  const [result] = await conn.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES (?, ?, ?, ?)`,
    [user.id, tokenHash, familyId, expiresAt]
  );

  return { accessToken, refreshToken, refreshTokenId: result.insertId };
}

/**
 * Registers a new user, creates their organization and owner membership, and
 * issues an initial token pair. All writes run in a single transaction.
 * @param {{ email: string, password: string, fullName: string, organizationName?: string }} input
 */
async function register({ email, password, fullName, organizationName }) {
  const normalizedEmail = email.trim().toLowerCase();

  const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existing.length > 0) {
    // Do not reveal whether an email exists via a different status code path.
    throw ApiError.badRequest('Email is already registered', { code: 'EMAIL_TAKEN' });
  }

  const passwordHash = await hashPassword(password);

  const result = await withTransaction(async (conn) => {
    const userPublicId = generatePublicId();
    const [userResult] = await conn.query(
      `INSERT INTO users (public_id, email, password_hash, full_name, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [userPublicId, normalizedEmail, passwordHash, fullName]
    );
    const user = { id: userResult.insertId, public_id: userPublicId };

    // Create a default organization owned by the new user.
    const orgName = organizationName?.trim() || `${fullName}'s Organization`;
    const slug = await generateUniqueOrgSlug(conn, orgName);
    const [orgResult] = await conn.query(
      `INSERT INTO organizations (public_id, name, slug, status)
       VALUES (?, ?, ?, 'active')`,
      [generatePublicId(), orgName, slug]
    );
    await conn.query(
      `INSERT INTO organization_members (organization_id, user_id, role, status)
       VALUES (?, ?, 'owner', 'active')`,
      [orgResult.insertId, user.id]
    );

    const familyId = generatePublicId();
    const tokens = await issueTokens(conn, user, familyId);

    const [userRows] = await conn.query(
      `SELECT public_id, email, full_name, status, created_at FROM users WHERE id = ?`,
      [user.id]
    );
    return { user: userRows[0], tokens };
  });

  logger.info('User registered', { email: normalizedEmail });
  return {
    user: toPublicUser(result.user),
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
  };
}

/**
 * Authenticates a user by email/password and issues a new token pair.
 * @param {{ email: string, password: string }} input
 */
async function login({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const [rows] = await db.query(
    `SELECT id, public_id, email, password_hash, full_name, status, created_at
     FROM users WHERE email = ?`,
    [normalizedEmail]
  );

  const user = rows[0];
  // Constant-ish behavior: always compare against a hash to reduce timing signal.
  const hashToCompare = user ? user.password_hash : '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const passwordOk = await verifyPassword(password, hashToCompare);

  if (!user || !passwordOk) {
    throw ApiError.unauthorized('Invalid email or password', { code: 'INVALID_CREDENTIALS' });
  }
  if (user.status !== 'active') {
    throw ApiError.forbidden('Account is not active', { code: 'ACCOUNT_INACTIVE' });
  }

  const familyId = generatePublicId();
  const tokens = await issueTokens(db, user, familyId);
  await db.query('UPDATE users SET last_login_at = UTC_TIMESTAMP(3) WHERE id = ?', [user.id]);

  logger.info('User logged in', { userId: user.id });
  return {
    user: toPublicUser(user),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

/**
 * Rotates a refresh token: validates the presented token, revokes it, and issues
 * a new token pair in the same family. Detects reuse of an already-rotated token
 * and revokes the entire family as a compromise response.
 * @param {{ refreshToken: string }} input
 */
async function refresh({ refreshToken }) {
  const tokenHash = hashRefreshToken(refreshToken);

  // Sentinel used to signal reuse from inside the transaction. The transaction
  // rolls back on any throw, so the family revocation must be committed
  // separately afterward (see catch below).
  class ReuseDetected extends Error {
    constructor(familyId, userId) {
      super('reuse');
      this.familyId = familyId;
      this.userId = userId;
    }
  }

  try {
    return await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        `SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at, rt.revoked_at, rt.replaced_by_token_id,
                u.public_id, u.status
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = ?
         FOR UPDATE`,
        [tokenHash]
      );

      const record = rows[0];
      if (!record) {
        throw ApiError.unauthorized('Invalid refresh token', { code: 'INVALID_REFRESH_TOKEN' });
      }

      // Reuse detection: a token that was already rotated (revoked) is being
      // presented again. Signal so the whole family can be revoked post-commit.
      if (record.revoked_at !== null) {
        throw new ReuseDetected(record.family_id, record.user_id);
      }

      if (new Date(record.expires_at).getTime() <= Date.now()) {
        throw ApiError.unauthorized('Refresh token has expired', {
          code: 'REFRESH_TOKEN_EXPIRED',
        });
      }

      if (record.status !== 'active') {
        throw ApiError.forbidden('Account is not active', { code: 'ACCOUNT_INACTIVE' });
      }

      const user = { id: record.user_id, public_id: record.public_id };
      const tokens = await issueTokens(conn, user, record.family_id);

      // Revoke the presented token and link it to its replacement (rotation).
      await conn.query(
        `UPDATE refresh_tokens
         SET revoked_at = UTC_TIMESTAMP(3), replaced_by_token_id = ?
         WHERE id = ?`,
        [tokens.refreshTokenId, record.id]
      );

      return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    });
  } catch (error) {
    if (error instanceof ReuseDetected) {
      // Committed revocation of the entire compromised family.
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3)
         WHERE family_id = ? AND revoked_at IS NULL`,
        [error.familyId]
      );
      logger.warn('Refresh token reuse detected; family revoked', {
        userId: error.userId,
        familyId: error.familyId,
      });
      throw ApiError.unauthorized('Refresh token has been revoked', {
        code: 'REFRESH_TOKEN_REVOKED',
      });
    }
    throw error;
  }
}

/**
 * Logs out by revoking the presented refresh token's entire family. Idempotent:
 * an unknown or already-revoked token does not error.
 * @param {{ refreshToken: string }} input
 */
async function logout({ refreshToken }) {
  const tokenHash = hashRefreshToken(refreshToken);
  const [rows] = await db.query('SELECT family_id FROM refresh_tokens WHERE token_hash = ?', [
    tokenHash,
  ]);
  if (rows.length === 0) {
    return; // Nothing to do; do not reveal token validity.
  }
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3)
     WHERE family_id = ? AND revoked_at IS NULL`,
    [rows[0].family_id]
  );
}

/**
 * Returns the public profile for an authenticated user by internal id.
 * @param {number} userId
 */
async function getCurrentUser(userId) {
  const [rows] = await db.query(
    `SELECT public_id, email, full_name, status, created_at FROM users WHERE id = ?`,
    [userId]
  );
  if (rows.length === 0) {
    throw ApiError.unauthorized('User no longer exists');
  }
  return toPublicUser(rows[0]);
}

module.exports = { register, login, refresh, logout, getCurrentUser };
