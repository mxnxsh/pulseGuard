'use strict';

/**
 * Lightweight, dependency-free migration runner for PulseGuard.
 *
 * Migrations are plain .sql files in database/migrations named `NNN_name.sql`.
 * Each file contains two sections delimited by marker comments:
 *
 *   -- @UP
 *   <statements applied when migrating up>
 *   -- @DOWN
 *   <statements applied when rolling back>
 *
 * Applied migrations are tracked in the `schema_migrations` table so that
 * `migrate` is idempotent and re-runnable. No ORM is used; statements are raw
 * SQL executed via mysql2 multi-statement queries.
 *
 * Commands:
 *   node database/migrate.js up        Apply all pending migrations (default).
 *   node database/migrate.js down       Roll back the most recently applied migration.
 *   node database/migrate.js reset      Roll back all applied migrations, then re-apply.
 *   node database/migrate.js status     Show applied/pending migrations.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { env } = require('../apps/api/src/config/env');
const logger = require('../apps/api/src/utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const UP_MARKER = '-- @UP';
const DOWN_MARKER = '-- @DOWN';

/**
 * Creates a single connection (not a pool) with multi-statement support.
 * Used only by CLI tooling, not the application runtime.
 * @returns {Promise<import('mysql2/promise').Connection>}
 */
async function createConnection() {
  return mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    multipleStatements: true,
    timezone: 'Z',
  });
}

/**
 * Reads and parses migration files from disk, sorted by filename.
 * @returns {{ name: string, up: string, down: string }[]}
 */
function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  return files.map((file) => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const upIndex = content.indexOf(UP_MARKER);
    const downIndex = content.indexOf(DOWN_MARKER);

    if (upIndex === -1 || downIndex === -1 || downIndex < upIndex) {
      throw new Error(`Migration ${file} must contain "${UP_MARKER}" then "${DOWN_MARKER}" markers`);
    }

    const up = content.slice(upIndex + UP_MARKER.length, downIndex).trim();
    const down = content.slice(downIndex + DOWN_MARKER.length).trim();
    return { name: file, up, down };
  });
}

/**
 * Ensures the migration bookkeeping table exists.
 * @param {import('mysql2/promise').Connection} connection
 */
async function ensureMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

/**
 * @param {import('mysql2/promise').Connection} connection
 * @returns {Promise<Set<string>>}
 */
async function appliedSet(connection) {
  const [rows] = await connection.query('SELECT name FROM schema_migrations ORDER BY name');
  return new Set(rows.map((row) => row.name));
}

async function migrateUp(connection) {
  const migrations = loadMigrations();
  const applied = await appliedSet(connection);
  const pending = migrations.filter((m) => !applied.has(m.name));

  if (pending.length === 0) {
    logger.info('No pending migrations');
    return;
  }

  for (const migration of pending) {
    logger.info(`Applying migration: ${migration.name}`);
    if (migration.up) {
      await connection.query(migration.up);
    }
    await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [migration.name]);
  }
  logger.info(`Applied ${pending.length} migration(s)`);
}

async function migrateDown(connection) {
  const migrations = loadMigrations();
  const applied = await appliedSet(connection);
  const appliedInOrder = migrations.filter((m) => applied.has(m.name));
  const last = appliedInOrder[appliedInOrder.length - 1];

  if (!last) {
    logger.info('No applied migrations to roll back');
    return;
  }

  logger.info(`Rolling back migration: ${last.name}`);
  if (last.down) {
    await connection.query(last.down);
  }
  await connection.query('DELETE FROM schema_migrations WHERE name = ?', [last.name]);
  logger.info(`Rolled back ${last.name}`);
}

async function migrateReset(connection) {
  const migrations = loadMigrations();
  const applied = await appliedSet(connection);
  const appliedInReverse = migrations.filter((m) => applied.has(m.name)).reverse();

  for (const migration of appliedInReverse) {
    logger.info(`Rolling back migration: ${migration.name}`);
    if (migration.down) {
      await connection.query(migration.down);
    }
    await connection.query('DELETE FROM schema_migrations WHERE name = ?', [migration.name]);
  }
  await migrateUp(connection);
}

async function status(connection) {
  const migrations = loadMigrations();
  const applied = await appliedSet(connection);
  for (const migration of migrations) {
    const mark = applied.has(migration.name) ? 'applied' : 'pending';
    logger.info(`[${mark}] ${migration.name}`);
  }
  if (migrations.length === 0) {
    logger.info('No migration files found');
  }
}

async function main() {
  const command = process.argv[2] || 'up';
  const connection = await createConnection();
  try {
    await ensureMigrationsTable(connection);
    switch (command) {
      case 'up':
        await migrateUp(connection);
        break;
      case 'down':
        await migrateDown(connection);
        break;
      case 'reset':
        await migrateReset(connection);
        break;
      case 'status':
        await status(connection);
        break;
      default:
        logger.error(`Unknown command: ${command}. Use up | down | reset | status`);
        process.exitCode = 1;
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  logger.error('Migration failed', { message: error.message, stack: error.stack });
  process.exit(1);
});
