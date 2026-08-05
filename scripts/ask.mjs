/**
 * Conversational queries over the ledger — the "how many reqs did I get this
 * week?" half of the product.
 *
 * The model never touches the mailbox and never runs code. It is handed a
 * compact, pre-aggregated snapshot of the ledger and asked to answer from it.
 * That keeps the answer grounded in real rows, keeps the token cost fixed
 * regardless of inbox size, and means a wrong answer can only ever be a
 * misreading of data the user can go check themselves.
 *
 * With no API key, a deterministic intent matcher handles the common questions
 * so the conversational surface still works on a rules-only install.
 */
import { env } from './env.mjs';
import { log } from './log.mjs';
import { readAll, rowsSince, stats } from './ledger.mjs';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';

/** Rows are trimmed to these fields before the model sees them. */
function slimMessage(row) {
  return {
    at: String(row.ts || row.receivedAt || '').slice(0, 16),
    category: row.category,
    title: row.fields?.title || row.subject || '',
    client: row.fields?.client || '',
    agency: row.fields?.agency || '',
    from: row.from,
    action: row.action,
    mode: row.fields?.workMode || '',
    rate: row.fields?.rate ? `${row.fields.rate.kind}:${row.fields.rate.min}-${row.fields.rate.max}` : '',
    dup: row.duplicateVerdict !== 'new' ? row.duplicateVerdict : ''
  };
}

/**
 * Builds the snapshot. Aggregates cover the long window; raw rows cover the
 * recent window, because specific questions ("who emailed me about Deloitte")
 * need detail and trend questions only need counts.
 */
export function buildContext({ detailHours = 72, aggregateHours = 24 * 30 } = {}) {
  const recent = rowsSince('messages', detailHours);
  const long = rowsSince('messages', aggregateHours);
  const submissions = readAll('submissions');
  const outbound = readAll('outbound');

  const perDay = {};
  for (const row of long) {
    const day = String(row.ts || '').slice(0, 10);
    if (!day) continue;
    perDay[day] ||= { total: 0, byCategory: {} };
    perDay[day].total += 1;
    perDay[day].byCategory[row.category] = (perDay[day].byCategory[row.category] || 0) + 1;
  }

  const agencyCounts = {};
  for (const row of long) {
    const agency = row.fields?.agency;
    if (agency) agencyCounts[agency] = (agencyCounts[agency] || 0) + 1;
  }

  return {
    now: new Date().toISOString(),
    last24h: stats(24),
    last7dTotal: rowsSince('messages', 24 * 7).length,
    last30dTotal: long.length,
    perDay,
    topAgencies: Object.entries(agencyCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([agency, count]) => ({ agency, count })),
    submissions: submissions.slice(-60).map((row) => ({
      at: String(row.submittedAt || '').slice(0, 10),
      title: row.titleRaw,
      client: row.clientRaw,
      agency: row.agencyRaw,
      account: row.accountId
    })),
    interviewsRecent: long
      .filter((row) => row.category === 'INTERVIEW')
      .slice(-25)
      .map(slimMessage),
    duplicatesRecent: long
      .filter((row) => row.duplicateVerdict && row.duplicateVerdict !== 'new')
      .slice(-25)
      .map((row) => ({ ...slimMessage(row), summary: row.duplicateSummary || '' })),
    pendingApprovals: outbound
      .filter((row) => row.status === 'pending')
      .slice(-25)
      .map((row) => ({ template: row.template, title: row.fields?.title || row.originalSubject, to: row.to, at: String(row.ts).slice(0, 16) })),
    repliesSent: outbound
      .filter((row) => row.status === 'sent')
      .slice(-40)
      .map((row) => ({ at: String(row.sentAt || row.ts).slice(0, 16), template: row.template, to: row.to, title: row.fields?.title || '' })),
    recentMessages: recent.slice(-120).map(slimMessage)
  };
}

const SYSTEM_PROMPT = [
  "You answer questions about a job seeker's recruiter inbox, using only the JSON snapshot provided.",
  'Rules:',
  '- Answer from the data. If the snapshot does not contain the answer, say so plainly and name what is missing.',
  '- Never invent counts, companies, dates, or names.',
  '- Be brief. Two or three sentences, or a short list. This is read on a phone.',
  '- Lead with the number when the question is a count.',
  '- Category meanings: NEW_REQ is a role pitched to them, RTR_REQUEST is a right-to-represent ask, RATE_CONFIRM is a rate ask, INTERVIEW is a scheduling request, ACK is an application receipt, REJECTION is a decline, JOB_ALERT is a board digest.',
  '- "Applications" the user sent are not in this data; this inbox tracks what came IN plus replies the agent sent. Say so if asked about outbound applications.',
  '- Plain text only. No markdown headers, no bold, no tables.'
].join('\n');

/* -------------------------------------------------------------------------- */
/* Deterministic fallback                                                     */
/* -------------------------------------------------------------------------- */

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Handles the common questions without a model. Returns null if unmatched. */
export function answerLocally(question, context = buildContext()) {
  const text = String(question || '').toLowerCase();
  const windowHours = /\bweek\b/.test(text) ? 24 * 7 : /\bmonth\b/.test(text) ? 24 * 30 : 24;
  const windowLabel = windowHours === 24 ? 'the last 24h' : windowHours === 168 ? 'the last 7 days' : 'the last 30 days';
  const rows = rowsSince('messages', windowHours);

  const countOf = (category) => rows.filter((row) => row.category === category).length;

  if (/\b(?:interview|screening|screen)\b/.test(text)) {
    const count = countOf('INTERVIEW');
    const list = context.interviewsRecent.slice(-5).map((row) => `• ${row.title || '(no title)'} — ${row.agency || row.from}`);
    return [`${pluralize(count, 'interview request')} in ${windowLabel}.`, ...list].join('\n');
  }
  if (/\b(?:req|requirement|role|opening|position|opportunit)/.test(text)) {
    return `${pluralize(countOf('NEW_REQ'), 'new requirement')} in ${windowLabel}.`;
  }
  if (/\b(?:rejection|rejected|turned down|no)\b/.test(text)) {
    return `${pluralize(countOf('REJECTION'), 'rejection')} in ${windowLabel}.`;
  }
  if (/\b(?:duplicate|dupe|already submitted|same role)\b/.test(text)) {
    const dupes = context.duplicatesRecent.slice(-5).map((row) => `• ${row.title} — ${row.summary}`);
    return [`${pluralize(context.duplicatesRecent.length, 'duplicate')} flagged recently.`, ...dupes].join('\n');
  }
  if (/\b(?:pending|waiting|approve|approval|draft)\b/.test(text)) {
    return `${pluralize(context.pendingApprovals.length, 'draft')} waiting on you. Use /pending to review.`;
  }
  if (/\b(?:submitted|submission)\b/.test(text)) {
    const recent = context.submissions.slice(-5).map((row) => `• ${row.title} at ${row.client || 'unnamed client'} via ${row.agency} (${row.at})`);
    return [`${pluralize(context.submissions.length, 'submission')} on record.`, ...recent].join('\n');
  }
  if (/\b(?:total|how many|volume|processed|count)\b/.test(text)) {
    const byCategory = Object.entries(
      rows.reduce((accumulator, row) => {
        accumulator[row.category] = (accumulator[row.category] || 0) + 1;
        return accumulator;
      }, {})
    )
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `• ${category}: ${count}`);
    return [`${pluralize(rows.length, 'message')} processed in ${windowLabel}.`, ...byCategory].join('\n');
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Model-backed answer                                                        */
/* -------------------------------------------------------------------------- */

export async function ask(question, { model = DEFAULT_MODEL, timeoutMs = 30000 } = {}) {
  const context = buildContext();
  const apiKey = env('ANTHROPIC_API_KEY').trim();

  if (!apiKey) {
    const local = answerLocally(question, context);
    return {
      ok: true,
      answer: local || 'I can answer that once ANTHROPIC_API_KEY is set in .env. Without it I can still do counts — try "how many interviews this week" or /stats.',
      via: 'local'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Snapshot of my inbox ledger:\n\n${JSON.stringify(context)}\n\nQuestion: ${question}`
          }
        ]
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log(`ask: API ${response.status} — falling back to local. ${detail.slice(0, 160)}`, { name: 'ask' });
      const local = answerLocally(question, context);
      return { ok: Boolean(local), answer: local || `The model call failed (HTTP ${response.status}) and I could not answer that one locally.`, via: 'local' };
    }

    const payload = await response.json();
    const answer = (payload.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!answer) {
      const local = answerLocally(question, context);
      return { ok: Boolean(local), answer: local || 'No answer came back. Try /stats.', via: 'local' };
    }
    return { ok: true, answer, via: 'model', usage: payload.usage || null };
  } catch (error) {
    const local = answerLocally(question, context);
    const detail = error?.name === 'AbortError' ? 'timed out' : String(error?.message || error);
    return { ok: Boolean(local), answer: local || `Could not answer that (${detail}).`, via: 'local' };
  } finally {
    clearTimeout(timer);
  }
}
