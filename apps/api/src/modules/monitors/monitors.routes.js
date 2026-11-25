'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const { validateBody } = require('../../middleware/validate');
const { requireOrgRole } = require('../authz/authz');
const controller = require('./monitors.controller');
const metricsController = require('../metrics/metrics.controller');
const { createMonitorSchema, updateMonitorSchema } = require('./monitors.validation');

// mergeParams: inherit :orgId and :projectId from parent routers.
const router = express.Router({ mergeParams: true });

// Reads: any active member. Writes: engineer or higher.
router.get('/', asyncHandler(controller.list));
router.get('/:monitorId', asyncHandler(controller.get));

// Metrics: history and summary. Reads are member-only (no role gate).
router.get('/:monitorId/checks', asyncHandler(metricsController.history));
router.get('/:monitorId/summary', asyncHandler(metricsController.summary));

router.post(
  '/',
  requireOrgRole('engineer'),
  validateBody(createMonitorSchema),
  asyncHandler(controller.create)
);
router.patch(
  '/:monitorId',
  requireOrgRole('engineer'),
  validateBody(updateMonitorSchema),
  asyncHandler(controller.update)
);
router.post('/:monitorId/pause', requireOrgRole('engineer'), asyncHandler(controller.pause));
router.post('/:monitorId/resume', requireOrgRole('engineer'), asyncHandler(controller.resume));
router.post('/:monitorId/run', requireOrgRole('engineer'), asyncHandler(controller.run));
router.delete('/:monitorId', requireOrgRole('engineer'), asyncHandler(controller.remove));

module.exports = router;
