/**
 * browserBinary — resolve a runnable Chrome/Chromium executable.
 *
 * Why this exists: Playwright resolves its own *pinned* browser revision from
 * `XDG_CACHE_HOME || os.homedir()/.cache` + `/ms-playwright`. When that exact
 * revision is absent (a `playwright install` that failed, a version bump, or an
 * XDG_CACHE_HOME pointing at a different user's home) `chromium.launch()` throws
 * "Executable doesn't exist at ...". Passing an explicit `executablePath` from
 * this module makes launches independent of Playwright's pin.
 *
 * Revision numbers are discovered by reading the cache directory, never
 * hardcoded — a hardcoded revision is exactly what made the previous resolver
 * in cdpScreencast.ts go stale.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logStore } from '../services/logStore.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Filesystem operations, injectable so the search is testable without a real disk.
 * `readdir` must return an empty list for an absent directory, never throw.
 */
export interface ChromeSearchDeps {
  exists(path: string): boolean;
  readdir(dir: string): string[];
}

/** Environment the search runs against, injectable for tests. */
export interface ChromeSearchEnv {
  home: string;
  cwd: string;
  /** `os.homedir()` — may differ from `home` (e.g. under sudo). */
  osHome?: string;
  xdgCacheHome?: string;
  /** Explicit overrides (CHROME_PATH etc.), tried first. */
  overrides?: string[];
  /**
   * `PLAYWRIGHT_BROWSERS_PATH`. When set, Playwright uses it *instead of* the
   * cache dir entirely, so it replaces the ms-playwright roots.
   */
  playwrightBrowsersPath?: string;
  /** `CLOAKBROWSER_CACHE_DIR` — replaces the default `~/.cloakbrowser`. */
  cloakbrowserCacheDir?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Env vars checked, in order, as an explicit operator override. */
const OVERRIDE_ENV_VARS = ['CHROME_PATH', 'CHROME_BIN', 'PUPPETEER_EXECUTABLE_PATH', 'CLOAKBROWSER_BINARY_PATH'] as const;

/** Bare commands tried last, resolved via PATH. */
const PATH_COMMANDS = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'] as const;

/** Relative layouts of a Chrome binary inside a browser cache directory. */
const FULL_CHROME_LAYOUTS = ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome'] as const;
const HEADLESS_SHELL_LAYOUTS = ['chrome-headless-shell-linux64/chrome-headless-shell'] as const;

const PROBE_TIMEOUT_MS = 10_000;

// ─── Candidate discovery ─────────────────────────────────────────────────────

function defaultDeps(): ChromeSearchDeps {
  return {
    exists: (path) => existsSync(path),
    readdir: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

/** Numeric revision parsed from a `chromium-1234` / `chromium_headless_shell-1234` dir name. */
function revisionOf(name: string): number | null {
  const match = name.match(/^chromium(?:_headless_shell)?-(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** Add every existing layout of `dir` to `out`. */
function addLayouts(dir: string, layouts: readonly string[], deps: ChromeSearchDeps, out: string[]): void {
  for (const layout of layouts) {
    const candidate = join(dir, layout);
    if (deps.exists(candidate)) out.push(candidate);
  }
}

/** Collect Playwright revision directories inside `browsersDir`, newest first. */
function collectPlaywrightRevisions(browsersDir: string, deps: ChromeSearchDeps, out: string[]): void {
  const entries = deps.readdir(browsersDir);

  // Full Chromium first — the complete browser copes better with the baxia/WAF
  // challenge than the headless shell.
  for (const prefix of ['chromium-', 'chromium_headless_shell-']) {
    const revisions = entries
      .filter((name) => revisionOf(name) !== null && name.startsWith(prefix))
      .sort((a, b) => (revisionOf(b) ?? 0) - (revisionOf(a) ?? 0));

    for (const revision of revisions) {
      const dir = join(browsersDir, revision);
      addLayouts(dir, revision.startsWith('chromium-') ? FULL_CHROME_LAYOUTS : HEADLESS_SHELL_LAYOUTS, deps, out);
    }
  }
}

/** Collect Playwright-cache candidates from one cache root, newest revision first. */
function collectPlaywrightRoot(root: string, deps: ChromeSearchDeps, out: string[]): void {
  collectPlaywrightRevisions(join(root, 'ms-playwright'), deps, out);
}

/**
 * Compare two version-ish directory names so the newest wins.
 *
 * Numeric on the first dotted component: a plain lexicographic sort would rank
 * "linux-99" above "linux-152".
 */
function byVersionDesc(a: string, b: string): number {
  const major = (name: string): number => {
    const match = name.match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  };
  return major(b) - major(a) || b.localeCompare(a);
}

/** Collect cloakbrowser-cache candidates from one cache root, newest version first. */
function collectCloakbrowserRoot(root: string, deps: ChromeSearchDeps, out: string[]): void {
  const entries = deps.readdir(root).filter((name) => name.startsWith('chromium-'));

  for (const version of entries.sort(byVersionDesc)) {
    addLayouts(join(root, version), FULL_CHROME_LAYOUTS, deps, out);
  }
}

/** Collect puppeteer-cache candidates from one `~/.cache` root, newest version first. */
function collectPuppeteerRoot(root: string, deps: ChromeSearchDeps, out: string[]): void {
  const chromeDir = join(root, 'puppeteer', 'chrome');

  for (const version of deps.readdir(chromeDir).sort(byVersionDesc)) {
    addLayouts(join(chromeDir, version), FULL_CHROME_LAYOUTS, deps, out);
  }
}

/**
 * Build the ordered candidate list for a given environment.
 *
 * Order: explicit overrides → Playwright cache → cloakbrowser cache →
 * puppeteer cache → bare PATH commands.
 */
export function buildChromeCandidates(env: ChromeSearchEnv, deps: ChromeSearchDeps = defaultDeps()): string[] {
  const out: string[] = [];

  for (const override of env.overrides ?? []) {
    if (override) out.push(override);
  }

  // Playwright's own rule is `XDG_CACHE_HOME || homedir()/.cache`, so XDG must
  // be searched even when it points outside $HOME. Dedupe: XDG often *is*
  // $HOME/.cache.
  const cacheRoots = new Set<string>();
  if (env.xdgCacheHome) cacheRoots.add(env.xdgCacheHome);
  cacheRoots.add(join(env.home, '.cache'));
  if (env.osHome) cacheRoots.add(join(env.osHome, '.cache'));

  for (const root of cacheRoots) {
    collectPlaywrightRoot(root, deps, out);
    collectPuppeteerRoot(root, deps, out);
  }

  // PLAYWRIGHT_BROWSERS_PATH replaces the registry directory outright, so its
  // ms-playwright children live directly under it (no `ms-playwright` segment).
  if (env.playwrightBrowsersPath && env.playwrightBrowsersPath !== '0') {
    collectPlaywrightRevisions(env.playwrightBrowsersPath, deps, out);
  }

  // cloakbrowser resolves its cache from os.homedir(), which can differ from $HOME.
  const cloakRoots = new Set<string>([join(env.home, '.cloakbrowser'), join(env.cwd, '.cloakbrowser')]);
  if (env.osHome) cloakRoots.add(join(env.osHome, '.cloakbrowser'));
  if (env.cloakbrowserCacheDir) cloakRoots.add(env.cloakbrowserCacheDir);

  for (const root of cloakRoots) {
    collectCloakbrowserRoot(root, deps, out);
  }

  out.push(...PATH_COMMANDS);

  // A candidate may be reachable through several roots.
  return [...new Set(out)];
}

// ─── Runnability probe ───────────────────────────────────────────────────────

/** True when `bin --version` exits 0. Rejects broken wrappers such as the snap stub. */
export function probeChromeBinary(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Return the first candidate the probe accepts, or null. */
export function pickFirstRunnable(candidates: string[], probe: (bin: string) => boolean): string | null {
  for (const candidate of candidates) {
    if (probe(candidate)) return candidate;
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

let cachedChromePath: string | null | undefined;
let cachedFailureAt = 0;

/**
 * How long a "nothing found" result is cached. A success is cached for the
 * process lifetime; a failure is re-probed after this, so an operator who runs
 * `npx playwright install` on a live server recovers without a restart.
 */
const FAILURE_CACHE_TTL_MS = 60_000;

function searchEnv(): ChromeSearchEnv {
  const overrides = OVERRIDE_ENV_VARS.map((key) => process.env[key]).filter((v): v is string => !!v);
  return {
    home: process.env.HOME || homedir(),
    osHome: homedir(),
    cwd: process.cwd(),
    xdgCacheHome: process.env.XDG_CACHE_HOME,
    overrides,
    playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
    cloakbrowserCacheDir: process.env.CLOAKBROWSER_CACHE_DIR,
  };
}

/**
 * Resolve a runnable Chrome/Chromium executable, or null when none is found.
 * Never throws. The result is cached for the process lifetime.
 */
export function findChromeExecutable(): string | null {
  if (cachedChromePath) return cachedChromePath;
  if (cachedChromePath === null && Date.now() - cachedFailureAt < FAILURE_CACHE_TTL_MS) return null;

  const candidates = buildChromeCandidates(searchEnv());
  const chosen = pickFirstRunnable(candidates, probeChromeBinary);
  cachedChromePath = chosen;

  if (chosen) {
    logStore.log('debug', 'browser', `Chrome binary resolved: ${chosen}`);
  } else {
    cachedFailureAt = Date.now();
    logStore.log('warn', 'browser', `No runnable Chrome/Chromium found (searched ${candidates.length} candidates)`);
  }
  return chosen;
}

/**
 * Resolve a runnable Chrome/Chromium executable, throwing a detailed and
 * actionable error when none is found.
 */
export function resolveChromeExecutable(): string {
  const found = findChromeExecutable();
  if (found) return found;

  const env = searchEnv();
  const candidates = buildChromeCandidates(env);
  const rejected = candidates.filter((candidate) => candidate.includes('/') && existsSync(candidate));

  const lines = [
    'No runnable Chrome/Chromium binary found.',
    `Searched: ${candidates.length} candidates under ${env.xdgCacheHome ?? join(env.home, '.cache')}/ms-playwright, ` +
      `${join(env.home, '.cloakbrowser')}, ${join(env.home, '.cache', 'puppeteer')} and PATH`,
  ];
  if (rejected.length > 0) {
    lines.push(`Rejected (present but not runnable): ${rejected.slice(0, 5).join(', ')}`);
  }
  lines.push('Fix: npx playwright install   (or set CHROME_PATH to a Chrome binary)');
  throw new Error(lines.join('\n'));
}

/** Clear the module-level cache. For tests. */
export function resetChromeExecutableCache(): void {
  cachedChromePath = undefined;
  cachedFailureAt = 0;
}
