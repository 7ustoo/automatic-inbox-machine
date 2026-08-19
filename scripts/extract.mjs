/**
 * Field extraction from recruiter mail. Deterministic and cheap — the model, if
 * enabled, only fills gaps this leaves and never overrides a confident hit here.
 *
 * Recruiter mail is remarkably formulaic: labelled lines ("Location: Dallas, TX")
 * dominate, so labelled extraction runs first and free-text inference is the
 * fallback.
 */
import { agencyFromDomain, emailDomain, normalizeText } from './normalize.mjs';

const LABEL_ALIASES = {
  title: ['job title', 'position title', 'title', 'position', 'role', 'req title', 'requirement'],
  client: ['client', 'end client', 'direct client', 'company', 'employer', 'customer', 'client name'],
  location: ['location', 'work location', 'job location', 'city', 'onsite location', 'position location'],
  duration: ['duration', 'contract duration', 'length', 'contract length', 'project duration', 'term'],
  rate: ['rate', 'pay rate', 'bill rate', 'hourly rate', 'compensation', 'salary', 'budget', 'max rate', 'w2 rate', 'c2c rate'],
  employmentType: ['employment type', 'tax term', 'job type', 'type', 'hire type', 'position type'],
  visa: ['visa', 'visa status', 'work authorization', 'authorization', 'visa requirement'],
  interview: ['interview', 'interview mode', 'interview process'],
  reqId: ['job id', 'req id', 'requisition id', 'reference', 'ref', 'job code', 'req #', 'position id'],
  workMode: ['work mode', 'remote', 'onsite', 'work type', 'workplace type', 'mode of work']
};

/** Profile values a recruiter may explicitly ask the candidate to provide. */
export const REQUESTABLE_PROFILE_FIELDS = Object.freeze([
  'fullName', 'phone', 'contactEmail', 'linkedin', 'location', 'workAuth',
  'availability', 'employmentTypes', 'dateOfBirth', 'ssnLast4'
]);

const REQUEST_FIELD_PATTERNS = Object.freeze({
  fullName: /\b(?:full|legal)\s+name\b/i,
  phone: /\b(?:phone|mobile|cell|contact)\s*(?:number|#)?\b/i,
  contactEmail: /\b(?:e-?mail)(?:\s+address)?\b/i,
  linkedin: /\blinked\s*in(?:\s+(?:profile|url|link))?\b/i,
  location: /\b(?:current\s+location|location|city\s*(?:and|\/|&)\s*state|city,?\s+state)\b/i,
  workAuth: /\b(?:work\s+auth(?:orization)?|visa\s+status|immigration\s+status|citizenship)\b/i,
  availability: /\b(?:availability|available\s+to\s+start|start\s+date|notice\s+period)\b/i,
  employmentTypes: /\b(?:employment\s+type|tax\s+term|w-?2\s*\/\s*c2c|c2c\s*\/\s*w-?2)\b/i,
  dateOfBirth: /\b(?:date\s+of\s+birth|d\.?o\.?b\.?|birth\s*date|birthday)\b/i,
  ssnLast4: /\blast\s*(?:four|4)\s*(?:digits?\s*)?(?:of\s*)?(?:your\s*)?(?:s\.?s\.?n\.?|social(?:\s+security)?(?:\s+number)?)?\b|\b(?:s\.?s\.?n\.?|social\s+security(?:\s+number)?)\s*(?:last\s*(?:four|4)|-\s*4|\(last\s*4\))/i
});

/**
 * Finds the profile fields the current (quoted-thread-stripped) message asks
 * for. Recruiter checklists are commonly a line of labels after "please send",
 * but many omit the verb and simply end each requested label with a colon.
 */
export function extractRequestedProfileFields(text) {
  const source = String(text || '');
  const requestContext = /\b(?:please|kindly|reply|send|share|provide|confirm|need|require|fill|complete|details?|information)\b/i.test(source);
  const requested = [];

  for (const [field, pattern] of Object.entries(REQUEST_FIELD_PATTERNS)) {
    if (!pattern.test(source)) continue;
    const labelled = source.split(/\r?\n/).some((line) =>
      pattern.test(line) && /(?:\?|:\s*$|:\s*_{2,}|-\s*$)/.test(line.trim())
    );
    if (requestContext || labelled) requested.push(field);
  }

  return REQUESTABLE_PROFILE_FIELDS.filter((field) => requested.includes(field));
}

/**
 * Pulls "Label: value" pairs. Handles `Label - value`, `Label :: value`, and
 * values that continue onto the next line when the label line ends bare.
 */
export function extractLabelled(body) {
  const lines = String(body || '').split(/\r?\n/);
  const found = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/^\s*[*\-•·>]+\s*/, '').trim();
    if (!line || line.length > 220) continue;

    const match = line.match(/^([A-Za-z][A-Za-z /&#]{1,34}?)\s*(?:::|:|–|—|-)\s*(.*)$/);
    if (!match) continue;

    const label = normalizeText(match[1]).replace(/[^a-z0-9 #]/g, '').trim();
    let value = match[2].trim();

    // A bare label takes the next non-empty line as its value.
    if (!value) {
      for (let ahead = index + 1; ahead < Math.min(index + 3, lines.length); ahead += 1) {
        const candidate = lines[ahead].trim();
        if (candidate && !/^([A-Za-z][A-Za-z /&#]{1,34}?)\s*(?:::|:)\s*/.test(candidate)) {
          value = candidate;
          break;
        }
      }
    }
    if (!value || value.length > 200) continue;

    for (const [field, aliases] of Object.entries(LABEL_ALIASES)) {
      if (aliases.includes(label) && !found[field]) {
        found[field] = value.replace(/\s+/g, ' ').replace(/[.;,]+$/, '').trim();
        break;
      }
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Work mode                                                                  */
/* -------------------------------------------------------------------------- */

const REMOTE_STRONG = /\b(?:100%\s*remote|fully\s+remote|remote\s*[-–—]?\s*(?:usa|us|united\s+states|anywhere|nationwide)|work\s+from\s+home|wfh\s+(?:role|position)|permanently\s+remote|remote\s+forever)\b/i;
const REMOTE_WEAK = /\bremote\b/i;
const HYBRID = /\b(?:hybrid|\d\s*days?\s*(?:a|per)\s*week\s*(?:in\s+office|onsite|on-?site)|partially\s+remote|flex(?:ible)?\s+(?:onsite|hybrid))\b/i;
const ONSITE = /\b(?:on-?site|in-?office|in-?person|relocat(?:e|ion)\s+required|must\s+be\s+(?:local|onsite|on-?site)|local\s+(?:candidates?|only)|day\s+one\s+onsite)\b/i;

/**
 * Returns 'remote' | 'hybrid' | 'onsite' | 'unknown'.
 * Onsite and hybrid are checked before remote because "Remote (hybrid 3 days
 * onsite)" is a hybrid role that leads with the word remote.
 */
export function detectWorkMode(text) {
  const haystack = String(text || '');
  if (HYBRID.test(haystack)) return 'hybrid';
  if (ONSITE.test(haystack) && !REMOTE_STRONG.test(haystack)) return 'onsite';
  if (REMOTE_STRONG.test(haystack)) return 'remote';
  if (REMOTE_WEAK.test(haystack)) return 'remote';
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Rate                                                                       */
/* -------------------------------------------------------------------------- */

const HOURLY_UNIT = /\/\s*(?:hr|hour)|\bper\s+hour\b|\ban\s+hour\b|\bhourly\b|\bhr\b/i;
const ANNUAL_UNIT = /\/\s*(?:yr|year|annum)|\bper\s+(?:year|annum)\b|\bannual(?:ly)?\b|\bsalary\b|\bbase\b/i;

/**
 * One money-ish number. Alternative order matters: the comma form and the "k"
 * shorthand must both be tried before the bare-digits form, or "150k" in
 * "130k-150k" matches as a bare 150 and the range collapses to nonsense.
 */
const MONEY = String.raw`\$?\s?(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{2,3}\s?[kK]\b|\d{2,7}(?:\.\d{1,2})?)`;

/**
 * A number, an optional range partner, and up to 32 characters of trailing
 * context so the unit ("per hour") is visible even when it follows the range.
 * The lookbehind stops a match starting mid-way through a longer number.
 */
const RATE_PATTERN = new RegExp(`(?<![\\w.])(${MONEY})\\s*(?:-|–|—|to)?\\s*(${MONEY})?([^\\n]{0,32})`, 'g');

function toAmount(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '').toLowerCase();
  if (!cleaned) return null;
  if (cleaned.endsWith('k')) {
    const thousands = Number(cleaned.slice(0, -1));
    return Number.isFinite(thousands) ? thousands * 1000 : null;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Canonical display form, so `raw` is stable regardless of how it was written. */
export function formatRate({ kind, min, max }) {
  const money = (value) => `$${Number(value).toLocaleString('en-US')}`;
  const suffix = kind === 'hourly' ? '/hr' : '';
  return max > min ? `${money(min)}-${money(max)}${suffix}` : `${money(min)}${suffix}`;
}

/**
 * Parses rate expressions into { kind: 'hourly'|'annual', min, max, raw }.
 * Handles "$65/hr", "65-70 per hour", "$130,000", "130k-150k", "up to $75/hr".
 * Returns null when nothing in the text is confidently a rate.
 */
export function extractRate(text) {
  const haystack = String(text || '');
  const candidates = [];

  for (const match of haystack.matchAll(RATE_PATTERN)) {
    const [whole, lowRaw, highRaw = '', trailing = ''] = match;
    const numbers = whole.slice(0, whole.length - trailing.length);
    const context = `${numbers} ${trailing}`;
    const hasDollar = /\$/.test(numbers);
    const isHourlyUnit = HOURLY_UNIT.test(context);
    const isAnnualUnit = ANNUAL_UNIT.test(context);

    let low = toAmount(lowRaw);
    let high = toAmount(highRaw);
    if (low === null) continue;

    // A range partner an order of magnitude off the anchor is not a range — it is
    // a different number that happened to follow (a phone fragment, a date).
    if (high !== null && (high > low * 20 || low > high * 20)) high = null;
    if (high !== null && high < low) [low, high] = [high, low];

    // Unit wins over magnitude; magnitude only decides when no unit is stated.
    let kind = null;
    if (isHourlyUnit && !isAnnualUnit) kind = 'hourly';
    else if (isAnnualUnit && !isHourlyUnit) kind = 'annual';
    else if (low >= 25 && low <= 400) kind = 'hourly';
    else if (low >= 30000) kind = 'annual';
    else continue;

    // A bare number with no currency symbol and no unit is almost always
    // something else — years of experience, a contract length, a percentage.
    if (!hasDollar && !isHourlyUnit && !isAnnualUnit) continue;
    if (kind === 'hourly' && (low < 10 || low > 500)) continue;
    if (kind === 'annual' && (low < 20000 || low > 1000000)) continue;

    candidates.push({
      kind,
      min: low,
      max: high ?? low,
      score: (hasDollar ? 2 : 0) + (isHourlyUnit || isAnnualUnit ? 3 : 0) + (high !== null ? 1 : 0)
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.max - a.max);
  const { kind, min, max } = candidates[0];
  return { kind, min, max, raw: formatRate({ kind, min, max }) };
}

/* -------------------------------------------------------------------------- */
/* Misc fields                                                                */
/* -------------------------------------------------------------------------- */

const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

export function extractLocation(text) {
  const haystack = String(text || '');
  const cityState = haystack.match(new RegExp(`\\b([A-Z][a-zA-Z.'-]+(?:\\s+[A-Z][a-zA-Z.'-]+){0,2}),\\s*(${US_STATES})\\b`));
  if (cityState) return `${cityState[1]}, ${cityState[2]}`;
  if (/\b(?:remote|anywhere|nationwide)\b/i.test(haystack)) return 'Remote';
  return '';
}

export function extractDuration(text) {
  const match = String(text || '').match(/\b(\d{1,2})\s*(?:\+|plus)?\s*(month|months|mo|year|years|yr|week|weeks)\b(?:\s*(?:contract|assignment|engagement|project|extendable|with\s+extension))?/i);
  if (!match) return '';
  return `${match[1]} ${match[2].toLowerCase().replace(/^mo$/, 'months').replace(/^yr$/, 'years')}`;
}

export function extractEmploymentType(text) {
  const found = new Set();
  const haystack = String(text || '');
  if (/\bw-?2\b/i.test(haystack)) found.add('W2');
  if (/\bc2c\b|\bcorp\s*to\s*corp\b/i.test(haystack)) found.add('C2C');
  if (/\b1099\b/i.test(haystack)) found.add('1099');
  if (/\bfull[\s-]?time\b|\bfte\b|\bperm(?:anent)?\b/i.test(haystack)) found.add('FTE');
  if (/\bcontract\s*(?:to|2)\s*hire\b|\bc2h\b/i.test(haystack)) found.add('C2H');
  else if (/\bcontract\b/i.test(haystack)) found.add('Contract');
  return [...found];
}

/** Recruiter's display name from the From header, or a sign-off in the body. */
export function extractRecruiterName({ fromName = '', body = '' } = {}) {
  const clean = String(fromName || '')
    .replace(/["']/g, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s*[|,–—-]\s*(?:sr\.?|senior|technical|it|lead)?\s*(?:recruiter|talent|staffing|ta)\b.*$/i, '')
    .trim();
  if (clean && /^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2}$/.test(clean)) return clean;

  const signoff = String(body || '').match(/\b(?:thanks?|regards?|best|sincerely|cheers)[,!.]?\s*(?:\r?\n){1,3}\s*([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)?)\s*(?:\r?\n|$)/);
  if (signoff) return signoff[1].trim();
  return clean || '';
}

export function extractPhone(text) {
  const match = String(text || '').match(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b(?:\s*(?:ext|x)\.?\s*\d{1,5})?/);
  return match ? match[0].trim() : '';
}

/** Agency: prefer an explicitly named company, else derive from the domain. */
export function extractAgency({ from = '', body = '', fromName = '' } = {}) {
  const named = String(body || '').match(/\b(?:i\s+am|i'm|this\s+is)\s+[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+)?\s+(?:from|with|at)\s+([A-Z][A-Za-z0-9&.,' -]{2,40}?)(?:\.|,|\s+and\b|\s*\r?\n)/);
  if (named) return named[1].trim().replace(/[.,]+$/, '');

  const domainName = agencyFromDomain(from);
  if (domainName) return domainName;

  const bracket = String(fromName || '').match(/[|(-]\s*([A-Za-z][A-Za-z0-9&.' -]{2,40})\s*[)]?$/);
  return bracket ? bracket[1].trim() : '';
}

/**
 * Best-effort job title when there is no labelled Title line: strip the
 * decorations recruiters bolt onto subject lines and keep the noun phrase.
 */
export function extractTitleFromSubject(subject) {
  let text = String(subject || '')
    .replace(/^\s*(?:re|fw|fwd|aw)\s*:\s*/gi, '')
    .replace(/\b(?:urgent|immediate|hot|asap|direct\s+client|w2\s+only|usc\s+only|gc\/?usc)\b/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ');

  // Subjects are usually delimited; the longest segment is nearly always the role.
  const segments = text.split(/\s*(?:::|\||\/{2,}|--|—|–|,)\s*/).map((part) => part.trim()).filter(Boolean);
  const roleish = segments
    .filter((segment) => /\b(?:developer|engineer|analyst|architect|administrator|manager|consultant|specialist|lead|designer|scientist|tester|qa|devops|sre|scrum|pm|director|technician|support)\b/i.test(segment))
    .sort((a, b) => b.length - a.length)[0];

  return (roleish || segments.sort((a, b) => b.length - a.length)[0] || text)
    .replace(/\s+/g, ' ')
    .replace(/[-–—:\s]+$/, '')
    .trim()
    .slice(0, 140);
}

/**
 * Full extraction pass. `text` should already be quoted-reply-stripped.
 * Every field is a best effort; missing is '' or null, never undefined.
 */
export function extractFields({ subject = '', body = '', from = '', fromName = '' } = {}) {
  const labelled = extractLabelled(body);
  const haystack = `${subject}\n${body}`;

  const rate = extractRate(labelled.rate ? `${labelled.rate} ${haystack}` : haystack);
  const workMode = detectWorkMode(`${labelled.workMode || ''} ${labelled.location || ''} ${haystack}`);

  return {
    title: (labelled.title || extractTitleFromSubject(subject) || '').slice(0, 160),
    client: (labelled.client || '').slice(0, 120),
    agency: extractAgency({ from, body, fromName }).slice(0, 120),
    recruiterName: extractRecruiterName({ fromName, body }).slice(0, 80),
    recruiterPhone: extractPhone(body),
    recruiterDomain: emailDomain(from),
    location: (labelled.location || extractLocation(haystack) || '').slice(0, 120),
    workMode,
    rate,
    duration: labelled.duration || extractDuration(haystack),
    employmentType: labelled.employmentType ? extractEmploymentType(`${labelled.employmentType} ${haystack}`) : extractEmploymentType(haystack),
    visa: (labelled.visa || '').slice(0, 80),
    reqId: (labelled.reqId || '').slice(0, 60),
    requestedProfileFields: extractRequestedProfileFields(body),
    labelled
  };
}
