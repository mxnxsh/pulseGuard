'use strict';

const { createApp } = require('./app');
const { env } = require('./config/env');
const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./db');

const app = createApp();

let server;

/**
 * Verifies the database is reachable, then starts the HTTP listener.
 * Fails fast (exit 1) if the database cannot be reached at startup.
 */
async function start() {
  try {
    await connectDB();
  } catch (error) {
    logger.error('Database connection failed at startup', { message: error.message });
    process.exit(1);
  }

  server = app.listen(env.PORT, () => {
    logger.info(`PulseGuard API listening on port ${env.PORT}`, {
      port: env.PORT,
      env: env.NODE_ENV,
    });
  });
}

/**
 * Gracefully shuts down the HTTP server and database pool, allowing in-flight
 * requests to finish.
 * @param {string} signal
 */
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully`);

  const closeServer = () =>
    new Promise((resolve, reject) => {
      if (!server) {
        return resolve();
      }
      server.close((err) => (err ? reject(err) : resolve()));
    });

  closeServer()
    .then(() => disconnectDB())
    .then(() => {
      logger.info('Server closed');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Error during shutdown', { message: err.message });
      process.exit(1);
    });

  // Force exit if graceful shutdown takes too long.
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { message: err.message, stack: err.stack });
  process.exit(1);
});

start();

module.exports = { start };
