'use strict';

// This suite verifies the checker blocks private/loopback targets at connection
// time when MONITOR_ALLOW_PRIVATE_TARGETS is NOT set. It intentionally does not
// set that env var, so it must run in a separate process from the local-server
// checker tests. Jest isolates module registries per test file.
const { runCheck } = require('../apps/worker/src/services/httpChecker');

describe('Checker SSRF connection-time blocking', () => {
  test('blocks a loopback IP literal target', async () => {
    const result = await runCheck({
      url: 'http://127.0.0.1:1/',
      method: 'GET',
      timeoutMs: 1000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    // Blocked either by the IP-literal pre-check or the guarded DNS lookup.
    expect(result.status).toBe('blocked');
  });

  test('blocks a hostname that resolves to loopback', async () => {
    // localhost resolves to 127.0.0.1 / ::1 -> guarded lookup rejects at connect.
    const result = await runCheck({
      url: 'http://localhost:1/',
      method: 'GET',
      timeoutMs: 1000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(result.status).toBe('blocked');
  });
});
