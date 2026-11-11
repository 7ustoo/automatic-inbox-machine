/** Bounded, read-only job-posting lookup for interview mail only. */
import { append, readAll } from './ledger.mjs';
import { env } from './env.mjs';
import { log, logError } from './log.mjs';
import { sourceMessageUrl } from './message-link.mjs';
import { localDay } from './local-day.mjs';
import { editMessage } from './telegram-api.mjs';
import * as cards from './notify/format.mjs';
import { interviewBrief } from './interview-brief.mjs';

const MODES = new Set(['remote', 'hybrid', 'onsite', 'unknown']);
const RECEIPT_SUBJECT = /(?:application (?:has been |was )?received|received your application|thanks for applying|thank you for your application|application confirm|employment submission|security code)/i;
const INTERVIEW_SIGNAL = /interview|screen|schedule|availability|available to (?:speak|talk)|\bcall\b|one[- ]way|pre[- ]screen/i;
const GENERIC_SENDERS = /^(?:workday|greenhouse|lever|smartrecruiters|icims|notifications?|recruiting team|talent acquisition)$/i;

function compact(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function keyPart(value) { return compact(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function roleFromSummary(summary) {
  const text = compact(summary);
  const patterns = [
    /\bfor the (.{4,100}?) (?:position|role|opportunity)\b/i,
    /\bdiscuss the (.{4,100}?) (?:position|role|opportunity)\b/i,
    /\babout the (.{4,100}?) (?:position|role|opportunity)\b/i,
    /\bfor (?:a |an )?(.{4,100}?) (?:position|role|opportunity)\b/i,
    /\bfor (?:a |the )?(.{4,100}?)\s+within \d+ hours\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && !/^(?:job application|screening|interview|candidate)/i.test(match[1])) {
      return compact(match[1]).replace(/^.*\b(?:about|regarding|for) (?:the |a |an )?/i, '').trim();
    }
  }
  return '';
}

function roleFromSubject(subject) {
  const text = compact(subject).replace(/^(?:re|fw|fwd):\s*/i, '');
  const patterns = [
    /\binterview request\s*[-–]\s*(.{5,100}?)\s+application\b/i,
    /\b(?:interview request!?|phone screen|pre-screening questionnaire)\s*[:–-]\s*(.{5,120})$/i,
    /\binterview availability\s*\|\|\s*[^-]+-\s*(.{5,100}?)(?:\s+at\s+.+)?$/i,
    /\bfor the (.{5,100}?) opportunity\b/i,
    /\|\s*(\[TFT\].{5,100})$/i,
    /\b(?:Interview Request|Video Screen)\s*[-–]\s*[^-]+[-–]\s*(.{5,120})$/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return compact(match[1].replace(/\s*\([^)]*\)$/, ''))
      .replace(/^(?:SitusAMC|Novaspect|Agoda|WOW!?)\s*[:–-]\s*/i, '').trim();
  }
  return '';
}

function genericTitle(value) {
  return /\b(?:interview|screening|assessment|availability|next steps|reminder|invited|congratulations|application|video introduction)\b/i.test(value) &&
    !/\b(?:engineer|administrator|scientist|developer|analyst|architect|manager|consultant|specialist|director)\b/i.test(value);
}

function orgKey(value) {
  const key = keyPart(value).replace(/\b(?:inc|llc|ltd|company|co|corp|corporation|services|usa|us|na|gcch|health system)\b/g, '').trim();
  if (/^serco/.test(key)) return 'serco';
  if (/^agoda/.test(key)) return 'agoda';
  if (/^(?:wow|wowinc)/.test(key)) return 'wow';
  if (/^(?:its|intelligent technical solutions)/.test(key)) return 'intelligent technical solutions';
  if (/^(?:midland|midlandsb)/.test(key)) return 'midland states bank';
  if (/^cleveland clinic/.test(key)) return 'cleveland clinic';
  return key;
}

export function interviewIdentity(row) {
  let title = compact(row.interviewRoleTitle || '');
  if (!title) title = roleFromSubject(row.subject) || roleFromSummary(row.summary);
  if (!title) {
    title = compact(row.fields?.title);
    if (genericTitle(title) || /\b(?:interview|screen(?:ing)?|assessment|availability|reminder|next steps|invited|congratulations)\b/i.test(title)) title = '';
  }
  title = title.replace(/^(?:Interview Request!?|Phone Screen|Pre-Screening Questionnaire)\s*[-:–]\s*/i, '').trim();
  let company = compact(row.fields?.client);
  if (!company) {
    const domain = compact(row.from).split('@')[1]?.toLowerCase() || '';
    if (domain && !/(?:greenhouse|workday|icims|smartrecruiters|lever|amazonaws|sendgrid|mailgun|gmail|outlook)/i.test(domain)) {
      company = domain.split('.')[0] || '';
    }
  }
  if (!company) {
    const name = compact(row.fromName).replace(/\s+(?:careers|recruiting|talent acquisition|jobs|team)$/i, '');
    if (name && !GENERIC_SENDERS.test(name) && !/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(name)) company = name;
  }
  const roleKey = keyPart(title).replace(/\b(?:virtual|remote|us|usa|tft|ite)\b/g, '').trim();
  return { title, company, key: `${orgKey(company) || 'unknown'}|${roleKey || 'role unknown'}` };
}

export function isResearchCandidate(row) {
  const missedInvitation = row.category === 'ACK' && /^\s*(?:re:\s*)?interview request\b/i.test(row.subject || '') &&
    /\b(?:schedule|interview|availability)\b/i.test(row.summary || '');
  if (row.category !== 'INTERVIEW' && !missedInvitation) return false;
  if (RECEIPT_SUBJECT.test(row.subject || '')) return false;
  return INTERVIEW_SIGNAL.test(`${row.subject || ''} ${row.summary || ''}`);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.*|gh_src|trk|source|ref)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function parseResearchResponse(payload) {
  const output = (payload.output || []).find((item) => item.type === 'message');
  const block = output?.content?.find((item) => item.type === 'output_text');
  const raw = String(block?.text || payload.output_text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let answer;
  try { answer = JSON.parse(raw); } catch { return { status: 'unknown', workMode: 'unknown', note: 'Search returned no usable result.', postingUrl: '' }; }
  const sources = new Set((payload.output || []).filter((item) => item.type === 'web_search_call')
    .flatMap((item) => item.action?.sources || []).map((item) => safeUrl(item.url)).filter(Boolean));
  for (const item of payload.output || []) {
    for (const part of item.content || []) {
      for (const annotation of part.annotations || []) {
        if (annotation.type === 'url_citation') sources.add(safeUrl(annotation.url));
      }
    }
  }
  const url = safeUrl(answer.postingUrl);
  const linked = url && sources.has(url);
  const exact = answer.exactRoleMatch === true;
  const mode = MODES.has(answer.workMode) ? answer.workMode : 'unknown';
  return {
    status: linked && exact && mode !== 'unknown' ? 'verified' : 'unknown',
    workMode: linked && exact ? mode : 'unknown',
    postingUrl: linked ? url : '',
    location: compact(answer.location).slice(0, 120),
    note: compact(answer.evidence).slice(0, 300) || 'No exact, sourced posting found.',
    sourceType: answer.sourceType === 'employer' ? 'employer' : 'other',
    exactRoleMatch: exact && Boolean(linked)
  };
}

export async function lookupInterviewPosting(row, { apiKey = env('OPENAI_API_KEY').trim(), model = 'gpt-4o-mini', fetchImpl = fetch, timeoutMs = 35_000 } = {}) {
  const identity = interviewIdentity(row);
  if (!identity.title || !identity.company) return { status: 'unknown', workMode: 'unknown', note: 'Job title or employer missing from the email.', postingUrl: '' };
  if (!apiKey) return { status: 'unavailable', workMode: 'unknown', note: 'OpenAI API key is not configured.', postingUrl: '' };
  const prompt = [
    'Search the public web for the exact employer job posting. Decide the JOB work arrangement, not the interview format.',
    'Use only a posting that matches both employer and role. Prefer the employer careers page. Never infer remote from a video interview or cloud/IT job title.',
    'Return one JSON object only: {"exactRoleMatch":boolean,"workMode":"remote|hybrid|onsite|unknown","postingUrl":"https://... or empty","location":"...","sourceType":"employer|other","evidence":"brief factual basis"}.',
    'If the role is not an exact match or work mode is absent, return unknown. Include an actual source URL you searched.',
    `Employer from email: ${identity.company.slice(0, 100)}`,
    `Role from email: ${identity.title.slice(0, 160)}`,
    `Email subject for disambiguation: ${compact(row.subject).slice(0, 180)}`,
    `Email location hint (unverified): ${compact(row.fields?.location).slice(0, 100)}`,
    `Possible job links from email: ${(row.jobLinks || []).slice(0, 2).join(' ')}`
  ].join('\n');
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      store: false,
      input: prompt,
      tools: [{ type: 'web_search', search_context_size: 'low' }],
      tool_choice: 'required',
      include: ['web_search_call.action.sources'],
      max_output_tokens: 400
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`posting lookup HTTP ${response.status}: ${String(payload?.error?.message || 'request failed').slice(0, 160)}`);
  return { ...parseResearchResponse(payload), usage: payload.usage || null };
}

function researchFor(rows = readAll('interviewResearch')) {
  const byKey = new Map();
  for (const row of rows) if (row.key) byKey.set(row.key, row);
  return byKey;
}

/** Distinct interview tracks plus provenance, for the dashboard. */
export function interviewTracker({ messages = readAll('messages'), research = readAll('interviewResearch'), accounts = [], now = Date.now(), timezone = 'America/Chicago' } = {}) {
  const byKey = researchFor(research);
  const searchDate = new Date(now).toISOString().slice(0, 10);
  const searchedToday = research.filter((row) => row.searchDate === searchDate);
  const groups = new Map();
  for (const row of messages) {
    const at = Date.parse(row.receivedAt || row.ts || '');
    if (!Number.isFinite(at) || at < now - 7 * 86_400_000 || !isResearchCandidate(row)) continue;
    const identity = interviewIdentity(row);
    const prior = groups.get(identity.key);
    if (!prior) groups.set(identity.key, { row, at, firstAt: at, identity });
    else if (at > prior.at) groups.set(identity.key, { row, at, firstAt: Math.min(prior.firstAt, at), identity });
    else prior.firstAt = Math.min(prior.firstAt, at);
  }
  const counts = { remote: 0, hybrid: 0, onsite: 0, unknown: 0 };
  const todayCounts = { remote: 0, hybrid: 0, onsite: 0, unknown: 0 };
  const today = localDay(now, timezone).date;
  const titledOrgs = new Set([...groups.values()].filter(({ identity }) => identity.title).map(({ identity }) => orgKey(identity.company)));
  const rows = [...groups.values()]
    .filter(({ identity }) => identity.title || !titledOrgs.has(orgKey(identity.company)))
    .sort((a, b) => b.at - a.at).map(({ row, at, firstAt, identity }) => {
    const result = byKey.get(identity.key);
    const mode = ['verified', 'reviewed'].includes(result?.status) ? result.workMode : 'unknown';
    counts[mode] += 1;
    if (localDay(firstAt, timezone).date === today) todayCounts[mode] += 1;
    return {
      at,
      firstAt,
      title: result?.title || identity.title || 'Role not named',
      company: result?.company || identity.company,
      brief: row.interviewBrief || interviewBrief({ subject: row.subject, summary: row.summary }),
      summary: row.summary || '',
      account: row.accountLabel || row.accountId || '',
      emailUrl: sourceMessageUrl(row, accounts),
      workMode: mode,
      status: result?.status || 'pending',
      postingUrl: result?.postingUrl || '',
      sourceType: result?.sourceType || '',
      location: result?.location || '',
      note: result?.note || '',
      researchedAt: result?.ts || ''
    };
  });
  return { counts, total: rows.length, rows,
    today: { total: Object.values(todayCounts).reduce((sum, count) => sum + count, 0), counts: todayCounts },
    usageToday: {
      lookups: searchedToday.length,
      inputTokens: searchedToday.reduce((sum, row) => sum + (Number(row.usage?.input_tokens) || 0), 0),
      outputTokens: searchedToday.reduce((sum, row) => sum + (Number(row.usage?.output_tokens) || 0), 0)
    }
  };
}

let running = false;
let lastCheckAt = 0;
export async function updateTelegramInterviewAlert(config, identity, result, {
  messages = readAll('messages'), editor = editMessage
} = {}) {
  const chatId = config.notify?.telegram?.chatId;
  if (!config.notify?.telegram?.enabled || !chatId) return;
  const message = messages.findLast((item) => item.category === 'INTERVIEW' &&
    item.telegramMessageId && interviewIdentity(item).key === identity.key);
  if (!message) return;
  const emailUrl = sourceMessageUrl(message, config.accounts || []);
  const html = cards.interviewAlert({ message, fields: message.fields || {},
    accountLabel: message.accountLabel || message.accountId || '', emailSummary: message.summary || '',
    brief: message.interviewBrief, roleTitle: identity.title, company: identity.company, research: result });
  const keyboard = cards.interviewKeyboard(emailUrl, result.status === 'verified' ? result.postingUrl : '');
  const edited = await editor(chatId, message.telegramMessageId, html, { keyboard });
  if (!edited.ok) log(`interview research: Telegram alert update failed: ${edited.error}`, { name: 'research' });
}
/** Starts at most one background lookup. Mail polling and alerts are never awaited on it. */
export function scheduleInterviewResearch(config) {
  const settings = config.interviewResearch || {};
  if (!settings.enabled || running) return;
  if (Date.now() - lastCheckAt < 30_000) return;
  lastCheckAt = Date.now();
  const apiKey = env('OPENAI_API_KEY').trim();
  if (!apiKey) return;
  const now = Date.now();
  const startAt = Date.parse(settings.startAt || '') || now;
  const today = new Date().toISOString().slice(0, 10);
  const done = readAll('interviewResearch');
  const maxPerDay = Math.max(0, Math.min(30, Number(settings.maxPerDay) || 8));
  if (done.filter((row) => row.searchDate === today).length >= maxPerDay) return;
  const known = researchFor(done);
  const row = readAll('messages').find((item) => {
    const at = Date.parse(item.receivedAt || item.ts || '');
    const previous = known.get(interviewIdentity(item).key);
    const retryable = previous?.status === 'error' && now - Date.parse(previous.ts || '') > 6 * 3_600_000;
    const stale = previous && now - Date.parse(previous.ts || '') > 30 * 86_400_000;
    return Number.isFinite(at) && at >= startAt && at <= now && isResearchCandidate(item) &&
      (!previous || retryable || stale);
  });
  if (!row) return;
  const identity = interviewIdentity(row);
  running = true;
  void lookupInterviewPosting(row, { apiKey, model: settings.model || 'gpt-4o-mini' })
    .then(async (result) => {
      append('interviewResearch', { key: identity.key, title: identity.title, company: identity.company,
        messageKey: row.messageKey, searchDate: result.usage ? today : '', ...result });
      log(`interview research: ${identity.company} / ${identity.title} -> ${result.workMode} (${result.status})`, { name: 'research' });
      await updateTelegramInterviewAlert(config, identity, result)
        .catch((error) => logError('interview research Telegram update', error, { name: 'research' }));
    })
    .catch((error) => {
      append('interviewResearch', { key: identity.key, title: identity.title, company: identity.company,
        messageKey: row.messageKey, searchDate: today, status: 'error', workMode: 'unknown', note: 'Posting lookup failed.', postingUrl: '' });
      logError('interview research', error, { name: 'research' });
    })
    .finally(() => { running = false; });
}
