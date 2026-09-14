/**
 * Tests for browserBinary — Chrome/Chromium binary resolution.
 *
 * These tests never need a real browser, filesystem, or network: the
 * directory listing, existence check, and runnability probe are all injected
 * fakes. Asserting that a real binary exists would fail in CI, which never
 * runs `playwright install`.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  buildChromeCandidates,
  type ChromeSearchDeps,
  type ChromeSearchEnv,
  pickFirstRunnable,
  probeChromeBinary,
} from './browserBinary.ts';

/**
 * A read-only virtual filesystem over a list of absolute file paths.
 *
 * Mirrors the real dependency's contract: reading an absent directory yields an
 * empty list rather than throwing.
 */
function fakeFs(files: string[]): ChromeSearchDeps {
  const set = new Set(files);
  return {
    exists: (path) => set.has(path),
    readdir: (dir) => {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const file of set) {
        if (file.startsWith(prefix)) {
          const segment = file.slice(prefix.length).split('/')[0];
          if (segment) names.add(segment);
        }
      }
      return [...names];
    },
  };
}

const ENV: ChromeSearchEnv = { home: '/home/u', cwd: '/app' };

const FULL_1234 = '/home/u/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const FULL_1243 = '/home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const SHELL_1243 = '/home/u/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';

describe('buildChromeCandidates', () => {
  it('should list Playwright Chromium revisions newest first', () => {
    const candidates = buildChromeCandidates(ENV, fakeFs([FULL_1234, FULL_1243]));
    expect(candidates.filter((c) => c.includes('ms-playwright') && c.includes('/chromium-'))).toEqual([FULL_1243, FULL_1234]);
  });

  it('should prefer full Chromium over the headless shell', () => {
    // The complete browser copes better with the baxia/WAF challenge than the shell.
    const candidates = buildChromeCandidates(ENV, fakeFs([FULL_1234, SHELL_1243]));
    const full = candidates.indexOf(FULL_1234);
    const shell = candidates.indexOf(SHELL_1243);
    expect(full).toBeGreaterThanOrEqual(0);
    expect(shell).toBeGreaterThanOrEqual(0);
    expect(full).toBeLessThan(shell);
  });

  it('should try an explicit CHROME_PATH override first', () => {
    const candidates = buildChromeCandidates({ ...ENV, overrides: ['/opt/chrome/chrome'] }, fakeFs([FULL_1234]));
    expect(candidates[0]).toBe('/opt/chrome/chrome');
  });

  it('should not duplicate candidates when XDG_CACHE_HOME equals $HOME/.cache', () => {
    const candidates = buildChromeCandidates({ ...ENV, xdgCacheHome: '/home/u/.cache', osHome: '/home/u' }, fakeFs([FULL_1234]));
    expect(candidates.filter((c) => c === FULL_1234)).toHaveLength(1);
  });

  it('should search XDG_CACHE_HOME even when it differs from $HOME', () => {
    // The production case: XDG_CACHE_HOME=/home/zeus/.cache while HOME is elsewhere.
    const candidates = buildChromeCandidates(
      { home: '/srv/app', osHome: '/srv/app', xdgCacheHome: '/home/zeus/.cache', cwd: '/app' },
      fakeFs(['/home/zeus/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome']),
    );
    expect(candidates).toContain('/home/zeus/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
  });

  it('should adapt to whatever revisions exist rather than a hardcoded one', () => {
    // Regression guard: the previous resolver hardcoded "chromium-1234" and went stale.
    const candidates = buildChromeCandidates(ENV, fakeFs(['/home/u/.cache/ms-playwright/chromium-9999/chrome-linux64/chrome']));
    expect(candidates).toContain('/home/u/.cache/ms-playwright/chromium-9999/chrome-linux64/chrome');
  });

  it('should find a cloakbrowser binary and a puppeteer binary', () => {
    const cloak = '/home/u/.cloakbrowser/chromium-146.0.7680.177.5/chrome';
    const puppeteer = '/home/u/.cache/puppeteer/chrome/linux-152.0.7977.54/chrome-linux64/chrome';
    const candidates = buildChromeCandidates(ENV, fakeFs([cloak, puppeteer]));
    expect(candidates).toContain(cloak);
    expect(candidates).toContain(puppeteer);
  });

  it('should fall back to bare PATH commands when no cache is populated', () => {
    const candidates = buildChromeCandidates(ENV, fakeFs([]));
    expect(candidates).toContain('chromium');
    expect(candidates).toContain('google-chrome');
  });

  it('should honor PLAYWRIGHT_BROWSERS_PATH as the registry directory', () => {
    // When set, Playwright uses it *instead of* the cache dir, so revisions sit
    // directly under it with no `ms-playwright` segment.
    const override = '/opt/pw-browsers';
    const candidates = buildChromeCandidates(
      { ...ENV, playwrightBrowsersPath: override },
      fakeFs([`${override}/chromium-1243/chrome-linux64/chrome`]),
    );
    expect(candidates).toContain(`${override}/chromium-1243/chrome-linux64/chrome`);
  });

  it('should ignore PLAYWRIGHT_BROWSERS_PATH when set to the "0" sentinel', () => {
    // "0" means a package-local directory, not a path.
    const candidates = buildChromeCandidates({ ...ENV, playwrightBrowsersPath: '0' }, fakeFs([FULL_1234]));
    expect(candidates).toContain(FULL_1234);
  });

  it('should honor CLOAKBROWSER_CACHE_DIR', () => {
    const cacheDir = '/opt/cloak-cache';
    const candidates = buildChromeCandidates(
      { ...ENV, cloakbrowserCacheDir: cacheDir },
      fakeFs([`${cacheDir}/chromium-146.0.7680.177.5/chrome`]),
    );
    expect(candidates).toContain(`${cacheDir}/chromium-146.0.7680.177.5/chrome`);
  });

  it('should search cloakbrowser under osHome when it differs from HOME', () => {
    const candidates = buildChromeCandidates(
      { home: '/srv/app', osHome: '/home/zeus', cwd: '/app' },
      fakeFs(['/home/zeus/.cloakbrowser/chromium-146.0.7680.177.5/chrome']),
    );
    expect(candidates).toContain('/home/zeus/.cloakbrowser/chromium-146.0.7680.177.5/chrome');
  });

  it('should rank puppeteer versions numerically, not lexicographically', () => {
    // A lexicographic sort would rank linux-99 above linux-152.
    const old = '/home/u/.cache/puppeteer/chrome/linux-99.0.0/chrome-linux64/chrome';
    const recent = '/home/u/.cache/puppeteer/chrome/linux-152.0.7977.54/chrome-linux64/chrome';
    const candidates = buildChromeCandidates(ENV, fakeFs([old, recent]));
    expect(candidates.indexOf(recent)).toBeLessThan(candidates.indexOf(old));
  });
});

describe('pickFirstRunnable', () => {
  it('should return the first candidate the probe accepts', () => {
    expect(pickFirstRunnable(['/a', '/b'], (bin) => bin === '/b')).toBe('/b');
  });

  it('should skip candidates the probe rejects, in order', () => {
    const probed: string[] = [];
    const chosen = pickFirstRunnable(['/dead', '/live'], (bin) => {
      probed.push(bin);
      return bin === '/live';
    });
    expect(chosen).toBe('/live');
    expect(probed).toEqual(['/dead', '/live']);
  });

  it('should return null when no candidate is runnable', () => {
    expect(pickFirstRunnable(['/a', '/b'], () => false)).toBeNull();
  });

  it('should reject a snap-stub candidate that exits non-zero', () => {
    // /usr/bin/chromium-browser on Debian/Ubuntu is a snap wrapper that exits 1
    // when the snap is absent — it must never be selected.
    const chosen = pickFirstRunnable(['/usr/bin/chromium-browser', '/real/chrome'], (bin) => bin !== '/usr/bin/chromium-browser');
    expect(chosen).toBe('/real/chrome');
  });
});

describe('probeChromeBinary', () => {
  // These use only binaries guaranteed present, so they stay hermetic in CI.

  it('should accept a real executable', () => {
    // process.execPath is the running runtime; `<it> --version` exits 0.
    expect(probeChromeBinary(process.execPath)).toBe(true);
  });

  it('should reject a command that exits non-zero', () => {
    // /bin/false is the portable stand-in for the snap stub: it exists, is
    // executable, and exits 1.
    if (!existsSync('/bin/false')) return;
    expect(probeChromeBinary('/bin/false')).toBe(false);
  });

  it('should reject a path that does not exist', () => {
    expect(probeChromeBinary('/nonexistent/chrome')).toBe(false);
  });
});
