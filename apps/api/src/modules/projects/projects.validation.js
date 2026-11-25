'use strict';

const { z } = require('zod');

const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(160),
  environment: z.string().trim().min(1, 'Environment is required').max(80),
});

const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    environment: z.string().trim().min(1).max(80).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

module.exports = { createProjectSchema, updateProjectSchema };
