'use strict';

const bcrypt = require('bcrypt');
const { env } = require('../../config/env');

/**
 * Hashes a plaintext password with bcrypt using the configured cost factor.
 * @param {string} plainPassword
 * @returns {Promise<string>} bcrypt hash
 */
function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, env.BCRYPT_ROUNDS);
}

/**
 * Verifies a plaintext password against a bcrypt hash.
 * @param {string} plainPassword
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
function verifyPassword(plainPassword, hash) {
  return bcrypt.compare(plainPassword, hash);
}

module.exports = { hashPassword, verifyPassword };
