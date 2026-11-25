'use strict';

const { z } = require('zod');
const { env } = require('../../config/env');

const methodEnum = z.enum(['GET', 'HEAD', 'POST']);

const intervalSchema = z.coerce
  .number()
  .int()
  .min(env.MONITOR_MIN_INTERVAL_SECONDS, `Interval must be at least ${env.MONITOR_MIN_INTERVAL_SECONDS}s`)
  .max(env.MONITOR_MAX_INTERVAL_SECONDS, `Interval must be at most ${env.MONITOR_MAX_INTERVAL_SECONDS}s`);

const timeoutSchema = z.coerce
  .number()
  .int()
  .min(env.MONITOR_MIN_TIMEOUT_MS, `Timeout must be at least ${env.MONITOR_MIN_TIMEOUT_MS}ms`)
  .max(env.MONITOR_MAX_TIMEOUT_MS, `Timeout must be at most ${env.MONITOR_MAX_TIMEOUT_MS}ms`);

const statusCode = z.coerce.number().int().min(100).max(599);

// Header map: string -> string, bounded to avoid abuse.
const headersSchema = z.record(z.string().max(128), z.string().max(1024)).optional();

const createMonitorSchema = z
  .object({
    name: z.string().trim().min(1, 'Monitor name is required').max(160),
    url: z.string().url('A valid URL is required').max(2048),
    method: methodEnum.default('GET'),
    intervalSeconds: intervalSchema.default(60),
    timeoutMs: timeoutSchema.default(10_000),
    expectedStatusMin: statusCode.default(200),
    expectedStatusMax: statusCode.default(299),
    requestHeaders: headersSchema,
  })
  .refine((d) => d.expectedStatusMin <= d.expectedStatusMax, {
    message: 'expectedStatusMin must be <= expectedStatusMax',
    path: ['expectedStatusMin'],
  });

const updateMonitorSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    url: z.string().url().max(2048).optional(),
    method: methodEnum.optional(),
    intervalSeconds: intervalSchema.optional(),
    timeoutMs: timeoutSchema.optional(),
    expectedStatusMin: statusCode.optional(),
    expectedStatusMax: statusCode.optional(),
    requestHeaders: headersSchema,
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' })
  .refine(
    (d) =>
      d.expectedStatusMin === undefined ||
      d.expectedStatusMax === undefined ||
      d.expectedStatusMin <= d.expectedStatusMax,
    { message: 'expectedStatusMin must be <= expectedStatusMax', path: ['expectedStatusMin'] }
  );

const listMonitorsQuerySchema = z.object({
  status: z.enum(['active', 'paused', 'disabled']).optional(),
});

module.exports = { createMonitorSchema, updateMonitorSchema, listMonitorsQuerySchema };
