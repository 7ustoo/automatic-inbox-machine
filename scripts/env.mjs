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

/**
 * Vars that must be scrubbed regardless of length. The pattern-based sweep below
 * has an 8-character floor to avoid redacting half of every log line, but
 * AIM_SSN_LAST4 is four digits and matters more than most things in here.
 */
const ALWAYS_SECRET = ['AIM_SSN_LAST4', 'AIM_DATE_OF_BIRTH'];

/** Every secret currently in the environment, for log scrubbing. */
export function knownSecrets() {
  loadEnv();
  const secrets = [];

  for (const key of ALWAYS_SECRET) {
    const value = process.env[key];
    if (value && String(value).trim()) secrets.push(String(value).trim());
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (!value || String(value).length < 8) continue;
    if (/TOKEN|SECRET|PASSWORD|API_KEY|CLIENT_ID/i.test(key)) secrets.push(String(value));
  }
  return secrets;
}

/* -------------------------------------------------------------------------- */
/* Onboarding details                                                         */
/* -------------------------------------------------------------------------- */

/** Date of birth as entered, or '' when not provided. Sent verbatim. */
export function dateOfBirth() {
  return env('AIM_DATE_OF_BIRTH').trim();
}

/**
 * Last four SSN digits, or '' when absent or malformed.
 *
 * Anything that is not exactly four digits is rejected rather than passed
 * through — a value like "123-45-6789" in this field is a full SSN pasted into
 * the wrong variable, and mailing that out would be the exact failure this
 * field is scoped to prevent.
 */
export function ssnLast4() {
  const raw = env('AIM_SSN_LAST4').trim().replace(/\s|-/g, '');
  return /^\d{4}$/.test(raw) ? raw : '';
}

/** True when AIM_SSN_LAST4 holds something that is not four digits. */
export function ssnLast4Malformed() {
  const raw = env('AIM_SSN_LAST4').trim();
  return Boolean(raw) && !ssnLast4();
}
