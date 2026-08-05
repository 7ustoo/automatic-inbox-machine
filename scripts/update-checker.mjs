/**
 * Update checking against GitHub Releases.
 *
 * Matters more for an installed .exe than for a git checkout: someone who
 * double-clicked an installer has no `git pull` habit and no reason to look at the
 * repo, so without this they run whatever they downloaded forever — including
 * through a classification bug fix.
 *
 * Read-only and best-effort. It never downloads or installs anything; it reports a
 * version and a URL and lets the human decide. Failure is silent by design — a
 * rate-limited or offline check must not surface as an error in the dashboard.
 */
import { readFileSync } from 'node:fs';
import { readState, writeState } from './state.mjs';
import { stripBom } from './normalize.mjs';
import { log } from './log.mjs';

const RELEASES_API = 'https://api.github.com/repos/7ustoo/automatic-inbox-machine/releases/latest';
const RELEASES_PAGE = 'https://github.com/7ustoo/automatic-inbox-machine/releases';

/** Checks at most this often, so a dashboard refreshing every 15s is not a poll. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The single source of truth for the running version, read from package.json.
 *
 * BOM-tolerant, and that is not defensive padding: a Windows PowerShell
 * `Set-Content -Encoding utf8` writes one, and it silently made every surface
 * report v0.0.0 while package.json looked perfectly correct in an editor.
 */
export function currentVersion() {
  try {
    return JSON.parse(stripBom(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Semver-ish comparison. Returns > 0 when a is newer than b.
 * Prerelease suffixes are compared as strings after the numeric core, which is
 * enough to keep 1.2.0 ahead of 1.2.0-rc1 without pulling in a dependency.
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core = '', pre = ''] = String(value || '').replace(/^v/, '').split('-');
    const parts = core.split('.').map((part) => Number(part) || 0);
    return { parts: [parts[0] || 0, parts[1] || 0, parts[2] || 0], pre };
  };
  const left = parse(a);
  const right = parse(b);

  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1; // a release beats a prerelease of the same core
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * Fetches the latest release. Returns null on any failure.
 * Cached in state.json so repeated dashboard loads do not hit the API.
 */
export async function checkForUpdate({ force = false, timeoutMs = 8000 } = {}) {
  const version = currentVersion();
  const state = readState();
  const cached = state.updateCheck || null;

  if (!force && cached?.checkedAt) {
    const age = Date.now() - Date.parse(cached.checkedAt);
    if (Number.isFinite(age) && age < CHECK_INTERVAL_MS) {
      return { ...cached, current: version, fromCache: true };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(RELEASES_API, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `automatic-inbox-machine/${version}`
      }
    });
    if (!response.ok) return cached ? { ...cached, current: version, fromCache: true } : null;

    const payload = await response.json();
    const latest = String(payload.tag_name || '').replace(/^v/, '');
    if (!latest) return null;

    const asset = (payload.assets || []).find((entry) => /^aim-setup-.*\.exe$/i.test(entry.name || ''));
    const result = {
      current: version,
      latest,
      behind: compareVersions(latest, version) > 0,
      publishedAt: payload.published_at || '',
      url: payload.html_url || RELEASES_PAGE,
      installerUrl: asset?.browser_download_url || '',
      checkedAt: new Date().toISOString(),
      fromCache: false
    };

    const next = readState();
    next.updateCheck = result;
    writeState(next);

    if (result.behind) log(`update-checker: ${latest} is available (running ${version})`, { name: 'update' });
    return result;
  } catch {
    return cached ? { ...cached, current: version, fromCache: true } : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cached result only, no network. Safe to call from a hot path. */
export function cachedUpdate() {
  const version = currentVersion();
  const cached = readState().updateCheck;
  if (!cached?.latest) return { current: version, latest: '', behind: false, url: RELEASES_PAGE };
  return { ...cached, current: version, behind: compareVersions(cached.latest, version) > 0 };
}

export { RELEASES_PAGE };
