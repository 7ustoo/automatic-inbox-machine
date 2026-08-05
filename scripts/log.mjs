/**
 * Logging with mandatory secret scrubbing.
 *
 * Two hard rules, both carried over from AMM after real incidents:
 *   1. A raw bot token or app password must never reach disk or stdout.
 *   2. log() itself must never throw. A locked log file on Windows cannot be
 *      allowed to kill a 24/7 process, so every write is best-effort.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR } from './os-paths.mjs';
import { knownSecrets, onEnvReload } from './env.mjs';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
let secretCache = null;

function secrets() {
  if (!secretCache) secretCache = knownSecrets();
  return secretCache;
}

/** Call after writing new secrets to the environment. */
export function resetSecretCache() {
  secretCache = null;
}

// A token written by the dashboard must become scrubbable immediately, not after
// the next restart. env.mjs cannot import this module (it would cycle), so it
// calls back into here instead.
onEnvReload(resetSecretCache);

/**
 * Removes known secrets and anything shaped like a credential. Runs on every
 * line, including ones built from caught exceptions — error messages from HTTP
 * clients love to echo the URL, and Telegram puts the token in the URL.
 */
export function scrub(input) {
  if (input === null || input === undefined) return '';
  let text = typeof input === 'string' ? input : safeStringify(input);
  if (!text) return '';

  for (const secret of secrets()) {
    if (secret && text.includes(secret)) text = text.split(secret).join('<REDACTED>');
  }

  return text
    // Telegram bot tokens, in URLs or bare. No leading \b: the token is glued to
    // "bot" in the API URL (…/bot8412345678:AAH…), so a word boundary never
    // matches there and the token would sail through into the log.
    .replace(/\d{8,12}:[A-Za-z0-9_-]{30,}/g, '<TG_TOKEN>')
    // Anthropic / OpenAI style keys
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<API_KEY>')
    // Google OAuth tokens and refresh tokens
    .replace(/\bya29\.[A-Za-z0-9._-]{20,}\b/g, '<OAUTH_TOKEN>')
    .replace(/\b1\/\/[A-Za-z0-9._-]{20,}\b/g, '<REFRESH_TOKEN>')
    // Gmail app passwords are 16 lowercase letters, usually space-grouped
    .replace(/\b(?:[a-z]{4}\s){3}[a-z]{4}\b/g, '<APP_PASSWORD>')
    // Anything that still looks like a bearer header
    .replace(/(authorization"?\s*[:=]\s*"?)(bearer\s+)?[A-Za-z0-9._-]{20,}/gi, '$1<REDACTED>');
}

function safeStringify(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Chat IDs are not secrets but they are identifying. Show only the tail. */
export function maskChatId(chatId) {
  const text = String(chatId || '');
  if (text.length <= 4) return '***';
  return `***${text.slice(-4)}`;
}

/** Redacts the local part of an address: j***@gmail.com */
export function maskEmail(address) {
  const text = String(address || '');
  const at = text.indexOf('@');
  if (at < 1) return text ? '***' : '';
  return `${text[0]}***${text.slice(at)}`;
}

function rotate(file) {
  try {
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    /* rotation is best-effort */
  }
}

/**
 * Appends one scrubbed line to logs/<name>.log and mirrors it to stdout.
 * Never throws.
 */
export function log(message, { name = 'aim', stdout = true } = {}) {
  const line = `[${new Date().toISOString()}] ${scrub(message)}`;
  if (stdout) {
    try {
      process.stdout.write(`${line}\n`);
    } catch {
      /* closed pipe */
    }
  }
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const file = join(LOG_DIR, `${name}.log`);
    rotate(file);
    appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    /* a locked or full disk must not kill the watcher */
  }
}

export function logError(context, error, options = {}) {
  log(`ERROR ${context}: ${scrub(error)}`, options);
}

/**
 * Installs process-level guards. Without these a single unhandled rejection
 * from a transient network blip takes down the whole agent.
 */
export function installCrashGuards(name = 'aim') {
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason, { name }));
  process.on('uncaughtException', (error) => logError('uncaughtException', error, { name }));
}
