/**
 * Cross-account dedupe.
 *
 * This is the piece that pays for the whole app. Agencies shotgun the same
 * requisition to every address they have for you, and two agencies submitting
 * you to the same end client is what gets your profile killed by that client —
 * not by the agency. So the ledger is deliberately global across every
 * configured inbox, and a client-level collision is surfaced even when the
 * stated job title is completely different.
 *
 * Three verdicts:
 *   new              — never seen this requisition
 *   duplicate        — same requisition, already pitched or already submitted
 *   client_collision — different-looking role at a client you are already in
 *                      play with. Deliberately NOT auto-answered; you decide.
 */
import { jdSimilarity, normalizeCompany, normalizeText, normalizeTitle, shortHash, titleSimilarity } from './normalize.mjs';

/** How much normalized JD text to keep per req for precise re-comparison. */
const JD_SAMPLE_CHARS = 3000;

/** Bottom-k sketch size. 64 is plenty to prefilter a few thousand reqs. */
const SKETCH_SIZE = 64;

function shingleList(text, size = 5) {
  const words = normalizeText(text).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (let index = 0; index + size <= words.length; index += 1) out.push(words.slice(index, index + size).join(' '));
  return out.length ? out : words;
}

/**
 * Bottom-k sketch of a JD: the k smallest shingle hashes. Comparing two sketches
 * estimates Jaccard cheaply, which lets us skip full comparison for the ~99% of
 * stored reqs that are nowhere close.
 */
export function jdSketch(text) {
  const hashes = new Set();
  for (const shingle of shingleList(text)) hashes.add(parseInt(shortHash(shingle), 16));
  return [...hashes].sort((a, b) => a - b).slice(0, SKETCH_SIZE);
}

export function sketchSimilarity(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  let shared = 0;
  for (const hash of b) if (left.has(hash)) shared += 1;
  return shared / Math.min(a.length, b.length);
}

/**
 * Stable identity for a requisition. Title plus client is the primary key; when
 * no client is named the recruiting domain stands in, because the same agency
 * re-pitching the same title is still a duplicate.
 */
export function reqFingerprint({ title = '', client = '', agency = '', recruiterDomain = '' } = {}) {
  const titleKey = normalizeTitle(title);
  const clientKey = normalizeCompany(client) || normalizeCompany(agency) || String(recruiterDomain || '').toLowerCase();
  return shortHash(`${titleKey}|${clientKey}`);
}

/** Builds the row stored in the reqs ledger. */
export function buildReqRecord({ fields, message, category }) {
  const jdText = `${message.subject || ''}\n${message.body || ''}`;
  return {
    fingerprint: reqFingerprint(fields),
    titleRaw: fields.title || '',
    titleNorm: normalizeTitle(fields.title),
    clientRaw: fields.client || '',
    clientNorm: normalizeCompany(fields.client),
    agencyRaw: fields.agency || '',
    agencyNorm: normalizeCompany(fields.agency),
    recruiterName: fields.recruiterName || '',
    recruiterEmail: message.from || '',
    recruiterDomain: fields.recruiterDomain || '',
    location: fields.location || '',
    workMode: fields.workMode || 'unknown',
    rate: fields.rate || null,
    duration: fields.duration || '',
    employmentType: fields.employmentType || [],
    reqId: fields.reqId || '',
    accountId: message.accountId,
    threadId: message.threadId,
    messageKey: message.messageKey,
    category,
    jdSample: normalizeText(jdText).slice(0, JD_SAMPLE_CHARS),
    jdSketch: jdSketch(jdText),
    firstSeenAt: new Date().toISOString()
  };
}

function daysBetween(isoA, isoB) {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.abs(a - b) / 86400000;
}

function sameParty(candidate, incoming) {
  // Two rows are the "same party" when they came from the same agency, which
  // means it is a re-send rather than a competing agency. Distinguishing these
  // matters: a re-send deserves a polite dedupe reply, a competing agency
  // deserves a decision from the human.
  const left = candidate.agencyNorm || candidate.recruiterDomain || '';
  const right = incoming.agencyNorm || incoming.recruiterDomain || '';
  return Boolean(left) && left === right;
}

/**
 * Checks one incoming req against everything already known.
 *
 * @param incoming  a record from buildReqRecord
 * @param known     { reqs: [], submissions: [] } from the ledger index
 * @param options   thresholds from config.dedupe
 */
export function checkDuplicate(incoming, known = {}, options = {}) {
  const {
    titleSimilarity: titleThreshold = 0.82,
    jdSimilarity: jdThreshold = 0.7,
    sameClientWindowDays = 45
  } = options;

  const reqs = known.reqs || [];
  const submissions = known.submissions || [];
  const now = incoming.firstSeenAt || new Date().toISOString();

  let best = null;
  const consider = (row, score, kind, why) => {
    if (!best || score > best.score) best = { match: row, score, kind, why };
  };

  for (const row of reqs) {
    if (row.messageKey && row.messageKey === incoming.messageKey) continue;
    if (row.threadId && row.threadId === incoming.threadId && row.accountId === incoming.accountId) continue;

    // 1. Identical fingerprint — same normalized title and client.
    if (row.fingerprint && row.fingerprint === incoming.fingerprint) {
      consider(row, 1, 'fingerprint', 'identical title + client');
      continue;
    }

    // 2. Same client with a near-identical title.
    const clientMatch = Boolean(row.clientNorm) && row.clientNorm === incoming.clientNorm;
    if (clientMatch) {
      const similarity = titleSimilarity(row.titleNorm, incoming.titleNorm);
      if (similarity >= titleThreshold) {
        consider(row, similarity, 'title+client', `title ${(similarity * 100).toFixed(0)}% similar at the same client`);
        continue;
      }
    }

    // 3. The JD itself matches, whatever the title says. Sketch prefilter first.
    const sketchScore = sketchSimilarity(row.jdSketch, incoming.jdSketch);
    if (sketchScore >= jdThreshold * 0.7) {
      const precise = jdSimilarity(row.jdSample, incoming.jdSample);
      if (precise >= jdThreshold) {
        consider(row, precise, 'jd', `job description ${(precise * 100).toFixed(0)}% overlapping`);
      }
    }
  }

  // 4. Already actually submitted — the strongest signal there is, and the one
  //    that produces the "already submitted by X on Y" reply.
  for (const submission of submissions) {
    const clientMatch = Boolean(submission.clientNorm) && submission.clientNorm === incoming.clientNorm;
    const similarity = titleSimilarity(submission.titleNorm, incoming.titleNorm);
    if ((clientMatch && similarity >= titleThreshold * 0.9) || similarity >= 0.95) {
      consider({ ...submission, _submitted: true }, Math.max(0.95, similarity), 'submitted', 'you are already submitted for this');
    }
  }

  if (best && best.kind !== 'client_window') {
    return {
      verdict: 'duplicate',
      kind: best.kind,
      score: Number(best.score.toFixed(3)),
      match: best.match,
      alreadySubmitted: Boolean(best.match._submitted),
      sameAgency: sameParty(best.match, incoming),
      reason: best.why
    };
  }

  // 5. Soft flag: a different role at a client you are already in play with,
  //    inside the window. Never auto-answered — this is the double-submission
  //    trap and it needs a human.
  const collisions = [...submissions, ...reqs].filter(
    (row) =>
      row.clientNorm &&
      incoming.clientNorm &&
      row.clientNorm === incoming.clientNorm &&
      daysBetween(row.submittedAt || row.firstSeenAt || row.ts, now) <= sameClientWindowDays &&
      !(row.accountId === incoming.accountId && row.threadId === incoming.threadId)
  );

  if (collisions.length) {
    const newest = collisions.sort((a, b) =>
      String(b.submittedAt || b.firstSeenAt || b.ts).localeCompare(String(a.submittedAt || a.firstSeenAt || a.ts))
    )[0];
    return {
      verdict: 'client_collision',
      kind: 'client_window',
      score: 0.5,
      match: newest,
      alreadySubmitted: Boolean(newest.submittedAt),
      sameAgency: sameParty(newest, incoming),
      reason: `you already have activity with ${newest.clientRaw || newest.clientNorm} within ${sameClientWindowDays} days`
    };
  }

  return { verdict: 'new', kind: null, score: 0, match: null, alreadySubmitted: false, sameAgency: false, reason: 'no prior match' };
}

/** Row appended to the submissions ledger once interest actually goes out. */
export function buildSubmissionRecord({ req, outboundId, via = 'auto' }) {
  return {
    reqFingerprint: req.fingerprint,
    titleRaw: req.titleRaw,
    titleNorm: req.titleNorm,
    clientRaw: req.clientRaw,
    clientNorm: req.clientNorm,
    agencyRaw: req.agencyRaw,
    agencyNorm: req.agencyNorm,
    recruiterName: req.recruiterName,
    recruiterEmail: req.recruiterEmail,
    accountId: req.accountId,
    threadId: req.threadId,
    rate: req.rate || null,
    workMode: req.workMode,
    outboundId,
    via,
    submittedAt: new Date().toISOString()
  };
}

/**
 * Human-readable sentence for the duplicate reply and the Telegram card.
 * "Already submitted for Sr. Java Developer at Deloitte by BrightPath on Jul 12."
 */
export function describeMatch(result) {
  if (!result?.match) return '';
  const row = result.match;
  const when = row.submittedAt || row.firstSeenAt || row.ts;
  const date = when ? new Date(when).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'earlier';
  const who = row.agencyRaw || row.agencyNorm || row.recruiterDomain || 'another agency';
  const what = row.titleRaw || row.titleNorm || 'this role';
  const where = row.clientRaw || row.clientNorm;

  if (result.alreadySubmitted) {
    return `already submitted for ${what}${where ? ` at ${where}` : ''} by ${who} on ${date}`;
  }
  return `already pitched ${what}${where ? ` at ${where}` : ''} by ${who} on ${date}`;
}
