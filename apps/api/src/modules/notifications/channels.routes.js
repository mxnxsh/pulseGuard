'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const { validateBody } = require('../../middleware/validate');
const { requireOrgRole } = require('../authz/authz');
const controller = require('./channels.controller');
const { createChannelSchema, updateChannelSchema } = require('./channels.validation');

const router = express.Router({ mergeParams: true });

router.get('/', asyncHandler(controller.list));
router.get('/:channelId', asyncHandler(controller.get));

// Writes require admin+ so ordinary engineers can't redirect alerts.
router.post(
  '/',
  requireOrgRole('admin'),
  validateBody(createChannelSchema),
  asyncHandler(controller.create)
);
router.patch(
  '/:channelId',
  requireOrgRole('admin'),
  validateBody(updateChannelSchema),
  asyncHandler(controller.update)
);
router.delete('/:channelId', requireOrgRole('admin'), asyncHandler(controller.remove));

module.exports = router;
