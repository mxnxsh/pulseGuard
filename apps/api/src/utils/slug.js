'use strict';

const { generatePublicId } = require('./ids');

/**
 * Normalizes a name into a URL-safe slug base (lowercase, hyphenated).
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'org'
  );
}

/**
 * Builds a slug unique within the organizations table, appending a short random
 * suffix on collision. Accepts any executor exposing query() (pool or connection).
 * @param {{ query: Function }} executor
 * @param {string} name
 * @returns {Promise<string>}
 */
async function generateUniqueOrgSlug(executor, name) {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate =
      attempt === 0 ? base : `${base}-${generatePublicId().slice(0, 6).toLowerCase()}`;
    const [rows] = await executor.query('SELECT 1 FROM organizations WHERE slug = ? LIMIT 1', [
      candidate,
    ]);
    if (rows.length === 0) {
      return candidate;
    }
  }
  return `${base}-${generatePublicId().toLowerCase()}`.slice(0, 100);
}

module.exports = { slugify, generateUniqueOrgSlug };
