'use strict';

const express = require('express');
const { db } = require('../../db');
const { env } = require('../../config/env');
const { pingRedis } = require('../../redis');

const router = express.Router();

const startedAt = Date.now();

/**
 * Liveness probe: process is up and able to respond. Does not check dependencies.
 */
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

/**
 * Readiness probe: process is ready to serve traffic. Verifies the database is
 * reachable. Returns 503 when a dependency is unhealthy.
 */
router.get('/ready', async (_req, res) => {
  const checks = { database: 'unknown' };
  let healthy = true;

  try {
    await db.query('SELECT 1');
    checks.database = 'ok';
  } catch (_error) {
    checks.database = 'unavailable';
    healthy = false;
  }

  // Redis is only a readiness dependency when the queue is enabled.
  if (env.QUEUE_ENABLED) {
    const redisOk = await pingRedis();
    checks.redis = redisOk ? 'ok' : 'unavailable';
    if (!redisOk) {
      healthy = false;
    }
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    checks,
  });
});

module.exports = router;
