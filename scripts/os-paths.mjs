/**
 * Filesystem layout. Everything the agent owns lives under the repo root so an
 * install is one directory you can zip, move, or delete. No roaming AppData
 * scatter, no registry.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(HERE, '..');
export const DATA_DIR = join(ROOT, 'data');
export const LOG_DIR = join(ROOT, 'logs');
export const TOKEN_DIR = join(DATA_DIR, 'tokens');

export const CONFIG_PATH = join(ROOT, 'config.json');
export const CONFIG_EXAMPLE_PATH = join(ROOT, 'config.example.json');
export const ENV_PATH = join(ROOT, '.env');

export const LEDGERS = {
  messages: join(DATA_DIR, 'messages.jsonl'),
  reqs: join(DATA_DIR, 'reqs.jsonl'),
  submissions: join(DATA_DIR, 'submissions.jsonl'),
  outbound: join(DATA_DIR, 'outbound.jsonl'),
  events: join(DATA_DIR, 'events.jsonl')
};

export const STATE_PATH = join(DATA_DIR, 'state.json');
export const HEARTBEAT_PATH = join(DATA_DIR, 'heartbeat.json');
export const BOT_HEARTBEAT_PATH = join(DATA_DIR, 'bot-heartbeat.json');
export const BACKUP_DIR = join(DATA_DIR, 'backups');

/**
 * One file per process rather than a shared pids.json. Three processes start
 * within milliseconds of each other at login, and a shared file means
 * read-modify-write: each reads the same empty object, each writes its own
 * entry, last write wins, and the lost registration makes Stop silently fail for
 * that process. Separate files have no such window.
 */
export const PID_DIR = join(DATA_DIR, 'pids');

/**
 * Bundled Node, shipped by the Windows installer so a fresh machine needs no
 * system Node. Falls back to whatever is running this process.
 */
export const BUNDLED_NODE = join(ROOT, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');

export function nodeBinary() {
  return existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;
}

/** Creates every directory the agent writes into. Idempotent. */
export function ensureDirs() {
  for (const dir of [DATA_DIR, LOG_DIR, TOKEN_DIR, BACKUP_DIR, PID_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Absolute path to the OAuth token cache for one account. */
export function tokenPath(accountId) {
  return join(TOKEN_DIR, `${accountId}-token.json`);
}

/**
 * Windows installs in the wild are sometimes missing System32 from PATH — AMM
 * hit this twice. Resolve system binaries from %SystemRoot% rather than
 * trusting PATH, and never spawn these bare.
 */
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
export const POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const CMD_EXE = join(SYSTEM_ROOT, 'System32', 'cmd.exe');
export const SCHTASKS = join(SYSTEM_ROOT, 'System32', 'schtasks.exe');

export const IS_WINDOWS = process.platform === 'win32';
