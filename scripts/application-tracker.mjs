/** Read-only estimates from application confirmation mail. Never touches mail. */
import { readAll } from './ledger.mjs';
import { sourceMessageUrl } from './message-link.mjs';
import { localDay } from './local-day.mjs';

const CODE = /(?:security|verification|one[- ]time|access|confirmation) code|\bOTP\b|verify your (?:email|address|account)/i;
const RECEIPT = /application (?:has been |was )?received|(?:we|we(?:'|’)ve|we have) received your application|thanks for applying|thank you for (?:your|submitting an?) application|application (?:acknowledg|confirm)|employment submission|application (?:was |has been )?submitted/i;
const WEAK = /thank you for your interest|thanks for your interest|your application to /i;
const NOT_RECEIPT = /application (?:update|decision|status)|update (?:on|to|from).*application|interview|assessment|not selected|unfortunately|withdrawn/i;

export function isApplicationReceipt(row) {
  const subject = String(row.subject || '');
  const summary = String(row.summary || '');
  if (CODE.test(subject) || NOT_RECEIPT.test(subject) || row.category === 'REJECTION') return false;
  if (row.category !== 'ACK') return false;
  if (RECEIPT.test(subject)) return true;
  return WEAK.test(subject) && /\b(?:application|applied|submission|received)\b/i.test(summary) && !NOT_RECEIPT.test(summary);
}

function dateOf(row) {
  const value = Date.parse(row.receivedAt || row.ts || '');
  return Number.isFinite(value) ? value : 0;
}

function companyOf(row) {
  if (row.fields?.client) return String(row.fields.client).trim();
  const fromName = String(row.fromName || '').replace(/\s+(?:careers|recruiting|talent acquisition|jobs|no[- ]reply)$/i, '').trim();
  if (fromName && !/^(?:workday|greenhouse|lever|smartrecruiters|icims|notification|recruiting team)$/i.test(fromName)) return fromName;
  const domain = String(row.from || '').split('@')[1]?.toLowerCase() || '';
  if (!domain || /(?:greenhouse|workday|icims|smartrecruiters|lever|amazonaws|sendgrid|mailgun)/i.test(domain)) return '';
  return domain.split('.')[0] || '';
}

function cleanTitle(row) {
  const title = String(row.fields?.title || '').trim();
  if (!title || /^(?:thank|application|we['’]?ve|your|thanks|update)\b/i.test(title)) return '';
  return title;
}

function keyFor(row) {
  if (row.rfcMessageId) return `message:${String(row.rfcMessageId).toLowerCase()}`;
  return `account:${row.accountId}:${row.messageKey || row.id}`;
}

/** Counts confirmations, not guaranteed successful submissions or bot actions. */
export function applicationTracker({ rows = readAll('messages'), accounts = [], now = Date.now(), limit = 120, timezone = 'America/Chicago' } = {}) {
  const seen = new Set();
  const receipts = [];
  for (const row of rows) {
    if (!isApplicationReceipt(row)) continue;
    const at = dateOf(row);
    if (!at || at > now + 60_000) continue;
    const key = keyFor(row);
    if (seen.has(key)) continue;
    seen.add(key);
    receipts.push({
      at,
      subject: row.subject || '',
      title: cleanTitle(row),
      company: companyOf(row),
      account: row.accountLabel || row.accountId || '',
      emailUrl: sourceMessageUrl(row, accounts),
      // Only explicit location extraction from the receipt; never claim a posting was verified.
      emailWorkMode: ['remote', 'hybrid', 'onsite'].includes(row.fields?.workMode) ? row.fields.workMode : 'unknown'
    });
  }
  receipts.sort((a, b) => b.at - a.at);
  const within = (hours) => receipts.filter((row) => row.at >= now - hours * 3_600_000);
  const last24 = within(24);
  const last7d = within(168);
  const today = localDay(now, timezone).date;
  const known = { remote: 0, hybrid: 0, onsite: 0, unknown: 0 };
  for (const row of last7d) known[row.emailWorkMode] += 1;
  return {
    today: receipts.filter((row) => localDay(row.at, timezone).date === today).length,
    last24h: last24.length,
    last7d: last7d.length,
    byEmailWorkMode7d: known,
    rows: receipts.slice(0, Math.max(1, Math.min(500, Number(limit) || 120)))
  };
}
