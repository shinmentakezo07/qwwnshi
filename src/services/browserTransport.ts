/**
 * browserTransport — perform Qwen API requests from inside a real Chrome page.
 *
 * Why: the aliyun WAF fingerprints the HTTP client, not the request. Requests
 * sent by wreq-js (even with a full set of real-browser cookies replayed
 * verbatim) get a 200 + text/html challenge page, while the same request issued
 * by a real Chrome returns 200 application/json. So API calls are made by a
 * page that has already passed the challenge.
 *
 * Streaming: chunks are relayed out of the page as they arrive via an exposed
 * binding, so SSE reaches the client incrementally rather than buffered.
 *
 * Non-streaming requests reuse a per-account warm page (navigating the SPA costs
 * ~7s, a warm request ~0.4s). Streaming requests get a dedicated context that is
 * always torn down, since a half-consumed SSE body leaves the page ambiguous.
 */
import { getBrowser } from './fireyejsRunner.ts';
import { logStore } from './logStore.ts';
import { Mutex } from './playwright.ts';
import { QWEN_API_BASE } from './qwen.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BrowserFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Keep the body streaming instead of buffering it. */
  stream?: boolean;
  /**
   * Account this request belongs to. Selects the warm page so per-account
   * cookies stay isolated and the SPA is not re-navigated per request.
   */
  accountEmail?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Headers a page's fetch() is not allowed to set. Passing any of these makes
 * the request fail outright with "Failed to fetch".
 */
const FORBIDDEN_HEADERS = new Set([
  'cookie',
  'user-agent',
  'origin',
  'referer',
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'accept-charset',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'proxy-authorization',
]);

/**
 * Our own bx tokens are dropped: the page's AWSC/fireyejs scripts generate
 * authentic ones, and sending ours alongside them conflicts.
 */
const GENERATED_TOKEN_HEADERS = new Set(['bx-ua', 'bx-pp', 'bx-umidtoken', 'bx-et']);

const NAV_TIMEOUT_MS = 30_000;

/** How long to wait for the page to relay the response head before giving up. */
const HEAD_TIMEOUT_MS = 30_000;

/** Ceiling on a non-streaming request, so a hung page cannot leak a context. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Response headers worth surfacing to callers; the rest are browser noise. */
const RELAYED_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'cache-control', 'date', 'set-cookie'];

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Drop headers the browser owns or that it generates itself. */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) continue;
    if (lower.startsWith('sec-')) continue;
    if (GENERATED_TOKEN_HEADERS.has(lower)) continue;
    out[name] = value;
  }
  return out;
}

/** Parse a `name=value; name2=value2` cookie header into pairs. */
export function parseCookieHeader(header: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name && value) out.push({ name, value });
  }
  return out;
}

/** Keep only the response headers we deliberately relay. */
function pickResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = headers[name];
    if (value) out[name] = value;
  }
  return out;
}

/**
 * Headers the WAF expects on every API call, which the SPA always sends but
 * callers here do not necessarily set.
 *
 * Measured on /api/v2/chats/new: with these present the request returns
 * `200 application/json` in ~380ms; without them the same request is answered
 * with a challenge whose body never completes, so it hangs until timeout.
 * `version` must track the deployed SPA build (the client rejects a mismatch).
 */
const SPA_VERSION = '0.2.91';

function withSpaHeaders(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  if (!out.version) out.version = SPA_VERSION;
  if (!out['x-request-id']) out['x-request-id'] = crypto.randomUUID();
  if (!out.timezone) {
    try {
      out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      /* leave unset */
    }
  }
  return out;
}

/**
 * Overlay the AWSC tokens harvested from the SPA's own traffic onto our request
 * headers. `sanitizeHeaders` strips any caller-supplied copies, so these are the
 * only source of bx-ua/bx-umidtoken.
 */
function withAwscTokens(headers: Record<string, string>, tokens: Record<string, string>): Record<string, string> {
  const out = withSpaHeaders(headers);
  for (const [name, value] of Object.entries(tokens)) {
    if (value) out[name] = value;
  }
  return out;
}

// ─── Warm page pool ──────────────────────────────────────────────────────────
//
// Navigating the Qwen SPA costs 6.5-7.4s per request; issuing a request against
// an already-loaded page costs ~0.4s. So each account keeps one warm page and
// reuses it. Pages are keyed by account because cookies are per-account.

interface WarmPage {
  context: any;
  page: any;
  lastUsed: number;
  /**
   * Serializes requests on this page.
   *
   * The relay binding is per-page, so two requests running concurrently on the
   * same page would overwrite each other's handler and cross-deliver chunks —
   * both responses arrive corrupted and neither recalls its own context. Only
   * one request may be in flight per page.
   */
  mutex: Mutex;
  /**
   * bx-ua / bx-umidtoken harvested from the SPA's own traffic.
   *
   * AWSC attaches these only to the app's bundled HTTP client — not to a
   * page's `fetch` or `XMLHttpRequest`. Without them the WAF answers
   * `/api/v2/chats/new` with a 200 text/html challenge that never resolves,
   * so the request hangs indefinitely. Replaying captured values makes the
   * same call return 200 application/json in ~400ms.
   */
  bxTokens: Record<string, string>;
}

/** Headers AWSC generates that we must replay on our own requests. */
const AWSC_HEADERS = ['bx-ua', 'bx-umidtoken'] as const;

/**
 * Placeholder AWSC emits before it has a real value (seen on /api/v1/auths/).
 * Sending it is worse than sending nothing.
 */
const AWSC_PLACEHOLDERS = new Set(['default_not_value', 'default', '']);

const warmPages = new Map<string, WarmPage>();

/** Idle warm pages are closed after this. */
const WARM_TTL_MS = 5 * 60 * 1000;

/** Upper bound on simultaneously cached pages. */
const MAX_WARM_PAGES = 8;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - WARM_TTL_MS;
    for (const [key, entry] of warmPages) {
      if (entry.lastUsed < cutoff) {
        warmPages.delete(key);
        entry.context.close().catch(() => {});
      }
    }
  }, 60_000);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/** Discard a cached page (used when the WAF challenges a warm page). */
function evictWarmPage(key: string): void {
  const entry = warmPages.get(key);
  if (!entry) return;
  warmPages.delete(key);
  entry.context.close().catch(() => {});
}

/** Close every cached page. Call on shutdown. */
export async function closeWarmPages(): Promise<void> {
  const entries = [...warmPages.values()];
  warmPages.clear();
  await Promise.all(entries.map((e) => e.context.close().catch(() => {})));
}

/**
 * Build a context+page that has loaded the Qwen SPA, so the AWSC/baxia scripts
 * have run and populated the WAF cookies the API expects.
 */
async function createWarmPage(key: string, headers: Record<string, string>): Promise<WarmPage> {
  const browser = await getBrowser();
  const context = await browser.newContext();

  const cookiePairs = parseCookieHeader(headers.cookie || '');
  if (cookiePairs.length > 0) {
    await context.addCookies(cookiePairs.map(({ name, value }) => ({ name, value, domain: '.qwen.ai', path: '/' })));
  }

  const page = await context.newPage();

  // Harvest the AWSC-generated tokens from the SPA's own requests. AWSC only
  // attaches them to the app's bundled client, so the only way to obtain them
  // is to observe traffic the app itself makes.
  //
  // bx-ua is a per-request signature (it differs across endpoints), so we keep
  // the newest one rather than the first. Requests that carry no token at all
  // (users/status, configs, models) must not overwrite a good capture.
  const bxTokens: Record<string, string> = {};
  let chatsTokenSeen = false;
  let tokenSource = '(none)';
  page.on('request', (req: any) => {
    try {
      const url = String(req.url());
      // Prefer a token harvested from a chats/* call: those are the values
      // observed to be accepted by chats/new. Tokens from /api/v1/auths/ and
      // similar carry a placeholder umidtoken and are rejected.
      const fromChats = /\/api\/v2\/chats\//.test(url);
      const h = req.headers();
      for (const name of AWSC_HEADERS) {
        const value = h[name];
        if (!value || AWSC_PLACEHOLDERS.has(value)) continue;
        if (fromChats || !bxTokens[name]) {
          bxTokens[name] = value;
          tokenSource = url.replace(QWEN_API_BASE, '').split('?')[0];
        }
        if (fromChats) chatsTokenSeen = true;
      }
    } catch {
      /* headers unavailable */
    }
  });

  try {
    await page.goto(QWEN_API_BASE, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }).catch(() => {});

    // Wait for AWSC to install its fetch wrapper and for the SPA to emit a
    // chats/* request carrying the tokens. Tokens harvested from other
    // endpoints are not accepted by chats/new.
    for (let i = 0; i < 24 && !chatsTokenSeen; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // The SPA does not always issue a chats/* call on load. If none arrived,
    // ask it for one directly — the list endpoint is the same one the UI uses
    // and its response carries the tokens we need.
    if (!chatsTokenSeen) {
      await page
        .evaluate(async (base: string) => {
          try {
            await fetch(`${base}/api/v2/chats/?page=1&exclude_project=true`, {
              headers: { accept: 'application/json, text/plain, */*', source: 'web' },
              credentials: 'include',
            });
          } catch {
            /* best effort — token capture is what matters */
          }
        }, QWEN_API_BASE)
        .catch(() => {});

      for (let i = 0; i < 12 && !chatsTokenSeen; i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const got = Object.keys(bxTokens);
    if (got.length === 0) {
      // Never cache a token-less page. Every request through it would be
      // challenged and hang, and nothing would ever rebuild it — one slow
      // bootstrap would poison that account until restart.
      throw new Error(`no AWSC tokens captured for ${key} — page would be challenged`);
    }

    logStore.log('debug', 'browser', `Warm page ready for ${key} (awsc tokens: ${got.join(', ')} from ${tokenSource})`);
    return { context, page, lastUsed: Date.now(), mutex: new Mutex(), bxTokens };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

// ─── In-page request ─────────────────────────────────────────────────────────

interface PageHead {
  status: number;
  headers: Record<string, string>;
}

/**
 * Register the chunk relay and run the request inside the page.
 *
 * The binding is registered before evaluation so no early chunk is missed.
 * `onHead` fires as soon as status/headers are known, before the body ends.
 */
/**
 * Per-page relay sink.
 *
 * `page.exposeBinding` throws if a name is registered twice on the same page
 * ("Function __qwenEmit has been already registered"), so the binding is
 * installed once per page and the handler is swapped per request. Without this,
 * every reuse of a warm page throws and the page is discarded and rebuilt —
 * which cost ~4s per request instead of ~0.4s.
 */
const pageSinks = new WeakMap<any, { current: ((payload: unknown) => void) | null }>();

async function ensureRelayBinding(page: any): Promise<{ current: ((payload: unknown) => void) | null }> {
  const existing = pageSinks.get(page);
  if (existing) return existing;

  const sink: { current: ((payload: unknown) => void) | null } = { current: null };
  await page.exposeBinding('__qwenEmit', (_source: unknown, payload: unknown) => {
    sink.current?.(payload);
  });
  pageSinks.set(page, sink);
  return sink;
}

async function runInPage(
  page: any,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  stream: boolean,
  onChunk: (chunk: Uint8Array) => void,
  onHead: (head: PageHead) => void,
): Promise<{ status: number; headers: Record<string, string>; body?: string }> {
  const sink = await ensureRelayBinding(page);
  sink.current = (payload: unknown) => {
    const data = payload as { type: string; value?: string; status?: number; headers?: Record<string, string> };
    if (data.type === 'head') {
      onHead({ status: data.status ?? 0, headers: data.headers ?? {} });
    } else if (data.type === 'chunk' && data.value) {
      onChunk(new TextEncoder().encode(data.value));
    }
  };

  return page
    .evaluate(
      async (args: { url: string; method: string; headers: Record<string, string>; body?: string; stream: boolean }) => {
        const relay = (window as any).__qwenEmit;
        const relayHeaders = ['content-type', 'content-disposition', 'cache-control', 'date', 'set-cookie'];

        const res = await fetch(args.url, {
          method: args.method,
          headers: args.headers,
          body: args.body,
          credentials: 'include',
        });

        const picked: Record<string, string> = {};
        for (const name of relayHeaders) {
          const value = res.headers.get(name);
          if (value) picked[name] = value;
        }
        await relay({ type: 'head', status: res.status, headers: picked });

        if (!args.stream || !res.body) {
          return { status: res.status, headers: picked, body: await res.text() };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Relay as text — SSE payloads are UTF-8, and the binding serializes
          // strings without base64 overhead.
          await relay({ type: 'chunk', value: decoder.decode(value, { stream: true }) });
        }
        return { status: res.status, headers: picked };
      },
      { url, method, headers, body, stream },
    )
    .finally(() => {
      // Stop routing this request's chunks once it has settled.
      sink.current = null;
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Perform an HTTP request to Qwen from inside a real browser page.
 *
 * Returns a standard `Response`. When `stream` is set, `.body` yields chunks as
 * they arrive from upstream.
 */
export async function browserFetch(url: string, options: BrowserFetchOptions = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body, stream = false, signal, accountEmail } = options;

  const sentHeaders = sanitizeHeaders(headers);
  const target = url.startsWith('http') ? url : `${QWEN_API_BASE}${url}`;

  // ─── Non-streaming: reuse the account's warm page ────────────────────
  // Navigating the SPA costs ~7s; a warm page issues the request in ~0.4s.
  if (!stream) {
    const key = accountEmail || '_default_';
    startSweep();

    for (let attempt = 0; attempt < 2; attempt++) {
      let entry = warmPages.get(key);
      const stale = entry && (entry.page.isClosed() || Date.now() - entry.lastUsed > WARM_TTL_MS);

      if (!entry || stale) {
        if (entry) evictWarmPage(key);
        try {
          entry = await createWarmPage(key, headers);
        } catch (buildErr) {
          // Bootstrap failed (e.g. no AWSC tokens). Retry once on a fresh page
          // rather than failing the request outright.
          if (attempt === 1) throw buildErr;
          continue;
        }
        // Bound the cache; drop the least-recently-used beyond the cap.
        if (warmPages.size >= MAX_WARM_PAGES) {
          const lru = [...warmPages.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
          if (lru) evictWarmPage(lru[0]);
        }
        warmPages.set(key, entry);
      }

      entry.lastUsed = Date.now();

      // One request at a time per page: the relay binding is per-page, so
      // concurrent requests would cross-deliver each other's chunks.
      const release = await entry.mutex.acquire();
      try {
        // Bound the request. A challenged endpoint (notably /api/v2/chats/new)
        // returns a challenge page whose body never completes, so without this
        // the evaluate never settles and the context leaks forever.
        const result = await Promise.race([
          runInPage(
            entry.page,
            target,
            method,
            withAwscTokens(sentHeaders, entry.bxTokens),
            body,
            false,
            () => {},
            () => {},
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms for ${url.split('?')[0]}`)),
              REQUEST_TIMEOUT_MS,
            ),
          ),
        ]);
        return new Response(result.body ?? '', { status: result.status, headers: pickResponseHeaders(result.headers) });
      } catch (err) {
        // A dead or hung page must not be reused; drop it and retry once.
        evictWarmPage(key);
        if (attempt === 1) throw err;
      } finally {
        release();
      }
    }
    throw new Error(`browserFetch: unreachable for ${url.split('?')[0]}`);
  }

  // ─── Streaming: dedicated context, always torn down ──────────────────
  // A half-consumed SSE body leaves the page in an ambiguous state, so it is
  // never returned to the pool.
  const browser = await getBrowser();
  const context = await browser.newContext();

  // Closing the context settles any pending evaluate rather than leaking it.
  // Single-flight: cancel(), the evaluation's finally, and an abort can all race
  // to tear the same context down.
  let closed = false;
  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await context.close();
    } catch {
      /* already gone */
    }
  };

  try {
    const page = await context.newPage();

    const cookiePairs = parseCookieHeader(headers.cookie || '');
    if (cookiePairs.length > 0) {
      await context.addCookies(cookiePairs.map(({ name, value }) => ({ name, value, domain: '.qwen.ai', path: '/' })));
    }

    // Harvest the AWSC tokens the SPA emits, same as the warm-page path.
    const streamTokens: Record<string, string> = {};
    page.on('request', (req: any) => {
      try {
        const h = req.headers();
        for (const name of AWSC_HEADERS) {
          if (h[name]) streamTokens[name] = h[name];
        }
      } catch {
        /* headers unavailable */
      }
    });

    // Load the app first so the AWSC/baxia scripts run and populate the WAF
    // cookies (tfstk/isg) the API expects.
    await page.goto(QWEN_API_BASE, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }).catch(() => {});

    // Wait for the SPA to emit at least one token-carrying request.
    for (let i = 0; i < 24 && !streamTokens['bx-ua']; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }

    const streamHeaders = withAwscTokens(sentHeaders, streamTokens);

    if (!stream) {
      const result = await runInPage(
        page,
        target,
        method,
        streamHeaders,
        body,
        false,
        () => {},
        () => {},
      );
      await cleanup();
      return new Response(result.body ?? '', { status: result.status, headers: pickResponseHeaders(result.headers) });
    }

    // Streaming: resolve the head as soon as it is known, then return a
    // ReadableStream fed by the page's relayed chunks.
    let resolveHead!: (head: PageHead) => void;
    let rejectHead!: (err: Error) => void;
    const headPromise = new Promise<PageHead>((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const streamBody = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      async cancel() {
        // Client disconnected: tear down the context so the in-page reader
        // stops instead of running to completion.
        await cleanup();
      },
    });

    // An abort (first-chunk timeout, client disconnect) must release the page
    // and the upstream connection, not just stop the consumer.
    signal?.addEventListener('abort', () => {
      void cleanup();
    });

    runInPage(
      page,
      target,
      method,
      streamHeaders,
      body,
      true,
      (chunk) => {
        try {
          controller?.enqueue(chunk);
        } catch {
          /* stream already closed */
        }
      },
      resolveHead,
    )
      .then(() => {
        try {
          controller?.close();
        } catch {
          /* already closed */
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Settle the head too — otherwise a failure before the head is relayed
        // (in-page fetch throwing, navigation failure) would leave the caller
        // awaiting forever and leak the context.
        rejectHead(new Error(msg));
        try {
          controller?.error(new Error(msg));
        } catch {
          /* already closed */
        }
      })
      .finally(() => {
        cleanup().catch(() => {});
      });

    // Bound the wait: the head normally arrives within a round trip, so a long
    // silence means the page died without relaying anything.
    let headTimer: ReturnType<typeof setTimeout> | undefined;
    const head = await Promise.race([
      headPromise,
      new Promise<never>((_, reject) => {
        headTimer = setTimeout(() => reject(new Error(`No response head from page for ${url.split('?')[0]}`)), HEAD_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(headTimer));

    return new Response(streamBody, { status: head.status, headers: pickResponseHeaders(head.headers) });
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Release transport resources. Call on app shutdown. */
export async function disposeBrowserTransport(): Promise<void> {
  logStore.log('debug', 'browser', 'Browser transport disposed');
}
