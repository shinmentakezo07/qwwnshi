/**
 * requestTimeout — scale a request's per-attempt timeout to its payload size.
 *
 * A fixed 30s ceiling is too short for large contexts. Measured through the
 * gateway on 2026-09-14:
 *
 *   ~52K tokens  (  207K chars) -> 12.7s
 *   ~258K tokens (1.03M chars) -> 22.8s
 *   ~517K tokens (2.07M chars) -> 41.4s
 *
 * At 30s those large requests fail, and repeated failures then trip the
 * circuit breaker, which blocks every subsequent request until it resets.
 * So the timeout grows with the payload — but stays bounded, because an
 * unbounded timeout turns a stuck upstream into a hung gateway.
 */

/** Timeout for a small request; unchanged from the previous fixed value. */
export const BASE_ATTEMPT_TIMEOUT_MS = 30_000;

/** Ceiling, so a pathological payload cannot hang a worker indefinitely. */
export const MAX_ATTEMPT_TIMEOUT_MS = 180_000;

/** Payloads at or below this size keep the base timeout. */
const BASE_PAYLOAD_CHARS = 100_000;

/**
 * Extra budget per additional 100K characters, derived from the measurements
 * above (~19s per 1M characters, rounded up for headroom).
 */
const MS_PER_100K_CHARS = 2_000;

/**
 * Timeout for one attempt, scaled to `payloadChars`.
 *
 * @param payloadChars Serialized request size in characters.
 * @param overrideMs Explicit timeout; still clamped to the maximum.
 */
export function attemptTimeoutForPayload(payloadChars: number, overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) {
    return Math.min(overrideMs, MAX_ATTEMPT_TIMEOUT_MS);
  }

  if (!Number.isFinite(payloadChars) || payloadChars <= BASE_PAYLOAD_CHARS) {
    return BASE_ATTEMPT_TIMEOUT_MS;
  }

  const extraChunks = (payloadChars - BASE_PAYLOAD_CHARS) / 100_000;
  return Math.min(BASE_ATTEMPT_TIMEOUT_MS + extraChunks * MS_PER_100K_CHARS, MAX_ATTEMPT_TIMEOUT_MS);
}
