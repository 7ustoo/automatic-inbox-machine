import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksForSensitiveData, buildReply, buildSlots, render, templateReadiness } from '../templates.mjs';
import * as fixtures from './fixtures.mjs';

const PROFILE = {
  fullName: 'Justin Williams',
  phone: '(555) 010-2030',
  contactEmail: 'justin@example.com',
  city: 'Atlanta',
  state: 'GA',
  workAuth: 'US Citizen',
  availability: '2 weeks',
  linkedin: 'linkedin.com/in/example',
  preferredRateHourly: 85,
  employmentTypes: ['W2', 'C2C']
};

const FIELDS = {
  title: 'Sr. Cloud Security Engineer',
  client: 'Charles Schwab',
  recruiterName: 'Sandeep Reddy',
  rate: { kind: 'hourly', min: 75, max: 75, raw: '$75/hr' }
};

test('slots render and conditionals resolve', () => {
  const slots = buildSlots({ profile: PROFILE, fields: FIELDS });
  const reply = buildReply('NEW_REQ', slots);
  assert.equal(reply.ok, true);
  assert.match(reply.body, /Hi Sandeep,/);
  assert.match(reply.body, /Sr\. Cloud Security Engineer at Charles Schwab/);
  assert.match(reply.body, /US Citizen/);
  assert.match(reply.body, /\$85\/hr/);
  assert.match(reply.body, /Justin Williams$/);
  assert.equal(reply.subject, 'Re: Sr. Cloud Security Engineer');
});

test('a missing client drops the clause instead of leaving a gap', () => {
  const slots = buildSlots({ profile: PROFILE, fields: { ...FIELDS, client: '' } });
  const reply = buildReply('NEW_REQ', slots);
  assert.equal(reply.ok, true);
  assert.doesNotMatch(reply.body, / at ,/);
  assert.doesNotMatch(reply.body, /at\s*$/m);
});

test('a missing greeting name falls back to a bare Hi', () => {
  const slots = buildSlots({ profile: PROFILE, fields: { ...FIELDS, recruiterName: '' } });
  const reply = buildReply('NEW_REQ', slots);
  assert.match(reply.body, /^Hi,/);
});

test('a template with a missing required slot is disabled, not sent blank', () => {
  const slots = buildSlots({ profile: { ...PROFILE, preferredRateHourly: 0 }, fields: FIELDS });
  const reply = buildReply('RATE_CONFIRM', slots);
  assert.equal(reply.ok, false);
  assert.deepEqual(reply.missing, ['preferredRate']);
  assert.match(reply.reason, /preferredRate/);
});

test('an empty profile disables every template that needs a name', () => {
  const slots = buildSlots({ profile: {}, fields: FIELDS });
  const readiness = templateReadiness(slots);
  assert.ok(readiness.every((entry) => !entry.ready), 'nothing should be sendable without a name');
});

test('the RTR reply asserts exclusivity, which is the whole point of an RTR', () => {
  const slots = buildSlots({ profile: PROFILE, fields: FIELDS });
  const reply = buildReply('RTR_REQUEST', slots);
  assert.equal(reply.ok, true);
  assert.match(reply.body, /exclusive to you/i);
  assert.match(reply.body, /have not been submitted/i);
});

test('the duplicate reply names who submitted and when', () => {
  const slots = buildSlots({ profile: PROFILE, fields: FIELDS, duplicate: 'already submitted for Sr. Cloud Security Engineer at Charles Schwab by Nexus on Jul 30' });
  const reply = buildReply('DUPLICATE', slots);
  assert.equal(reply.ok, true);
  assert.match(reply.body, /Nexus on Jul 30/);
  assert.match(reply.body, /duplicate submission/i);
});

test('the duplicate reply is disabled without a match summary', () => {
  const slots = buildSlots({ profile: PROFILE, fields: FIELDS });
  const reply = buildReply('DUPLICATE', slots);
  assert.equal(reply.ok, false);
  assert.deepEqual(reply.missing, ['duplicateSummary']);
});

test('sensitive-data requests are detected', () => {
  assert.equal(asksForSensitiveData(fixtures.SENSITIVE_ASK.body), true);
  assert.equal(asksForSensitiveData('Please confirm your hourly rate and availability.'), false);
  assert.equal(asksForSensitiveData('We need your social security number for onboarding'), true);
  assert.equal(asksForSensitiveData('send a voided check for direct deposit'), true);
});

test('there is no template that can emit personal identifiers', () => {
  const slots = buildSlots({ profile: PROFILE, fields: FIELDS, duplicate: 'x' });
  for (const name of ['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM', 'DUPLICATE', 'DECLINE_ONSITE', 'DECLINE_RATE']) {
    const reply = buildReply(name, slots);
    if (!reply.ok) continue;
    assert.doesNotMatch(reply.body, /\bssn\b|social security|date of birth|driver'?s licen|passport|routing number/i, `${name} must not contain identity data`);
  }
});

test('unknown placeholders resolve to empty rather than leaking braces', () => {
  const result = render('Hello {{nope}}!', {}, []);
  assert.equal(result.text, 'Hello !');
  assert.equal(result.ok, true);
});

test('an unknown template name fails cleanly', () => {
  const reply = buildReply('NOT_A_TEMPLATE', {});
  assert.equal(reply.ok, false);
  assert.match(reply.reason, /no template/);
});
