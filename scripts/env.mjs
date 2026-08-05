/**
 * Minimal .env loader. Deliberately not the dotenv package — this is 30 lines
 * and one fewer dependency in a tree that touches the user's mail credentials.
 *
 * Existing process env always wins, so `TG_TOKEN=x npm run bot` overrides the
 * file without editing it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ENV_PATH } from './os-paths.mjs';

let loaded = false;

export function loadEnv(path = ENV_PATH) {
  if (loaded) return process.env;
  loaded = true;
  if (!existsSync(path)) return process.env;

  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip one matching pair of surrounding quotes, then unescape \n in
    // double-quoted values only (single quotes stay literal, like sh).
    const quoted = value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    }

    if (!(key in process.env)) process.env[key] = value;
  }
  return process.env;
}

/** Reads a var, returning '' rather than undefined so callers can just trim(). */
export function env(key, fallback = '') {
  loadEnv();
  const value = process.env[key];
  return value === undefined || value === null ? fallback : String(value);
}

/**
 * Per-account secret lookup: IMAP_PASSWORD_PRIMARY for account id "primary".
 * Account ids are lowercase-with-dashes; env vars are uppercase-with-underscores.
 */
export function accountEnv(prefix, accountId) {
  const suffix = String(accountId || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return env(`${prefix}_${suffix}`);
}

/** Every secret currently in the environment, for log scrubbing. */
export function knownSecrets() {
  loadEnv();
  const secrets = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || String(value).length < 8) continue;
    if (/TOKEN|SECRET|PASSWORD|API_KEY|CLIENT_ID/i.test(key)) secrets.push(String(value));
  }
  return secrets;
}
