# Issue Report — Qwen account configuration failing (`Cookie refresh failed — cannot retry`)

**Date:** 2026-09-13
**Version:** 0.7.0
**Base commit:** `5220f7d`
**Status:** All three issues fixed and verified end-to-end

---

## 1. Executive summary

Account configuration was aborting for every Qwen account, so tools-off / memory-off /
custom system prompt were never applied. The visible error was misleading:

```
[Qwen] Error configuring acc1@example.com: Cookie refresh failed for
  https://chat.qwen.ai/api/v2/users/user/settings/update — cannot retry
```

The real cause was that **Playwright's pinned browser revision did not exist on disk**,
so the browser fallback could never launch.

Fixing that exposed a second, larger problem: the aliyun WAF had begun **blocking the
`wreq-js` HTTP client entirely**, on every endpoint. That required replacing the transport.

Testing the new transport end-to-end then exposed a third: **`chats/new` hung**, so no chat
could start, because the WAF requires the SPA's header set (`version`, `x-request-id`,
`timezone`) on that endpoint.

Three distinct issues, all fixed:

| # | Issue | Root cause | Status |
|---|---|---|---|
| 1 | Browser could not launch | Playwright's pinned revision absent from cache | Fixed, verified |
| 2 | Every API call WAF-blocked | WAF fingerprints the wreq-js client | Fixed, verified |
| 3 | `chats/new` hung | Endpoint requires the SPA's `version`/`x-request-id`/`timezone` headers | Fixed, verified |

---

## 2. Issue 1 — Playwright's pinned browser revision was missing

### Symptom

```
warn  fireyejs   Cookie refresh via browser failed: launch: Executable doesn't
                 exist at /home/zeus/.cache/ms-playwright/chromium_headless_shell-1223/
                 chrome-headless-shell-linux64/chrome-headless-shell
error system     [Qwen] Error configuring acc1@example.com: Cookie refresh
                 failed ... — cannot retry
```

### Root cause

`src/services/fireyejsRunner.ts` called `chromium.launch()` with **no `executablePath`**,
so Playwright resolved its own pinned revision — which was not installed:

| | |
|---|---|
| `playwright@1.60.0` (direct dep) → nested `playwright-core@1.60.0` | pins revision **1223** |
| `playwright-core@1.61.0` (also a direct dep) | pins revision **1228** |
| Actually on disk | `chromium-1234`, `chromium-1243`, `chromium_headless_shell-1234`, `-1243` |

**Neither 1223 nor 1228 existed** — no installed Playwright pinned a revision present on
the host.

The `/home/zeus` path was also confusing. Playwright computes its cache directory as
`XDG_CACHE_HOME || os.homedir()/.cache` (`playwright-core/lib/coreBundle.js:28588`),
**not** `HOME`. Here `XDG_CACHE_HOME=/home/zeus/.cache` while `HOME=/teamspace/studios/this_studio`.

Reproduced under the real runtime (`bun`):

```
bare chromium.launch()            -> FAIL  .../chromium_headless_shell-1223/...
with executablePath chromium-1234 -> PASS  (loaded example.com)
```

### Why other paths worked

`cloakbrowser` passes an **explicit** `executablePath` resolved from
`~/.cloakbrowser/chromium-<ver>/chrome`, which did exist — so login and profile paths
were unaffected. `cdpScreencast.ts` also worked because it spawns a probed binary path
directly rather than trusting Playwright's registry.

### Contributing factor

`install.sh:108-113` wraps the browser install in a non-fatal handler:

```sh
if npx playwright install 2>/dev/null; then ok "..."; else warn "continuing anyway"; fi
```

So a failed browser install was silently swallowed and the server shipped with a launch
path that could never succeed.

### Fix

New `src/utils/browserBinary.ts` resolves a real Chrome binary and passes it as
`executablePath`. Revisions are **discovered by reading the cache directory**, never
hardcoded — hardcoding is exactly what made the older resolver stale.

- `buildChromeCandidates(env, deps)` — ordered candidate list (env overrides → Playwright
  cache → cloakbrowser → puppeteer → PATH), revisions sorted numerically newest-first.
- `probeChromeBinary(bin)` — `bin --version` must exit 0. Rejects broken wrappers.
- `resolveChromeExecutable()` — throws with searched paths and a fix hint.
- Honors `CHROME_PATH`, `CHROME_BIN`, `PUPPETEER_EXECUTABLE_PATH`,
  `CLOAKBROWSER_BINARY_PATH`, `CLOAKBROWSER_CACHE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`.

Also removed a latent bug in the same area: `fireyejsRunner.ts` guarded the cached browser
with `browser._closed`, **which does not exist on Playwright's `Browser`** (it is
`undefined` both before and after `close()`). It now uses `isConnected()`. Previously a
crashed browser was never detected and would be reused until restart.

### Verification

```
Chrome binary resolved: /home/zeus/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
Cookies refreshed via browser: acw_tc=0a03e58a17893198172264510e424f27450be4552c894a788e897...
```

---

## 3. Issue 2 — The WAF blocked the HTTP client entirely

### Symptom

After Issue 1 was fixed, requests still failed, but differently:

```
WAF detected on .../api/v2/files/getstsToken — trying HTTP refresh first...
HTTP refresh failed — trying Playwright browser...
WAF challenge persists after cookie refresh for .../api/v2/files/getstsToken
```

### Root cause

**The aliyun WAF fingerprints the HTTP client, not the request.** Control test — same URL,
same cookies, same headers:

| Client | `/api/v2/users/status` |
|---|---|
| Real Chrome (Playwright) | `200 application/json` — **passes** |
| `wreqFetch` (wreq-js) | `200 text/html` + `aliyun_waf` — **blocked** |

The blocking response is HTTP **200** with `content-type: text/html` and an
`aliyun_waf_aa`/`aliyun_waf_bb` JS challenge body (~16 KB).

Ruled out by direct experiment:

- **Cookies.** Harvested a complete real-browser set (`acw_tc, cna, tfstk, isg, xlly_s,
  cbc, atpsida, ssxmod_itna, ssxmod_itna2`) and replayed it verbatim through `wreqFetch`
  → still blocked.
- **Headers.** A configuration that passed was blocked minutes later with identical
  headers, while the browser kept passing. Not header-driven.
- **Impersonation profile.** Both `chrome_142` (default) and `chrome_147` (newest wreq-js
  offers) blocked. wreq-js has no Chrome 153 profile; the real browser is Chrome 153.

### Fix

New `src/services/browserTransport.ts` issues API requests **from inside a real Chrome
page** that has already passed the challenge.

- **Streaming preserved.** Chunks relay out via `page.exposeBinding` as they arrive.
  Measured: 5 chunks over 1191 ms (`+25 +314 +614 +914 +1216 ms`) — incremental, not
  buffered. This was verified *before* committing to the design.
- **Header handling.** The browser owns `cookie`/`user-agent`/`origin`/`referer`/`host`/
  `content-length`/`connection`/`accept-encoding` and the whole `sec-*` family — passing
  any of them makes `fetch` fail with "Failed to fetch". Cookies are injected via
  `context.addCookies` instead.
- **Our `bx-*` tokens are dropped.** The page's own AWSC/baxia scripts generate authentic
  ones; sending ours alongside conflicts.
- **Isolation.** One `BrowserContext` per request, so per-account cookies never leak.

`browserlessFetch` now delegates to it. The wreq prelude was deleted — hand-made `bx-ua`/
`bx-pp`/`bx-umidtoken` generation and the `acw_tc` refresh timer, which were both
pointless and harmful (the latter also installed a 15-minute `setInterval`).

### Supporting fixes found while investigating

Two latent bugs in the WAF recovery path, both real, both fixed in
`src/services/wafRecovery.ts` (with tests):

1. **Fresh `acw_tc` was discarded.** The code appended only when absent
   (`!currentCookie.includes('acw_tc=')`), but login always saves an `acw_tc`, so a
   freshly fetched value was thrown away every time.
2. **The retry re-sent the rejected `bx-umidtoken`.** The retry deleted `bx-ua`/`bx-pp`/
   `acw_tc` from the cache but not `bx-umidtoken`, *and* `ensureBxUmidtoken()` returns
   early when the header is already set — so both layers short-circuited.

Also corrected `QWEN_BX_V` from `2.5.36` → `2.5.37` to match the `baxia/2.5.37` the real
client loads (confirmed from a HAR capture).

### Verification

```
status=200 ct=application/json aliyun_waf=ABSENT (passes)
body={"success":true,"request_id":"f17febae-3a9a-41e2-9728-5a95368aa834","data":true}
```

---

## 4. Bugs introduced during the fix (and corrected)

Recorded for honesty; both were caught and fixed before completion.

1. **A hang in the new transport.** If the in-page fetch failed *before* relaying the
   response head, `resolveHead` was never called, so `browserFetch` never returned and the
   context leaked. Measured **25 s+ hang → 32 ms** with a clear error, plus a 30 s head
   timeout as a backstop.
2. **Orphaned Chrome processes** from repeated test scripts (7 left running, ~36 min old).
   Cleaned up; the application server was unaffected.

---

## 5. Files changed

### New

| File | Lines | Purpose |
|---|---|---|
| `src/services/browserTransport.ts` | 323 | Browser-backed `fetch` returning a streaming `Response` |
| `src/utils/browserBinary.ts` | 289 | Chrome binary resolver (no hardcoded revisions) |
| `src/services/wafRecovery.ts` | 34 | Cookie-header merge helpers |
| `src/services/browserTransport.test.ts` | 99 | Header/cookie unit tests |
| `src/utils/browserBinary.test.ts` | 192 | Resolver unit tests |
| `src/services/wafRecovery.test.ts` | 73 | Merge regression tests |

### Modified

| File | Change |
|---|---|
| `src/services/browserlessFetch.ts` | 286 → 130 lines; delegates to `browserFetch` |
| `src/services/cdpScreencast.ts` | Removed stale hardcoded paths; delegates to the shared resolver |
| `src/services/fireyejsRunner.ts` | `executablePath`; `isConnected()` guard; exports `getBrowser` |
| `src/routes/chat.ts` | Added missing `cancel()` handler (see §7) |
| `src/services/qwen.ts` | `bx-v` 2.5.37; wired the abort signal |
| `src/services/playwright.ts` | Guarded the unreachable firefox/webkit branch |

`src/services/cdpScreencast.ts` previously hardcoded `chromium-1234` and a puppeteer path
(`linux-150.0.7871.24`) that no longer existed, hardcoded a fallback home
(`/home/youssefsrv`), and fell back to the bare name `chromium-browser` — which on this
host is a **snap stub that exits 1**.

---

## 6. Test results

```
bunx biome check src/   → Checked 109 files. No fixes applied.
bunx tsc --noEmit       → exit 0
bun test                → 194 pass, 0 fail (17 files)
```

Baseline before this work was 166 tests; 28 added, all browser-free so CI (which never
runs `playwright install`) stays green.

---

## 7. Issue 3 — `chats/new` hung; chat completions could not start

Found while testing chat end-to-end against the running server, after Issues 1 and 2 were
fixed. Boot, account configuration, uploads, and `/v1/models` all worked, but every chat
request failed with `Session acquire timed out after 30000ms`.

### Symptom

```
warn  chat        [Chat] Session acquire failed for …: Session acquire timed out after 30000ms
warn  browserless POST https://chat.qwen.ai/api/v2/chats/new failed after 60125ms:
                  evaluate: Target page, context or browser has been closed
```

### Investigation

Isolation against the same warm page showed the failure was **endpoint-specific**:

| Request | Result |
|---|---|
| `GET /api/v2/models/` | `200 application/json` in 328 ms |
| `POST /api/v2/users/status` | `200 application/json` in 314 ms |
| `POST /api/v2/chats/new` | **never completes** |

Two things were ruled out along the way:

- **Not a wedged page.** Polling `page.evaluate(() => 1+1)` during the hang returned `2`
  every time — the page stayed responsive while the request stalled.
- **Not the account or cookies.** Driving the real UI (type a message, press Enter) made
  the SPA's own `POST /api/v2/chats/new` return `200` and create a chat.

Capturing the SPA's request byte-for-byte showed it sent six headers that our callers did
not: `version`, `x-request-id`, `timezone`, `accept-language`, `bx-ua`, `bx-umidtoken`.

### Root cause

**`chats/new` requires the SPA's header set.** Isolated to a single variable on one page
with identical tokens and body:

| Headers sent | Result |
|---|---|
| `content-type`, `accept`, `source` | hangs |
| + `version` | hangs |
| + `version`, `x-request-id`, `timezone` | **`200 application/json` in 380 ms** |

`sessionPool.ts` sent only `content-type`/`accept`/`source`/`cookie`/`origin`/`referer`.
Without `version`/`x-request-id`/`timezone`, the WAF answers with a challenge whose body
never completes — so the `evaluate` never settles and the request hangs until timeout.

### Fix

`browserTransport.ts` now adds the SPA headers itself (`withSpaHeaders`) rather than
requiring every caller to remember them:

```ts
const SPA_VERSION = '0.2.91';
function withSpaHeaders(headers) {
  // version / x-request-id / timezone, unless the caller set them
}
```

### Supporting fixes

- **Unbounded hang.** The non-streaming path had no timeout, so a challenged request
  leaked its `BrowserContext` forever (observed: 14–20 orphaned Chrome processes). A
  `REQUEST_TIMEOUT_MS = 20_000` ceiling now bounds it and the page is evicted.
- **AWSC token harvesting.** AWSC attaches `bx-ua`/`bx-umidtoken` only to the app's bundled
  HTTP client — not to a page's `fetch`, and not to `XMLHttpRequest` (both verified).
  `AWSC.use('um', cb)` is reachable but exposes only `st`, `init`, `getVersion`
  (`107.85`) — **no token getter**. The tokens are now harvested from the SPA's own
  requests via `page.on('request')`, preferring `chats/*` traffic and rejecting the
  `default_not_value` placeholder AWSC emits before it has a real value.
- **Warm page pooling.** Navigating the SPA costs **6.5–7.4 s** per request; reusing a warm
  page costs **~0.4 s** (measured). Pages are pooled per account, since cookies are
  per-account. Streaming requests still get a dedicated context, always torn down.
- **`chat.ts` had no `cancel()` handler** on its re-wrapped stream, so a client disconnect
  never propagated upstream and leaked the page. Added.

### Verification

Non-streaming:

```
HTTP 200 in 17.154285s
{"choices":[{"index":0,"message":{"role":"assistant","content":"HELLO WORLD", …}}]}
```

Streaming — 7 SSE chunks with proper `chat.completion.chunk` deltas:

```
data: {"id":"chatcmpl-aad804bc-…","object":"chat.completion.chunk", …}
```

---

## 8. Issue 4 — Large context "didn't respond"; one account poisoned at boot

### Symptom

Requests carrying a large context never returned. A 225 KB payload hung until the client
gave up (105 s), while small requests worked.

### Root cause

**A warm page built without AWSC tokens was cached and reused forever.**

At boot the log showed one account healthy and one not:

```
Warm page ready for acc1@example.com but no awsc tokens captured — requests may be challenged
Warm page ready for acc2@example.com (awsc tokens: bx-ua, bx-umidtoken from /api/v2/chats/pinned)
```

`createWarmPage` waited up to 12 s for the SPA to emit a `chats/*` request carrying the
tokens, then **cached the page anyway** when none arrived. Every request through that page
was challenged and hung, and nothing ever rebuilt it — so that account stayed broken until
a restart.

This is why the failure *looked* size-related: it was really *which account got picked*.
Every 225 KB attempt routed to the token-less account; the healthy account handled small
uploads fine.

Size was ruled out directly — `getstsToken` with `filesize=225147` returned `200` in **418 ms**
in isolation.

### The upload pipeline (why large context behaves differently)

Large context is **not** sent inline. `chat.ts:196-218` merges system instructions, tool
results and chat history into one `context.txt`, uploads it, and attaches it to the message
as `files: [file]`. The code comments state why:

> *"NEVER fall back to sending the payload inline: Qwen bot-detects oversized user messages
> and the request hangs/spins."*

So context is held as an uploaded file the model reads server-side, not as a long prompt.
That path is: `getstsToken` → OSS upload (plain `fetch`, not the browser) → `parse` → poll
`parse/status`.

### Fix

1. **Never cache a token-less page** — `createWarmPage` now throws, so the build retries
   rather than poisoning the account.
2. **Trigger the `chats/*` request** rather than waiting up to 12 s hoping the SPA emits one.
3. **Retry a failed page build** instead of failing the request outright.

### Verification

Both accounts now bootstrap with tokens:

```
Warm page ready for acc1@example.com (awsc tokens: bx-ua from /api/v2/chats/pinned)
Warm page ready for acc2@example.com (awsc tokens: bx-ua, bx-umidtoken from /api/v2/chats/pinned)
```

Recall test — a marker buried mid-document in a 225,101-character payload:

```
HTTP 200 in 14.205001s
content: '7391_QXZ'          # the buried SECRET_CODE, returned exactly
```

Full upload pipeline, no timeouts:

```
Uploading 225147 bytes → Got STS token (0.4s) → Uploaded to OSS → Parse complete (~4s)
```

---

## 9. Current state

Server verified running with all fixes applied:

```
Account acc1@example.com configured (tools off, memory off)
Account acc2@example.com configured (tools off, memory off)
[2/5] Accounts configured: 2 ready
Background initialization complete
```

`GET /health` → `{"status":"ok","accounts":{"total":2,"authenticated":2,"available":2}}`

Verified working end-to-end: boot, account configuration, `/v1/models`, file upload
(`getstsToken` → OSS → parse), chat creation, and both streaming and non-streaming chat
completions.

All previous failure signatures are absent from the log: `aliyun_waf`,
`WAF challenge persists`, `Cookie refresh failed`, `Error configuring`,
`Executable doesn't exist`.

### Known gaps

- **`version: '0.2.91'` is hardcoded** in `browserTransport.ts`. It is the deployed SPA
  build and will go stale; a mismatch is a fingerprint signal. Worth reading it from the
  loaded page instead.
- **`install.sh` / `install.ps1` still swallow a failed browser install**
  (`|| warn "continuing anyway"`) — the contributing factor from §2.
- **Three browser stacks coexist**: `fireyejsRunner.getBrowser()` (API traffic),
  `playwright.ts` via cloakbrowser (login), and `cdpScreencast.ts` (raw CDP). Consolidating
  is out of scope but worth a follow-up.
