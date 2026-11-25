'use strict';

const mysql = require('mysql2/promise');
const { env } = require('../config/env');
const logger = require('../utils/logger');

// Shared connection pool for the whole process. Uses parameterized SQL only;
// no ORM. See PROJECT_MASTER_PLAN.md section 7 for the required pattern.
const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Store and interpret timestamps in UTC.
  timezone: 'Z',
  // Return DECIMAL/BIGINT as numbers where safe; keep decimals as strings to
  // avoid precision loss (relevant for latency aggregates later).
  decimalNumbers: false,
  namedPlaceholders: true,
});

/**
 * Verifies the pool can reach the database. Intended to be called once at
 * startup so misconfiguration fails fast.
 * @returns {Promise<void>}
 */
async function connectDB() {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
    logger.info('MySQL database connected', { database: env.DB_NAME, host: env.DB_HOST });
  } finally {
    connection.release();
  }
}

/**
 * Closes the pool. Call during graceful shutdown.
 * @returns {Promise<void>}
 */
async function disconnectDB() {
  await pool.end();
  logger.info('MySQL pool closed');
}

/**
 * Runs a set of queries inside a single transaction. Rolls back on any error.
 * @template T
 * @param {(connection: import('mysql2/promise').PoolConnection) => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withTransaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { db: pool, connectDB, disconnectDB, withTransaction };
