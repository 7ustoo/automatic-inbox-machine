/**
 * The decision engine. Given a classified message, decides what actually
 * happens to it — and records why, so every action in the ledger is explainable
 * after the fact.
 *
 * Auto-send is the only irreversible action this app takes, so it is gated by
 * AND, never OR: every applicable check must pass. Anything that fails a gate
 * degrades to an approval card rather than being dropped, so nothing is silently
 * lost — the difference between "the agent replied" and "the agent asked you".
 */
import { ARCHIVABLE, NEVER_AUTO_REPLY } from './rules.mjs';
import { asksForSensitiveData } from './templates.mjs';
import { emailDomain } from './normalize.mjs';

export const ACTIONS = {
  AUTO_SEND: 'auto_send',
  APPROVE: 'approve',
  ALERT: 'alert',
  ARCHIVE: 'archive',
  IGNORE: 'ignore'
};

/** Categories that always reach the human, loudly, whatever else is true. */
const URGENT = new Set(['INTERVIEW']);

function inList(list, value) {
  return Array.isArray(list) && list.includes(value);
}

function rateBelowFloor(rate, policy) {
  if (!rate) return false;
  if (rate.kind === 'hourly') {
    const floor = Number(policy.rateFloorHourly) || 0;
    return floor > 0 && rate.max < floor;
  }
  const floor = Number(policy.salaryFloor) || 0;
  return floor > 0 && rate.max < floor;
}

/**
 * Decides the fate of one classified message.
 *
 * @returns {{
 *   action: string, template: string|null, urgent: boolean,
 *   archive: boolean, reasons: string[], blockedBy: string|null
 * }}
 */
export function decide({ category, confidence, fields, message, duplicate, config, counters = {} }) {
  const policy = config.policy || {};
  const autoSend = policy.autoSend || {};
  const reasons = [];
  const senderDomain = emailDomain(message.from);
  const fullText = `${message.subject || ''}\n${message.body || ''}`;

  const urgent = URGENT.has(category);
  const archivable = ARCHIVABLE.has(category) && policy.autoArchive?.enabled && inList(policy.autoArchive?.categories, category);

  /* ----- terminal, no-reply outcomes -------------------------------------- */

  if (config.paused) {
    return { action: urgent ? ACTIONS.ALERT : ACTIONS.IGNORE, template: null, urgent, archive: false, reasons: ['agent is paused (/resume to re-enable)'], blockedBy: 'paused' };
  }

  if (inList(policy.blocklistSenders, String(message.from || '').toLowerCase()) || inList(policy.blocklistDomains, senderDomain)) {
    return { action: ACTIONS.IGNORE, template: null, urgent: false, archive: archivable, reasons: [`sender ${senderDomain} is blocklisted`], blockedBy: 'blocklist' };
  }

  if (category === 'REJECTION' || category === 'ACK' || category === 'JOB_ALERT' || category === 'NEWSLETTER') {
    return {
      action: archivable ? ACTIONS.ARCHIVE : ACTIONS.IGNORE,
      template: null,
      urgent: false,
      archive: archivable,
      reasons: [archivable ? `${category} — archived, not deleted` : `${category} — left in place (autoArchive off for this category)`],
      blockedBy: null
    };
  }

  if (category === 'INTERVIEW') {
    return {
      action: ACTIONS.ALERT,
      template: null,
      urgent: true,
      archive: false,
      reasons: ['interview language detected — never auto-replied, always escalated to you'],
      blockedBy: null
    };
  }

  if (category === 'OTHER' || category === 'RECRUITER_OTHER') {
    return { action: ACTIONS.IGNORE, template: null, urgent: false, archive: false, reasons: [`${category} — logged for the digest, no action`], blockedBy: null };
  }

  /* ----- replyable categories: NEW_REQ, RTR_REQUEST, RATE_CONFIRM --------- */

  let template = category;
  const hardBlocks = [];

  if (asksForSensitiveData(fullText)) {
    hardBlocks.push('message asks for SSN / DOB / bank or ID details — the agent never auto-sends these');
  }

  if (NEVER_AUTO_REPLY.has(category)) {
    hardBlocks.push(`${category} is on the never-auto-reply list`);
  }

  // Duplicate handling comes before fit checks: if you are already in play, the
  // rate and the work mode are irrelevant.
  if (duplicate?.verdict === 'duplicate') {
    template = 'DUPLICATE';
    reasons.push(`duplicate (${duplicate.kind}, ${(duplicate.score * 100).toFixed(0)}%): ${duplicate.reason}`);
    if (!config.dedupe?.autoReplyToDuplicates) {
      hardBlocks.push('dedupe.autoReplyToDuplicates is off — duplicates are surfaced, not answered');
    }
  } else if (duplicate?.verdict === 'client_collision') {
    reasons.push(`client collision: ${duplicate.reason}`);
    hardBlocks.push('two agencies pitching the same end client — this needs your decision, never an auto-reply');
  }

  // Fit checks. A miss is not a failure — it swaps in a decline template — but
  // it does downgrade to approval unless you have explicitly allowed declines.
  if (template === category) {
    const mode = fields.workMode;
    if (policy.remoteOnly && mode === 'onsite') {
      template = 'DECLINE_ONSITE';
      reasons.push('role is onsite and policy.remoteOnly is set');
    } else if (policy.remoteOnly && mode === 'hybrid' && !policy.allowHybrid) {
      template = 'DECLINE_ONSITE';
      reasons.push('role is hybrid and policy.allowHybrid is false');
    } else if (rateBelowFloor(fields.rate, policy)) {
      template = 'DECLINE_RATE';
      reasons.push(`offered ${fields.rate.raw} is below your floor`);
    } else if (policy.remoteOnly && mode === 'unknown') {
      reasons.push('work mode not stated — cannot confirm remote, so not auto-sending interest');
      hardBlocks.push('work mode unknown while remoteOnly is set');
    }
  }

  /* ----- auto-send gates -------------------------------------------------- */

  const gates = [
    [autoSend.enabled === true, 'policy.autoSend.enabled is false'],
    [inList(autoSend.categories, template) || inList(autoSend.categories, category), `${template} is not in policy.autoSend.categories`],
    [confidence >= (Number(policy.minConfidence) || 0.85), `confidence ${confidence} is below minConfidence ${policy.minConfidence}`],
    [(counters.sentLastHour || 0) < (Number(autoSend.maxPerHour) || 12), `hourly send cap (${autoSend.maxPerHour}) reached`],
    [(counters.sentOnThread || 0) < (Number(autoSend.maxPerThread) || 2), `already sent ${counters.sentOnThread} on this thread (cap ${autoSend.maxPerThread})`],
    [Boolean(config.profile?.fullName), 'profile.fullName is empty — refusing to send unsigned mail']
  ];

  const failed = gates.filter(([passed]) => !passed).map(([, why]) => why);
  const blocked = [...hardBlocks, ...failed];

  if (!blocked.length) {
    return { action: ACTIONS.AUTO_SEND, template, urgent: false, archive: false, reasons: [...reasons, 'all auto-send gates passed'], blockedBy: null };
  }

  return {
    action: policy.approvals?.enabled === false ? ACTIONS.ALERT : ACTIONS.APPROVE,
    template,
    urgent: false,
    archive: false,
    reasons: [...reasons, ...blocked],
    blockedBy: hardBlocks.length ? hardBlocks[0] : failed[0]
  };
}

/** True when a push should be held for quiet hours. Urgent always breaks through. */
export function inQuietHours(config, now = new Date()) {
  const quiet = config.policy?.quietHours;
  if (!quiet?.enabled) return false;

  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: quiet.timezone || 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = format.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  const nowMinutes = hour * 60 + minute;

  const toMinutes = (text) => {
    const [h, m] = String(text || '0:0').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);

  // Windows that wrap midnight (23:00 -> 07:00) need the OR form.
  return start <= end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
}
