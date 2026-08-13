#!/usr/bin/env node
/**
 * One-click self-update, ported from AMM's scripts/self-update.mjs.
 *
 * Windows is the only platform with a seamless story: releases ship an Inno
 * Setup `aim-setup-<ver>.exe` that runs per-user (no UAC), stops the running
 * app, upgrades in place, and relaunches. `apply` downloads it, verifies it
 * against the release's SHA256SUMS.txt, then spawns a DETACHED updater — a cmd
 * script that survives AIM.exe being killed by the installer:
 *   wait a beat → installer /VERYSILENT → relaunch AIM.exe --after-update.
 *
 * macOS/Linux have no silent-install convention, so `apply` reports
 * canAutoUpdate:false and the UI links to the releases page instead.
 *
 * Exported as functions for the dashboard to call in-process; the CLI shim at
 * the bottom prints one line of JSON per subcommand, same contract as AMM.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CMD_EXE, IS_WINDOWS, ROOT } from './os-paths.mjs';
import { compareVersions, currentVersion } from './update-checker.mjs';
import { snapshot } from './config-rw.mjs';
import { log } from './log.mjs';
import { readPids } from './state.mjs';

// Release assets are deliberately public even though the application source is
// private. Installed copies can therefore check for and download updates without
// asking customers for a GitHub account or token.
const REPO = '7ustoo/automatic-inbox-machine-releases';
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`;

/** The release asset that self-installs on this platform. Windows-only by design. */
export function installerAssetFor(assets, isWindows = IS_WINDOWS) {
  if (!isWindows) return null;
  return (assets || []).find((asset) => /^aim-setup-.*\.exe$/i.test(asset?.name || '')) || null;
}

/** Pulls the expected sha256 for one asset out of a SHA256SUMS.txt body. */
export function checksumFor(sumsText, assetName) {
  const line = String(sumsText || '')
    .split('\n')
    .find((candidate) => candidate.toLowerCase().includes(String(assetName || '').toLowerCase()));
  const hash = line?.trim().split(/\s+/)[0]?.toLowerCase() || '';
  return /^[0-9a-f]{64}$/.test(hash) ? hash : '';
}

/**
 * Builds the updater that survives the application shutdown.
 *
 * The old flow let Inno's `taskkill /T` stop AIM. Because this cmd process was
 * a descendant of AIM's dashboard, Windows killed the updater itself too: files
 * were often replaced, but the success log and relaunch never happened. Stop
 * each registered Node process without `/T`, then stop AIM without `/T`; the cmd
 * child survives, runs Inno, and starts the new binary.
 */
export function updaterScriptFor({ pids = {}, dest, root = ROOT, aimExe, logPath, latest }) {
  const stopLines = [...new Set(Object.values(pids).map((row) => Number(row?.pid)).filter((pid) => Number.isInteger(pid) && pid > 0))]
    .map((pid) => `taskkill /PID ${pid} /F >nul 2>&1`);
  return [
    '@echo off',
    'setlocal',
    `echo [%date% %time%] AIM auto-update to v${latest} starting >> "${logPath}"`,
    'ping 127.0.0.1 -n 3 >nul',
    ...stopLines,
    'taskkill /IM AIM.exe /F >nul 2>&1',
    'ping 127.0.0.1 -n 3 >nul',
    `"${dest}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="${root}" >> "${logPath}" 2>&1`,
    'set "aimExit=%errorlevel%"',
    `echo [%date% %time%] installer exit %aimExit% >> "${logPath}"`,
    'if not "%aimExit%"=="0" exit /b %aimExit%',
    'ping 127.0.0.1 -n 3 >nul',
    `start "" "${aimExe}" --after-update`,
    `echo [%date% %time%] relaunched AIM v${latest} (--after-update) >> "${logPath}"`,
    'endlocal'
  ].join('\r\n');
}

async function fetchLatestRelease() {
  const response = await fetch(MANIFEST_URL, {
    signal: AbortSignal.timeout(10000),
    headers: { 'user-agent': `aim/${currentVersion()}`, accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`update manifest HTTP ${response.status}`);
  const manifest = await response.json();
  const version = String(manifest.version || '').replace(/^v/, '');
  const installer = manifest.installer || {};
  if (!version) throw new Error('update manifest has no version');
  return {
    tag_name: `v${version}`,
    html_url: manifest.releaseUrl || `https://github.com/${REPO}/releases`,
    body: manifest.notes || '',
    assets: [
      ...(installer.name && installer.url ? [{ name: installer.name, browser_download_url: installer.url }] : []),
      ...(manifest.checksumsUrl ? [{ name: 'SHA256SUMS.txt', browser_download_url: manifest.checksumsUrl }] : [])
    ]
  };
}

export async function updateInfo() {
  const current = currentVersion();
  let release;
  try {
    release = await fetchLatestRelease();
  } catch (error) {
    return { ok: false, error: String(error?.message || error), current };
  }
  if (!release) return { ok: true, current, latest: current, hasUpdate: false };

  const latest = String(release.tag_name || '').replace(/^v/, '');
  const asset = installerAssetFor(release.assets);
  return {
    ok: true,
    current,
    latest,
    hasUpdate: Boolean(latest) && compareVersions(latest, current) > 0,
    installerUrl: asset ? asset.browser_download_url : '',
    installerName: asset ? asset.name : '',
    releaseUrl: release.html_url || `https://github.com/${REPO}/releases`,
    notes: String(release.body || '').slice(0, 1200),
    canAutoUpdate: IS_WINDOWS && Boolean(asset)
  };
}

async function downloadTo(url, destPath) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000), redirect: 'follow' });
  if (!response.ok) throw new Error(`download HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100000) throw new Error(`downloaded installer looks too small (${buffer.length} bytes)`);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buffer);
  return buffer.length;
}

export async function updateApply() {
  const current = currentVersion();
  let release;
  try {
    release = await fetchLatestRelease();
  } catch (error) {
    return { ok: false, error: `Could not reach GitHub: ${String(error?.message || error)}` };
  }
  const latest = release ? String(release.tag_name || '').replace(/^v/, '') : current;
  if (!release || compareVersions(latest, current) <= 0) {
    return { ok: false, error: `Already on the latest version (v${current}).` };
  }

  const asset = installerAssetFor(release.assets);
  if (!IS_WINDOWS || !asset) {
    return {
      ok: false,
      canAutoUpdate: false,
      releaseUrl: release.html_url,
      error: 'Automatic install is Windows-only. Download the update from the releases page.'
    };
  }

  const dest = join(ROOT, 'data', 'update', asset.name);
  try {
    const bytes = await downloadTo(asset.browser_download_url, dest);
    log(`self-update: downloaded ${bytes} bytes -> ${asset.name}`, { name: 'update' });
  } catch (error) {
    return { ok: false, error: `Download failed: ${String(error?.message || error)}` };
  }

  // Verify against SHA256SUMS.txt before executing anything. A mismatch means a
  // corrupted or tampered download — never run it. If verification
  // infrastructure itself fails, err on the side of NOT running the binary.
  try {
    const sums = (release.assets || []).find((candidate) => /^SHA256SUMS\.txt$/i.test(candidate.name));
    if (!sums) throw new Error('release has no SHA256SUMS.txt');
    const response = await fetch(sums.browser_download_url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (!response.ok) throw new Error(`SHA256SUMS download HTTP ${response.status}`);
    const expected = checksumFor(await response.text(), asset.name);
    if (!expected) throw new Error('installer not listed in SHA256SUMS.txt');
    const actual = createHash('sha256').update(readFileSync(dest)).digest('hex');
    if (actual !== expected) {
      try { unlinkSync(dest); } catch { /* already gone */ }
      return { ok: false, error: 'Installer checksum mismatch — download discarded. Try again, or install from the releases page.' };
    }
    log('self-update: sha256 verified', { name: 'update' });
  } catch (error) {
    try { unlinkSync(dest); } catch { /* already gone */ }
    return { ok: false, error: `Could not verify the download (${String(error?.message || error)}). Nothing was installed.` };
  }

  // Snapshot config right before the installer runs, so a bad update is one
  // restore away from the user's settings. Best-effort.
  try {
    const snap = snapshot('pre-update');
    if (snap) log(`self-update: config snapshot ${snap}`, { name: 'update', stdout: false });
  } catch { /* must not block the update */ }

  // Detached updater: a cmd script that OUTLIVES this process AND AIM.exe,
  // which the installer is about to taskkill. Written to temp so the in-place
  // upgrade cannot clobber it. /DIR pins the upgrade to THIS install's root —
  // without it Inno falls back to its registry-remembered (or default) dir and
  // can install a FRESH copy next to the real one, which then relaunches with
  // no config and looks exactly like "the update wiped my settings".
  const aimExe = join(ROOT, 'wrapper', 'dist', 'AIM.exe');
  const logPath = join(ROOT, 'data', 'update', 'update.log');
  const script = updaterScriptFor({ pids: readPids(), dest, root: ROOT, aimExe, logPath, latest });

  const scriptPath = join(tmpdir(), `aim-update-${process.pid}.cmd`);
  writeFileSync(scriptPath, script);

  const child = spawn(CMD_EXE, ['/c', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  log(`self-update: updater launched for v${latest}`, { name: 'update' });
  return { ok: true, started: true, installer: asset.name, from: current, to: latest };
}

/* ----- CLI shim, same contract as AMM ------------------------------------- */

const invokedDirectly = process.argv[1] && /self-update\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const sub = process.argv[2];
  (async () => {
    if (sub === 'info') return print(await updateInfo());
    if (sub === 'apply') return print(await updateApply());
    print({ ok: false, error: 'usage: self-update.mjs <info|apply>' });
    process.exit(2);
  })().catch((error) => {
    print({ ok: false, error: String(error?.message || error) });
    process.exit(1);
  });
}
