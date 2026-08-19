import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyByRules, NEVER_AUTO_REPLY, semanticCategoryOverride } from '../rules.mjs';
import { prepareMessage } from '../classify.mjs';
import * as fixtures from './fixtures.mjs';

/** Runs a fixture through the same preparation the pipeline uses. */
function classify(fixture) {
  const prepared = prepareMessage({ textBody: fixture.body, htmlBody: '' });
  return classifyByRules({ subject: fixture.subject, body: prepared.body, from: fixture.from });
}

test('a thank-you-for-interviewing decline is a REJECTION, not an INTERVIEW', () => {
  const result = classify(fixtures.REJECTION_AFTER_INTERVIEW);
  assert.equal(result.category, 'REJECTION');
});

test('an ATS receipt is an ACK even when it restates the job description', () => {
  const result = classify(fixtures.ATS_ACK);
  assert.equal(result.category, 'ACK');
});

test('the real iCIMS Duluth receipt is ACK, never a new requirement', () => {
  const result = classify(fixtures.ICIMS_ACK_DULUTH);
  assert.equal(result.category, 'ACK');
  assert.ok(result.confidence > 0.9);
});

test('a conditional future interview inside a receipt is still ACK', () => {
  assert.equal(classify(fixtures.ATS_CONDITIONAL_INTERVIEW).category, 'ACK');
});

test('an application verification is not an interview request', () => {
  assert.equal(classify(fixtures.APPLICATION_VERIFICATION).category, 'ACK');
});

test('a direct phone-screen availability request from an ATS is INTERVIEW', () => {
  assert.equal(classify(fixtures.ATS_DIRECT_INTERVIEW).category, 'INTERVIEW');
});

test('a scheduled ATS interview is not demoted merely because the sender is automated', () => {
  const result = classifyByRules({
    subject: 'Your interview has been scheduled!',
    body: 'Thank you for scheduling your interview. Interview details: Friday at 9:00 AM.',
    from: 'company+email+abc@talent.icims.com'
  });
  assert.equal(result.category, 'INTERVIEW');
});

test('hypothetical non-selection boilerplate remains ACK, not rejection', () => {
  const result = classifyByRules({
    subject: 'Thank you for your application',
    body: 'We are reviewing your application. If you are not selected for this position, please consider future openings.',
    from: 'company+autoreply@talent.icims.com'
  });
  assert.equal(result.category, 'ACK');
});

test('a direct ATS minimum-qualification rejection remains REJECTION', () => {
  const result = classifyByRules({
    subject: 'Application status',
    body: 'We are sorry to inform you that you do not meet the minimum qualifications for this position.',
    from: 'company+autoreply@talent.icims.com'
  });
  assert.equal(result.category, 'REJECTION');
});

test('semantic guardrail downgrades an AI new-req mistake on a receipt', () => {
  assert.equal(semanticCategoryOverride({
    subject: fixtures.ICIMS_ACK_DULUTH.subject,
    body: fixtures.ICIMS_ACK_DULUTH.body,
    category: 'NEW_REQ'
  }), 'ACK');
});

test('semantic guardrail preserves a concrete interview even if AI calls it ACK', () => {
  assert.equal(semanticCategoryOverride({
    subject: fixtures.ATS_DIRECT_INTERVIEW.subject,
    body: fixtures.ATS_DIRECT_INTERVIEW.body,
    category: 'ACK'
  }), 'INTERVIEW');
});

test('ACK is permanently excluded from auto-reply categories', () => {
  assert.equal(NEVER_AUTO_REPLY.has('ACK'), true);
});

test('a scheduling request is an INTERVIEW', () => {
  const result = classify(fixtures.INTERVIEW_REQUEST);
  assert.equal(result.category, 'INTERVIEW');
  assert.ok(result.confidence > 0.6, `expected confident interview, got ${result.confidence}`);
});

test('a right-to-represent ask beats the requirement it quotes', () => {
  const result = classify(fixtures.RTR_REQUEST);
  assert.equal(result.category, 'RTR_REQUEST');
});

test('a rate question is RATE_CONFIRM', () => {
  const result = classify(fixtures.RATE_REQUEST);
  assert.equal(result.category, 'RATE_CONFIRM');
});

test('a pitched role is NEW_REQ', () => {
  const result = classify(fixtures.NEW_REQ_REMOTE);
  assert.equal(result.category, 'NEW_REQ');
});

test('a descriptively worded remote pitch stays a req without AI', () => {
  const result = classifyByRules({
    subject: 'Remote Cloud Engineer role',
    body: 'We have a 100% remote Cloud Engineer role for Acme. Please let me know if interested.',
    from: 'alex@agency.com'
  });
  assert.equal(result.category, 'NEW_REQ');
});

test('a job-board digest is JOB_ALERT, never NEW_REQ', () => {
  const result = classify(fixtures.JOB_BOARD_ALERT);
  assert.equal(result.category, 'JOB_ALERT');
});

test('a bare follow-up on a neutral subject is RECRUITER_OTHER', () => {
  const result = classify(fixtures.FOLLOW_UP);
  assert.equal(result.category, 'RECRUITER_OTHER');
});

test('the same follow-up on an RTR thread is still an RTR ask', () => {
  // The recruiter chasing "any update?" on a thread titled "RTR needed" is
  // still chasing the RTR, so the subject legitimately carries the intent.
  const result = classify(fixtures.RTR_FOLLOW_UP);
  assert.equal(result.category, 'RTR_REQUEST');
});

test('quoted replies do not leak interview language from earlier messages', () => {
  // The quoted portion contains "schedule an interview" and "screening call".
  // Stripping the quote is what keeps this from being misread as an invitation.
  const result = classify(fixtures.QUOTED_THREAD);
  assert.notEqual(result.category, 'INTERVIEW');
});

test('unmatched mail lands in OTHER with low confidence', () => {
  const result = classifyByRules({ subject: 'lunch tomorrow?', body: 'want to grab a bite', from: 'friend@example.com' });
  assert.equal(result.category, 'OTHER');
  assert.ok(result.confidence < 0.5);
});

test('custom phrases from config are honoured', () => {
  const result = classifyByRules({
    subject: 'Update on your candidacy',
    body: 'The panel has selected a different profile for this engagement.',
    from: 'someone@agency.com',
    extraPhrases: { REJECTION: ['selected a different profile'] }
  });
  assert.equal(result.category, 'REJECTION');
});

test('confidence drops when two categories are close', () => {
  const clear = classify(fixtures.INTERVIEW_REQUEST);
  const muddy = classifyByRules({
    subject: 'Following up',
    body: 'Thanks for applying. Unfortunately we are moving forward with others, but I would like to speak with you about another opening.',
    from: 'someone@agency.com'
  });
  assert.ok(muddy.confidence < clear.confidence, 'ambiguous mail should be less confident than clear mail');
});

test('every verdict carries a reason and a decidedBy', () => {
  for (const fixture of Object.values(fixtures)) {
    const result = classify(fixture);
    assert.ok(result.reason, 'reason must be populated');
    assert.equal(result.decidedBy, 'rules');
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  }
});
