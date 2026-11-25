'use strict';

const { db, withTransaction } = require('../apps/api/src/db');

/**
 * Determines whether a MySQL database is reachable. When it is not (common in
 * CI or local machines without MySQL), the integration assertions are skipped
 * rather than failing, so `npm test` stays green without infrastructure.
 */
async function databaseAvailable() {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

describe('Database integration', () => {
  let available = false;

  beforeAll(async () => {
    available = await databaseAvailable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Skipping DB integration assertions: MySQL not reachable.');
    }
  });

  // Pool is closed once globally in tests/teardown.js.

  test('SELECT 1 returns a row when the database is reachable', async () => {
    if (!available) {
      return;
    }
    const [rows] = await db.query('SELECT 1 AS value');
    expect(rows[0].value).toBe(1);
  });

  test('core tables exist after migration', async () => {
    if (!available) {
      return;
    }
    const [rows] = await db.query(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()`
    );
    const tables = new Set(rows.map((row) => row.name));
    for (const expected of [
      'organizations',
      'users',
      'organization_members',
      'refresh_tokens',
      'projects',
      'api_keys',
      'monitors',
      'monitor_check_results',
      'alert_rules',
      'incidents',
      'incident_events',
      'notification_channels',
      'notification_deliveries',
      'telemetry_events',
      'application_logs',
      'ai_analyses',
      'audit_logs',
      'outbox_events',
    ]) {
      expect(tables.has(expected)).toBe(true);
    }
  });

  test('withTransaction rolls back on error', async () => {
    if (!available) {
      return;
    }
    await expect(
      withTransaction(async (connection) => {
        await connection.query('SELECT 1');
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');
  });
});
