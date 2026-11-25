'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authRateLimiter = require('../../middleware/authRateLimiter');
const { validateBody } = require('../../middleware/validate');
const controller = require('./auth.controller');
const {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
} = require('./auth.validation');

const router = express.Router();

// Sensitive endpoints share a stricter rate limiter.
const limiter = authRateLimiter();

router.post('/register', limiter, validateBody(registerSchema), asyncHandler(controller.register));
router.post('/login', limiter, validateBody(loginSchema), asyncHandler(controller.login));
router.post('/refresh', limiter, validateBody(refreshSchema), asyncHandler(controller.refresh));
router.post('/logout', validateBody(logoutSchema), asyncHandler(controller.logout));

module.exports = router;
