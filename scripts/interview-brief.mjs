/** Short, evidence-aware description of what an interview email asks for. */
export function interviewBrief({ subject = '', summary = '', snippet = '' } = {}) {
  const text = `${subject} ${summary} ${snippet}`;
  if (/\b(?:assessment|coding challenge|take[- ]home|questionnaire|online test)\b/i.test(text)) {
    return { kind: 'assessment', label: 'Screening / assessment', action: 'Complete the screening step described in the email.' };
  }
  if (/\b(?:one[- ]way|recorded|video introduction|video screen)\b/i.test(text)) {
    return { kind: 'screening', label: 'Video screening request', action: 'Review the video screening instructions and deadline.' };
  }
  if (/\b(?:schedule|scheduling|book (?:a |your )?(?:time|slot|interview)|select (?:a |your )?(?:time|slot)|choose (?:a |your )?(?:time|slot)|share (?:your )?availability|available to (?:speak|talk)|interview availability)\b/i.test(text)) {
    return { kind: 'scheduling', label: 'Interview scheduling request', action: 'Choose an interview time or send your availability.' };
  }
  if (/\b(?:calendar invitation|calendar invite|interview (?:is )?(?:confirmed|scheduled)|interview at \d|meeting link)\b/i.test(text)) {
    return { kind: 'scheduled', label: 'Scheduled interview', action: 'Review the interview time and meeting details.' };
  }
  if (/\b(?:interview request|invited? (?:you )?(?:to|for) (?:an? )?interview|next[- ]round interview|phone screen)\b/i.test(text)) {
    return { kind: 'invitation', label: 'Interview invitation', action: 'Review and respond to the invitation.' };
  }
  return { kind: 'unclear', label: 'Possible interview — review', action: 'Open the email to confirm whether an interview is being requested.' };
}

/** Interview format alone is not evidence of the job's work arrangement. */
export function emailJobWorkMode({ fields = {}, subject = '', summary = '', snippet = '' } = {}) {
  const mode = fields.workMode;
  if (!['remote', 'hybrid', 'onsite'].includes(mode)) return 'unknown';
  const text = `${subject} ${summary} ${snippet}`;
  const interviewFormat = /\b(?:remote|virtual|on[- ]site|in[- ]person)\s+(?:interview|screen(?:ing)?|meeting|call)\b/i.test(text);
  const jobArrangement = /\b(?:remote|hybrid|on[- ]site|in[- ]office)\s+(?:role|position|job|work|opportunity)\b|\b(?:role|position|job)\s+(?:is|will be)\s+(?:fully\s+)?(?:remote|hybrid|on[- ]site)\b|\bwork from home\b/i.test(text);
  return interviewFormat && !jobArrangement ? 'unknown' : mode;
}
