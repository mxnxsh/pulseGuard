'use strict';

const { z } = require('zod');

const emailConfigSchema = z.object({
  to: z.string().email().max(254),
});

const createChannelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['email']).default('email'), // MVP: email only
  config: emailConfigSchema,
  enabled: z.boolean().default(true),
});

const updateChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    config: emailConfigSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one field must be provided',
  });

module.exports = { createChannelSchema, updateChannelSchema };
