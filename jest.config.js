'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js', '**/?(*.)+(spec|test).js'],
  testPathIgnorePatterns: ['/node_modules/'],
  clearMocks: true,
  verbose: true,
  // Integration tests hold an open MySQL pool for the duration of the run. The
  // pool is closed in a shared afterAll (tests/setup.js); forceExit guards
  // against any lingering socket keeping the worker alive.
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  forceExit: true,
};
