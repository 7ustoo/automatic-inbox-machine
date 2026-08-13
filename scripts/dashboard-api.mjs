/**
 * Dashboard data and actions. Pure functions over the ledger and config — the
 * HTTP layer in dashboard.mjs only routes and serializes.
 *
 * Nothing here returns a secret. Tokens, passwords and API keys stay in .env and
 * are reported as present/absent booleans, never values, because the dashboard is
 * the surface most likely to end up in a screenshot.
 */
import { addToArray, initFromExample, configExists, read, removeAccount, set, setMany, upsertAccount, validate, workLocationMode } from './config-rw.mjs';
import { removeSecret, secretsPresent, setSecret, writableFields } from './env-writer.mjs';
import { authorizeAccount, hasClientCredentials, hasTokens as gmailAuthorized } from './transports/gmail-oauth.mjs';
import { accountIdFor, guessMailHosts } from './mail-hosts.mjs';
import { sourceMessageUrl } from './message-link.mjs';
import { friendlyError } from './friendly-errors.mjs';
import { pendingApprovals, readAll, rowsSince, stats } from './ledger.mjs';
import { getCursor, heartbeatAgeSeconds, readHeartbeat } from './state.mjs';
import { activeChannels } from './notify/index.mjs';
import { createTransport } from './transports/index.mjs';
import { editReply, getOutbound, sendReply, skipReply } from './responder.mjs';
import { findOutboundReq } from './req-lookup.mjs';
import { SSN_LAST4_DISCLAIMER, buildSlots, templateReadiness } from './templates.mjs';
import { cachedUpdate, checkForUpdate, currentVersion } from './update-checker.mjs';
import { updateApply, updateInfo } from './self-update.mjs';
import { createPairingLink, pairingStatus, unpair } from './telegram-setup.mjs';
import { dateOfBirth, env, ssnLast4, ssnLast4Malformed } from './env.mjs';
import { log } from './log.mjs';
import { AI_PROVIDERS, providerFor, providerHasKey, providerList } from './ai-providers.mjs';
import { removeResume, resumeStatus, saveResumeUpload } from './resume-attachment.mjs';

/** Re-exported so the dashboard shell and the API agree on one implementation. */
export const version = currentVersion;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

function accountSummary(config) {
  return (config.accounts || []).map((account) => {
    const cursor = getCursor(account.id);
    const authorized = account.transport === 'gmail' ? gmailAuthorized(account.id) : Boolean(env(`IMAP_PASSWORD_${account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`));
    return {
      id: account.id,
      label: account.label || account.id,
      email: account.email,
      transport: account.transport,
      enabled: account.enabled !== false,
      authorized,
      lastSyncAt: cursor.lastSyncAt || '',
      lastError: cursor.lastError || '',
      lastErrorAt: cursor.lastErrorAt || '',
      pollSeconds: account.pollSeconds || 45
    };
  });
}

export function overview() {
  const config = read();
  const check = validate(config);
  const accountIds = (config.accounts || []).map((account) => account.id);
  const beat = readHeartbeat();
  const age = heartbeatAgeSeconds();

  return {
    version: version(),
    needsSetup: (config.accounts || []).length === 0,
    config: {
      paused: Boolean(config.paused),
      autoSend: Boolean(config.policy?.autoSend?.enabled),
      autoSendCategories: config.policy?.autoSend?.categories || [],
      autoArchive: Boolean(config.policy?.autoArchive?.enabled),
      remoteOnly: Boolean(config.policy?.remoteOnly),
      allowHybrid: Boolean(config.policy?.allowHybrid),
      workLocationMode: workLocationMode(config),
      rateFloorHourly: Number(config.policy?.rateFloorHourly) || 0,
      minConfidence: Number(config.policy?.minConfidence) || 0,
      dedupeEnabled: Boolean(config.dedupe?.enabled),
      aiEnabled: Boolean(config.classify?.ai?.enabled),
      aiProvider: config.classify?.ai?.provider || 'anthropic',
      aiModel: config.classify?.ai?.model || '',
      blocklistDomains: config.policy?.blocklistDomains || [],
      ammBridge: Boolean(config.ammBridge?.enabled)
    },
    secrets: {
      telegramToken: Boolean(env('TG_TOKEN').trim()),
      anthropicKey: Boolean(env('ANTHROPIC_API_KEY').trim()),
      openaiKey: Boolean(env('OPENAI_API_KEY').trim()),
      geminiKey: Boolean(env('GEMINI_API_KEY').trim()),
      googleClient: Boolean(env('GOOGLE_CLIENT_ID').trim()),
      ntfyTopic: Boolean(env('NTFY_TOPIC').trim()),
      webhookUrl: Boolean(env('WEBHOOK_URL').trim())
    },
    // Presence and consent only. The values themselves are never serialized —
    // this response ends up in browser memory and, often enough, a screenshot.
    onboarding: {
      dobPresent: Boolean(dateOfBirth()),
      dobEnabled: config.profile?.provideDateOfBirth !== false,
      ssnPresent: Boolean(ssnLast4()),
      ssnMalformed: ssnLast4Malformed(),
      ssnAcknowledged: config.profile?.ssnLast4Acknowledged === true,
      ssnAutoSendable: (config.policy?.autoSend?.categories || []).includes('ONBOARDING_INFO'),
      disclaimer: SSN_LAST4_DISCLAIMER
    },
    watcher: {
      heartbeatAt: beat.at || '',
      ageSeconds: age === Infinity ? null : age,
      alive: age !== Infinity && age < 180,
      pid: beat.pid || 0,
      mode: beat.mode || ''
    },
    update: cachedUpdate(),
    // Presence booleans plus field metadata, so the setup UI can render itself
    // and show what is already set without ever receiving a secret.
    secretsPresent: secretsPresent(accountIds),
    secretFields: writableFields(),
    aiProviders: providerList(),
    googleClientConfigured: hasClientCredentials(),
    profile: {
      fullName: config.profile?.fullName || '',
      phone: config.profile?.phone || '',
      contactEmail: config.profile?.contactEmail || '',
      city: config.profile?.city || '',
      state: config.profile?.state || '',
      country: config.profile?.country || '',
      workAuth: config.profile?.workAuth || '',
      linkedin: config.profile?.linkedin || '',
      availability: config.profile?.availability || '',
      preferredRateHourly: Number(config.profile?.preferredRateHourly) || 0,
      preferredSalary: Number(config.profile?.preferredSalary) || 0,
      employmentTypes: Array.isArray(config.profile?.employmentTypes) ? config.profile.employmentTypes : [],
      titles: Array.isArray(config.profile?.titles) ? config.profile.titles : [],
      updatedAt: config.profile?.updatedAt || '',
      resume: resumeStatus(config)
    },
    channels: activeChannels(config),
    telegram: pairingStatus(),
    accounts: accountSummary(config),
    stats24h: stats(24),
    stats7d: stats(24 * 7),
    templates: templateReadiness(buildSlots({ profile: config.profile, fields: {}, accountEmail: config.accounts?.[0]?.email || '' })),
    validation: check
  };
}

export function recentMessages({ limit = 100, category = '' } = {}) {
  const config = read();
  let rows = readAll('messages');
  if (category) rows = rows.filter((row) => row.category === category);
  return rows
    .slice(-Math.max(1, Math.min(500, limit)))
    .reverse()
    .map((row) => ({
      id: row.id,
      ts: row.ts,
      account: row.accountLabel || row.accountId,
      from: row.from,
      fromName: row.fromName,
      subject: row.subject,
      emailUrl: sourceMessageUrl(row, config.accounts || []),
      category: row.category,
      confidence: row.confidence,
      decidedBy: row.decidedBy,
      action: row.action,
      template: row.template,
      archived: Boolean(row.archived),
      blockedBy: row.blockedBy || '',
      reason: row.reason || '',
      gateReasons: row.gateReasons || [],
      duplicateVerdict: row.duplicateVerdict || 'new',
      duplicateSummary: row.duplicateSummary || '',
      fields: row.fields || {}
    }));
}

export function pending() {
  const config = read();
  return pendingApprovals({ expireHours: config.policy?.approvals?.expireHours || 24 }).map((row) => ({
    id: row.id,
    ts: row.ts,
    account: row.accountLabel || row.accountId,
    to: row.to,
    subject: row.subject,
    emailUrl: sourceMessageUrl(row, config.accounts || []),
    body: row.body,
    template: row.template,
    templateLabel: row.templateLabel,
    category: row.category,
    blockedBy: row.blockedBy || '',
    reasons: row.reasons || [],
    fields: row.fields || {}
  }));
}

export function submissions() {
  return readAll('submissions')
    .slice(-200)
    .reverse()
    .map((row) => ({
      title: row.titleRaw,
      client: row.clientRaw,
      agency: row.agencyRaw,
      recruiter: row.recruiterName || row.recruiterEmail,
      account: row.accountId,
      submittedAt: row.submittedAt,
      via: row.via,
      rate: row.rate || null
    }));
}

export function duplicates() {
  return rowsSince('messages', 24 * 90)
    .filter((row) => row.duplicateVerdict && row.duplicateVerdict !== 'new')
    .slice(-200)
    .reverse()
    .map((row) => ({
      ts: row.ts,
      verdict: row.duplicateVerdict,
      summary: row.duplicateSummary,
      title: row.fields?.title || row.subject,
      client: row.fields?.client || '',
      agency: row.fields?.agency || '',
      from: row.from
    }));
}

export function funnel(hours = 24) {
  const rows = rowsSince('messages', hours);
  const byAction = {};
  const byCategory = {};
  for (const row of rows) {
    byAction[row.action || 'none'] = (byAction[row.action || 'none'] || 0) + 1;
    byCategory[row.category || 'UNKNOWN'] = (byCategory[row.category || 'UNKNOWN'] || 0) + 1;
  }
  const outbound = rowsSince('outbound', hours);
  return {
    hours,
    total: rows.length,
    byAction,
    byCategory,
    outbound: {
      sent: outbound.filter((row) => row.status === 'sent').length,
      pending: outbound.filter((row) => row.status === 'pending').length,
      skipped: outbound.filter((row) => row.status === 'skipped').length,
      failed: outbound.filter((row) => row.status === 'failed').length,
      expired: outbound.filter((row) => row.status === 'expired').length
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

export async function action(name, payload = {}) {
  const config = read();

  switch (name) {
    case 'pause':
      set('paused', true);
      return { ok: true, paused: true };

    case 'resume':
      set('paused', false);
      return { ok: true, paused: false };

    case 'autosend': {
      const enabled = Boolean(payload.enabled);
      if (enabled && !config.profile?.fullName) {
        return { ok: false, error: 'Set profile.fullName before enabling auto-send — unsigned mail is never sent.' };
      }
      set('policy.autoSend.enabled', enabled);
      log(`dashboard: auto-send ${enabled ? 'enabled' : 'disabled'}`, { name: 'dashboard' });
      return { ok: true, enabled };
    }

    case 'autoarchive':
      set('policy.autoArchive.enabled', Boolean(payload.enabled));
      return { ok: true, enabled: Boolean(payload.enabled) };

    case 'remoteOnly':
      setMany({
        'policy.remoteOnly': Boolean(payload.enabled),
        'policy.workLocationMode': payload.enabled ? 'remote' : 'all'
      });
      return { ok: true, enabled: Boolean(payload.enabled) };

    case 'allowHybrid':
      setMany({
        'policy.allowHybrid': Boolean(payload.enabled),
        'policy.workLocationMode': payload.enabled ? 'remote_hybrid' : 'remote'
      });
      return { ok: true, enabled: Boolean(payload.enabled) };

    case 'workLocationMode': {
      const mode = String(payload.mode || '');
      if (!['remote', 'remote_hybrid', 'all'].includes(mode)) return { ok: false, error: 'choose remote, remote + hybrid, or all locations' };
      setMany({
        'policy.workLocationMode': mode,
        'policy.remoteOnly': mode !== 'all',
        'policy.allowHybrid': mode === 'remote_hybrid'
      });
      return { ok: true, mode };
    }

    case 'floor': {
      const value = Number(payload.value);
      if (!Number.isFinite(value) || value < 0) return { ok: false, error: 'floor must be a non-negative number' };
      set('policy.rateFloorHourly', value);
      return { ok: true, value };
    }

    case 'minConfidence': {
      const value = Number(payload.value);
      if (!Number.isFinite(value) || value < 0 || value > 1) return { ok: false, error: 'minConfidence must be between 0 and 1' };
      set('policy.minConfidence', value);
      return { ok: true, value };
    }

    case 'aiEnabled': {
      const enabled = Boolean(payload.enabled);
      const provider = providerFor(config.classify?.ai?.provider || 'anthropic');
      if (enabled && !providerHasKey(provider.id)) {
        return { ok: false, error: `${provider.label} needs an API key first` };
      }
      set('classify.ai.enabled', enabled);
      return { ok: true, enabled };
    }

    case 'aiProvider': {
      const provider = AI_PROVIDERS[String(payload.provider || '')];
      if (!provider) return { ok: false, error: 'choose Claude, OpenAI, or Gemini' };
      setMany({
        'classify.ai.provider': provider.id,
        'classify.ai.model': provider.defaultModel,
        'classify.ai.enabled': providerHasKey(provider.id)
      });
      return { ok: true, provider: provider.id, enabled: providerHasKey(provider.id) };
    }

    case 'dedupeEnabled':
      set('dedupe.enabled', Boolean(payload.enabled));
      return { ok: true, enabled: Boolean(payload.enabled) };

    /* ----- first-run setup ------------------------------------------------ */

    case 'suggestHosts': {
      const guess = guessMailHosts(String(payload.email || ''));
      if (!guess.domain) return { ok: false, error: 'that does not look like an email address' };
      return {
        ok: true,
        ...guess,
        suggestedId: accountIdFor(payload.email, (config.accounts || []).map((account) => account.id)),
        googleClientConfigured: hasClientCredentials()
      };
    }

    case 'addAccount': {
      const email = String(payload.email || '').trim().toLowerCase();
      if (!email.includes('@')) return { ok: false, error: 'enter a valid email address' };

      const transport = payload.transport === 'gmail' ? 'gmail' : 'imap';
      if (transport === 'gmail' && !hasClientCredentials()) {
        return { ok: false, error: 'Add a Google OAuth client ID and secret first, or use the app-password option.' };
      }

      // config.json may not exist yet on a fresh install — the installer ships
      // only the example. Create it here rather than making the user run setup.
      if (!configExists()) initFromExample();

      const existing = read();
      const taken = (existing.accounts || []).map((account) => account.id);
      const id = String(payload.id || '').trim() || accountIdFor(email, taken);
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return { ok: false, error: 'account id must be lowercase letters, digits, dash or underscore' };
      if (taken.includes(id)) return { ok: false, error: `an account with id "${id}" already exists` };

      const guess = guessMailHosts(email);
      const account = {
        id,
        label: String(payload.label || '').trim() || email.split('@')[0],
        email,
        transport,
        enabled: true,
        pollSeconds: 45,
        replyFromName: ''
      };

      if (transport === 'imap') {
        account.imap = {
          host: String(payload.imapHost || guess.imap?.host || '').trim(),
          port: Number(payload.imapPort) || guess.imap?.port || 993,
          secure: payload.imapSecure !== false
        };
        account.smtp = {
          host: String(payload.smtpHost || guess.smtp?.host || '').trim(),
          port: Number(payload.smtpPort) || guess.smtp?.port || 465,
          secure: payload.smtpSecure !== undefined ? Boolean(payload.smtpSecure) : (guess.smtp?.secure ?? true)
        };
        if (!account.imap.host) return { ok: false, error: 'an IMAP host is required' };

        if (payload.password) {
          const stored = setSecret('IMAP_PASSWORD', payload.password, { accountId: id });
          if (!stored.ok) return stored;
        }
      }

      upsertAccount(account);
      log(`dashboard: added account ${id} (${transport})`, { name: 'dashboard' });
      return { ok: true, id, transport, needsGmailAuth: transport === 'gmail' };
    }

    case 'deleteAccount': {
      const id = String(payload.id || '');
      if (!(config.accounts || []).some((account) => account.id === id)) return { ok: false, error: 'unknown account' };
      removeAccount(id);
      removeSecret('IMAP_PASSWORD', { accountId: id });
      removeSecret('SMTP_PASSWORD', { accountId: id });
      log(`dashboard: removed account ${id}`, { name: 'dashboard' });
      return { ok: true };
    }

    case 'setSecret': {
      const result = setSecret(String(payload.key || ''), payload.value, { accountId: payload.accountId || '' });
      return result.ok ? { ok: true, key: result.key } : result;
    }

    case 'clearSecret':
      return removeSecret(String(payload.key || ''), { accountId: payload.accountId || '' });

    case 'gmailAuthUrl': {
      // authorizeAccount() blocks until the loopback callback arrives, so it
      // cannot be awaited inside a request. Kick it off, hand the URL back, and
      // let the browser drive it; the client polls overview for the result.
      const id = String(payload.id || '');
      const account = (config.accounts || []).find((candidate) => candidate.id === id);
      if (!account) return { ok: false, error: 'unknown account' };
      if (account.transport !== 'gmail') return { ok: false, error: 'that account does not use the Gmail API' };

      return new Promise((resolve) => {
        let settled = false;
        authorizeAccount({
          accountId: id,
          email: account.email,
          onUrl: (url) => {
            settled = true;
            resolve({ ok: true, url });
          }
        })
          .then(() => log(`dashboard: gmail authorized for ${id}`, { name: 'dashboard' }))
          .catch((error) => {
            log(`dashboard: gmail auth failed for ${id}: ${error.message}`, { name: 'dashboard' });
            if (!settled) resolve({ ok: false, error: String(error?.message || error) });
          });
      });
    }

    case 'startAgent': {
      // Called at the end of setup so the user never types a command to begin
      // watching. Imported lazily — app.mjs spawns processes on import-time paths.
      const { start } = await import('./app.mjs');
      const code = await start({ open: false });
      return code === 0 ? { ok: true } : { ok: false, error: 'the agent did not come up — check logs/app.log' };
    }

    case 'provideDateOfBirth':
      set('profile.provideDateOfBirth', Boolean(payload.enabled));
      return { ok: true, enabled: Boolean(payload.enabled) };

    case 'acknowledgeSsnLast4': {
      const enabled = Boolean(payload.enabled);
      if (!enabled) {
        set('profile.ssnLast4Acknowledged', false);
        return { ok: true, enabled: false };
      }
      // The client must echo the acknowledgement back. This is not security — it
      // is a guard against a mis-click flipping on something that mails identity
      // data, and it means the rundown was actually rendered before consent.
      if (payload.acknowledged !== true) {
        return { ok: false, error: 'acknowledgement required — read the notice and confirm' };
      }
      if (ssnLast4Malformed()) {
        return { ok: false, error: 'AIM_SSN_LAST4 is not exactly four digits. If a full SSN is in there, remove it — the full number is never sendable.' };
      }
      if (!ssnLast4()) {
        return { ok: false, error: 'AIM_SSN_LAST4 is not set in .env — nothing to enable' };
      }
      set('profile.ssnLast4Acknowledged', true);
      log('dashboard: SSN last four acknowledged and enabled', { name: 'dashboard' });
      return { ok: true, enabled: true };
    }

    case 'onboardingAutoSend': {
      // Allowlisting ONBOARDING_INFO by name is the second, separate decision:
      // "the agent may include this" and "the agent may send it unasked" are not
      // the same consent.
      const enabled = Boolean(payload.enabled);
      if (enabled) {
        if (!config.policy?.autoSend?.enabled) return { ok: false, error: 'turn auto-send on first' };
        addToArray('policy.autoSend.categories', 'ONBOARDING_INFO');
      } else {
        const categories = (config.policy?.autoSend?.categories || []).filter((entry) => entry !== 'ONBOARDING_INFO');
        set('policy.autoSend.categories', categories);
      }
      return { ok: true, enabled };
    }

    case 'block': {
      const domain = String(payload.domain || '').trim().toLowerCase().replace(/^.*@/, '');
      if (!domain.includes('.')) return { ok: false, error: 'not a domain' };
      addToArray('policy.blocklistDomains', domain);
      return { ok: true, domain };
    }

    case 'profile': {
      const updates = {};
      const allowed = ['fullName', 'phone', 'contactEmail', 'city', 'state', 'country', 'workAuth', 'linkedin', 'availability', 'preferredRateHourly', 'preferredSalary'];
      for (const key of allowed) {
        if (payload[key] === undefined) continue;
        updates[`profile.${key}`] = key.startsWith('preferred') ? Math.max(0, Number(payload[key]) || 0) : String(payload[key]).trim();
      }
      for (const key of ['employmentTypes', 'titles']) {
        if (payload[key] === undefined) continue;
        const values = Array.isArray(payload[key]) ? payload[key] : String(payload[key]).split(',');
        updates[`profile.${key}`] = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
      }
      if (!Object.keys(updates).length) return { ok: false, error: 'nothing to update' };
      updates['profile.updatedAt'] = new Date().toISOString();
      setMany(updates);
      return { ok: true, updated: Object.keys(updates).length };
    }

    case 'resumeUpload': {
      const saved = saveResumeUpload({ filename: payload.filename, dataBase64: payload.dataBase64 });
      setMany({
        'profile.resume.enabled': true,
        'profile.resume.storedName': saved.storedName,
        'profile.resume.filename': saved.filename,
        'profile.resume.contentType': saved.contentType,
        'profile.updatedAt': new Date().toISOString()
      });
      return { ok: true, filename: saved.filename, bytes: saved.bytes };
    }

    case 'resumeEnabled': {
      const present = resumeStatus(config).present;
      if (payload.enabled && !present) return { ok: false, error: 'upload a resume first' };
      setMany({
        'profile.resume.enabled': Boolean(payload.enabled),
        'profile.updatedAt': new Date().toISOString()
      });
      return { ok: true, enabled: Boolean(payload.enabled) };
    }

    case 'resumeRemove':
      removeResume();
      setMany({
        'profile.resume.enabled': false,
        'profile.resume.storedName': '',
        'profile.resume.filename': '',
        'profile.resume.contentType': '',
        'profile.updatedAt': new Date().toISOString()
      });
      return { ok: true };

    case 'checkUpdate': {
      const result = await checkForUpdate({ force: true });
      return result ? { ok: true, ...result } : { ok: false, error: 'could not reach GitHub' };
    }

    case 'updateInfo':
      return updateInfo();

    case 'updateApply':
      // Downloads, sha256-verifies, then hands off to a detached updater that
      // survives this process being killed by the installer. Same flow as AMM.
      return updateApply();

    case 'pairingLink':
      return createPairingLink();

    case 'unpair':
      return unpair();

    case 'skipOutbound': {
      const row = skipReply(String(payload.id || ''), 'skipped from dashboard');
      return row ? { ok: true } : { ok: false, error: 'not found' };
    }

    case 'editOutbound': {
      const row = editReply(String(payload.id || ''), String(payload.body || ''));
      return row ? { ok: true, body: row.body } : { ok: false, error: 'not found or already sent' };
    }

    case 'sendOutbound': {
      const row = getOutbound(String(payload.id || ''));
      if (!row) return { ok: false, error: 'not found' };
      const account = (config.accounts || []).find((candidate) => candidate.id === row.accountId);
      if (!account) return { ok: false, error: `account "${row.accountId}" is no longer configured` };

      const transport = createTransport(account);
      try {
        await transport.connect();
        const result = await sendReply({ outboundId: row.id, transport, config, reqRecord: findOutboundReq(row), via: 'manual' });
        return result.ok ? { ok: true } : { ok: false, error: result.reason };
      } finally {
        await transport.disconnect().catch(() => {});
      }
    }

    case 'runOnce': {
      // Imported lazily: pulling the watcher in at module load would start its
      // config validation on every dashboard boot.
      const { runOnce } = await import('./watcher.mjs');
      const results = await runOnce({ config });
      return { ok: true, processed: results.length, results };
    }

    case 'testAccount': {
      const account = (config.accounts || []).find((candidate) => candidate.id === payload.id);
      if (!account) return { ok: false, error: 'unknown account' };
      const transport = createTransport(account);
      try {
        const health = await transport.health();
        if (health.ok) return { ok: true, ...health };
        return { ok: false, ...health, error: friendlyError(health.error).message };
      } catch (error) {
        return { ok: false, error: friendlyError(error?.message || error).message };
      } finally {
        await transport.disconnect().catch(() => {});
      }
    }

    default:
      return { ok: false, error: `unknown action "${name}"` };
  }
}

export const READ_ENDPOINTS = { overview, recentMessages, pending, submissions, duplicates, funnel };
