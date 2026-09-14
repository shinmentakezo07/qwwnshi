/**
 * Tests for WAF recovery header handling.
 *
 * Regression guards for two bugs that made "HTTP refresh failed — trying
 * Playwright browser..." fire on every WAF hit even though the acw_tc refresh
 * had actually succeeded:
 *
 *   1. A freshly fetched acw_tc was discarded whenever the existing cookie
 *      string already contained one — which it always does, because login
 *      saves the full cookie set.
 *   2. The retry path asked for a fresh bx-umidtoken but both the header and
 *      the cache short-circuited, so the rejected token was re-sent verbatim.
 */
import { describe, expect, it } from 'bun:test';
import { mergeAcwTc, replaceCookie } from './wafRecovery.ts';

describe('mergeAcwTc', () => {
  it('should replace an existing acw_tc rather than keeping the stale one', () => {
    const merged = mergeAcwTc('cna=abc; acw_tc=OLD; token=jwt', 'NEW');
    expect(merged).toContain('acw_tc=NEW');
    expect(merged).not.toContain('acw_tc=OLD');
  });

  it('should preserve the other cookies when replacing', () => {
    const merged = mergeAcwTc('cna=abc; acw_tc=OLD; token=jwt', 'NEW');
    expect(merged).toContain('cna=abc');
    expect(merged).toContain('token=jwt');
  });

  it('should append acw_tc when none is present', () => {
    const merged = mergeAcwTc('cna=abc; token=jwt', 'NEW');
    expect(merged).toContain('acw_tc=NEW');
    expect(merged).toContain('cna=abc');
  });

  it('should return the fresh value alone when there is no existing cookie', () => {
    expect(mergeAcwTc('', 'NEW')).toBe('acw_tc=NEW');
  });

  it('should leave the cookie string untouched when no fresh value is available', () => {
    const original = 'cna=abc; acw_tc=OLD';
    expect(mergeAcwTc(original, null)).toBe(original);
  });

  it('should not be fooled by a cookie whose name merely contains acw_tc', () => {
    // "xacw_tc" must not be mistaken for the real cookie.
    const merged = mergeAcwTc('xacw_tc=DECOY; cna=abc', 'NEW');
    expect(merged).toContain('xacw_tc=DECOY');
    expect(merged).toContain('acw_tc=NEW');
  });
});

describe('replaceCookie', () => {
  it('should swap a named cookie in place', () => {
    expect(replaceCookie('a=1; token=OLD; b=2', 'token', 'NEW')).toBe('a=1; token=NEW; b=2');
  });

  it('should append when the cookie is absent', () => {
    expect(replaceCookie('a=1', 'token', 'NEW')).toBe('a=1; token=NEW');
  });

  it('should not match a cookie that merely ends with the name', () => {
    // "csrf_token" must survive a "token" replacement.
    const out = replaceCookie('csrf_token=KEEP; token=OLD', 'token', 'NEW');
    expect(out).toContain('csrf_token=KEEP');
    expect(out).toContain('token=NEW');
    expect(out).not.toContain('token=OLD');
  });

  it('should handle an empty cookie string', () => {
    expect(replaceCookie('', 'token', 'NEW')).toBe('token=NEW');
  });
});
