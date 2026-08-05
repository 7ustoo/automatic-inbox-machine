/**
 * Text normalization and similarity. Shared by the classifier (so rules match
 * regardless of formatting) and the dedupe engine (so the same req reworded by
 * two agencies still collides).
 */

/**
 * Removes a UTF-8 byte-order mark.
 *
 * Not theoretical: Notepad, `Set-Content -Encoding utf8` on Windows PowerShell 5,
 * and several editors all write a BOM by default. JSON.parse rejects it with
 * "Unexpected token", which turns a user editing config.json in Notepad into an
 * app that will not start and an error that does not say why. Every read of a
 * user-editable text file goes through this.
 */
export function stripBom(text) {
  const value = String(text ?? '');
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** Collapses whitespace, strips zero-width and smart punctuation, lowercases. */
export function normalizeText(input) {
  return String(input || '')
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips quoted replies, signatures, and disclaimer boilerplate so a five-deep
 * recruiter thread does not re-match rules from earlier messages.
 */
export function stripQuoted(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const cutPoints = [
    text.search(/^\s*-{2,}\s*original message\s*-{2,}\s*$/im),
    text.search(/^\s*_{5,}\s*$/m),
    text.search(/^\s*on .{4,80}\bwrote:\s*$/im),
    text.search(/^\s*from:\s*.+\bsent:\s*/ims),
    text.search(/^\s*>{1,}\s?/m),
    text.search(/^\s*this (?:e-?mail|message) and any attachments/im),
    text.search(/^\s*confidentiality notice\b/im),
    text.search(/^\s*(?:--|—)\s*$/m)
  ].filter((index) => index > 40);

  const cut = cutPoints.length ? Math.min(...cutPoints) : -1;
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

/** Converts HTML mail to something the rules and the model can read. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const TITLE_NOISE = [
  /\b(?:urgent(?:ly)?|immediate|asap|hot|priority|direct client|direct end client|end client|w2 only|c2c|1099|remote|onsite|hybrid|contract|contract to hire|c2h|full ?time|part ?time|perm(?:anent)?|need(?:ed)?|opening|opportunity|position|role|req(?:uirement|uisition)?|job|hiring|multiple positions?)\b/g,
  /\b(?:usc|gc|ead|h1b|h4|tn|opt|cpt)\b/g,
  /\b\d+\+?\s*(?:years?|yrs?)\b/g,
  /\bid\s*[:#]?\s*\w{3,}\b/g,
  /\b(?:jd|rtr|vms|msp)\b/g
];

/**
 * Reduces a subject line or job title to its comparable core.
 * "URGENT :: Sr. Java Developer (Remote) - W2 Only - 10+ yrs" -> "senior java developer"
 */
export function normalizeTitle(input) {
  let text = normalizeText(input);

  text = text
    .replace(/^\s*(?:re|fw|fwd|aw|sv)\s*:\s*/gi, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/::+/g, ' ')
    .replace(/[|/\\]+/g, ' ');

  for (const pattern of TITLE_NOISE) text = text.replace(pattern, ' ');

  text = text
    // Abbreviations are matched without requiring a trailing word boundary:
    // "sr." ends on a period followed by a space, which is not a \b position, so
    // the naive /\bsr\.?\b/ silently leaves "senior." behind.
    .replace(/\bsr\.?(?=\s|$)/g, 'senior')
    .replace(/\bjr\.?(?=\s|$)/g, 'junior')
    .replace(/\bmgr\.?(?=\s|$)/g, 'manager')
    .replace(/\bdev(?=\s|$)/g, 'developer')
    .replace(/\beng(?=\s|$)/g, 'engineer')
    .replace(/\badmin(?=\s|$)/g, 'administrator')
    .replace(/\barch(?=\s|$)/g, 'architect')
    .replace(/\banalysts\b/g, 'analyst')
    .replace(/\bengineers\b/g, 'engineer')
    .replace(/\bdevelopers\b/g, 'developer')
    // Periods go last so "sr." is resolved first and ".net"/"node.js" still
    // normalize identically on both sides of a comparison.
    .replace(/\./g, ' ')
    .replace(/[^a-z0-9+# ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

/**
 * Company name to a comparison key. Drops legal suffixes so "Deloitte
 * Consulting LLP" and "Deloitte" collide, which is exactly the case that gets
 * a candidate double-submitted.
 */
export function normalizeCompany(input) {
  return normalizeText(input)
    .replace(/[,.]/g, ' ')
    .replace(/\b(?:inc|llc|llp|ltd|limited|corp|corporation|co|company|group|holdings|solutions|technologies|technology|systems|services|consulting|consultancy|global|usa|us|india|pvt|private|international|labs|software|staffing|recruit(?:ing|ment)|partners|associates|enterprises)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sender domain, lowercased, with the common public mail hosts flagged. */
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'aol.com', 'icloud.com', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com'
]);

export function emailDomain(address) {
  const match = String(address || '').toLowerCase().match(/@([^\s>@]+)/);
  return match ? match[1].replace(/[.,;]+$/, '') : '';
}

export function isPublicMailDomain(domain) {
  return PUBLIC_MAIL_DOMAINS.has(String(domain || '').toLowerCase());
}

/**
 * Agency name inferred from the sender domain when the body does not name it.
 * "talent@brightpathtech.com" -> "brightpathtech"
 */
export function agencyFromDomain(address) {
  const domain = emailDomain(address);
  if (!domain || isPublicMailDomain(domain)) return '';
  return domain.split('.').slice(0, -1).join('.').replace(/^(?:mail|smtp|email|careers|jobs|apply|noreply|no-reply)\./, '');
}

/* -------------------------------------------------------------------------- */
/* Similarity                                                                 */
/* -------------------------------------------------------------------------- */

export function tokenSet(input) {
  return new Set(normalizeText(input).split(/[^a-z0-9+#.]+/).filter((token) => token.length > 1));
}

/** Jaccard over token sets — order-insensitive, good for titles. */
export function jaccard(a, b) {
  const left = a instanceof Set ? a : tokenSet(a);
  const right = b instanceof Set ? b : tokenSet(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** Character trigrams — catches typos and spacing differences titles suffer from. */
export function trigrams(input) {
  const text = ` ${normalizeText(input).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const grams = new Set();
  for (let index = 0; index < text.length - 2; index += 1) grams.add(text.slice(index, index + 3));
  return grams;
}

export function trigramSimilarity(a, b) {
  return jaccard(trigrams(a), trigrams(b));
}

/** Blend of token and trigram similarity. Titles benefit from both signals. */
export function titleSimilarity(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  return 0.6 * jaccard(left, right) + 0.4 * trigramSimilarity(left, right);
}

/**
 * Word-shingle set for a job description. 5-word shingles are long enough that
 * shared boilerplate ("must have excellent communication skills") does not
 * dominate, short enough to survive light rewording.
 */
export function shingles(text, size = 5) {
  const words = normalizeText(text).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let index = 0; index + size <= words.length; index += 1) {
    set.add(words.slice(index, index + size).join(' '));
  }
  // Short bodies produce no shingles; fall back to the token set so they are
  // still comparable rather than silently scoring 0 against everything.
  if (!set.size && words.length) return new Set(words);
  return set;
}

/**
 * Containment rather than plain Jaccard: an agency that pastes a JD and adds
 * three paragraphs of its own boilerplate should still match the original.
 */
export function jdSimilarity(a, b) {
  const left = shingles(a);
  const right = shingles(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const shingle of left) if (right.has(shingle)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

/** Stable short hash for fingerprints. FNV-1a, hex. */
export function shortHash(input) {
  let hash = 0x811c9dc5;
  const text = String(input || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
