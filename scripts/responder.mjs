/**
 * Outbound replies: queue, send, skip.
 *
 * Every reply becomes a row in the outbound ledger before anything leaves the
 * machine, and the row is the single source of truth for what the agent did. That
 * ordering matters — if the process dies mid-send, the ledger shows a `sending`
 * row rather than losing the record entirely, and the duplicate guard on resume
 * refuses to fire it twice.
 */
import { append, find, sentInLastHour, sentOnThread, update } from './ledger.mjs';
import { buildSubmissionRecord } from './dedupe.mjs';
import { log, logError } from './log.mjs';
import { attachmentsForReply } from './resume-attachment.mjs';

/** Templates that constitute expressing interest, so they log a submission. */
const SUBMITTING_TEMPLATES = new Set(['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM']);

export function replySubject(originalSubject) {
  const subject = String(originalSubject || '').trim();
  if (!subject) return 'Re: your message';
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function replyTarget(message) {
  return message.replyTo || message.from;
}

/**
 * Records an intended reply. Status is 'pending' when it needs approval and
 * 'queued' when the gate already cleared it for immediate send.
 */
export function queueReply({ message, category, template, draft, decision, reqRecord, summary = '', status = 'pending', accountLabel = '' }) {
  return append('outbound', {
    status,
    accountId: message.accountId,
    accountLabel,
    accountEmail: message.accountEmail,
    threadId: message.threadId,
    messageKey: message.messageKey,
    providerId: message.providerId,
    rfcMessageId: message.rfcMessageId,
    references: message.references,
    to: replyTarget(message),
    subject: draft?.subject || replySubject(message.subject),
    body: draft?.body || '',
    template,
    templateLabel: draft?.label || template,
    category,
    action: decision?.action || '',
    reasons: decision?.reasons || [],
    blockedBy: decision?.blockedBy || null,
    fields: reqRecord
      ? {
          title: reqRecord.titleRaw,
          client: reqRecord.clientRaw,
          agency: reqRecord.agencyRaw,
          workMode: reqRecord.workMode,
          rate: reqRecord.rate
        }
      : {},
    reqFingerprint: reqRecord?.fingerprint || '',
    originalSubject: message.subject || '',
    originalFrom: message.from || '',
    originalSummary: String(summary || '').slice(0, 240)
  });
}

/**
 * Sends one outbound row. Idempotent by design: a row that is already 'sent'
 * short-circuits, so a retried Telegram callback or a resumed process cannot
 * double-send.
 *
 * Returns { ok, reason, row }.
 */
export async function sendReply({ outboundId, transport, config, reqRecord = null, via = 'auto' }) {
  const row = find('outbound', (candidate) => candidate.id === outboundId);
  if (!row) return { ok: false, reason: 'outbound row not found' };
  if (row.status === 'sent') return { ok: false, reason: 'already sent', row };
  if (row.status === 'skipped') return { ok: false, reason: 'was skipped', row };
  if (row.status === 'expired') return { ok: false, reason: 'approval expired — too old to fire safely', row };
  if (!row.body?.trim()) return { ok: false, reason: 'no body to send', row };
  if (config.paused) return { ok: false, reason: 'agent is paused', row };

  // Re-check volume caps at send time, not just at decision time. An approval
  // sitting in Telegram for an hour must not bypass the cap it was queued under.
  const autoSend = config.policy?.autoSend || {};
  if (via === 'auto') {
    if (sentInLastHour() >= (Number(autoSend.maxPerHour) || 12)) {
      return { ok: false, reason: `hourly send cap (${autoSend.maxPerHour}) reached`, row };
    }
    if (sentOnThread(row.accountId, row.threadId) >= (Number(autoSend.maxPerThread) || 2)) {
      return { ok: false, reason: 'per-thread send cap reached', row };
    }
  }

  update('outbound', (candidate) => candidate.id === outboundId, { status: 'sending' });

  try {
    const attachments = attachmentsForReply(config, row.template);
    const result = await transport.sendReply({
      to: row.to,
      subject: row.subject,
      body: row.body,
      threadId: row.threadId,
      inReplyTo: row.rfcMessageId,
      references: row.references,
      fromName: config.profile?.fullName || '',
      fromEmail: row.accountEmail,
      attachments
    });

    if (!result?.ok) {
      update('outbound', (candidate) => candidate.id === outboundId, { status: 'failed', error: 'transport reported failure' });
      return { ok: false, reason: 'transport reported failure', row };
    }

    const sentRow = update('outbound', (candidate) => candidate.id === outboundId, {
      status: 'sent',
      sentAt: new Date().toISOString(),
      sentVia: via,
      sentProviderId: result.providerId || '',
      attachments: attachments.map((attachment) => attachment.filename)
    });

    // Expressing interest is what creates a submission of record. Declines and
    // duplicate notices deliberately do not, or the dedupe ledger would fill up
    // with roles you actually turned down.
    if (SUBMITTING_TEMPLATES.has(row.template) && reqRecord) {
      const submission = buildSubmissionRecord({ req: reqRecord, outboundId, via });
      append('submissions', submission);
      log(`responder: logged submission for "${submission.titleRaw}" at ${submission.clientRaw || submission.agencyRaw || 'unknown client'}`, { name: 'responder' });
    }

    append('events', { type: 'reply_sent', outboundId, template: row.template, to: row.to, accountId: row.accountId, via });
    log(`responder: sent ${row.template} to ${row.to} (${via})`, { name: 'responder' });
    return { ok: true, reason: 'sent', row: sentRow };
  } catch (error) {
    logError('responder send', error, { name: 'responder' });
    update('outbound', (candidate) => candidate.id === outboundId, {
      status: 'failed',
      error: String(error?.message || error).slice(0, 300)
    });
    return { ok: false, reason: String(error?.message || error), row };
  }
}

export function skipReply(outboundId, reason = 'skipped by user') {
  const row = update('outbound', (candidate) => candidate.id === outboundId, { status: 'skipped', skipReason: reason });
  if (row) append('events', { type: 'reply_skipped', outboundId, reason });
  return row;
}

/** Replaces a queued body — used by the Telegram edit flow. */
export function editReply(outboundId, newBody) {
  const row = find('outbound', (candidate) => candidate.id === outboundId);
  if (!row) return null;
  if (row.status === 'sent') return null;
  return update('outbound', (candidate) => candidate.id === outboundId, {
    body: String(newBody).trim(),
    status: 'pending',
    editedAt: new Date().toISOString()
  });
}

export function getOutbound(outboundId) {
  return find('outbound', (candidate) => candidate.id === outboundId);
}
