/**
 * wafRecovery — cookie header helpers for the WAF recovery path.
 *
 * These exist because the naive "append if missing" approach silently no-ops:
 * a cookie string saved at login already contains acw_tc, so a freshly fetched
 * replacement was thrown away and the retry replayed the stale value.
 *
 * Cookie names are matched on exact name boundaries — a plain `includes()`
 * would treat `xacw_tc` as `acw_tc` and `csrf_token` as `token`.
 */

/** Matches `; name=` or a leading `name=` exactly. */
function cookiePattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|;\\s*)${escaped}=[^;]*`);
}

/** Replace `name`'s value in a cookie header, appending it when absent. */
export function replaceCookie(cookieStr: string, name: string, value: string): string {
  const pattern = cookiePattern(name);
  if (pattern.test(cookieStr)) {
    return cookieStr.replace(pattern, `$1${name}=${value}`);
  }
  return cookieStr ? `${cookieStr}; ${name}=${value}` : `${name}=${value}`;
}

/**
 * Merge a freshly fetched acw_tc into the cookie header, replacing any stale
 * value. Returns the original string when no fresh value was obtained.
 */
export function mergeAcwTc(cookieStr: string, freshAcwTc: string | null): string {
  if (!freshAcwTc) return cookieStr;
  return replaceCookie(cookieStr, 'acw_tc', freshAcwTc);
}
