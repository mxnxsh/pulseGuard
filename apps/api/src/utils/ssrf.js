'use strict';

const dns = require('dns').promises;
const net = require('net');
const { env, isProduction } = require('../config/env');

/**
 * SSRF-safe target validation for user-supplied monitor URLs.
 *
 * Strategy (see PROJECT_MASTER_PLAN.md section 5):
 *   - Allow only http:/https: schemes.
 *   - Reject credentials in the URL and non-default/unsafe ports unless allowed.
 *   - Resolve the hostname to all A/AAAA addresses and reject if ANY resolved
 *     address falls in a blocked range (private, loopback, link-local,
 *     multicast, reserved, or cloud metadata) for IPv4 and IPv6.
 *   - IP literals are validated directly against the same rules.
 *
 * This module performs validation only. The Phase 6 checker must re-validate at
 * connection time (and on redirects) to defend against DNS rebinding.
 */

class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Converts an IPv4 dotted string to a 32-bit unsigned integer.
 * @param {string} ip
 * @returns {number}
 */
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

/**
 * Returns true if an IPv4 address is in a blocked range.
 * @param {string} ip
 */
function isBlockedIpv4(ip) {
  const n = ipv4ToInt(ip);
  const inRange = (base, maskBits) => {
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };

  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local (includes 169.254.169.254 metadata)
    inRange('172.16.0.0', 12) || // private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.0.2.0', 24) || // TEST-NET-1
    inRange('192.168.0.0', 16) || // private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('198.51.100.0', 24) || // TEST-NET-2
    inRange('203.0.113.0', 24) || // TEST-NET-3
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved (includes 255.255.255.255 broadcast)
  );
}

/**
 * Returns true if an IPv6 address is in a blocked range. Handles IPv4-mapped
 * addresses by delegating to the IPv4 check.
 * @param {string} ip
 */
function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase();

  // IPv4-mapped/compatible (::ffff:a.b.c.d or ::a.b.c.d): validate the IPv4 part.
  const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }

  if (lower === '::' || lower === '::1') {
    return true; // unspecified / loopback
  }

  const firstHextet = lower.split(':')[0];
  const prefix = firstHextet ? parseInt(firstHextet, 16) : 0;

  // fe80::/10 link-local
  if ((prefix & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique local
  if ((prefix & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast
  if ((prefix & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Returns true if an IP literal (v4 or v6) is in a blocked range.
 * @param {string} ip
 */
function isBlockedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) return isBlockedIpv4(ip);
  if (type === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP -> treat as unsafe
}

/**
 * Validates a user-supplied URL for use as a monitor target. Resolves DNS and
 * checks every resolved address. Throws SsrfError on any violation.
 *
 * When MONITOR_ALLOW_PRIVATE_TARGETS is true (dev/test only, never production),
 * the IP-range checks are skipped so local endpoints can be monitored in tests.
 *
 * @param {string} rawUrl
 * @returns {Promise<{ url: string, hostname: string, addresses: string[] }>}
 */
async function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    throw new SsrfError('URL is malformed');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SsrfError('Only http and https URLs are allowed');
  }

  if (parsed.username || parsed.password) {
    throw new SsrfError('URLs must not contain credentials');
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new SsrfError('URL must include a host');
  }

  // Dev/test escape hatch (blocked in production by env validation).
  if (env.MONITOR_ALLOW_PRIVATE_TARGETS && !isProduction) {
    return { url: parsed.toString(), hostname, addresses: [] };
  }

  // If the host is an IP literal, validate it directly.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SsrfError('URL resolves to a blocked or private address');
    }
    return { url: parsed.toString(), hostname, addresses: [hostname] };
  }

  // Resolve DNS and validate every resolved address.
  let addresses;
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch (_error) {
    throw new SsrfError('Host could not be resolved');
  }

  if (addresses.length === 0) {
    throw new SsrfError('Host did not resolve to any address');
  }

  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new SsrfError('URL resolves to a blocked or private address');
    }
  }

  return { url: parsed.toString(), hostname, addresses };
}

module.exports = { assertSafeUrl, SsrfError, isBlockedIp, isBlockedIpv4, isBlockedIpv6 };
