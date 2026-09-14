/**
 * Tests for requestTimeout — scales the per-attempt timeout to payload size.
 *
 * A fixed 30s ceiling fails large-context requests: measured through the
 * gateway, a ~517K-token payload needs ~41s. The timeout grows with the
 * request, but is always bounded so a stuck request cannot hang forever.
 */
import { describe, expect, it } from 'bun:test';
import { attemptTimeoutForPayload, BASE_ATTEMPT_TIMEOUT_MS, MAX_ATTEMPT_TIMEOUT_MS } from './requestTimeout.ts';

describe('attemptTimeoutForPayload', () => {
  it('should use the base timeout for a small payload', () => {
    expect(attemptTimeoutForPayload(1_000)).toBe(BASE_ATTEMPT_TIMEOUT_MS);
  });

  it('should use the base timeout at the small-payload boundary', () => {
    expect(attemptTimeoutForPayload(100_000)).toBe(BASE_ATTEMPT_TIMEOUT_MS);
  });

  it('should grow the timeout for a large payload', () => {
    // Measured: ~517K tokens (~2.07M chars) completes in ~41s.
    const t = attemptTimeoutForPayload(2_070_000);
    expect(t).toBeGreaterThan(40_000);
  });

  it('should never exceed the maximum', () => {
    expect(attemptTimeoutForPayload(50_000_000)).toBe(MAX_ATTEMPT_TIMEOUT_MS);
  });

  it('should increase monotonically with payload size below the cap', () => {
    const sizes = [150_000, 500_000, 1_000_000, 2_000_000];
    // Wrap in an arrow: a bare `.map(fn)` would pass the array index as the
    // second argument, which is `overrideMs`.
    const timeouts = sizes.map((s) => attemptTimeoutForPayload(s));
    for (let i = 1; i < timeouts.length; i++) {
      expect(timeouts[i]).toBeGreaterThan(timeouts[i - 1]);
    }
  });

  it('should flatten at the cap for payloads beyond it', () => {
    // Past the ceiling more payload buys no more time — the cap is the point.
    // 8M chars is comfortably past it; 4M is not.
    expect(attemptTimeoutForPayload(8_000_000)).toBe(MAX_ATTEMPT_TIMEOUT_MS);
    expect(attemptTimeoutForPayload(50_000_000)).toBe(MAX_ATTEMPT_TIMEOUT_MS);
  });

  it('should treat a zero or negative payload as the base timeout', () => {
    expect(attemptTimeoutForPayload(0)).toBe(BASE_ATTEMPT_TIMEOUT_MS);
    expect(attemptTimeoutForPayload(-5)).toBe(BASE_ATTEMPT_TIMEOUT_MS);
  });

  it('should honour an explicit override', () => {
    expect(attemptTimeoutForPayload(2_000_000, 90_000)).toBe(90_000);
  });

  it('should clamp an override to the maximum', () => {
    expect(attemptTimeoutForPayload(1_000, 10_000_000)).toBe(MAX_ATTEMPT_TIMEOUT_MS);
  });
});
