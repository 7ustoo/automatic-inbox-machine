/**
 * Small mutable runtime state: per-account sync cursors, the Telegram poll
 * offset, and the heartbeat the watchdog reads. Separate from the ledger
 * because this file is rewritten constantly and holds nothing worth keeping.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { HEARTBEAT_PATH, STATE_PATH, ensureDirs } from './os-paths.mjs';

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return { ...structuredClone(fallback), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return structuredClone(fallback);
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
