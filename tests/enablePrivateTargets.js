'use strict';

// Runs before any modules under test are loaded (jest setupFiles). Enables the
// dev/test-only flag so local-server checker and monitor CRUD tests can target
// 127.0.0.1 / localhost. Never used outside the test runner.
process.env.MONITOR_ALLOW_PRIVATE_TARGETS = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
