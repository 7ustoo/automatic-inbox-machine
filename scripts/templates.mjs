/**
 * Reply templates.
 *
 * Two deliberate design rules:
 *
 * 1. A template with an unfilled required slot is DISABLED, not sent with a
 *    blank. Mailing a recruiter "My rate is $/hr" is worse than not replying.
 *
 * 2. There is no template for personally identifying data — no SSN (full or
 *    last four), no date of birth, no driver's licence, no passport, no bank
 *    details. Agencies do ask for these, routinely, and an agent that auto-sends
 *    them is a liability. Those messages are routed to you as an alert instead,
 *    and the config has nowhere to store them on purpose.
 */

/** Fields that must never be auto-supplied, whatever a recruiter asks. */
export const NEVER_AUTOFILL = [
  'ssn', 'social security', 'last four', 'last 4', 'date of birth', 'dob',
  'driver', 'licence', 'license number', 'passport', 'bank', 'routing',
  'account number', 'mother', 'i-9', 'i9 form', 'void cheque', 'void check'
];

const SENSITIVE_ASK = new RegExp(
  `\\b(?:${[
    'ssn', 'social\\s+security(?:\\s+number)?', 'last\\s*(?:four|4)\\s*(?:of|digits)',
    'date\\s+of\\s+birth', '\\bdob\\b', "driver'?s?\\s+licen[cs]e", 'passport\\s+number',
    'bank\\s+(?:account|details)', 'routing\\s+number', 'void(?:ed)?\\s+che(?:ck|que)'
  ].join('|')})\\b`,
  'i'
);

/** True when a message is fishing for data the agent must never auto-send. */
export function asksForSensitiveData(text) {
  return SENSITIVE_ASK.test(String(text || ''));
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

/** Slot bag assembled from config.profile plus the extracted req fields. */
export function buildSlots({ profile = {}, fields = {}, duplicate = null, accountEmail = '' }) {
  const rate = fields.rate;
  const preferredHourly = money(profile.preferredRateHourly);
  const preferredSalary = money(profile.preferredSalary);

  return {
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
 */
function resolveConditionals(text, slots) {
  return text.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
    const value = slots[key];
    return value !== undefined && value !== null && String(value).trim() !== '' ? inner : '';
  });
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
