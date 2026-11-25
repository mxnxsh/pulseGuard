'use strict';

const { z } = require('zod');

const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, 'Organization name is required').max(160),
});

const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

module.exports = { createOrganizationSchema, updateOrganizationSchema };
