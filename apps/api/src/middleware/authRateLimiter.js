'use strict';

const rateLimit = require('express-rate-limit');
const { isTest } = require('../config/env');

/**
 * Stricter rate limiter for sensitive auth endpoints (login, register, refresh).
 * Limits by client IP. Disabled under NODE_ENV=test so the suite is deterministic.
 * @returns {import('express').RequestHandler}
 */
function authRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many authentication attempts. Please try again later.',
      },
    },
  });
}

module.exports = authRateLimiter;
