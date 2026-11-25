'use strict';

// These are pure unit tests for the SSRF IP-range logic and scheme/credential
// checks. They do not require a database. The DNS-resolution path is exercised
// indirectly; range logic is tested directly against isBlockedIp.
const { isBlockedIp, assertSafeUrl, SsrfError } = require('../apps/api/src/utils/ssrf');

describe('SSRF IP range blocking', () => {
  const blocked = [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:10.0.0.1',
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'];

  test.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  test.each(allowed)('allows public %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  test('rejects non-IP strings as unsafe', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('assertSafeUrl scheme/credential checks', () => {
  test('rejects non-http(s) scheme', async () => {
    await expect(assertSafeUrl('ftp://example.com')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
  });

  test('rejects malformed URL', async () => {
    await expect(assertSafeUrl('http://')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('notaurl')).rejects.toBeInstanceOf(SsrfError);
  });

  test('rejects URLs containing credentials', async () => {
    await expect(assertSafeUrl('http://user:pass@example.com')).rejects.toBeInstanceOf(SsrfError);
  });
});
