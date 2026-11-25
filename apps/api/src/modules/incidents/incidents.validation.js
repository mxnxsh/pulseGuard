'use strict';

const { z } = require('zod');

const listIncidentsQuerySchema = z.object({
  status: z.enum(['open', 'acknowledged', 'investigating', 'resolved']).optional(),
  monitorId: z.string().min(1).max(64).optional(),
  projectId: z.string().min(1).max(64).optional(),
});

module.exports = { listIncidentsQuerySchema };
