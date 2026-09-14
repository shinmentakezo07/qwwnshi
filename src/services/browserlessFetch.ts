/**
 * browserlessFetch — Qwen API access through a real browser page.
 *
 * Historically this proxied requests through a wreq-js worker (Rust + BoringSSL)
 * impersonating Chrome. The aliyun WAF now fingerprints that client regardless
 * of cookies or headers, so requests are issued from a real Chrome page that has
 * already passed the challenge — see browserTransport.ts.
 *
 * The bx-* tokens and acw_tc cookie that this module used to hand-craft are
 * gone: the page's own AWSC/baxia scripts produce authentic ones.
 */

import { logCrash, logEvent, logFetchCall } from '../utils/wreqCrashLogger.ts';
import { browserFetch, disposeBrowserTransport } from './browserTransport.ts';
import { logStore } from './logStore.ts';
import { QWEN_BX_V } from './qwen.ts';
import { tokenCache } from './tokenCache.ts';

export interface BrowserlessFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  accountEmail?: string;
  signal?: AbortSignal;
  /** Keep the session alive for streaming. Default false — session is closed after response. */
  stream?: boolean;
}

// ─── WAF check ──────────────────────────────────────────────────────────────

const wafCheck = (r: Response): boolean => {
  if (r.status === 302) return true;
  if (r.status === 403) return true;
  if (r.status === 200) {
    try {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
};

/**
 * Make a browserless HTTP request to Qwen API.
 *
 * Returns a standard Web API Response object.
 * Use `response.body.getReader()` for SSE streaming.
 */
export async function browserlessFetch(url: string, options: BrowserlessFetchOptions = {}): Promise<Response> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const { method = 'GET', headers = {}, body } = options;
    return globalThis.fetch(url, { method, headers, body });
  }

  const { method = 'GET', headers = {}, body, signal, stream, accountEmail } = options;

  // No bx-token or acw_tc injection here any more. The page's own AWSC/baxia
  // scripts generate authentic bx-ua/bx-pp/bx-umidtoken and the WAF cookies,
  // and browserTransport strips our hand-made copies so they cannot conflict.
  if (!headers['bx-v']) headers['bx-v'] = QWEN_BX_V;

  const startTime = Date.now();

  // ─── Request via the browser transport ───────────────────────────────
  // The aliyun WAF fingerprints the HTTP client, not the request: wreq-js gets
  // a 200 + text/html challenge even with a full real-browser cookie set, while
  // a real Chrome returns 200 application/json. So the request is issued from a
  // page that has already passed the challenge.
  try {
    logFetchCall('browserlessFetch', url, method);
    const response = await browserFetch(url, {
      method,
      headers,
      body,
      signal,
      accountEmail,
      stream: !!stream,
    });
    logFetchCall('browserlessFetch', url, method, response.status);

    // Should not happen now that a real browser issues the request, but a
    // challenge here means the WAF has tightened — log it loudly rather than
    // silently returning an HTML page to callers.
    if (wafCheck(response)) {
      logEvent('browserlessFetch', 'WAF detected', { url: url.split('?')[0], status: response.status });
      logStore.log(
        'error',
        'browserless',
        `WAF challenge returned via browser transport for ${url.split('?')[0]} — WAF may have tightened`,
      );
    }

    const elapsed = Date.now() - startTime;
    logStore.log('debug', 'browserless', `${method} ${url.split('?')[0]} → ${response.status} (${elapsed}ms)`);

    // For streaming: stash noop close function so qwen.ts doesn't break
    if (stream) {
      (response as any)._wreqClose = () => {
        // Each request owns its own context — closing it happens with the body.
      };
    }

    return response;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);

    // Classify crash type for easier analysis
    const errStr = msg.toLowerCase();
    if (errStr.includes('waf') || errStr.includes('aliyun_waf') || errStr.includes('403') || errStr.includes('302')) {
      logEvent('browserlessFetch', 'WAF error', { url: url.split('?')[0], method, error: msg.substring(0, 200), elapsed_ms: elapsed });
    } else {
      logCrash('browserlessFetch', err, { url: url.split('?')[0], method, elapsed_ms: elapsed });
    }

    logStore.log('warn', 'browserless', `${method} ${url.split('?')[0]} failed after ${elapsed}ms: ${msg}`);

    if (msg.includes('403') || msg.includes('FAIL_SYS_USER_VALIDATE')) {
      tokenCache.delete('bx-umidtoken');
    }

    throw err;
  }
}

/** Release transport resources. Call on app shutdown. */
export async function disposeSession(_accountEmail?: string): Promise<void> {
  await disposeBrowserTransport();
}
