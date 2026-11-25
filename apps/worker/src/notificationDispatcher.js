'use strict';

const { env } = require('../../api/src/config/env');
const logger = require('../../api/src/utils/logger');
const { dispatcherTick } = require('../../api/src/modules/notifications/notifications.service');

/**
 * Starts the notification dispatcher tick loop. Same shape as the scheduler:
 * setTimeout with unref, in-flight promise tracked so stop() can await it.
 * Any tick failure is logged and swallowed so the loop keeps running (a bad
 * provider or single row must not stop deliveries for others).
 * @returns {{ stop: () => Promise<void> }}
 */
function startNotificationDispatcher() {
  let stopping = false;
  let inFlight = null;
  let timer = null;

  async function tick() {
    if (stopping) return;
    inFlight = dispatcherTick().catch((error) => {
      logger.error('Notification dispatcher tick failed', { message: error.message });
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
    }, env.NOTIFICATION_TICK_MS);
    timer.unref?.();
  }

  logger.info('Notification dispatcher started', {
    tickMs: env.NOTIFICATION_TICK_MS,
    batchSize: env.NOTIFICATION_BATCH_SIZE,
    provider: env.EMAIL_PROVIDER,
  });
  schedule();

  return {
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight.catch(() => {});
      logger.info('Notification dispatcher stopped');
    },
  };
}

module.exports = { startNotificationDispatcher };
