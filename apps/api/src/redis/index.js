'use strict';

const IORedis = require('ioredis');
const { env } = require('../config/env');
const logger = require('../utils/logger');

// BullMQ requires maxRetriesPerRequest: null on its connections. We share the
// same connection options for the app-level client for consistency.
const connectionOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  maxRetriesPerRequest: null,
  // Do not spin forever trying to connect during startup/readiness probes.
  enableReadyCheck: true,
  lazyConnect: true,
};

let client = null;

/**
 * Returns a lazily-created shared ioredis client. Callers must handle the case
 * where Redis is unavailable (e.g. readiness reports degraded).
 * @returns {import('ioredis').Redis}
 */
function getRedis() {
  if (!client) {
    client = new IORedis(connectionOptions);
    client.on('error', (err) => {
      // Avoid noisy stack traces; log the message once per error event.
      logger.warn('Redis client error', { message: err.message });
    });
  }
  return client;
}

/**
 * Pings Redis to verify connectivity. Returns true when reachable.
 * @returns {Promise<boolean>}
 */
async function pingRedis() {
  try {
    const redis = getRedis();
    if (redis.status === 'wait' || redis.status === 'close' || redis.status === 'end') {
      await redis.connect();
    }
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (_error) {
    return false;
  }
}

/**
 * Closes the shared Redis client if open.
 * @returns {Promise<void>}
 */
async function disconnectRedis() {
  if (client) {
    await client.quit().catch(() => client.disconnect());
    client = null;
  }
}

module.exports = { getRedis, pingRedis, disconnectRedis, connectionOptions };
