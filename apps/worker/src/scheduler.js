'use strict';

const { env } = require('../../api/src/config/env');
const logger = require('../../api/src/utils/logger');
const { claimAndEnqueueDue } = require('../../api/src/modules/scheduler/scheduler.service');

/**
 * Starts a periodic scheduler tick that claims due monitors and enqueues checks.
 * Returns a stop() function that resolves once any in-flight tick finishes.
 * @returns {{ stop: () => Promise<void> }}
 */
function startScheduler() {
  let stopping = false;
  let inFlight = null;
  let timer = null;

  async function tick() {
    if (stopping) return;
    inFlight = claimAndEnqueueDue().catch((error) => {
      logger.error('Scheduler tick failed', { message: error.message });
    });
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function schedule() {
    if (stopping) return;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, env.SCHEDULER_TICK_MS);
    // Do not keep the event loop alive purely for the tick timer.
    timer.unref?.();
  }

  logger.info('Scheduler started', { tickMs: env.SCHEDULER_TICK_MS, batchSize: env.SCHEDULER_BATCH_SIZE });
  schedule();

  return {
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight.catch(() => {});
      logger.info('Scheduler stopped');
    },
  };
}

module.exports = { startScheduler };
