import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyByRules } from '../rules.mjs';
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
