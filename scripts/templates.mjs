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

  const source = onboarding || { dateOfBirth: dateOfBirth(), ssnLast4: ssnLast4() };
  const dob = profile.provideDateOfBirth === false ? '' : String(source.dateOfBirth || '').trim();
  const last4 = profile.ssnLast4Acknowledged === true ? String(source.ssnLast4 || '').trim() : '';

  return {
    dateOfBirth: dob,
    ssnLast4: last4,
    fullName: profile.fullName || '',
    firstName: String(profile.fullName || '').trim().split(/\s+/)[0] || '',
    phone: profile.phone || '',
    contactEmail: profile.contactEmail || accountEmail || '',
    city: profile.city || '',
    state: profile.state || '',
    location: [profile.city, profile.state].filter(Boolean).join(', '),
    workAuth: profile.workAuth || '',
    linkedin: profile.linkedin || '',
    availability: profile.availability || '',
    employmentTypes: (profile.employmentTypes || []).join(' / '),
    preferredRate: preferredHourly ? `${preferredHourly}/hr` : '',
    preferredSalary,
    recruiterName: fields.recruiterName || '',
    recruiterFirstName: String(fields.recruiterName || '').trim().split(/\s+/)[0] || '',
    title: fields.title || 'the role',
    client: fields.client || '',
    offeredRate: rate ? (rate.kind === 'hourly' ? `$${rate.min}${rate.max > rate.min ? `-$${rate.max}` : ''}/hr` : money(rate.min)) : '',
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

Confirmed — you have my right to represent for {{title}}{{#client}} at {{client}}{{/client}}. This is exclusive to you for this requisition; I have not been submitted to this client for this role by anyone else.

For your file:
Full name: {{fullName}}
Location: {{location}}
Work authorization: {{workAuth}}
Availability: {{availability}}
Phone: {{phone}}
Email: {{contactEmail}}

Please send the client name and rate before submission if you have not already. Let me know once you have submitted so I can track it.

Thanks,
{{fullName}}`
  },

  RATE_CONFIRM: {
    label: 'Rate confirmation',
    required: ['fullName', 'preferredRate'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

My rate for {{title}}{{#client}} at {{client}}{{/client}} is {{preferredRate}} on {{employmentTypes}}.{{#offeredRate}} I see you have {{offeredRate}} on the requirement — if the client can meet my number I am ready to move.{{/offeredRate}}

Availability: {{availability}}
Location: {{location}}
Work authorization: {{workAuth}}

Happy to jump on a quick call if it helps.

Thanks,
{{fullName}}`
  },

  NEW_REQ: {
    label: 'Interested in role',
    required: ['fullName'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

Yes, I am interested in {{title}}{{#client}} at {{client}}{{/client}} and available to move on it now.

Full name: {{fullName}}
Location: {{location}}
Work authorization: {{workAuth}}
Availability: {{availability}}
Rate: {{preferredRate}}
Phone: {{phone}}
{{#linkedin}}LinkedIn: {{linkedin}}{{/linkedin}}

Send the client name and the full job description and I will confirm before you submit. Please do not submit me anywhere without confirming first.

Thanks,
{{fullName}}`
  },

  DUPLICATE: {
    label: 'Already submitted',
    required: ['fullName', 'duplicateSummary'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

Thanks for reaching out. I am {{duplicateSummary}}, so I have to pass on a second submission for the same requisition — a duplicate submission would put both of us at risk with the client.

Happy to look at anything else you are working on that does not overlap.

Thanks,
{{fullName}}`
  },

  ONBOARDING_INFO: {
    label: 'Onboarding details',
    required: ['fullName'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

Here are the details for the candidate profile{{#client}} for {{client}}{{/client}}:

Full name: {{fullName}}
{{#dateOfBirth}}Date of birth: {{dateOfBirth}}{{/dateOfBirth}}
{{#ssnLast4}}SSN (last four): {{ssnLast4}}{{/ssnLast4}}
Location: {{location}}
Work authorization: {{workAuth}}
Phone: {{phone}}
Email: {{contactEmail}}
Availability: {{availability}}

I do not send full SSN, ID scans, or banking details over email. Once there is a
signed agreement in place I am happy to complete those on your onboarding portal
or over the phone.

Thanks,
{{fullName}}`
  },

  DECLINE_ONSITE: {
    label: 'Decline (not remote)',
    required: ['fullName'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

Thanks for the details. I am only considering fully remote roles right now, so {{title}} is not a fit for me{{#client}} at {{client}}{{/client}}.

If you have remote requirements, please keep me on your list.

Thanks,
{{fullName}}`
  },

  DECLINE_RATE: {
    label: 'Decline (below rate)',
    required: ['fullName', 'preferredRate'],
    subject: (slots) => `Re: ${slots.title}`,
    body: `${GREETING}

Thanks for the details. {{#offeredRate}}{{offeredRate}} is below where I can go{{/offeredRate}} — my number for this type of work is {{preferredRate}}.

If the client has room to move I am interested; otherwise keep me in mind for the next one.

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
  const template = overrides[category] || TEMPLATES[category];
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
export function templateReadiness(slots) {
  return Object.entries(TEMPLATES).map(([name, template]) => {
    const result = buildReply(name, slots);
    return { name, label: template.label, ready: result.ok, missing: result.missing };
  });
}
