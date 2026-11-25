'use strict';

const crypto = require('crypto');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generates a 26-character Crockford-base32 identifier (ULID-shaped). Suitable
 * for opaque external identifiers (public_id) and token family ids. Not a
 * spec-perfect ULID (no embedded timestamp ordering), but collision-resistant
 * from 16 random bytes and dependency-free.
 * @returns {string}
 */
function generatePublicId() {
  const bytes = crypto.randomBytes(26);
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out += CROCKFORD[bytes[i] % 32];
  }
  return out;
}

module.exports = { generatePublicId };
