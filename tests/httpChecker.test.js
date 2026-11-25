'use strict';

const http = require('http');

// These tests run the checker against a local HTTP server. They require
// MONITOR_ALLOW_PRIVATE_TARGETS=true (set for the test run) so that localhost is
// reachable; the "blocked when flag off" case is covered by ssrf.test.js at the
// range level. The checker module reads the flag at require time.
const { runCheck } = require('../apps/worker/src/services/httpChecker');

/** Starts a throwaway HTTP server with a custom handler. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('SSRF-safe HTTP checker', () => {
  let ctx;

  afterEach(() => {
    if (ctx && ctx.server) {
      ctx.server.close();
      ctx = null;
    }
  });

  test('reports success for an expected 200', async () => {
    ctx = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const result = await runCheck({
      url: ctx.url,
      method: 'GET',
      timeoutMs: 2000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(result.status).toBe('success');
    expect(result.httpStatus).toBe(200);
    expect(typeof result.latencyMs).toBe('number');
  });

  test('reports failure for an unexpected status code', async () => {
    ctx = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const result = await runCheck({
      url: ctx.url,
      method: 'GET',
      timeoutMs: 2000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(result.status).toBe('failure');
    expect(result.httpStatus).toBe(500);
    expect(result.errorCode).toBe('UNEXPECTED_STATUS');
  });

  test('reports timeout when the server is slow', async () => {
    ctx = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 500);
    });
    const result = await runCheck({
      url: ctx.url,
      method: 'GET',
      timeoutMs: 100,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(result.status).toBe('timeout');
    expect(result.errorCode).toBe('TIMEOUT');
  });

  test('follows a redirect to a successful endpoint', async () => {
    ctx = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        res.end();
      } else {
        res.writeHead(200);
        res.end('final');
      }
    });
    const result = await runCheck({
      url: `${ctx.url}/start`,
      method: 'GET',
      timeoutMs: 2000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(result.status).toBe('success');
    expect(result.httpStatus).toBe(200);
  });

  test('reports failure when redirects exceed the limit', async () => {
    // Infinite redirect loop -> should stop and report failure.
    ctx = await startServer((_req, res) => {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    });
    const result = await runCheck({
      url: `${ctx.url}/loop`,
      method: 'GET',
      timeoutMs: 2000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(result.status).toBe('failure');
    expect(result.errorCode).toBe('TOO_MANY_REDIRECTS');
  });

  test('reports failure for an unresolvable host', async () => {
    const result = await runCheck({
      url: 'http://this-host-should-not-exist.pulseguard-invalid.test',
      method: 'GET',
      timeoutMs: 2000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(result.status).toBe('failure');
    expect(['ENOTFOUND', 'EAI_AGAIN', 'ERROR']).toContain(result.errorCode);
  });

  test('blocks a disallowed scheme', async () => {
    const result = await runCheck({
      url: 'ftp://127.0.0.1/x',
      method: 'GET',
      timeoutMs: 2000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(result.status).toBe('blocked');
    expect(result.errorCode).toBe('BAD_SCHEME');
  });
});
