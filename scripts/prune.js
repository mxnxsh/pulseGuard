'use strict';

/**
 * CLI entry point for retention pruning. Intended to be run from cron or a
 * scheduled task in production, e.g. daily off-peak.
 *
 * Usage: node scripts/prune.js
 */

const { pruneAll } = require('../apps/api/src/modules/maintenance/retention.service');
const { disconnectDB } = require('../apps/api/src/db');
const logger = require('../apps/api/src/utils/logger');

pruneAll()
  .then((counts) => {
    logger.info('Retention prune complete', counts);
  })
  .catch((error) => {
    logger.error('Retention prune failed', { message: error.message });
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDB().catch(() => {});
  });
