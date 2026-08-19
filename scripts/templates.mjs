/**
 * Reply templates.
 *
 * Two deliberate design rules:
 *
 * 1. A template with an unfilled required slot is DISABLED, not sent with a
 *    blank. Mailing a recruiter "My rate is $/hr" is worse than not replying.
 *
 * 2. Personally identifying data is tiered, not uniformly refused. Date of birth
 *    and the last four SSN digits are routine staffing paperwork and can be
 *    auto-sent once the operator opts in — the last four additionally require an
 *    explicit acknowledgement, because setting an env var is not consent to mail
 *    it. Everything else in that family — full SSN, driver's licence, passport,
 *    bank and routing details — has no config field and no template that can
 *    emit it, in any configuration.
 */
import { dateOfBirth, ssnLast4 } from './env.mjs';

/* -------------------------------------------------------------------------- */
/* Sensitive data: two tiers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * OPT_IN — routine staffing paperwork. Auto-sendable, but only once the value is
 * present AND (for the SSN last four) explicitly acknowledged. Setting an env var
 * is not by itself consent to mail it.
 */
export const OPT_IN_PATTERNS = {
  dateOfBirth: /\b(?:date\s+of\s+birth|d\.?o\.?b\.?|birth\s*date|birthday)\b/i,
  ssnLast4: /\blast\s*(?:four|4)\s*(?:digits?\s*)?(?:of\s*)?(?:your\s*)?(?:s\.?s\.?n\.?|social(?:\s+security)?(?:\s+number)?)?\b|\b(?:s\.?s\.?n\.?|social\s+security(?:\s+number)?)\s*(?:last\s*(?:four|4)|-\s*4|\(last\s*4\))/i
};

/**
 * BLOCKED — never sendable, in any configuration. There is no config field for
 * any of these and no template that can emit one. A full SSN is not a "stricter
 * version" of the last four; it is a different category of exposure.
 */
export const BLOCKED_PATTERNS = {
  fullSsn: /\b(?:full\s+)?(?:s\.?s\.?n\.?|social\s+security\s+number)\b|\b\d{3}-\d{2}-\d{4}\b/i,
  driversLicense: /\bdriver'?s?\s+licen[cs]e|\bdl\s*(?:number|#)|\bstate\s+id\s+(?:number|card)\b/i,
  passport: /\bpassport\s*(?:number|copy|scan|#)?\b/i,
  bankDetails: /\bbank\s+(?:account|details|info)|\brouting\s+number\b|\baccount\s+(?:and\s+)?routing\b|\bvoid(?:ed)?\s+che(?:ck|que)\b|\bdirect\s+deposit\s+form\b/i,
  motherMaidenName: /\bmother'?s?\s+maiden\s+name\b/i,
  fullDobPlusSsn: /\bi-?9\s+(?:form|document)|\bw-?4\s+form\b/i
};

/** The rundown shown before the SSN last-four option can be switched on. */
export const SSN_LAST4_DISCLAIMER = [
  'Most recruiters ask for the last four of your SSN to create a candidate profile',
  'for you in their system — VMS platforms use it to tell you apart from someone',
  'with the same name and to spot duplicate submissions. It is a routine ask in',
  'staffing and the risk in providing it is low.',
  '',
  'That said: this is your data and your decision. Turning this on means the agent',
  'will include those four digits in replies without asking you first, to any',
  'sender it classifies as making that request. This project is not responsible',
  'for what happens to the information once it leaves your mailbox.',
  '',
  'Your full SSN is never stored and never sendable, whatever this is set to.'
].join('\n');

/**
 * Tiers what a message is asking for.
 *
 * Opt-in matches are removed from the text before the blocked patterns run, so
 * "last 4 of your SSN" is recognised as the narrow ask rather than tripping the
 * full-SSN rule on the word "SSN" inside it.
 *
 * @returns {{ allowed: string[], blocked: string[], hasAllowed: boolean, hasBlocked: boolean }}
 */
export function classifySensitiveAsk(text) {
  const source = String(text || '');
  const allowed = [];
  let remainder = source;

  for (const [field, pattern] of Object.entries(OPT_IN_PATTERNS)) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    if (global.test(source)) {
      allowed.push(field);
      remainder = remainder.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), ' ');
    }
  }

  const blocked = Object.entries(BLOCKED_PATTERNS)
    .filter(([, pattern]) => pattern.test(remainder))
    .map(([field]) => field);

  return { allowed, blocked, hasAllowed: allowed.length > 0, hasBlocked: blocked.length > 0 };
}

/**
 * True when a message asks for something the agent must never auto-send.
 * Kept as the coarse check the gate reaches for first.
 */
export function asksForSensitiveData(text) {
  return classifySensitiveAsk(text).hasBlocked;
}

/**
 * Which opt-in fields a message asks for that are not available to send —
 * either unset, or set but not acknowledged. A non-empty result means the reply
 * has to go to approval rather than out the door.
 */
export function unavailableOptInFields(text, slots = {}) {
  const { allowed } = classifySensitiveAsk(text);
  return allowed.filter((field) => !String(slots[field] || '').trim());
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return `$${number.toLocaleString('en-US')}`;
}

/**
 * Renders {{slot}} placeholders. Returns { ok, text, missing[] }.
 * `required` names the slots that must be non-empty for the template to send.
 */
export function render(template, slots, required = []) {
  const missing = [];
  const text = String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = slots[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      if (required.includes(key)) missing.push(key);
      return '';
    }
    return String(value);
  });

  return {
    ok: missing.length === 0,
    missing,
    text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  };
}

/**
 * Slot bag assembled from config.profile, the extracted req fields, and the two
 * onboarding values held in .env.
 *
 * Both onboarding slots are double-gated: the value must exist in .env AND the
 * corresponding consent flag must be set in config. Either one missing yields an
 * empty slot, which disables any template that requires it rather than sending a
 * gap. `env` is injectable so tests never depend on the developer's own .env.
 */
export function buildSlots({ profile = {}, fields = {}, duplicate = null, accountEmail = '', onboarding = null }) {
  const rate = fields.rate;
  const preferredHourly = money(profile.preferredRateHourly);
  const preferredSalary = money(profile.preferredSalary);
  const roleLabel = `${fields.title || 'the role'}${fields.client ? ` at ${fields.client}` : ''}`;
  const offeredRate = rate ? (rate.kind === 'hourly' ? `$${rate.min}${rate.max > rate.min ? `-$${rate.max}` : ''}/hr` : money(rate.min)) : '';

  const source = onboarding || { dateOfBirth: dateOfBirth(), ssnLast4: ssnLast4() };
  const dob = profile.provideDateOfBirth === false ? '' : String(source.dateOfBirth || '').trim();
  const last4 = profile.ssnLast4Acknowledged === true ? String(source.ssnLast4 || '').trim() : '';

  const values = {
    fullName: profile.fullName || '',
    phone: profile.phone || '',
    contactEmail: profile.contactEmail || accountEmail || '',
    linkedin: profile.linkedin || '',
    location: [profile.city, profile.state].filter(Boolean).join(', '),
    workAuth: profile.workAuth || '',
    availability: profile.availability || '',
    employmentTypes: (profile.employmentTypes || []).join(' / '),
    dateOfBirth: dob,
    ssnLast4: last4
  };
  const requested = [...new Set(fields.requestedProfileFields || [])];
  const core = ['fullName', 'phone', 'contactEmail', 'linkedin', 'location', 'workAuth', 'availability'];
  const detailOrder = [...new Set([...core, ...requested])];
  const labels = {
    fullName: 'Full name', phone: 'Phone', contactEmail: 'Email', linkedin: 'LinkedIn',
    location: 'Location', workAuth: 'Work authorization', availability: 'Availability',
    employmentTypes: 'Employment types', dateOfBirth: 'Date of birth', ssnLast4: 'SSN (last four)'
  };
  const detailsBlock = detailOrder
    .filter((field) => String(values[field] || '').trim())
    .map((field) => `${labels[field]}: ${values[field]}`)
    .join('\n');
  const onboardingDetailsBlock = [...new Set([...core, 'dateOfBirth', 'ssnLast4', ...requested])]
    .filter((field) => String(values[field] || '').trim())
    .map((field) => `${labels[field]}: ${values[field]}`)
    .join('\n');
  const requestedMissingFields = requested.filter((field) => !String(values[field] || '').trim());

  return {
    dateOfBirth: dob,
    ssnLast4: last4,
    fullName: values.fullName,
    firstName: String(profile.fullName || '').trim().split(/\s+/)[0] || '',
    phone: values.phone,
    contactEmail: values.contactEmail,
    city: profile.city || '',
    state: profile.state || '',
    location: values.location,
    workAuth: values.workAuth,
    linkedin: values.linkedin,
    availability: values.availability,
    employmentTypes: values.employmentTypes,
    preferredRate: preferredHourly ? `${preferredHourly}/hr` : '',
    initialRate: profile.includePreferredRateInInitial && preferredHourly && !offeredRate ? `${preferredHourly}/hr` : '',
    preferredSalary,
    recruiterName: fields.recruiterName || '',
    recruiterFirstName: String(fields.recruiterName || '').trim().split(/\s+/)[0] || '',
    title: fields.title || 'the role',
    client: fields.client || '',
    offeredRate,
    rateResponse: offeredRate ? `I confirm the rate of ${offeredRate} for ${roleLabel}.` : `What is the rate for ${roleLabel}?`,
    rateConfirmation: offeredRate ? `I confirm the rate of ${offeredRate} for ${roleLabel}.` : `Please confirm the rate for ${roleLabel}.`,
    detailsBlock,
    onboardingDetailsBlock,
    requestedProfileFields: requested,
    requestedMissingFields,
    duplicateSummary: duplicate || '',
    greetingName: fields.recruiterName ? String(fields.recruiterName).trim().split(/\s+/)[0] : ''
  };
}

const GREETING = '{{#greeting}}';

function greetingFor(slots) {
  return slots.greetingName ? `Hi ${slots.greetingName},` : 'Hi,';
}

export const TEMPLATES = {
  RTR_REQUEST: {
    label: 'Right to represent',
    required: ['fullName'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

I agree to the right to represent for {{title}}{{#client}} at {{client}}{{/client}}.

{{rateResponse}}
{{#initialRate}}Preferred rate: {{initialRate}}{{/initialRate}}

{{detailsBlock}}

Thanks,
{{fullName}}`
  },

  RATE_CONFIRM: {
    label: 'Rate confirmation',
    required: ['fullName'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

{{rateResponse}}
{{#initialRate}}Preferred rate: {{initialRate}}{{/initialRate}}

{{detailsBlock}}

Thanks,
{{fullName}}`
  },

  NEW_REQ: {
    label: 'Interested in role',
    required: ['fullName'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

I am interested in {{title}}{{#client}} at {{client}}{{/client}}.

{{rateResponse}}
{{#initialRate}}Preferred rate: {{initialRate}}{{/initialRate}}

{{detailsBlock}}

Thanks,
{{fullName}}`
  },

  DUPLICATE: {
    label: 'Already submitted',
    required: ['fullName', 'duplicateSummary'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

Thanks for reaching out. I am {{duplicateSummary}}, so I cannot accept a duplicate submission.

Thanks,
{{fullName}}`
  },

  ONBOARDING_INFO: {
    label: 'Onboarding details',
    required: ['fullName'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

Here are the requested details{{#client}} for {{client}}{{/client}}:

{{onboardingDetailsBlock}}

{{rateResponse}}

I do not send full SSN, ID scans, or banking details by email.

Thanks,
{{fullName}}`
  },

  DECLINE_ONSITE: {
    label: 'Decline (not remote)',
    required: ['fullName'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

Thanks for reaching out. I am only considering fully remote roles, so I will pass on {{title}}.

Thanks,
{{fullName}}`
  },

  DECLINE_RATE: {
    label: 'Decline (below rate)',
    required: ['fullName', 'preferredRate'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

Thanks for reaching out. {{#offeredRate}}I cannot accept {{offeredRate}}.{{/offeredRate}} My minimum is {{preferredRate}}.

Thanks,
{{fullName}}`
  }
};

/**
 * Resolves the tiny conditional syntax: {{#slot}}...{{/slot}} keeps the block
 * only when the slot has a value. Kept deliberately minimal — this is a mail
 * merge, not a template language.
 *
 * Two passes. The first handles blocks that occupy a whole line and takes the
 * newline with them when dropped — otherwise a withheld field leaves a blank line
 * mid-list, which reads as though something failed to render. The second handles
 * inline blocks like "the role{{#client}} at {{client}}{{/client}}".
 */
function resolveConditionals(text, slots) {
  const filled = (key) => {
    const value = slots[key];
    return value !== undefined && value !== null && String(value).trim() !== '';
  };

  return text
    .replace(/^[ \t]*\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}[ \t]*(\r?\n|$)/gm, (_, key, inner, ending) =>
      filled(key) ? `${inner}${ending}` : ''
    )
    .replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => (filled(key) ? inner : ''));
}

/**
 * Builds a reply for one category.
 * Returns { ok, template, subject, body, missing[], reason }.
 */
export function buildReply(category, slots, overrides = {}) {
  const base = TEMPLATES[category];
  const custom = overrides?.[category];
  const template = typeof custom === 'string' && custom.trim()
    ? { ...base, body: custom }
    : custom && typeof custom === 'object'
      ? { ...base, ...custom }
      : base;
  if (!template) return { ok: false, missing: [], reason: `no template for ${category}` };

  const withGreeting = String(template.body).replace(GREETING, greetingFor(slots));
  const conditioned = resolveConditionals(withGreeting, slots);
  const rendered = render(conditioned, slots, template.required);

  if (!rendered.ok) {
    return {
      ok: false,
      template: category,
      missing: rendered.missing,
      reason: `template ${category} needs ${rendered.missing.join(', ')} — fill it in config.json profile, or reply by hand`
    };
  }

  const subject = typeof template.subject === 'function' ? template.subject(slots) : String(template.subject || '');

  return {
    ok: true,
    template: category,
    label: template.label,
    subject: subject.slice(0, 200),
    body: rendered.text,
    missing: [],
    reason: 'ready'
  };
}

/** Every template name plus whether the current profile can actually fill it. */
export function templateReadiness(slots, overrides = {}) {
  return Object.entries(TEMPLATES).map(([name, template]) => {
    const result = buildReply(name, slots, overrides);
    const custom = typeof overrides?.[name] === 'string' && overrides[name].trim();
    return { name, label: template.label, ready: result.ok, missing: result.missing, body: custom || template.body, customized: Boolean(custom) };
  });
}
