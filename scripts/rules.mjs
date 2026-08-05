/**
 * The free classifier.
 *
 * Rules run before any model call and settle the large majority of a flooded
 * recruiter inbox at zero cost and zero latency. Weighted patterns per category,
 * subject matches counting heavier than body matches, plus a small set of hard
 * precedence rules for the cases where naive keyword counting gets it wrong.
 *
 * The precedence rules exist because of real failure modes:
 *   - "Thank you for interviewing with us... unfortunately" contains interview
 *     language but is a rejection.
 *   - A rejection that says "we'll keep your resume on file for future roles"
 *     is still a rejection, not a new req.
 *   - An ATS no-reply confirming receipt is an ACK even when it restates the
 *     whole job description underneath.
 */

export const CATEGORIES = [
  'INTERVIEW',
  'RTR_REQUEST',
  'RATE_CONFIRM',
  'NEW_REQ',
  'DUPLICATE',
  'REJECTION',
  'ACK',
  'JOB_ALERT',
  'NEWSLETTER',
  'RECRUITER_OTHER',
  'OTHER'
];

/** Categories that must never be auto-replied to, whatever the config says. */
export const NEVER_AUTO_REPLY = new Set(['INTERVIEW', 'REJECTION', 'JOB_ALERT', 'NEWSLETTER', 'OTHER']);

/** Categories safe to move out of the inbox. Nothing here is ever deleted. */
export const ARCHIVABLE = new Set(['REJECTION', 'ACK', 'JOB_ALERT', 'NEWSLETTER']);

const P = (weight, pattern) => ({ weight, pattern });

export const PATTERNS = {
  INTERVIEW: [
    P(5, /\b(?:schedule|set ?up|arrange|book)\s+(?:an?\s+)?(?:brief\s+|quick\s+|short\s+|initial\s+)?(?:call|interview|screening|chat|meeting|discussion|conversation)\b/i),
    P(5, /\b(?:phone|video|technical|panel|final|initial|first|second|third)\s+(?:screen|screening|interview|round)\b/i),
    P(5, /\bscreening\s+call\b/i),
    P(5, /\binvit(?:e|ing|ation)\s+you\s+(?:to|for)\b/i),
    P(5, /\bwould\s+like\s+to\s+(?:speak|talk|meet|interview|connect)\s+with\s+you\b/i),
    P(4, /\b(?:client|hiring\s+manager|manager|team)\s+(?:would\s+like|wants|is\s+interested|has\s+asked)\s+to\s+(?:speak|talk|meet|interview)\b/i),
    P(4, /\bare\s+you\s+available\s+(?:on|at|for|this|next|tomorrow|today|between)\b/i),
    P(4, /\bwhat\s+(?:is|are)\s+your\s+availability\b/i),
    P(4, /\bplease\s+(?:share|send|provide|confirm)\s+your\s+availability\b/i),
    P(4, /\byou(?:'ve| have)\s+been\s+(?:shortlisted|selected)\s+for\b/i),
    P(4, /\bmov(?:e|ing)\s+(?:you\s+)?(?:forward|ahead)\s+(?:to|with)\s+(?:the\s+)?(?:next\s+step|interview|screening)/i),
    P(4, /\bcalendly\.com\/|\bcalendar\.app\.google\b|\bhttps?:\/\/[^\s]*\/booking\b/i),
    P(3, /\b(?:teams\.microsoft\.com\/l\/meetup|zoom\.us\/j\/|meet\.google\.com\/[a-z-]{10,}|webex\.com\/meet)\b/i),
    P(3, /\bnext\s+steps?\s+(?:in|of|for)\s+(?:the|your)\s+(?:process|interview|application)\b/i),
    P(3, /\b(?:interview|meeting)\s+(?:is\s+)?(?:confirmed|scheduled|set)\s+for\b/i),
    P(3, /\bdo\s+you\s+(?:want|wish|care)\s+to\s+schedule\b/i),
    P(3, /\blet\s+me\s+know\s+(?:a\s+)?(?:few\s+)?(?:times?|slots?|windows?)\s+that\s+work\b/i),
    P(2, /\b(?:15|20|30|45|60)[\s-]*(?:min|minute)s?\s+(?:call|chat|slot|conversation|interview)\b/i),
    P(2, /\btime\s+slots?\s+(?:that\s+)?(?:work|available)\b/i),
    P(2, /\binterview\b/i)
  ],

  RTR_REQUEST: [
    P(6, /\bright\s+to\s+represent\b/i),
    P(6, /\bright[\s-]to[\s-]represent(?:ation)?\b/i),
    P(5, /\bRTR\b/),
    P(4, /\b(?:permission|authoriz(?:e|ation)|approval|consent)\s+to\s+(?:submit|represent|present)\s+(?:you|your\s+(?:resume|profile|candidature))\b/i),
    P(4, /\b(?:confirm|reply|respond)\s+(?:back\s+)?(?:with\s+)?(?:your\s+)?(?:written\s+)?(?:confirmation|approval|consent)\s+(?:so|to|that|before)\s+(?:i|we)\s+(?:can\s+)?submit\b/i),
    P(4, /\bmay\s+i\s+(?:submit|present|represent)\s+(?:you|your\s+(?:profile|resume))\b/i),
    P(3, /\bexclusive\s+right\s+to\s+(?:submit|represent)\b/i),
    P(3, /\bsubmission\s+(?:approval|authorization|consent)\b/i),
    P(3, /\bconfirm(?:ation)?\s+(?:email\s+)?(?:that\s+)?(?:you|your)\s+(?:have\s+)?(?:not\s+been\s+)?(?:already\s+)?submitted\b/i)
  ],

  RATE_CONFIRM: [
    P(5, /\brate\s+confirmation\b/i),
    P(5, /\bconfirm\s+(?:your|the)\s+(?:hourly\s+|bill\s+|pay\s+|final\s+)?rate\b/i),
    P(4, /\bwhat\s+(?:is|are|would\s+be)\s+your\s+(?:expected\s+|desired\s+|best\s+|current\s+|hourly\s+)?rate\b/i),
    P(4, /\b(?:expected|desired|best|lowest|minimum)\s+(?:hourly\s+)?rate\b/i),
    P(4, /\byour\s+rate\s+expectation/i),
    P(4, /\b(?:salary|compensation|rate)\s+expectations?\b/i),
    P(3, /\bare\s+you\s+(?:ok|okay|fine|comfortable)\s+with\s+(?:this\s+|the\s+)?(?:rate|budget|\$\s*\d)/i),
    P(3, /\bmax(?:imum)?\s+(?:bill\s+)?rate\s+(?:is|of)\b/i),
    P(3, /\bcan\s+you\s+(?:do|work|go)\s+(?:it\s+)?(?:on|at|for)\s+\$\s*\d{2,3}/i),
    P(2, /\bw2\s+rate\b|\bc2c\s+rate\b|\b1099\s+rate\b/i),
    P(2, /\bplease\s+(?:share|send|provide)\s+(?:your\s+)?(?:rate|compensation)\b/i)
  ],

  NEW_REQ: [
    P(4, /\b(?:new|immediate|urgent|hot|direct\s+client)\s+(?:requirement|opening|position|role|req)\b/i),
    P(4, /\bplease\s+(?:find|see)\s+(?:the\s+|below\s+)?(?:job\s+)?(?:description|requirement|details)\b/i),
    P(4, /\b(?:we\s+have|there\s+is|i\s+have)\s+an?\s+(?:urgent\s+|immediate\s+|new\s+)?(?:opening|opportunity|requirement|position|role)\b/i),
    P(4, /\bjob\s+description\s*[:\-]/i),
    P(3, /\b(?:kindly|please)\s+(?:share|send)\s+(?:me\s+)?your\s+(?:updated\s+)?(?:resume|cv|profile)\b/i),
    P(3, /\blet\s+me\s+know\s+(?:if\s+)?you(?:'re| are)?\s+(?:interested|comfortable|available)\b/i),
    P(3, /\bif\s+(?:you\s+are|this\s+(?:looks|sounds))\s+(?:interested|good|like\s+a\s+fit)\b/i),
    P(3, /^\s*(?:job\s+)?title\s*[:\-]/im),
    P(3, /^\s*(?:location|duration|client|rate|visa|employment\s+type)\s*[:\-]/im),
    P(3, /\bare\s+you\s+(?:available|open)\s+(?:for|to)\s+(?:a\s+)?new\s+(?:role|position|opportunity|project)\b/i),
    P(2, /\bcontract\s+(?:to\s+hire|position|role)\b/i),
    P(2, /\b(?:months?|years?)\s+contract\b/i),
    P(2, /\bopportunity\s+(?:with|at|for)\b/i)
  ],

  REJECTION: [
    P(6, /\b(?:decided|chosen|elected)\s+to\s+(?:move|proceed|go)\s+forward\s+with\s+(?:other|another|a\s+different)\b/i),
    P(6, /\bwe\s+(?:will\s+)?not\s+be\s+(?:moving|proceeding|progressing)\s+(?:forward|ahead)\s+with\s+your\b/i),
    P(6, /\bnot\s+(?:been\s+)?select(?:ed)?\s+(?:for|to)\b/i),
    P(6, /\bregret\s+to\s+inform\b/i),
    P(5, /\bunfortunately,?\s+(?:we|you|your|after|at\s+this)\b/i),
    P(5, /\bpursu(?:e|ing)\s+other\s+(?:candidates|applicants|profiles)\b/i),
    P(5, /\bno\s+longer\s+(?:under\s+consideration|being\s+considered|in\s+consideration)\b/i),
    P(5, /\b(?:position|role|req(?:uisition)?)\s+(?:has\s+been|is|was)\s+(?:filled|closed|cancelled|canceled|placed|put\s+on\s+hold)\b/i),
    P(5, /\bwe\s+(?:have\s+)?decided\s+not\s+to\b/i),
    P(4, /\bafter\s+(?:careful\s+)?(?:review|consideration|evaluating)\b/i),
    P(4, /\bmov(?:e|ing)\s+forward\s+with\s+(?:candidates|profiles)\s+whose\b/i),
    P(4, /\bnot\s+(?:a|the)\s+(?:right|best|ideal)\s+(?:fit|match)\s+(?:for|at)\b/i),
    P(4, /\bkeep\s+your\s+(?:resume|profile|application|details)\s+on\s+file\b/i),
    P(4, /\bwish\s+you\s+(?:the\s+best|success|good\s+luck)\s+(?:in|with)\s+your\s+(?:job\s+)?search\b/i),
    P(3, /\bwe\s+(?:won'?t|will\s+not)\s+be\s+(?:advancing|continuing)\b/i),
    P(3, /\bother\s+candidates\s+whose\s+(?:qualifications|experience|background)\b/i),
    P(3, /\bdecided\s+to\s+(?:pass|pursue\s+a\s+different\s+direction)\b/i)
  ],

  ACK: [
    P(6, /\bthank\s+you\s+for\s+(?:applying|your\s+application)\b/i),
    P(6, /\b(?:we|your\s+application)\s+(?:have|has)\s+(?:been\s+)?received\b/i),
    P(5, /\bapplication\s+(?:received|confirmation|submitted\s+successfully)\b/i),
    P(5, /\bthanks?\s+for\s+(?:your\s+)?(?:interest\s+in|applying\s+(?:to|for))\b/i),
    P(4, /\bwe\s+(?:are|will\s+be)\s+review(?:ing)?\s+your\s+(?:application|resume|profile)\b/i),
    P(4, /\bwe\s+(?:appreciate|value)\s+your\s+interest\s+in\b/i),
    P(4, /\bthis\s+is\s+(?:an\s+)?(?:automated|auto-generated|automatic)\s+(?:response|confirmation|message)\b/i),
    P(3, /\bif\s+your\s+(?:qualifications|background|profile)\s+match(?:es)?\b/i),
    P(3, /\bsomeone\s+(?:from\s+our\s+team\s+)?will\s+(?:be\s+in\s+touch|contact\s+you|reach\s+out)\s+if\b/i),
    P(3, /\bplease\s+do\s+not\s+reply\s+to\s+this\s+(?:e-?mail|message)\b/i)
  ],

  JOB_ALERT: [
    P(6, /\b\d+\s+new\s+jobs?\s+(?:for\s+you|matching|posted)\b/i),
    P(5, /\bjob\s+alert\b/i),
    P(5, /\bjobs?\s+matching\s+your\s+(?:search|profile|preferences|criteria)\b/i),
    P(5, /\b(?:recommended|suggested|new)\s+(?:jobs?|roles?|opportunities)\s+(?:for\s+you|based\s+on)\b/i),
    P(4, /\byour\s+(?:daily|weekly)\s+job\s+(?:alert|digest|matches)\b/i),
    P(3, /\bbased\s+on\s+your\s+(?:recent\s+)?(?:searches|activity|profile)\b/i),
    P(3, /\bjobs\s+you\s+may\s+be\s+interested\s+in\b/i)
  ],

  NEWSLETTER: [
    P(5, /\bunsubscribe\s+(?:from\s+)?(?:this\s+)?(?:list|newsletter|these\s+emails)\b/i),
    P(4, /\b(?:newsletter|weekly\s+digest|monthly\s+roundup)\b/i),
    P(4, /\bmanage\s+(?:your\s+)?(?:email\s+)?preferences\b/i),
    P(3, /\bwebinar\b|\bupcoming\s+events?\b/i),
    P(3, /\byou(?:'re| are)\s+receiving\s+this\s+(?:e-?mail|message)\s+because\b/i)
  ],

  RECRUITER_OTHER: [
    P(3, /\b(?:following\s+up|checking\s+in|circling\s+back|bumping\s+this)\b/i),
    P(3, /\bdid\s+you\s+(?:get|receive|see)\s+(?:my|the)\s+(?:last\s+)?(?:e-?mail|message)\b/i),
    P(3, /\bany\s+update\s+on\s+(?:this|the\s+below)\b/i),
    P(2, /\b(?:staffing|recruit(?:ing|ment)|talent\s+acquisition|technical\s+recruiter|sr\.?\s+recruiter)\b/i),
    P(2, /\bsubmitted\s+your\s+(?:profile|resume|candidature)\b/i),
    P(2, /\bhope\s+(?:you\s+are|you'?re|this\s+e?mail\s+finds\s+you)\s+(?:doing\s+)?well\b/i)
  ]
};

/** Senders that are ATS/no-reply robots. Strong prior toward ACK/REJECTION. */
export const ATS_SENDER = /(?:no-?reply|do-?not-?reply|donotreply|notifications?|auto(?:mated)?|mailer|postmaster|careers|jobs|talent|recruiting|hr)@|@(?:myworkday(?:jobs)?\.com|greenhouse\.io|us\.greenhouse\.io|lever\.co|hire\.lever\.co|ashbyhq\.com|icims\.com|taleo\.net|successfactors\.com|smartrecruiters\.com|jobvite\.com|workable(?:mail)?\.com|breezy\.hr|bamboohr\.com|paylocity\.com|dayforcehcm\.com|avature\.net|eightfold\.ai|phenompeople\.com|oraclecloud\.com)/i;

/** Job boards whose mail is almost always an alert digest, not a real human. */
export const JOB_BOARD_SENDER = /@(?:linkedin\.com|indeed(?:email)?\.com|ziprecruiter\.com|glassdoor\.com|dice\.com|monster\.com|careerbuilder\.com|simplyhired\.com|talent\.com|jobs?\.[a-z]+\.com|hiring\.cafe|wellfound\.com|angel\.co|builtin\.com|otta\.com|welcometothejungle\.com)/i;

const SUBJECT_WEIGHT = 1.6;

/**
 * Scores one message against every category.
 * Returns { scores, matched } where matched[category] lists the hit patterns.
 */
export function scoreCategories({ subject = '', body = '', from = '', extraPhrases = {} } = {}) {
  const scores = {};
  const matched = {};

  const consider = (category, weight, source) => {
    scores[category] = (scores[category] || 0) + weight;
    (matched[category] ||= []).push(source);
  };

  for (const [category, patterns] of Object.entries(PATTERNS)) {
    for (const { weight, pattern } of patterns) {
      if (pattern.test(subject)) consider(category, weight * SUBJECT_WEIGHT, `subject:${pattern.source.slice(0, 44)}`);
      else if (pattern.test(body)) consider(category, weight, `body:${pattern.source.slice(0, 44)}`);
    }
  }

  // User-supplied phrases from config, treated as strong body signals.
  for (const [category, phrases] of Object.entries(extraPhrases)) {
    for (const phrase of phrases || []) {
      if (!phrase) continue;
      const needle = String(phrase).toLowerCase();
      if (subject.toLowerCase().includes(needle)) consider(category, 5 * SUBJECT_WEIGHT, `custom:${needle}`);
      else if (body.toLowerCase().includes(needle)) consider(category, 5, `custom:${needle}`);
    }
  }

  if (ATS_SENDER.test(from)) {
    // A robot sender cannot be scheduling an interview conversationally, but it
    // absolutely can be confirming receipt or issuing a rejection.
    scores.ACK = (scores.ACK || 0) + 3;
    scores.REJECTION = (scores.REJECTION || 0) + 1.5;
    scores.INTERVIEW = (scores.INTERVIEW || 0) * 0.55;
    (matched.ACK ||= []).push('sender:ats');
  }

  if (JOB_BOARD_SENDER.test(from)) {
    scores.JOB_ALERT = (scores.JOB_ALERT || 0) + 5;
    scores.NEW_REQ = (scores.NEW_REQ || 0) * 0.4;
    (matched.JOB_ALERT ||= []).push('sender:jobboard');
  }

  return { scores, matched };
}

/**
 * Hard precedence, applied after scoring. Each rule returns a category or null.
 * Order matters — the first rule that fires wins.
 */
const PRECEDENCE = [
  // A past-tense thank-you plus any rejection signal is a rejection, even
  // though "interview" appears in the text.
  ({ text, scores }) =>
    scores.REJECTION >= 4 &&
    /\bthank\s+you\s+for\s+(?:taking\s+the\s+time|your\s+time|interviewing|speaking|meeting)\b/i.test(text)
      ? 'REJECTION'
      : null,

  // Explicit rejection language beats interview keywords outright.
  ({ scores }) => (scores.REJECTION >= 6 && scores.REJECTION >= scores.INTERVIEW ? 'REJECTION' : null),

  // Genuine scheduling language beats everything else, including a JD dump.
  ({ scores }) => (scores.INTERVIEW >= 6 ? 'INTERVIEW' : null),

  // RTR is narrow and unambiguous when it hits; it outranks the JD it quotes.
  ({ scores }) => (scores.RTR_REQUEST >= 6 ? 'RTR_REQUEST' : null),

  // A receipt confirmation from a robot is an ACK no matter what it restates.
  ({ scores, from }) => (ATS_SENDER.test(from) && scores.ACK >= 6 && scores.INTERVIEW < 6 ? 'ACK' : null),

  // Board digests masquerade as reqs because they contain job titles.
  ({ scores, from }) => (JOB_BOARD_SENDER.test(from) && scores.JOB_ALERT >= 5 ? 'JOB_ALERT' : null)
];

/**
 * Full rules verdict.
 *
 * confidence is derived from two things: how strong the winning score is, and
 * how far clear of the runner-up it is. A message that scores 8 for INTERVIEW
 * and 7 for REJECTION is genuinely ambiguous and should go to the model, so it
 * reports low confidence even though the raw score is high.
 */
export function classifyByRules({ subject = '', body = '', from = '', extraPhrases = {} } = {}) {
  const { scores, matched } = scoreCategories({ subject, body, from, extraPhrases });
  const text = `${subject}\n${body}`;

  const ranked = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!ranked.length) {
    return { category: 'OTHER', confidence: 0.3, scores, matched, reason: 'no rule matched', decidedBy: 'rules' };
  }

  const [topCategory, topScore] = ranked[0];
  const runnerUp = ranked[1]?.[1] || 0;

  let category = topCategory;
  let reason = `rules: ${topCategory} scored ${topScore.toFixed(1)}`;

  for (const rule of PRECEDENCE) {
    const forced = rule({ text, scores: { ...scores, INTERVIEW: scores.INTERVIEW || 0, REJECTION: scores.REJECTION || 0, ACK: scores.ACK || 0, RTR_REQUEST: scores.RTR_REQUEST || 0, JOB_ALERT: scores.JOB_ALERT || 0 }, from });
    if (forced) {
      if (forced !== category) reason = `precedence override -> ${forced} (raw winner was ${topCategory})`;
      category = forced;
      break;
    }
  }

  // Saturating strength: 6 points is a solid single strong match, 14 is emphatic.
  const strength = Math.min(1, topScore / 14);
  const margin = topScore > 0 ? Math.min(1, (topScore - runnerUp) / Math.max(4, topScore)) : 0;
  const confidence = Math.max(0.15, Math.min(0.98, 0.45 * strength + 0.55 * (0.35 + 0.65 * margin) * strength + 0.2 * strength));

  return {
    category,
    confidence: Number(confidence.toFixed(3)),
    scores,
    matched: matched[category] || [],
    allMatched: matched,
    reason,
    decidedBy: 'rules'
  };
}
