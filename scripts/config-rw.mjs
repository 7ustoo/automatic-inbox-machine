/**
 * config.json access. Every write is atomic (temp file + rename) because the
 * watcher, the bot, and the dashboard can all touch this file at once. Never
 * JSON.stringify + writeFileSync it directly from anywhere else.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_DIR, CONFIG_EXAMPLE_PATH, CONFIG_PATH, ensureDirs } from './os-paths.mjs';
import { stripBom } from './normalize.mjs';

const DEFAULTS = {
  version: 1,
  accounts: [],
  profile: {
    fullName: '', phone: '', contactEmail: '', city: '', state: '', country: 'USA',
    workAuth: '', linkedin: '', availability: '', preferredRateHourly: 0,
    preferredSalary: 0, employmentTypes: ['W2', 'C2C', '1099'], titles: [],
    // Consent flags for the two onboarding values held in .env. The values
    // themselves are never stored here — config.json gets snapshotted into
    // data/backups, and copying identity data around is how it leaks.
    provideDateOfBirth: true,
    ssnLast4Acknowledged: false,
    updatedAt: '',
    resume: { enabled: true, storedName: '', filename: '', contentType: '' }
  },
  policy: {
    remoteOnly: true,
    allowHybrid: false,
    workLocationMode: null,
    rateFloorHourly: 0,
    salaryFloor: 0,
    minConfidence: 0.85,
    blocklistDomains: [],
    blocklistSenders: [],
    vipSenders: [],
    autoArchive: { enabled: true, categories: ['REJECTION', 'ACK', 'JOB_ALERT', 'NEWSLETTER'], label: 'AIM/Archived' },
    autoSend: { enabled: false, categories: [], maxPerHour: 12, maxPerThread: 2 },
    approvals: { enabled: true, expireHours: 24 },
    quietHours: { enabled: false, start: '23:00', end: '07:00', timezone: 'America/New_York' }
  },
  dedupe: {
    enabled: true, titleSimilarity: 0.82, jdSimilarity: 0.7,
    sameClientWindowDays: 45, autoReplyToDuplicates: false
  },
  classify: {
    ai: { enabled: false, provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxPerHour: 240, maxBodyChars: 6000 },
    extraRejectionPhrases: [],
    extraInterviewPhrases: []
  },
  notify: {
    telegram: { enabled: false, chatId: '', silentCategories: ['REJECTION', 'ACK'] },
    ntfy: { enabled: false, priorityCategories: ['INTERVIEW'] },
    webhook: { enabled: false },
    digest: { enabled: true, hour: 8, timezone: 'America/New_York' }
  },
  dashboard: { enabled: true, port: 7391, host: '127.0.0.1' },
  ammBridge: { enabled: false, path: '' },
  paused: false
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merges defaults under an existing config so upgrades pick up new fields
 * without the user editing anything. User values always win; arrays are taken
 * whole rather than merged element-wise.
 */
export function withDefaults(config, defaults = DEFAULTS) {
  const out = Array.isArray(defaults) ? [] : {};
  for (const key of Object.keys(defaults)) out[key] = defaults[key];
  if (!isPlainObject(config)) return structuredClone(out);

  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('_')) continue;
    const fallback = defaults[key];
    out[key] = isPlainObject(value) && isPlainObject(fallback) ? withDefaults(value, fallback) : value;
  }
  return structuredClone(out);
}

export function configExists() {
  return existsSync(CONFIG_PATH);
}

/** Reads config.json merged over defaults. Returns bare defaults if absent. */
export function read() {
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULTS);
  try {
    return withDefaults(JSON.parse(stripBom(readFileSync(CONFIG_PATH, 'utf8'))));
  } catch (error) {
    throw new Error(`config.json is not valid JSON (${error.message}). Fix it or delete it and re-run \`npm run setup\`.`);
  }
}

/** Raw on-disk config with no defaults applied — for the dashboard editor. */
export function readRaw() {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(stripBom(readFileSync(CONFIG_PATH, 'utf8')));
}

export function write(config) {
  ensureDirs();
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(temp, CONFIG_PATH);
  return config;
}

/**
 * Creates config.json from the shipping template. Refuses to clobber.
 *
 * The template's `accounts` entry is documentation — it shows the shape of an
 * account, with a placeholder `you@gmail.com`. Copied verbatim it becomes a real
 * configured inbox pointing at an address that does not exist, which then shows
 * up in the UI as a broken account nobody added. So the array is emptied: a fresh
 * config has no accounts by definition, which is also what makes `needsSetup`
 * mean what it says.
 */
export function initFromExample() {
  if (existsSync(CONFIG_PATH)) return false;
  ensureDirs();
  copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);

  const fresh = read();
  fresh.accounts = [];
  write(fresh);
  return true;
}

/** Timestamped copy under data/backups. Returns the path, or '' if no config. */
export function snapshot(tag = 'manual') {
  if (!existsSync(CONFIG_PATH)) return '';
  ensureDirs();
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(BACKUP_DIR, `config-${stamp}-${tag}.json`);
  copyFileSync(CONFIG_PATH, target);
  return target;
}

function walk(root, path, { create = false } = {}) {
  const parts = String(path).split('.').filter(Boolean);
  if (!parts.length) throw new Error('config path cannot be empty');
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) {
      if (!create) return { parent: null, key: parts.at(-1) };
      node[part] = {};
    }
    node = node[part];
  }
  return { parent: node, key: parts.at(-1) };
}

/** get('policy.rateFloorHourly') */
export function get(path, fallback = undefined) {
  const config = read();
  const { parent, key } = walk(config, path);
  if (!parent || !(key in parent)) return fallback;
  return parent[key];
}

/** set('policy.rateFloorHourly', 70) — atomic, returns the new config. */
export function set(path, value) {
  const config = read();
  const { parent, key } = walk(config, path, { create: true });
  parent[key] = value;
  return write(config);
}

/** Applies several dot-path updates in one atomic write. */
export function setMany(updates) {
  const config = read();
  for (const [path, value] of Object.entries(updates)) {
    const { parent, key } = walk(config, path, { create: true });
    parent[key] = value;
  }
  return write(config);
}

export function addToArray(path, value) {
  const config = read();
  const { parent, key } = walk(config, path, { create: true });
  if (!Array.isArray(parent[key])) parent[key] = [];
  if (!parent[key].includes(value)) parent[key].push(value);
  return write(config);
}

export function removeFromArray(path, value) {
  const config = read();
  const { parent, key } = walk(config, path, { create: true });
  if (!Array.isArray(parent[key])) return config;
  parent[key] = parent[key].filter((item) => item !== value);
  return write(config);
}

/** Replaces one account by id, or appends it if new. */
export function upsertAccount(account) {
  const config = read();
  if (!Array.isArray(config.accounts)) config.accounts = [];
  const index = config.accounts.findIndex((candidate) => candidate.id === account.id);
  if (index >= 0) config.accounts[index] = { ...config.accounts[index], ...account };
  else config.accounts.push(account);
  return write(config);
}

export function removeAccount(accountId) {
  const config = read();
  config.accounts = (config.accounts || []).filter((account) => account.id !== accountId);
  return write(config);
}

export function deleteConfig() {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

/**
 * Structural validation. Returns { ok, errors[], warnings[] } — the dashboard
 * and the watcher both refuse to run against a config with errors.
 */
export function validate(config = read()) {
  const errors = [];
  const warnings = [];
  const accounts = Array.isArray(config.accounts) ? config.accounts : [];

  if (!accounts.length) errors.push('No accounts configured. Run `npm run setup`.');

  const seen = new Set();
  for (const [index, account] of accounts.entries()) {
    const where = `accounts[${index}]`;
    if (!account || typeof account !== 'object') {
      errors.push(`${where} is not an object`);
      continue;
    }
    if (!account.id || !/^[a-z0-9][a-z0-9_-]*$/.test(account.id)) {
      errors.push(`${where}.id must be lowercase letters, digits, dash or underscore (got ${JSON.stringify(account.id)})`);
    } else if (seen.has(account.id)) {
      errors.push(`${where}.id "${account.id}" is duplicated — ids must be unique`);
    } else {
      seen.add(account.id);
    }
    if (!account.email || !account.email.includes('@')) errors.push(`${where}.email is missing or malformed`);
    if (!['gmail', 'imap'].includes(account.transport)) errors.push(`${where}.transport must be "gmail" or "imap"`);
    if (account.transport === 'imap') {
      if (!account.imap?.host) errors.push(`${where}.imap.host is required for the imap transport`);
      if (!account.smtp?.host) warnings.push(`${where}.smtp.host is unset — replies from this account will fail`);
    }
    const poll = Number(account.pollSeconds);
    if (account.pollSeconds !== undefined && (!Number.isFinite(poll) || poll < 15)) {
      warnings.push(`${where}.pollSeconds below 15 risks Gmail rate limits; clamped to 15`);
    }
  }

  const confidence = Number(config.policy?.minConfidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push('policy.minConfidence must be between 0 and 1');
  }
  if (config.policy?.workLocationMode !== null && config.policy?.workLocationMode !== undefined &&
      !['remote', 'remote_hybrid', 'all'].includes(config.policy.workLocationMode)) {
    errors.push('policy.workLocationMode must be "remote", "remote_hybrid", or "all"');
  }
  if (config.policy?.autoSend?.enabled && !config.profile?.fullName) {
    errors.push('policy.autoSend.enabled requires profile.fullName — refusing to send unsigned mail');
  }
  if (config.policy?.autoSend?.enabled && confidence < 0.8) {
    warnings.push('autoSend is on with minConfidence below 0.80 — that is a low bar for sending real mail');
  }
  const providerKeys = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
  const provider = config.classify?.ai?.provider || 'anthropic';
  if (config.classify?.ai?.enabled && !process.env[providerKeys[provider] || 'ANTHROPIC_API_KEY']) {
    warnings.push(`classify.ai.enabled is true but the ${provider} API key is unset — falling back to rules only`);
  }

  const rawSsn = String(process.env.AIM_SSN_LAST4 || '').trim();
  if (rawSsn && !/^\d{4}$/.test(rawSsn.replace(/[\s-]/g, ''))) {
    errors.push('AIM_SSN_LAST4 is not exactly four digits — refusing to use it. If you pasted a full SSN there, remove it.');
  }
  if (rawSsn && !config.profile?.ssnLast4Acknowledged) {
    warnings.push('AIM_SSN_LAST4 is set but not acknowledged — it will not be sent until you confirm (/ssn confirm, or the dashboard toggle)');
  }
  if (config.profile?.ssnLast4Acknowledged && !rawSsn) {
    warnings.push('profile.ssnLast4Acknowledged is true but AIM_SSN_LAST4 is unset — nothing to send');
  }

  return { ok: errors.length === 0, errors, warnings };
}

export { DEFAULTS };

/** New three-way setting with compatibility for configs created before v1.5.3. */
export function workLocationMode(configOrPolicy = {}) {
  const policy = configOrPolicy.policy || configOrPolicy;
  if (['remote', 'remote_hybrid', 'all'].includes(policy?.workLocationMode)) return policy.workLocationMode;
  if (policy?.remoteOnly === false) return 'all';
  return policy?.allowHybrid ? 'remote_hybrid' : 'remote';
}
