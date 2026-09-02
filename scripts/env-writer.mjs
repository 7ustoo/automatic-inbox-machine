/**
 * Writes secrets into .env from the dashboard.
 *
 * The CLI wizard deliberately refuses to prompt for secrets — on a dev box,
 * editing .env yourself keeps credentials out of shell history for no real cost.
 * That reasoning does not survive contact with an installed app: the file lives
 * in %LOCALAPPDATA%\automatic-inbox-machine\.env, and telling someone who
 * double-clicked an installer to go find and edit it is not setup, it is a dead
 * end. So the dashboard writes it.
 *
 * Constraints that make that acceptable:
 *   - Keys are allowlisted. An arbitrary name cannot be injected into the file.
 *   - Values are validated per key, so a malformed token is rejected at the door
 *     rather than failing mysteriously three screens later.
 *   - Nothing here ever returns a stored value. Callers get booleans. The
 *     dashboard is the surface most likely to end up in a screenshot.
 *   - Existing comments and unrelated keys in the file are preserved.
 *   - The file is written 0600 where the platform honours it.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ENV_PATH, ensureDirs } from './os-paths.mjs';
import { reloadEnv } from './env.mjs';
import { stripBom } from './normalize.mjs';
import { log } from './log.mjs';

/**
 * Every key the dashboard may write, with a validator and a human label.
 * `perAccount` keys are suffixed with an uppercased account id at call time.
 */
export const WRITABLE = {
  TG_TOKEN: {
    label: 'Telegram bot token',
    // BotFather tokens are <digits>:<35-ish url-safe chars>.
    test: (value) => /^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(value),
    hint: 'Should look like 8412345678:AA... — copy the whole line BotFather sent you.'
  },
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API key',
    test: (value) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value),
    hint: 'Starts with sk-ant- — from console.anthropic.com.'
  },
  OPENAI_API_KEY: {
    label: 'OpenAI API key',
    test: (value) => /^sk-[A-Za-z0-9_-]{20,}$/.test(value),
    hint: 'Starts with sk- — create one at platform.openai.com/api-keys. ChatGPT and Codex subscriptions are separate.'
  },
  GEMINI_API_KEY: {
    label: 'Google Gemini API key',
    test: (value) => /^(?:AIza[A-Za-z0-9_-]{20,}|AQ\.[A-Za-z0-9_-]{20,})$/.test(value),
    hint: 'Starts with AIza or AQ. — create one in Google AI Studio.'
  },
  GOOGLE_CLIENT_ID: {
    label: 'Google OAuth client ID',
    test: (value) => /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value),
    hint: 'Ends in .apps.googleusercontent.com'
  },
  GOOGLE_CLIENT_SECRET: {
    label: 'Google OAuth client secret',
    test: (value) => value.length >= 10 && value.length <= 100,
    hint: 'From the same Desktop-app credential as the client ID.'
  },
  NTFY_TOPIC: {
    label: 'ntfy topic',
    test: (value) => /^[A-Za-z0-9_-]{8,64}$/.test(value),
    hint: 'At least 8 characters. Anyone who knows it can read your alerts, so make it unguessable.'
  },
  NTFY_SERVER: {
    label: 'ntfy server',
    test: (value) => /^https?:\/\/[^\s]+$/.test(value),
    hint: 'A full URL. Leave blank to use https://ntfy.sh'
  },
  WEBHOOK_URL: {
    label: 'Webhook URL',
    test: (value) => /^https:\/\/[^\s]+$/.test(value),
    hint: 'Must be https.'
  },
  AIM_DATE_OF_BIRTH: {
    label: 'Date of birth',
    test: (value) => value.length >= 3 && value.length <= 20,
    hint: 'Whatever format you want to send, e.g. 04/12 or 04/12/1990.'
  },
  AIM_SSN_LAST4: {
    label: 'SSN last four',
    test: (value) => /^\d{4}$/.test(value),
    hint: 'Exactly four digits. Never enter a full SSN — it is not storable here.'
  },
  IMAP_PASSWORD: {
    label: 'IMAP app password',
    perAccount: true,
    // App passwords are commonly shown space-grouped; those are stripped first.
    test: (value) => value.length >= 8 && value.length <= 200,
    hint: 'The app password from your mail provider, not your normal login password.'
  },
  SMTP_PASSWORD: {
    label: 'SMTP app password',
    perAccount: true,
    test: (value) => value.length >= 8 && value.length <= 200,
    hint: 'Leave blank to reuse the IMAP password.'
  }
};

/** IMAP_PASSWORD + account "primary" -> IMAP_PASSWORD_PRIMARY */
export function envKeyFor(baseKey, accountId = '') {
  const spec = WRITABLE[baseKey];
  if (!spec) throw new Error(`"${baseKey}" is not a writable key`);
  if (!spec.perAccount) return baseKey;
  if (!accountId) throw new Error(`${baseKey} needs an account id`);
  return `${baseKey}_${String(accountId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function readLines() {
  if (!existsSync(ENV_PATH)) return [];
  return stripBom(readFileSync(ENV_PATH, 'utf8')).split(/\r?\n/);
}

function writeLines(lines) {
  ensureDirs();
  const body = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  const temp = `${ENV_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, ENV_PATH);
  // The dashboard process must see its own write immediately, or the presence
  // booleans it reports back would still describe the previous state.
  reloadEnv({ override: true });
}

/**
 * Sets one key. Returns { ok, key } or { ok: false, error, hint }.
 * An empty value removes the key rather than writing a blank.
 */
export function setSecret(baseKey, rawValue, { accountId = '' } = {}) {
  const spec = WRITABLE[baseKey];
  if (!spec) return { ok: false, error: `"${baseKey}" cannot be set from here` };

  const key = envKeyFor(baseKey, accountId);
  // App passwords are displayed space-grouped by Google and others; accept that
  // and store it compact, because a pasted "abcd efgh ijkl mnop" is the norm.
  const value = String(rawValue ?? '').trim().replace(/^["']|["']$/g, '');
  const normalized = /PASSWORD/.test(baseKey) ? value.replace(/\s+/g, '') : value;

  if (!normalized) return removeSecret(baseKey, { accountId });

  if (!spec.test(normalized)) {
    return { ok: false, error: `That does not look like a valid ${spec.label}.`, hint: spec.hint };
  }

  const lines = readLines();
  const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  const entry = `${key}=${normalized}`;

  if (index >= 0) lines[index] = entry;
  else {
    if (lines.length && lines.at(-1).trim() !== '') lines.push('');
    lines.push(entry);
  }

  writeLines(lines);
  log(`env-writer: set ${key}`, { name: 'dashboard' });
  return { ok: true, key };
}

export function removeSecret(baseKey, { accountId = '' } = {}) {
  const key = envKeyFor(baseKey, accountId);
  const lines = readLines();
  const kept = lines.filter((line) => !new RegExp(`^\\s*${key}\\s*=`).test(line));
  const removed = kept.length !== lines.length;

  if (removed) {
    writeLines(kept);
    log(`env-writer: removed ${key}`, { name: 'dashboard' });
  }

  // Deleting the line is not enough. reloadEnv() only *sets* what the file
  // contains — it has no way to know a key vanished — so without this the value
  // lingers in the running process and the dashboard keeps reporting it present
  // after the user cleared it.
  delete process.env[key];

  return { ok: true, key, removed };
}

/** Presence map only — never values. Safe to serialize to the browser. */
export function secretsPresent(accountIds = []) {
  const present = {};
  for (const [baseKey, spec] of Object.entries(WRITABLE)) {
    if (spec.perAccount) {
      for (const id of accountIds) {
        present[envKeyFor(baseKey, id)] = Boolean(String(process.env[envKeyFor(baseKey, id)] || '').trim());
      }
    } else {
      present[baseKey] = Boolean(String(process.env[baseKey] || '').trim());
    }
  }
  return present;
}

/** Field metadata for the setup UI. No values, just labels and hints. */
export function writableFields() {
  return Object.entries(WRITABLE).map(([key, spec]) => ({
    key,
    label: spec.label,
    hint: spec.hint,
    perAccount: Boolean(spec.perAccount)
  }));
}
