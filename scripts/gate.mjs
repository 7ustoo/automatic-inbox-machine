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
import { ARCHIVABLE, NEVER_AUTO_REPLY, NO_REPLY_SENDER } from './rules.mjs';
import { classifySensitiveAsk } from './templates.mjs';
import { emailDomain } from './normalize.mjs';
import { workLocationMode } from './config-rw.mjs';

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
export function decide({ category, confidence, fields, message, duplicate, config, counters = {}, slots = {}, decidedBy = '' }) {
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

  // Defense in depth: even if both the rules and an AI provider misclassify a
  // machine-generated message as replyable, never compose or send mail to an
  // address that explicitly says replies are not monitored.
  if (NO_REPLY_SENDER.test(String(message.from || '')) && ['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM'].includes(category)) {
    return {
      action: ACTIONS.IGNORE,
      template: null,
      urgent: false,
      archive: false,
      reasons: ['no-reply sender — no response drafted or sent'],
      blockedBy: 'no-reply sender'
    };
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

  if (category === 'RECRUITER_OTHER') {
    return {
      action: ACTIONS.ALERT,
      template: null,
      urgent: false,
      archive: false,
      reasons: ['recruiter message needs review — kept visible and never auto-replied'],
      blockedBy: null
    };
  }

  if (category === 'OTHER') {
    return { action: ACTIONS.IGNORE, template: null, urgent: false, archive: false, reasons: ['OTHER — logged for the digest, no action'], blockedBy: null };
  }

  /* ----- replyable categories: NEW_REQ, RTR_REQUEST, RATE_CONFIRM --------- */

  // Location filtering is inbox cleanup, not a decline campaign. An excluded
  // role is archived (recoverably) and never replied to. Unknown stays visible
  // because guessing "onsite" from missing information would hide real leads.
  const locationPreference = workLocationMode(policy);
  const mode = fields.workMode;
  const excludedByLocation =
    (locationPreference === 'remote' && (mode === 'hybrid' || mode === 'onsite')) ||
    (locationPreference === 'remote_hybrid' && mode === 'onsite');
  if (excludedByLocation) {
    const archive = policy.autoArchive?.enabled === true;
    return {
      action: archive ? ACTIONS.ARCHIVE : ACTIONS.IGNORE,
      template: null,
      urgent: false,
      archive,
      reasons: [`${mode} role excluded by ${locationPreference} work-location preference${archive ? ' — archived, not deleted' : ' — left in place because auto-archive is off'}`],
      blockedBy: 'work-location preference'
    };
  }

  let template = category;
  const hardBlocks = [];

  // If a configured model is unavailable, preserve an obvious rules-detected
  // opportunity so it cannot disappear from the user's view, but never let a
  // rules-only guess send mail automatically. It must go through approval.
  if (decidedBy === 'rules-failsafe') {
    hardBlocks.push('AI verification unavailable — review this recruiter message before sending');
  }

  // Sensitive asks are tiered. Anything in the blocked tier ends the discussion;
  // an opt-in ask redirects to the onboarding template, but only if every field
  // it wants is actually available and consented to.
  const sensitive = classifySensitiveAsk(fullText);

  if (sensitive.hasBlocked) {
    hardBlocks.push(
      `message asks for ${sensitive.blocked.join(', ')} — never auto-sent, in any configuration`
    );
  } else if (sensitive.hasAllowed) {
    const missing = sensitive.allowed.filter((field) => !String(slots[field] || '').trim());
    template = 'ONBOARDING_INFO';
    reasons.push(`onboarding details requested: ${sensitive.allowed.join(', ')}`);

    if (missing.length) {
      const hint = missing
        .map((field) =>
          field === 'ssnLast4'
            ? 'SSN last four is unset or not acknowledged (/ssn in Telegram, or the dashboard toggle)'
            : 'date of birth is unset (AIM_DATE_OF_BIRTH in .env)'
        )
        .join('; ');
      hardBlocks.push(`asked for ${missing.join(', ')} but ${hint}`);
    }
  }

  const missingRequested = (slots.requestedMissingFields || [])
    .filter((field) => !sensitive.allowed.includes(field));
  if (missingRequested.length) {
    hardBlocks.push(`recruiter requested missing profile fields: ${missingRequested.join(', ')} — complete your Candidate Profile before sending`);
  } else if ((fields.requestedProfileFields || []).length) {
    reasons.push(`reply includes requested fields: ${fields.requestedProfileFields.join(', ')}`);
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
    if (rateBelowFloor(fields.rate, policy)) {
      template = 'DECLINE_RATE';
      reasons.push(`offered ${fields.rate.raw} is below your floor`);
    } else if (locationPreference !== 'all' && mode === 'unknown') {
      reasons.push('work mode not stated — cannot confirm it matches your location preference');
      hardBlocks.push('work mode unknown under a restrictive location preference');
    }
  }

  /* ----- auto-send gates -------------------------------------------------- */

  // ONBOARDING_INFO must be allowlisted by its own name — it may carry date of
  // birth and SSN last four, so it must not inherit permission from the category
  // that happened to trigger it (a rate question with a DOB ask tacked on).
  const categoryAllowed =
    template === 'ONBOARDING_INFO'
      ? inList(autoSend.categories, 'ONBOARDING_INFO')
      : inList(autoSend.categories, template) || inList(autoSend.categories, category);

  const gates = [
    [autoSend.enabled === true, 'policy.autoSend.enabled is false'],
    [categoryAllowed, `${template} is not in policy.autoSend.categories`],
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
