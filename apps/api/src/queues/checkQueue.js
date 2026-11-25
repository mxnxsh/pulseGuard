'use strict';

const { Queue } = require('bullmq');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { connectionOptions } = require('../redis');
const { generatePublicId } = require('../utils/ids');

let queue = null;

/**
 * Returns the shared BullMQ check queue, creating it on first use. Returns null
 * when QUEUE_ENABLED is false so callers can no-op cleanly.
 * @returns {import('bullmq').Queue|null}
 */
function getCheckQueue() {
  if (!env.QUEUE_ENABLED) {
    return null;
  }
  if (!queue) {
    queue = new Queue(env.CHECK_QUEUE_NAME, {
      connection: connectionOptions,
      defaultJobOptions: {
        attempts: env.CHECK_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: env.CHECK_JOB_BACKOFF_MS },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return queue;
}

/**
 * Enqueues a check for a monitor. Generates a check_id used as the BullMQ jobId
 * (idempotency) and persisted with the result. No-ops when the queue is disabled.
 * @param {{ monitorId: number, organizationId: number }} params
 * @returns {Promise<{ checkId: string, enqueued: boolean }>}
 */
async function enqueueCheck({ monitorId, organizationId }) {
  const checkId = generatePublicId();
  const q = getCheckQueue();
  if (!q) {
    logger.debug('Queue disabled; skipping enqueue', { monitorId });
    return { checkId, enqueued: false };
  }
  await q.add(
    'check',
    { monitorId, organizationId, checkId },
    { jobId: checkId }
  );
  return { checkId, enqueued: true };
}

/**
 * Closes the queue if open.
 * @returns {Promise<void>}
 */
async function closeCheckQueue() {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

module.exports = { getCheckQueue, enqueueCheck, closeCheckQueue };
