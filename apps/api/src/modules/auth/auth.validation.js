'use strict';

const { z } = require('zod');

// Password policy: min 8 chars, with at least one letter and one number.
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

const registerSchema = z.object({
  email: z.string().email('A valid email is required').max(254),
  password: passwordSchema,
  fullName: z.string().trim().min(1, 'Full name is required').max(160),
  organizationName: z.string().trim().min(1).max(160).optional(),
});

const loginSchema = z.object({
  email: z.string().email('A valid email is required').max(254),
  password: z.string().min(1, 'Password is required').max(128),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

module.exports = { registerSchema, loginSchema, refreshSchema, logoutSchema };
