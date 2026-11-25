'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./incidents.controller');

// mergeParams: inherit :orgId from the parent organizations router. Membership
// is already established there.
const router = express.Router({ mergeParams: true });

router.get('/', asyncHandler(controller.list));
router.get('/:incidentId', asyncHandler(controller.get));

module.exports = router;
