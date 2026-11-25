'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const { validateBody } = require('../../middleware/validate');
const { requireOrgMembership, requireOrgRole } = require('../authz/authz');
const controller = require('./organizations.controller');
const projectRoutes = require('../projects/projects.routes');
const incidentRoutes = require('../incidents/incidents.routes');
const channelRoutes = require('../notifications/channels.routes');
const {
  createOrganizationSchema,
  updateOrganizationSchema,
} = require('./organizations.validation');

const router = express.Router();

// Every organization route requires authentication.
router.use(authenticate());

// Collection endpoints (no specific org).
router.get('/', asyncHandler(controller.list));
router.post('/', validateBody(createOrganizationSchema), asyncHandler(controller.create));

// Single-org endpoints: membership is resolved and enforced here.
router.get('/:orgId', requireOrgMembership(), asyncHandler(controller.get));
router.patch(
  '/:orgId',
  requireOrgMembership(),
  requireOrgRole('admin'),
  validateBody(updateOrganizationSchema),
  asyncHandler(controller.update)
);

// Nested projects: membership must be established before entering the sub-router.
router.use('/:orgId/projects', requireOrgMembership(), projectRoutes);

// Nested incidents (read-only, org-scoped).
router.use('/:orgId/incidents', requireOrgMembership(), incidentRoutes);

// Notification channels (CRUD, admin+ for writes).
router.use('/:orgId/notification-channels', requireOrgMembership(), channelRoutes);

module.exports = router;
