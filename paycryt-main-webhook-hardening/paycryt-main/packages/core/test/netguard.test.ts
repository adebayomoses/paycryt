import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, isPrivateHost } from '@paycryt/core';

describe('isPrivateHost', () => {
  it.each([
    'localhost', 'api.localhost', 'printer.local', 'db.internal', 'router.lan',
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '[::1]', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1',
    'localhost.', '',
  ])('treats %s as private', (h) => expect(isPrivateHost(h)).toBe(true));

  it.each([
    'example.com', 'hooks.merchant.ng', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1',
    '2606:4700:4700::1111', '[2001:4860:4860::8888]', '::ffff:8.8.8.8',
  ])('treats %s as public', (h) => expect(isPrivateHost(h)).toBe(false));

  it('refuses an IPv6 literal it cannot parse instead of letting it through', () => {
    expect(isPrivateHost('1:2:3')).toBe(true);
    expect(isPrivateHost('::g')).toBe(true);
  });
});

describe('assertPublicHttpUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(assertPublicHttpUrl('https://hooks.example.com/paycryt').hostname).toBe('hooks.example.com');
    expect(() => assertPublicHttpUrl('http://hooks.example.com')).not.toThrow();
  });

  it('rejects private targets, including numeric-host tricks the URL parser normalises', () => {
    for (const u of [
      'http://localhost:8080/x', 'http://127.0.0.1/x', 'http://2130706433/x', 'http://0x7f.1/x',
      'http://[::1]/x', 'http://169.254.169.254/latest/meta-data', 'https://intranet.internal/hook',
    ]) expect(() => assertPublicHttpUrl(u), u).toThrow(/private|loopback|internal/);
  });

  it('rejects non-http schemes, credentials, garbage, and (when asked) plain http', () => {
    expect(() => assertPublicHttpUrl('ftp://example.com')).toThrow(/http/);
    expect(() => assertPublicHttpUrl('https://user:pw@example.com')).toThrow(/credentials/);
    expect(() => assertPublicHttpUrl('not a url')).toThrow(/valid URL/);
    expect(() => assertPublicHttpUrl('http://example.com', { requireHttps: true })).toThrow(/https/);
  });
});
