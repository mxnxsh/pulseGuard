'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const { validateBody } = require('../../middleware/validate');
const { requireOrgRole } = require('../authz/authz');
const controller = require('./projects.controller');
const monitorRoutes = require('../monitors/monitors.routes');
const { createProjectSchema, updateProjectSchema } = require('./projects.validation');

// mergeParams lets this router read :orgId from the parent organizations router.
const router = express.Router({ mergeParams: true });

// All routes here run after requireOrgMembership (mounted by the parent), so
// req.membership is always present. Reads allow any member; writes require
// engineer or higher.
router.get('/', asyncHandler(controller.list));
router.get('/:projectId', asyncHandler(controller.get));

router.post(
  '/',
  requireOrgRole('engineer'),
  validateBody(createProjectSchema),
  asyncHandler(controller.create)
);
router.patch(
  '/:projectId',
  requireOrgRole('engineer'),
  validateBody(updateProjectSchema),
  asyncHandler(controller.update)
);

// Nested monitors: project scope is validated inside the monitors service.
router.use('/:projectId/monitors', monitorRoutes);

module.exports = router;
