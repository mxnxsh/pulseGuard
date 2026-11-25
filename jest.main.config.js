'use strict';

// Main test run: private targets ENABLED (so local-server checker and monitor
// CRUD tests can reach 127.0.0.1/localhost). Excludes the SSRF-blocking suite,
// which must run with the flag disabled (see jest.ssrf.config.js).
const base = require('./jest.config');

module.exports = {
  ...base,
  setupFiles: ['<rootDir>/tests/enablePrivateTargets.js'],
  testPathIgnorePatterns: [...base.testPathIgnorePatterns, '<rootDir>/tests/httpCheckerSsrf.test.js'],
};
