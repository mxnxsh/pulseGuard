'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const { getCurrentUser } = require('../auth/auth.service');

const router = express.Router();

/**
 * GET /users/me — returns the authenticated user's profile.
 */
router.get(
  '/me',
  authenticate(),
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req.auth.userId);
    res.status(200).json({ user });
  })
);

module.exports = router;
