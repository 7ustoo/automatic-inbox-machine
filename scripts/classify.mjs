/**
 * Classification pipeline: rules first, model second, never model-only.
 *
 * The model is a tiebreaker, not the engine. Rules settle the flood for free,
 * and the model is only asked about messages where the rules are genuinely
 * unsure — which keeps cost near zero and, more importantly, keeps behaviour
 * predictable. If the API is down, misconfigured, or out of budget, the agent
 * degrades to rules and keeps running.
 */
import { env } from './env.mjs';
import { log, logError } from './log.mjs';
import { classifyByRules, CATEGORIES } from './rules.mjs';
import { extractFields } from './extract.mjs';
import { htmlToText, normalizeText, stripQuoted } from './normalize.mjs';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Rules below this confidence get escalated to the model when it is enabled. */
const ESCALATE_BELOW = 0.78;

/** Categories where a wrong call is expensive, so escalate even when confident. */
const ALWAYS_VERIFY = new Set(['INTERVIEW', 'RTR_REQUEST', 'RATE_CONFIRM']);

const hourlyCalls = [];

function withinHourlyBudget(maxPerHour) {
  const cutoff = Date.now() - 3600 * 1000;
  while (hourlyCalls.length && hourlyCalls[0] < cutoff) hourlyCalls.shift();
  return hourlyCalls.length < Math.max(0, Number(maxPerHour) || 0);
}

function recordCall() {
  hourlyCalls.push(Date.now());
}

/** Test seam: reset the in-process rate limiter. */
export function resetAiBudget() {
  hourlyCalls.length = 0;
}

const CLASSIFY_TOOL = {
  name: 'classify_recruiter_email',
  description: 'Record the classification of one recruiter or job-application email.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: CATEGORIES.filter((category) => category !== 'DUPLICATE'),
        description: [
          'INTERVIEW: sender proposes, requests, or confirms a call, screen, or interview, or asks for availability.',
          'RTR_REQUEST: sender asks for a right-to-represent, permission, or written confirmation to submit the candidate.',
          'RATE_CONFIRM: sender asks the candidate to state or confirm a rate or salary expectation.',
          'NEW_REQ: sender pitches a specific new role or job requirement.',
          'REJECTION: candidate was not selected, or the role is filled, closed, or on hold.',
          'ACK: automated confirmation that an application was received. No decision conveyed.',
          'JOB_ALERT: an automated digest of multiple job postings from a job board.',
          'NEWSLETTER: marketing, events, or general mailing-list content.',
          'RECRUITER_OTHER: a real human recruiter, but a follow-up or admin message rather than any of the above.',
          'OTHER: unrelated to the job search.'
        ].join(' ')
      },
      confidence: { type: 'number', description: 'Your confidence from 0 to 1.' },
      isInterviewRequest: { type: 'boolean', description: 'True only if the sender is actually trying to get time on the calendar.' },
      reason: { type: 'string', description: 'One short sentence, under 20 words, citing the deciding phrase.' },
      title: { type: 'string', description: 'Job title if a specific role is discussed, else empty string.' },
      client: { type: 'string', description: 'End client or hiring company if named, else empty string.' },
      workMode: { type: 'string', enum: ['remote', 'hybrid', 'onsite', 'unknown'] }
    },
    required: ['category', 'confidence', 'isInterviewRequest', 'reason']
  }
};

const SYSTEM_PROMPT = [
  'You classify one email from a job seeker\'s inbox. The inbox is flooded with staffing-agency mail.',
  'Be decisive and literal: classify what the sender is actually asking for, not the general topic.',
  'Critical distinctions:',
  '- A message thanking the candidate for interviewing and then declining them is REJECTION, not INTERVIEW.',
  '- "We will keep your resume on file" is REJECTION.',
  '- An automated "we received your application" with no decision is ACK, even if it restates the job description.',
  '- A digest listing many jobs from a job board is JOB_ALERT, never NEW_REQ.',
  '- Only use INTERVIEW when the sender wants time on a calendar or is confirming a booked slot.',
  'Never invent a client name or job title that is not present in the text.'
].join('\n');

function buildUserContent({ subject, from, fromName, body, maxBodyChars, ruleVerdict }) {
  const trimmedBody = body.length > maxBodyChars ? `${body.slice(0, maxBodyChars)}\n[...truncated]` : body;
  return [
    `From: ${fromName ? `${fromName} <${from}>` : from}`,
    `Subject: ${subject}`,
    '',
    'Body:',
    trimmedBody,
    '',
    `A deterministic rules pass guessed ${ruleVerdict.category} (confidence ${ruleVerdict.confidence}). Treat that as a hint only; disagree freely if the text says otherwise.`
  ].join('\n');
}

/**
 * One Claude call. Returns null on any failure — callers keep the rules verdict.
 * Never throws.
 */
async function classifyWithModel({ subject, from, fromName, body, model, maxBodyChars, ruleVerdict, timeoutMs = 20000 }) {
  const apiKey = env('ANTHROPIC_API_KEY').trim();
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: 'tool', name: CLASSIFY_TOOL.name },
        messages: [{ role: 'user', content: buildUserContent({ subject, from, fromName, body, maxBodyChars, ruleVerdict }) }]
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log(`classifier: API ${response.status} — falling back to rules. ${detail.slice(0, 200)}`, { name: 'classify' });
      return null;
    }

    const payload = await response.json();
    const toolUse = (payload.content || []).find((block) => block.type === 'tool_use');
    if (!toolUse?.input?.category) return null;

    const input = toolUse.input;
    return {
      category: input.category,
      confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0.5)),
      isInterviewRequest: Boolean(input.isInterviewRequest),
      reason: String(input.reason || '').slice(0, 160),
      title: String(input.title || '').slice(0, 160),
      client: String(input.client || '').slice(0, 120),
      workMode: ['remote', 'hybrid', 'onsite', 'unknown'].includes(input.workMode) ? input.workMode : 'unknown',
      usage: payload.usage || null
    };
  } catch (error) {
    if (error?.name === 'AbortError') log('classifier: model call timed out — using rules', { name: 'classify' });
    else logError('classifier model call', error, { name: 'classify' });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizes a raw fetched message into the shape the classifier and the rest of
 * the pipeline expect. Body prefers text/plain, converts HTML when that is all
 * there is, and always strips quoted replies so a deep thread does not re-fire
 * rules from earlier messages.
 */
export function prepareMessage(raw) {
  const plain = raw.textBody || '';
  const derived = plain.trim() ? plain : htmlToText(raw.htmlBody || '');
  const body = stripQuoted(derived);
  return {
    ...raw,
    body,
    bodyFull: derived,
    normalizedBody: normalizeText(body)
  };
}

/**
 * The public entry point.
 *
 * Returns { category, confidence, decidedBy, reason, fields, ruleVerdict,
 * modelVerdict } where decidedBy is 'rules' | 'model' | 'rules+model'.
 */
export async function classify(message, config) {
  const subject = String(message.subject || '');
  const body = String(message.body || '');
  const from = String(message.from || '');
  const fromName = String(message.fromName || '');

  const ruleVerdict = classifyByRules({
    subject,
    body,
    from,
    extraPhrases: {
      REJECTION: config?.classify?.extraRejectionPhrases || [],
      INTERVIEW: config?.classify?.extraInterviewPhrases || []
    }
  });

  const fields = extractFields({ subject, body, from, fromName });

  const ai = config?.classify?.ai || {};
  const shouldEscalate =
    ai.enabled &&
    Boolean(env('ANTHROPIC_API_KEY').trim()) &&
    (ruleVerdict.confidence < ESCALATE_BELOW || ALWAYS_VERIFY.has(ruleVerdict.category));

  if (!shouldEscalate) {
    return { ...ruleVerdict, fields, ruleVerdict, modelVerdict: null, decidedBy: 'rules' };
  }

  if (!withinHourlyBudget(ai.maxPerHour ?? 240)) {
    log('classifier: hourly model budget exhausted — rules only for now', { name: 'classify' });
    return { ...ruleVerdict, fields, ruleVerdict, modelVerdict: null, decidedBy: 'rules' };
  }

  recordCall();
  const modelVerdict = await classifyWithModel({
    subject,
    from,
    fromName,
    body,
    model: ai.model || 'claude-haiku-4-5-20251001',
    maxBodyChars: Number(ai.maxBodyChars) || 6000,
    ruleVerdict
  });

  if (!modelVerdict) {
    return { ...ruleVerdict, fields, ruleVerdict, modelVerdict: null, decidedBy: 'rules' };
  }

  // Agreement is the common case and compounds confidence. Disagreement takes
  // the model's call but caps confidence, so a contested message still has to
  // clear the auto-send gate on its own merits rather than sailing through.
  const agree = modelVerdict.category === ruleVerdict.category;
  const category = modelVerdict.category;
  const confidence = agree
    ? Math.min(0.99, Math.max(ruleVerdict.confidence, modelVerdict.confidence) + 0.08)
    : Math.min(0.8, modelVerdict.confidence);

  // The model fills gaps in extraction but never overwrites a labelled hit.
  const merged = { ...fields };
  if (!merged.title && modelVerdict.title) merged.title = modelVerdict.title;
  if (!merged.client && modelVerdict.client) merged.client = modelVerdict.client;
  if (merged.workMode === 'unknown' && modelVerdict.workMode !== 'unknown') merged.workMode = modelVerdict.workMode;

  return {
    category,
    confidence: Number(confidence.toFixed(3)),
    decidedBy: agree ? 'rules+model' : 'model',
    reason: agree ? `${ruleVerdict.reason}; model agreed` : `model overrode rules (${ruleVerdict.category}): ${modelVerdict.reason}`,
    scores: ruleVerdict.scores,
    matched: ruleVerdict.matched,
    fields: merged,
    ruleVerdict,
    modelVerdict
  };
}

export { ESCALATE_BELOW, ALWAYS_VERIFY };
