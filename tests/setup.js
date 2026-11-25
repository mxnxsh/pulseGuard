'use strict';

// Runs in each test worker (setupFilesAfterEnv). Closes the shared MySQL pool
// after all suites in the worker finish, so individual suites don't need to
// (and must not) close it themselves.
afterAll(async () => {
  const { disconnectDB } = require('../apps/api/src/db');
  await disconnectDB().catch(() => {});
});
