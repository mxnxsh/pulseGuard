'use strict';

const { z } = require('zod');
const { WINDOWS } = require('./metrics.service');

const historyQuerySchema = z.object({
  status: z.enum(['success', 'failure', 'timeout', 'blocked']).optional(),
});

const summaryQuerySchema = z.object({
  window: z.enum(Object.keys(WINDOWS)).default('24h'),
});

module.exports = { historyQuerySchema, summaryQuerySchema };
