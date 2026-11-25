'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { env } = require('../../config/env');

/**
 * Signs a short-lived access token for a user.
 * @param {{ userId: number|string, publicId: string }} params
 * @returns {string} signed JWT
 */
function signAccessToken({ userId, publicId }) {
  return jwt.sign({ sub: String(userId), pid: publicId }, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
}

/**
 * Verifies and decodes an access token. Throws jwt errors on failure.
 * @param {string} token
 * @returns {{ sub: string, pid: string, iat: number, exp: number }}
 */
function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
}

/**
 * Generates a new opaque refresh token (returned to the client) together with
 * its SHA-256 hash (stored in the database). The raw token is never persisted.
 * @returns {{ token: string, tokenHash: string }}
 */
function generateRefreshToken() {
  const token = crypto.randomBytes(48).toString('base64url');
  const tokenHash = hashRefreshToken(token);
  return { token, tokenHash };
}

/**
 * Hashes a refresh token for storage/lookup. Produces a 64-char hex string,
 * matching the refresh_tokens.token_hash CHAR(64) column.
 * @param {string} token
 * @returns {string}
 */
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
};
