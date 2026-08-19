/**
 * Classification pipeline: rules first, model second, never model-only.
 *
 * The model is a tiebreaker, not the engine. Rules settle the flood for free,
 * and the model is only asked about messages where the rules are genuinely
 * unsure — which keeps cost near zero and, more importantly, keeps behaviour
 * predictable. If the API is down, misconfigured, or out of budget, the agent
 * degrades to rules and keeps running.
 */
import { log, logError } from './log.mjs';
import { classifyByRules, CATEGORIES, semanticCategoryOverride } from './rules.mjs';
import { extractFields } from './extract.mjs';
import { htmlToText, normalizeText, stripQuoted } from './normalize.mjs';
import { providerFor, providerHasKey, requestClassification } from './ai-providers.mjs';

/** Rules below this confidence get escalated to the model when it is enabled. */
const ESCALATE_BELOW = 0.78;

/** Categories where a wrong call is expensive, so escalate even when confident. */
const ALWAYS_VERIFY = new Set([
  'INTERVIEW', 'NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM',
  'REJECTION', 'ACK', 'JOB_ALERT', 'NEWSLETTER'
]);

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

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
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
      isDirectOpportunity: { type: 'boolean', description: 'True only for a specific role personally pitched to the candidate with a request to respond, submit, confirm, or schedule.' },
      isAutomatedJobMail: { type: 'boolean', description: 'True for job-board alerts, saved-search notifications, digests, recommendation mail, or other automated job listings without a personal recruiter ask.' },
      reason: { type: 'string', description: 'One short sentence, under 20 words, citing the deciding phrase.' },
      title: { type: 'string', description: 'Job title if a specific role is discussed, else empty string.' },
      client: { type: 'string', description: 'End client or hiring company if named, else empty string.' },
      workMode: { type: 'string', enum: ['remote', 'hybrid', 'onsite', 'unknown'] },
      requestedProfileFields: {
        type: 'array',
        items: { type: 'string', enum: ['fullName', 'phone', 'contactEmail', 'linkedin', 'location', 'workAuth', 'availability', 'employmentTypes', 'dateOfBirth', 'ssnLast4'] },
        description: 'Candidate details the sender explicitly asks to receive in this email. Empty when none are requested.'
      },
      rateConfirmationRequested: {
        type: 'boolean',
        description: 'True when the sender asks the candidate to accept, agree to, or confirm a stated pay rate.'
      }
  },
  required: ['category', 'confidence', 'isInterviewRequest', 'isDirectOpportunity', 'isAutomatedJobMail', 'reason', 'title', 'client', 'workMode', 'requestedProfileFields', 'rateConfirmationRequested']
};

const SYSTEM_PROMPT = [
  'You classify one email from a job seeker\'s inbox. The inbox is flooded with staffing-agency mail.',
  'Be decisive and literal: classify what the sender is actually asking for, not the general topic.',
  'Critical distinctions:',
  '- A message thanking the candidate for interviewing and then declining them is REJECTION, not INTERVIEW.',
  '- "We will keep your resume on file" is REJECTION.',
  '- An automated "we received your application" with no decision is ACK, even if it restates the job description.',
  '- Any automated job-board alert, saved search, recommendation, digest, or listing notification is JOB_ALERT, even if it contains only one role.',
  '- NEW_REQ requires a specific role personally pitched to the candidate by a recruiter or hiring contact, normally with an invitation to reply.',
  '- RATE_CONFIRM applies when the sender asks the candidate to accept or confirm a stated rate, not merely because a job description lists compensation.',
  '- Extract every candidate detail the sender explicitly requests, including LinkedIn, location, work authorization, availability, DOB, and SSN last four.',
  '- Marketing language such as "you may be a fit" or "jobs for you" is not a personal recruiter request.',
  '- Only use INTERVIEW when the sender wants time on a calendar or is confirming a booked slot.',
  'Never invent a client name or job title that is not present in the text.'
].join('\n');

function buildUserContent({ subject, from, fromName, body, maxBodyChars, ruleVerdict }) {
  // Recruiters commonly put the response checklist after a very long JD. Keep
  // both ends when limiting input so the model sees the role at the top and the
  // actual "please send/confirm" request at the bottom.
  const headChars = Math.ceil(maxBodyChars * 0.6);
  const tailChars = Math.floor(maxBodyChars * 0.4);
  const trimmedBody = body.length > maxBodyChars
    ? `${body.slice(0, headChars)}\n[...middle omitted...]\n${body.slice(-tailChars)}`
    : body;
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
 * One selected-provider call. Returns null on failure; callers keep the rules verdict.
 * Never throws.
 */
async function classifyWithModel({ subject, from, fromName, body, provider, model, maxBodyChars, ruleVerdict, timeoutMs = 20000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await requestClassification({
      providerId: provider,
      model,
      system: SYSTEM_PROMPT,
      prompt: buildUserContent({ subject, from, fromName, body, maxBodyChars, ruleVerdict }),
      schema: CLASSIFY_SCHEMA,
      signal: controller.signal
    });

    if (!result.ok) {
      log(`classifier: ${provider} API ${result.status || 'configuration error'} — falling back to rules. ${result.detail.slice(0, 200)}`, { name: 'classify' });
      return null;
    }

    if (!result.input?.category || !CATEGORIES.includes(result.input.category)) return null;

    const input = result.input;
    let category = input.category;
    if (input.isAutomatedJobMail && ['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM'].includes(category)) category = 'JOB_ALERT';
    if (category === 'NEW_REQ' && !input.isDirectOpportunity) category = input.isAutomatedJobMail ? 'JOB_ALERT' : 'RECRUITER_OTHER';
    if (category === 'NEW_REQ' && input.rateConfirmationRequested) category = 'RATE_CONFIRM';
    return {
      category,
      confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0.5)),
      isInterviewRequest: Boolean(input.isInterviewRequest),
      isDirectOpportunity: Boolean(input.isDirectOpportunity),
      isAutomatedJobMail: Boolean(input.isAutomatedJobMail),
      reason: String(input.reason || '').slice(0, 160),
      title: String(input.title || '').slice(0, 160),
      client: String(input.client || '').slice(0, 120),
      workMode: ['remote', 'hybrid', 'onsite', 'unknown'].includes(input.workMode) ? input.workMode : 'unknown',
      requestedProfileFields: Array.isArray(input.requestedProfileFields)
        ? input.requestedProfileFields.filter((field) => ['fullName', 'phone', 'contactEmail', 'linkedin', 'location', 'workAuth', 'availability', 'employmentTypes', 'dateOfBirth', 'ssnLast4'].includes(field))
        : [],
      rateConfirmationRequested: Boolean(input.rateConfirmationRequested),
      usage: result.usage || null
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
  const provider = providerFor(ai.provider || 'anthropic');
  // Once a user opts into AI, it reads every new message. Rules remain the
  // fallback, but sampling only ambiguous mail cannot repair a confident false
  // positive (the exact failure mode of alerts that resemble recruiter asks).
  const shouldEscalate = ai.enabled && providerHasKey(provider.id);

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
    provider: provider.id,
    model: ai.model || provider.defaultModel,
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
  const category = semanticCategoryOverride({
    subject,
    body,
    category: modelVerdict.category
  });
  const confidence = agree
    ? Math.min(0.99, Math.max(ruleVerdict.confidence, modelVerdict.confidence) + 0.08)
    : Math.min(0.8, modelVerdict.confidence);

  // The model fills gaps in extraction but never overwrites a labelled hit.
  const merged = { ...fields };
  if (!merged.title && modelVerdict.title) merged.title = modelVerdict.title;
  if (!merged.client && modelVerdict.client) merged.client = modelVerdict.client;
  if (merged.workMode === 'unknown' && modelVerdict.workMode !== 'unknown') merged.workMode = modelVerdict.workMode;
  merged.requestedProfileFields = [...new Set([
    ...(merged.requestedProfileFields || []),
    ...(modelVerdict.requestedProfileFields || []).filter((field) => !['dateOfBirth', 'ssnLast4'].includes(field))
  ])];
  merged.rateConfirmationRequested = Boolean(modelVerdict.rateConfirmationRequested);

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
