/**
 * Message formatting for every notification channel.
 *
 * Kept separate from the transports so the wording of an interview alert is
 * defined once, and a channel that cannot render HTML (ntfy, SMS) can strip
 * tags from the same source text instead of maintaining its own copy.
 */
import { escapeHtml } from '../telegram-api.mjs';

const ICONS = {
  INTERVIEW: '🚨',
  NEW_REQ: '📄',
  RTR_REQUEST: '✍️',
  RATE_CONFIRM: '💵',
  DUPLICATE: '♻️',
  CLIENT_COLLISION: '⚠️',
  REJECTION: '❌',
  ACK: '📥',
  JOB_ALERT: '📰',
  NEWSLETTER: '📰',
  RECRUITER_OTHER: '💬',
  OTHER: '•'
};

export function icon(category) {
  return ICONS[category] || '•';
}

/** Strips HTML tags for channels that render plain text only. */
export function toPlain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function rateText(rate) {
  if (!rate) return '';
  if (rate.kind === 'hourly') return rate.max > rate.min ? `$${rate.min}-$${rate.max}/hr` : `$${rate.min}/hr`;
  const format = (value) => `$${Number(value).toLocaleString('en-US')}`;
  return rate.max > rate.min ? `${format(rate.min)}-${format(rate.max)}` : format(rate.min);
}

function detailLines(fields) {
  const lines = [];
  if (fields.client) lines.push(`Client: <b>${escapeHtml(fields.client)}</b>`);
  if (fields.agency) lines.push(`Agency: ${escapeHtml(fields.agency)}`);
  if (fields.location) lines.push(`Location: ${escapeHtml(fields.location)}`);
  if (fields.workMode && fields.workMode !== 'unknown') lines.push(`Mode: ${escapeHtml(fields.workMode)}`);
  const rate = rateText(fields.rate);
  if (rate) lines.push(`Rate: ${escapeHtml(rate)}`);
  if (fields.duration) lines.push(`Duration: ${escapeHtml(fields.duration)}`);
  if (fields.employmentType?.length) lines.push(`Type: ${escapeHtml(fields.employmentType.join(' / '))}`);
  return lines;
}

/** The loud one. Interview language always reaches the human immediately. */
export function interviewAlert({ message, fields, accountLabel, emailSummary = '' }) {
  const who = fields.recruiterName || message.fromName || message.from;
  return [
    `${ICONS.INTERVIEW} <b>INTERVIEW REQUEST</b>`,
    '',
    `<b>${escapeHtml(fields.title || message.subject || 'Role not stated')}</b>`,
    ...detailLines(fields),
    '',
    `From: ${escapeHtml(who)} &lt;${escapeHtml(message.from)}&gt;`,
    `Inbox: ${escapeHtml(accountLabel)}`,
    '',
    '<b>Email summary</b>',
    escapeHtml(emailSummary || (message.snippet || message.body || '').slice(0, 300)),
    '',
    '<b>Not auto-replied.</b> This one is yours.'
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/** A reply is queued and waiting for Send / Edit / Skip. */
export function approvalCard({ message, fields, category, template, reasons, draft, accountLabel, confidence, emailSummary = '' }) {
  const lines = [
    `${icon(category)} <b>${escapeHtml(labelFor(category))}</b> · needs your call`,
    '',
    `<b>${escapeHtml(fields.title || message.subject || 'Untitled')}</b>`,
    ...detailLines(fields),
    '',
    `From: ${escapeHtml(fields.recruiterName || message.fromName || message.from)} &lt;${escapeHtml(message.from)}&gt;`,
    `Inbox: ${escapeHtml(accountLabel)} · confidence ${(Number(confidence) * 100).toFixed(0)}%`,
    '',
    '<b>Email summary</b>',
    escapeHtml(emailSummary || (message.snippet || message.body || '').slice(0, 300))
  ];

  if (reasons?.length) {
    lines.push('', `<b>Held because:</b> ${escapeHtml(reasons[0])}`);
  }

  if (draft?.ok) {
    lines.push('', `<b>Draft reply</b> (${escapeHtml(draft.label || template)}):`, `<pre>${escapeHtml(draft.body.slice(0, 1200))}</pre>`);
  } else if (draft?.reason) {
    lines.push('', `<b>No draft:</b> ${escapeHtml(draft.reason)}`);
  }

  return lines.join('\n');
}

/** A reply already went out. Informational, no buttons. */
export function sentCard({ message, fields, template, accountLabel, to }) {
  return [
    `✅ <b>Auto-replied</b> · ${escapeHtml(labelFor(template))}`,
    '',
    `<b>${escapeHtml(fields.title || message.subject || 'Untitled')}</b>`,
    ...detailLines(fields),
    '',
    `To: ${escapeHtml(to)}`,
    `Inbox: ${escapeHtml(accountLabel)}`
  ].join('\n');
}

export function duplicateCard({ message, fields, duplicate, summary, accountLabel, emailSummary = '' }) {
  const collision = duplicate.verdict === 'client_collision';
  return [
    `${collision ? ICONS.CLIENT_COLLISION : ICONS.DUPLICATE} <b>${collision ? 'CLIENT COLLISION' : 'Duplicate req'}</b>`,
    '',
    `<b>${escapeHtml(fields.title || message.subject || 'Untitled')}</b>`,
    ...detailLines(fields),
    '',
    `Match: ${escapeHtml(summary)}`,
    `Basis: ${escapeHtml(duplicate.kind)} · ${(duplicate.score * 100).toFixed(0)}%`,
    `From: ${escapeHtml(fields.recruiterName || message.from)}`,
    `Inbox: ${escapeHtml(accountLabel)}`,
    '',
    '<b>Email summary</b>',
    escapeHtml(emailSummary || (message.snippet || message.body || '').slice(0, 300)),
    ...(collision
      ? ['', '<b>Two agencies, same end client.</b> Submitting through both can get you killed by the client — pick one.']
      : [])
  ].join('\n');
}

export function digestCard({ stats, pending, interviews, windowLabel = 'the last 24h' }) {
  const byCategory = Object.entries(stats.byCategory || {})
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `  ${icon(category)} ${escapeHtml(category)}: <b>${count}</b>`);

  const lines = [
    `📊 <b>Inbox digest</b> · ${escapeHtml(windowLabel)}`,
    '',
    `Processed: <b>${stats.processed}</b>`,
    `Archived: <b>${stats.archived}</b> · Replied: <b>${stats.sent}</b> · Waiting on you: <b>${stats.pending}</b>`,
    ''
  ];

  if (byCategory.length) lines.push('<b>Breakdown</b>', ...byCategory, '');

  if (interviews?.length) {
    lines.push(`${ICONS.INTERVIEW} <b>Interview requests (${interviews.length})</b>`);
    for (const row of interviews.slice(0, 8)) {
      lines.push(`  • ${escapeHtml(row.fields?.title || row.subject || 'Untitled')} — ${escapeHtml(row.fields?.agency || row.from || '')}`);
    }
    lines.push('');
  }

  if (pending > 0) lines.push(`${pending} draft${pending === 1 ? '' : 's'} waiting — /pending to review.`);
  else lines.push('Nothing waiting on you.');

  return lines.join('\n');
}

export function labelFor(category) {
  return (
    {
      INTERVIEW: 'Interview request',
      NEW_REQ: 'New requirement',
      RTR_REQUEST: 'Right to represent',
      RATE_CONFIRM: 'Rate request',
      DUPLICATE: 'Already submitted',
      DECLINE_ONSITE: 'Decline — not remote',
      DECLINE_RATE: 'Decline — below rate',
      REJECTION: 'Rejection',
      ACK: 'Application received',
      JOB_ALERT: 'Job alert',
      NEWSLETTER: 'Newsletter',
      RECRUITER_OTHER: 'Recruiter follow-up',
      OTHER: 'Other'
    }[category] || category
  );
}

/** Inline keyboard for an approval card. */
export function openEmailKeyboard(emailUrl = '') {
  return emailUrl ? [[{ text: '📧 Open email', url: emailUrl }]] : null;
}

export function approvalKeyboard(outboundId, { hasDraft = true, emailUrl = '' } = {}) {
  const rows = [];
  if (hasDraft) {
    rows.push([
      { text: '✅ Send', callback_data: `snd:${outboundId}` },
      { text: '✏️ Edit', callback_data: `edt:${outboundId}` },
      { text: '⏭ Skip', callback_data: `skp:${outboundId}` }
    ]);
  } else {
    rows.push([{ text: '⏭ Dismiss', callback_data: `skp:${outboundId}` }]);
  }
  if (emailUrl) rows.push([{ text: '📧 Open email', url: emailUrl }]);
  rows.push([{ text: '🚫 Block sender', callback_data: `blk:${outboundId}` }]);
  return rows;
}
