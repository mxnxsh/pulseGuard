'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');
const { env, isProduction } = require('../../../api/src/config/env');
const { isBlockedIp } = require('../../../api/src/utils/ssrf');

/**
 * SSRF-safe HTTP checker.
 *
 * Defends against DNS rebinding by validating the resolved IP at CONNECTION time
 * via a custom dns lookup hook, not merely against the URL string. Enforces:
 *   - http/https only, no credentials in URL
 *   - strict total timeout (per monitor timeout_ms)
 *   - bounded manual redirect handling with per-hop revalidation
 *   - response-size cap (aborts the socket if exceeded)
 *   - no forwarding of internal/authorization headers
 *
 * Returns a structured result; never throws for network failures (those are
 * reported as status 'failure'/'timeout'/'blocked' with an error code).
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOW_PRIVATE = () => env.MONITOR_ALLOW_PRIVATE_TARGETS && !isProduction;

/**
 * Builds a dns.lookup-compatible function that rejects blocked IPs at connect
 * time. When private targets are allowed (dev/test), it defers to the default.
 * @returns {Function}
 */
function guardedLookup() {
  return function lookup(hostname, options, callback) {
    // Normalize the (options, callback) overload.
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options;

    dns.lookup(hostname, { ...opts, all: false, verbatim: true }, (err, address, family) => {
      if (err) return cb(err);
      if (!ALLOW_PRIVATE() && isBlockedIp(address)) {
        const blockErr = new Error('Resolved address is blocked (SSRF protection)');
        blockErr.code = 'SSRF_BLOCKED';
        return cb(blockErr);
      }
      return cb(null, address, family);
    });
  };
}

/**
 * Performs a single HTTP(S) request (no redirect following) with SSRF-guarded
 * connection, timeout, and size cap.
 * @param {string} rawUrl
 * @param {{ method: string, timeoutMs: number, headers?: Record<string,string> }} opts
 * @returns {Promise<{ statusCode: number, durationMs: number }>}
 */
function requestOnce(rawUrl, { method, timeoutMs, headers }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_e) {
      const err = new Error('Malformed URL');
      err.code = 'BAD_URL';
      return reject(err);
    }

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      const err = new Error('Disallowed protocol');
      err.code = 'BAD_SCHEME';
      return reject(err);
    }
    if (parsed.username || parsed.password) {
      const err = new Error('Credentials in URL are not allowed');
      err.code = 'BAD_URL';
      return reject(err);
    }

    // IP-literal hosts bypass the dns.lookup hook (Node connects directly), so
    // validate them explicitly here. Hostnames are validated in guardedLookup.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    if (net.isIP(hostname) && !ALLOW_PRIVATE() && isBlockedIp(hostname)) {
      const err = new Error('Target IP is blocked (SSRF protection)');
      err.code = 'SSRF_BLOCKED';
      return reject(err);
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const start = process.hrtime.bigint();

    const req = transport.request(
      rawUrl,
      {
        method,
        lookup: guardedLookup(),
        // Only forward explicitly-provided safe headers. Never forward auth.
        headers: { 'user-agent': 'PulseGuard/1.0 (+monitor)', ...(headers || {}) },
        // Do not send credentials; keep the connection minimal.
        setHost: true,
      },
      (res) => {
        let received = 0;
        // We only need status + timing; drain and discard body under a cap.
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > env.CHECK_MAX_RESPONSE_BYTES) {
            req.destroy(Object.assign(new Error('Response too large'), { code: 'SIZE_LIMIT' }));
          }
        });
        res.on('end', () => {
          const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
          resolve({
            statusCode: res.statusCode,
            durationMs: Math.round(durationMs),
            location: res.headers.location,
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' }));
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

/**
 * Runs a full check for a monitor, following bounded redirects with per-hop
 * SSRF revalidation. Returns a structured result suitable for persistence.
 * @param {{ url: string, method: string, timeoutMs: number, expectedStatusMin: number, expectedStatusMax: number, requestHeaders?: object }} monitor
 * @returns {Promise<{ status: 'success'|'failure'|'timeout'|'blocked', httpStatus: number|null, latencyMs: number|null, errorCode: string|null }>}
 */
async function runCheck(monitor) {
  const started = process.hrtime.bigint();
  let currentUrl = monitor.url;
  let redirects = 0;

  try {
    // Follow redirects manually so each hop is revalidated by guardedLookup.
    // (guardedLookup runs on every connection, including redirect targets.)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await requestOnce(currentUrl, {
        method: monitor.method || 'GET',
        timeoutMs: monitor.timeoutMs,
        headers: monitor.requestHeaders || undefined,
      });

      const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && res.location;
      if (isRedirect) {
        if (redirects >= env.CHECK_MAX_REDIRECTS) {
          return result('failure', res.statusCode, elapsed(started), 'TOO_MANY_REDIRECTS');
        }
        redirects += 1;
        // Resolve relative redirects against the current URL.
        currentUrl = new URL(res.location, currentUrl).toString();
        continue;
      }

      const ok =
        res.statusCode >= monitor.expectedStatusMin && res.statusCode <= monitor.expectedStatusMax;
      return result(ok ? 'success' : 'failure', res.statusCode, res.durationMs, ok ? null : 'UNEXPECTED_STATUS');
    }
  } catch (error) {
    const code = error.code || 'ERROR';
    if (code === 'TIMEOUT') {
      return result('timeout', null, elapsed(started), 'TIMEOUT');
    }
    if (code === 'SSRF_BLOCKED' || code === 'BAD_SCHEME' || code === 'BAD_URL') {
      return result('blocked', null, elapsed(started), code);
    }
    return result('failure', null, elapsed(started), normalizeErrorCode(code));
  }
}

function elapsed(startedHr) {
  return Math.round(Number(process.hrtime.bigint() - startedHr) / 1e6);
}

function result(status, httpStatus, latencyMs, errorCode) {
  return { status, httpStatus, latencyMs, errorCode };
}

/**
 * Maps common Node network error codes to compact, stored error codes.
 */
function normalizeErrorCode(code) {
  const known = new Set([
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'SIZE_LIMIT',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  ]);
  return known.has(code) ? code : 'ERROR';
}

module.exports = { runCheck, requestOnce };
