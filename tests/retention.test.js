'use strict';

const { db } = require('../apps/api/src/db');
const { generatePublicId } = require('../apps/api/src/utils/ids');
const {
  pruneOldCheckResults,
  pruneRefreshTokens,
} = require('../apps/api/src/modules/maintenance/retention.service');
const { env } = require('../apps/api/src/config/env');

async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

describe('Retention pruning', () => {
  let available = false;
  const orgsCreated = [];
  const usersCreated = [];

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping retention tests: MySQL not reachable.');
    }
  });

  afterAll(async () => {
    if (!available) return;
    for (const orgId of orgsCreated) {
      await db.query('DELETE FROM organizations WHERE id = ?', [orgId]);
    }
    for (const userId of usersCreated) {
      await db.query('DELETE FROM users WHERE id = ?', [userId]);
    }
  });

  test('pruneOldCheckResults deletes rows older than retention', async () => {
    if (!available) return;
    // Seed an org + monitor + two results (one old, one recent).
    const orgPub = generatePublicId();
    const [org] = await db.query(
      "INSERT INTO organizations (public_id, name, slug, status) VALUES (?, ?, ?, 'active')",
      [orgPub, 'Ret', orgPub.toLowerCase()]
    );
    orgsCreated.push(org.insertId);
    const [proj] = await db.query(
      "INSERT INTO projects (public_id, organization_id, name, environment, status) VALUES (?, ?, 'R', 'p', 'active')",
      [generatePublicId(), org.insertId]
    );
    const [mon] = await db.query(
      `INSERT INTO monitors
         (public_id, organization_id, project_id, name, target_url, method,
          interval_seconds, timeout_ms, expected_status_min, expected_status_max, status)
       VALUES (?, ?, ?, 'M', 'https://example.com', 'GET', 60, 5000, 200, 299, 'active')`,
      [generatePublicId(), org.insertId, proj.insertId]
    );

    const oldDays = env.CHECK_RESULT_RETENTION_DAYS + 1;
    await db.query(
      `INSERT INTO monitor_check_results
         (organization_id, monitor_id, check_id, region, status, checked_at)
       VALUES (?, ?, ?, 'default', 'success', DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))`,
      [org.insertId, mon.insertId, generatePublicId(), oldDays]
    );
    await db.query(
      `INSERT INTO monitor_check_results
         (organization_id, monitor_id, check_id, region, status, checked_at)
       VALUES (?, ?, ?, 'default', 'success', UTC_TIMESTAMP(3))`,
      [org.insertId, mon.insertId, generatePublicId()]
    );

    const deleted = await pruneOldCheckResults();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const [rows] = await db.query(
      'SELECT COUNT(*) AS c FROM monitor_check_results WHERE monitor_id = ?',
      [mon.insertId]
    );
    expect(rows[0].c).toBe(1);
  });

  test('pruneRefreshTokens deletes expired and long-revoked tokens', async () => {
    if (!available) return;
    // Seed a user so we can attach refresh tokens.
    const [user] = await db.query(
      `INSERT INTO users (public_id, email, password_hash, full_name, status)
       VALUES (?, ?, 'PLACEHOLDER_HASH', 'Ret User', 'active')`,
      [generatePublicId(), `ret_${Date.now()}@pulseguard.test`]
    );
    usersCreated.push(user.insertId);

    // Expired token.
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES (?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY))`,
      [user.insertId, 'a'.repeat(64), generatePublicId()]
    );
    // Revoked long ago.
    const revokeAgo = env.REFRESH_TOKEN_RETENTION_DAYS + 1;
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, revoked_at)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY),
               DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))`,
      [user.insertId, 'b'.repeat(64), generatePublicId(), revokeAgo]
    );
    // Active (must survive).
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY))`,
      [user.insertId, 'c'.repeat(64), generatePublicId()]
    );

    const deleted = await pruneRefreshTokens();
    expect(deleted).toBeGreaterThanOrEqual(2);

    const [rows] = await db.query(
      'SELECT COUNT(*) AS c FROM refresh_tokens WHERE user_id = ?',
      [user.insertId]
    );
    expect(rows[0].c).toBe(1);
  });
});
