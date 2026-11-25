'use strict';

// SSRF-blocking test run: private targets DISABLED (the default). Runs only the
// suites that assert loopback/private targets are rejected, so it must not load
// the enablePrivateTargets setup.
const base = require('./jest.config');

module.exports = {
  ...base,
  testMatch: ['**/tests/ssrf.test.js', '**/tests/httpCheckerSsrf.test.js'],
};
