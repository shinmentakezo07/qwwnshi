/**
 * Tests for browserTransport header/cookie handling.
 *
 * These never launch a browser: the header sanitizer, cookie parser and
 * chunk-relay logic are pure and take injected inputs. CI installs no browser,
 * so a test that needed one would fail there.
 */
import { describe, expect, it } from 'bun:test';
import { parseCookieHeader, sanitizeHeaders } from './browserTransport.ts';

describe('sanitizeHeaders', () => {
  it('should strip headers the browser owns', () => {
    // Passing these to fetch() inside a page throws "Failed to fetch".
    const out = sanitizeHeaders({
      cookie: 'token=abc',
      'user-agent': 'Fake/1.0',
      origin: 'https://evil.test',
      referer: 'https://evil.test/',
      host: 'evil.test',
    });
    expect(out).toEqual({});
  });

  it('should strip the whole sec-* family', () => {
    const out = sanitizeHeaders({
      'sec-ch-ua': '"Chromium";v="142"',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-gpc': '1',
    });
    expect(out).toEqual({});
  });

  it('should keep headers the page can legitimately set', () => {
    const out = sanitizeHeaders({
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      source: 'web',
      version: '0.2.91',
      timezone: 'Sun Sep 13 2026 23:04:05 GMT+0545',
      'x-request-id': 'abc-123',
    });
    expect(out).toEqual({
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      source: 'web',
      version: '0.2.91',
      timezone: 'Sun Sep 13 2026 23:04:05 GMT+0545',
      'x-request-id': 'abc-123',
    });
  });

  it('should drop our hand-made bx tokens — the page generates real ones', () => {
    const out = sanitizeHeaders({
      'bx-ua': '231!fake',
      'bx-umidtoken': 'fake',
      'bx-pp': 'fake',
      accept: 'application/json',
    });
    expect(out).toEqual({ accept: 'application/json' });
  });

  it('should be case-insensitive about the names it strips', () => {
    const out = sanitizeHeaders({ Cookie: 'a=1', 'User-Agent': 'x', ACCEPT: 'application/json' });
    expect(out).toEqual({ ACCEPT: 'application/json' });
  });

  it('should return an empty object for empty input', () => {
    expect(sanitizeHeaders({})).toEqual({});
  });
});

describe('parseCookieHeader', () => {
  it('should split a cookie header into name/value pairs', () => {
    expect(parseCookieHeader('a=1; b=2')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });

  it('should preserve "=" inside a value', () => {
    // JWTs are padded with "=" and must survive intact.
    expect(parseCookieHeader('token=abc==; x=1')).toEqual([
      { name: 'token', value: 'abc==' },
      { name: 'x', value: '1' },
    ]);
  });

  it('should ignore empty segments and malformed pairs', () => {
    expect(parseCookieHeader('a=1;;  ; novalue; b=2')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });

  it('should return an empty list for an empty header', () => {
    expect(parseCookieHeader('')).toEqual([]);
  });
});
