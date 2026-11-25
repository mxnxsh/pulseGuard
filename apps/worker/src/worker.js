'use strict';

const { Worker } = require('bullmq');
const { env } = require('../../api/src/config/env');
const logger = require('../../api/src/utils/logger');
const { connectDB, disconnectDB } = require('../../api/src/db');
const { disconnectRedis, connectionOptions } = require('../../api/src/redis');
const { processCheckJob } = require('./processors/checkProcessor');
const { startScheduler } = require('./scheduler');
const { startNotificationDispatcher } = require('./notificationDispatcher');

async function start() {
  if (!env.QUEUE_ENABLED) {
    logger.error('QUEUE_ENABLED must be true to run the worker. Exiting.');
    process.exit(1);
  }

  // Verify the database is reachable before consuming jobs.
  try {
    await connectDB();
  } catch (error) {
    logger.error('Worker DB connection failed', { message: error.message });
    process.exit(1);
  }

  const worker = new Worker(env.CHECK_QUEUE_NAME, processCheckJob, {
    connection: connectionOptions,
    concurrency: env.WORKER_CONCURRENCY,
  });

  // Optionally run the scheduler in the same process. In a multi-instance
  // deployment, run at least one process with SCHEDULER_ENABLED=true; the
  // atomic claim (FOR UPDATE SKIP LOCKED) makes running more than one safe.
  const scheduler = env.SCHEDULER_ENABLED ? startScheduler() : null;

  // Notification dispatcher (same DB-driven pattern).
  const notifier = env.NOTIFICATIONS_ENABLED ? startNotificationDispatcher() : null;

  worker.on('completed', (job) => {
    logger.debug('Job completed', { jobId: job.id });
  });
  worker.on('failed', (job, err) => {
    logger.warn('Job failed', { jobId: job?.id, message: err?.message });
  });
  worker.on('error', (err) => {
    logger.error('Worker error', { message: err.message });
  });

  logger.info('PulseGuard worker started', {
    queue: env.CHECK_QUEUE_NAME,
    concurrency: env.WORKER_CONCURRENCY,
  });

  async function shutdown(signal) {
    logger.info(`Worker received ${signal}, shutting down gracefully`);
    try {
      if (scheduler) await scheduler.stop();
      if (notifier) await notifier.stop();
      await worker.close(); // waits for active jobs to finish
      await disconnectRedis();
      await disconnectDB();
      logger.info('Worker shut down cleanly');
      process.exit(0);
    } catch (error) {
      logger.error('Error during worker shutdown', { message: error.message });
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
