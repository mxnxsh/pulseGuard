'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const router = express.Router();

// Read once at process start; the spec is bundled with the app.
const specPath = path.join(__dirname, '..', '..', 'docs', 'openapi.yaml');
const openapiYaml = fs.readFileSync(specPath, 'utf8');

/**
 * Serves the hand-authored OpenAPI 3 spec. Publicly readable so any client can
 * introspect the API contract; the underlying endpoints still require auth.
 */
router.get('/openapi.yaml', (_req, res) => {
  res.type('application/yaml').send(openapiYaml);
});

module.exports = router;
