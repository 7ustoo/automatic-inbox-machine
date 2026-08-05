/**
 * Dashboard data and actions. Pure functions over the ledger and config — the
 * HTTP layer in dashboard.mjs only routes and serializes.
 *
 * Nothing here returns a secret. Tokens, passwords and API keys stay in .env and
 * are reported as present/absent booleans, never values, because the dashboard is
 * the surface most likely to end up in a screenshot.
 */
import { addToArray, read, set, setMany, validate } from './config-rw.mjs';
import { pendingApprovals, readAll, rowsSince, stats } from './ledger.mjs';
import { getCursor, heartbeatAgeSeconds, readHeartbeat } from './state.mjs';
import { activeChannels } from './notify/index.mjs';
import { createTransport } from './transports/index.mjs';
import { editReply, getOutbound, sendReply, skipReply } from './responder.mjs';
import { findOutboundReq } from './req-lookup.mjs';
import { SSN_LAST4_DISCLAIMER, buildSlots, templateReadiness } from './templates.mjs';
import { cachedUpdate, checkForUpdate, currentVersion } from './update-checker.mjs';
import { createPairingLink, pairingStatus, unpair } from './telegram-setup.mjs';
import { hasTokens } from './transports/gmail-oauth.mjs';
import { dateOfBirth, env, ssnLast4, ssnLast4Malformed } from './env.mjs';
import { log } from './log.mjs';

/** Re-exported so the dashboard shell and the API agree on one implementation. */
export const version = currentVersion;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

function accountSummary(config) {
  return (config.accounts || []).map((account) => {
    const cursor = getCursor(account.id);
    const authorized = account.transport === 'gmail' ? hasTokens(account.id) : Boolean(env(`IMAP_PASSWORD_${account.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`));
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
      rateFloorHourly: Number(config.policy?.rateFloorHourly) || 0,
      minConfidence: Number(config.policy?.minConfidence) || 0,
      dedupeEnabled: Boolean(config.dedupe?.enabled),
      aiEnabled: Boolean(config.classify?.ai?.enabled),
      aiModel: config.classify?.ai?.model || '',
      blocklistDomains: config.policy?.blocklistDomains || [],
      ammBridge: Boolean(config.ammBridge?.enabled)
    },
    secrets: {
      telegramToken: Boolean(env('TG_TOKEN').trim()),
      anthropicKey: Boolean(env('ANTHROPIC_API_KEY').trim()),
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
      set('policy.remoteOnly', Boolean(payload.enabled));
      return { ok: true, enabled: Boolean(payload.enabled) };

    case 'allowHybrid':
      set('policy.allowHybrid', Boolean(payload.enabled));
      return { ok: true, enabled: Boolean(payload.enabled) };

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
      if (enabled && !env('ANTHROPIC_API_KEY').trim()) {
        return { ok: false, error: 'ANTHROPIC_API_KEY is not set in .env' };
      }
      set('classify.ai.enabled', enabled);
      return { ok: true, enabled };
    }

    case 'dedupeEnabled':
      set('dedupe.enabled', Boolean(payload.enabled));
      return { ok: true, enabled: Boolean(payload.enabled) };

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
      const allowed = ['fullName', 'phone', 'contactEmail', 'city', 'state', 'workAuth', 'linkedin', 'availability', 'preferredRateHourly', 'preferredSalary'];
      for (const key of allowed) {
        if (payload[key] === undefined) continue;
        updates[`profile.${key}`] = key.startsWith('preferred') ? Number(payload[key]) || 0 : String(payload[key]);
      }
      if (!Object.keys(updates).length) return { ok: false, error: 'nothing to update' };
      setMany(updates);
      return { ok: true, updated: Object.keys(updates).length };
    }

    case 'checkUpdate': {
      const result = await checkForUpdate({ force: true });
      return result ? { ok: true, ...result } : { ok: false, error: 'could not reach GitHub' };
    }

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
        return { ok: health.ok, ...health };
      } finally {
        await transport.disconnect().catch(() => {});
      }
    }

    default:
      return { ok: false, error: `unknown action "${name}"` };
  }
}

export const READ_ENDPOINTS = { overview, recentMessages, pending, submissions, duplicates, funnel };
