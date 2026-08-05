/**
 * Small mutable runtime state: per-account sync cursors, the Telegram poll
 * offset, and the heartbeat the watchdog reads. Separate from the ledger
 * because this file is rewritten constantly and holds nothing worth keeping.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { existsSync as _fsExists, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_HEARTBEAT_PATH, HEARTBEAT_PATH, PID_DIR, STATE_PATH, ensureDirs } from './os-paths.mjs';
import { stripBom } from './normalize.mjs';

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return { ...structuredClone(fallback), ...JSON.parse(stripBom(readFileSync(path, 'utf8'))) };
  } catch (error) {
    // Only a corrupt or partially-written file is recoverable by falling back to
    // defaults. A programming error must not be, and a bare catch here hid a
    // missing import once — every write silently reverted to defaults while the
    // file on disk was perfectly correct. Re-throw anything that is not a parse
    // or I/O failure.
    if (error instanceof SyntaxError || error?.code) return structuredClone(fallback);
    throw error;
  }
}

function writeJson(path, value) {
  ensureDirs();
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
  return value;
}

const STATE_DEFAULTS = { accounts: {}, telegramOffset: 0, lastDigestDate: '', pairingNonce: '' };

export function readState() {
  return readJson(STATE_PATH, STATE_DEFAULTS);
}

export function writeState(state) {
  return writeJson(STATE_PATH, state);
}

/**
 * Per-account cursor. Gmail stores { historyId }, IMAP stores { uidNext,
 * uidValidity }. Both also carry lastSyncAt and lastError for the health panel.
 */
export function getCursor(accountId) {
  const state = readState();
  return state.accounts?.[accountId] || {};
}

export function setCursor(accountId, patch) {
  const state = readState();
  if (!state.accounts) state.accounts = {};
  state.accounts[accountId] = { ...state.accounts[accountId], ...patch };
  writeState(state);
  return state.accounts[accountId];
}

export function getTelegramOffset() {
  return Number(readState().telegramOffset || 0);
}

export function setTelegramOffset(offset) {
  const state = readState();
  state.telegramOffset = Number(offset) || 0;
  return writeState(state);
}

/** One-time nonce binding a QR scan to this install. */
export function issuePairingNonce(nonce) {
  const state = readState();
  state.pairingNonce = nonce;
  writeState(state);
  return nonce;
}

export function consumePairingNonce(candidate) {
  const state = readState();
  const expected = String(state.pairingNonce || '');
  if (!expected || expected !== String(candidate || '')) return false;
  state.pairingNonce = '';
  writeState(state);
  return true;
}

export function markDigestSent(dateKey) {
  const state = readState();
  state.lastDigestDate = dateKey;
  return writeState(state);
}

export function lastDigestDate() {
  return String(readState().lastDigestDate || '');
}

/* -------------------------------------------------------------------------- */
/* Heartbeat                                                                  */
/* -------------------------------------------------------------------------- */

export function beat(extra = {}) {
  return writeJson(HEARTBEAT_PATH, { at: new Date().toISOString(), pid: process.pid, ...extra });
}

export function readHeartbeat() {
  return readJson(HEARTBEAT_PATH, { at: '', pid: 0 });
}

/** Stale means the watcher has not written a beat inside the window. */
export function heartbeatAgeSeconds() {
  const { at } = readHeartbeat();
  if (!at) return Infinity;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return Infinity;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

/**
 * The bot keeps its own heartbeat, separate from the watcher's. The launcher
 * needs to tell "the bot is running" from "the watcher is running" — they are
 * different processes and either can die alone.
 */
export function beatBot(extra = {}) {
  return writeJson(BOT_HEARTBEAT_PATH, { at: new Date().toISOString(), pid: process.pid, ...extra });
}

/**
 * True when a PID currently exists. Signal 0 performs the permission and
 * existence checks without delivering anything.
 *
 * Used together with heartbeat freshness, never alone: a PID can be recycled, and
 * a heartbeat file outlives the process that wrote it. Freshness alone was enough
 * to fool the launcher into skipping a dead watcher after a test run left a
 * recent beat behind.
 */
export function processAlive(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return error?.code === 'EPERM';
  }
}

/** Fresh beat AND a live PID. Either alone is not evidence the process is up. */
export function watcherAlive(windowSeconds = 180) {
  const { pid } = readHeartbeat();
  return heartbeatAgeSeconds() < windowSeconds && processAlive(pid);
}

export function botAlive(windowSeconds = 180) {
  const row = readJson(BOT_HEARTBEAT_PATH, { at: '', pid: 0 });
  return botHeartbeatAgeSeconds() < windowSeconds && processAlive(row.pid);
}

export function botHeartbeatAgeSeconds() {
  const { at } = readJson(BOT_HEARTBEAT_PATH, { at: '' });
  if (!at) return Infinity;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return Infinity;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

/* -------------------------------------------------------------------------- */
/* Process bookkeeping for the launcher                                       */
/* -------------------------------------------------------------------------- */

/**
 * Recorded so `--stop` has something to signal. Liveness is never inferred from
 * these — PIDs get recycled, so the launcher probes the dashboard port and the
 * two heartbeats instead. These are only used to send the actual kill.
 *
 * One file per process; see PID_DIR for why a shared file was wrong.
 */
const PID_NAME = /^[a-z][a-z0-9_-]*$/;

function pidFile(name) {
  if (!PID_NAME.test(String(name))) throw new Error(`invalid process name "${name}"`);
  return join(PID_DIR, `${name}.json`);
}

export function readPids() {
  if (!_fsExists(PID_DIR)) return {};
  const pids = {};
  for (const entry of readdirSync(PID_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -5);
    const row = readJson(join(PID_DIR, entry), {});
    if (row?.pid) pids[name] = row;
  }
  return pids;
}

export function recordPid(name, pid) {
  ensureDirs();
  if (!_fsExists(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
  writeJson(pidFile(name), { pid, startedAt: new Date().toISOString() });
  return readPids();
}

export function clearPid(name) {
  try {
    rmSync(pidFile(name), { force: true });
  } catch {
    /* already gone */
  }
  return readPids();
}

/**
 * Called by each long-running process at startup so `app.mjs --stop` can signal
 * it regardless of who launched it.
 *
 * This has to be self-registration rather than the launcher recording what it
 * spawned: after a reboot the platform scheduler starts the watcher and bot
 * directly, so a launcher-only record would be empty and Stop would silently do
 * nothing. Registering from inside the process is the only way the record
 * reflects reality.
 */
export function registerSelf(name) {
  recordPid(name, process.pid);
  const release = () => {
    try {
      const current = readPids();
      // Only clear if the entry is still ours — a restart may have replaced it.
      if (current[name]?.pid === process.pid) clearPid(name);
    } catch {
      /* shutdown is best-effort */
    }
  };
  process.once('exit', release);
  process.once('SIGINT', release);
  process.once('SIGTERM', release);
  return release;
}
