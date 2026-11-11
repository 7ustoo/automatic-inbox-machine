import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksForSensitiveData, buildReply, buildSlots, render, sampleReply, templateReadiness } from '../templates.mjs';
import * as fixtures from './fixtures.mjs';
import { extractFields, namedClient } from '../extract.mjs';

test('generic client labels are omitted in extraction and replies, including stored fields', () => {
  for (const client of ['Pharmaceutical Client', 'our client', 'Confidential', 'A leading financial services company', 'Fortune 500 client', 'N/A']) {
    assert.equal(extractFields({ body: `Client: ${client}` }).client, '');
    const slots = buildSlots({ profile: { fullName: 'Test User' }, fields: { title: 'DevOps Engineer HPC', client } });
    const reply = buildReply('NEW_REQ', slots);
    assert.match(reply.body, /^Hello, I am interested in this role\.\n\nWhat's the rate for this role\?/);
    assert.doesNotMatch(reply.body, /DevOps Engineer HPC/);
    assert.match(reply.body, /Full name: Test User/);
    assert.equal(slots.client, '');
  }
  for (const name of ['Charles Schwab', 'Pharmaceutical Product Development', 'The Client Company LLC']) {
    assert.equal(namedClient(name), name);
  }
});

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
  assert.match(reply.body, /^Hello, I am interested in this role\.\n\nI confirm the rate of \$75\/hr\./);
  assert.doesNotMatch(reply.body, /Sr\. Cloud Security Engineer|Charles Schwab|What's the rate/);
  assert.match(reply.body, /Full name: Justin Williams/);
  assert.match(reply.body, /Phone: \(555\) 010-2030/);
  assert.match(reply.body, /Email: justin@example\.com/);
  assert.match(reply.body, /LinkedIn: linkedin\.com\/in\/example/);
  assert.match(reply.body, /Location: Atlanta, GA/);
  assert.doesNotMatch(reply.body, /\$85\/hr|Rate:/, 'preferred rate stays out of the initial reply by default');
  assert.equal(reply.subject, 'Re: Sr. Cloud Security Engineer');
});

test('sharing a preferred rate in first replies is explicit opt-in', () => {
  const slots = buildSlots({ profile: { ...PROFILE, includePreferredRateInInitial: true }, fields: { ...FIELDS, rate: null } });
  assert.match(buildReply('NEW_REQ', slots).body, /What's the rate for this role\?/);
  assert.match(buildReply('NEW_REQ', slots).body, /Preferred rate: \$85\/hr/);
  assert.match(buildReply('RTR_REQUEST', slots).body, /Preferred rate: \$85\/hr/);
});

test('a missing client drops the clause instead of leaving a gap', () => {
  const slots = buildSlots({ profile: PROFILE, fields: { ...FIELDS, client: '' } });
  const reply = buildReply('NEW_REQ', slots);
  assert.equal(reply.ok, true);
  assert.doesNotMatch(reply.body, / at ,/);
  assert.doesNotMatch(reply.body, /at\s*$/m);
});

test('interest replies use Hello even without a recruiter name', () => {
  const slots = buildSlots({ profile: PROFILE, fields: { ...FIELDS, recruiterName: '' } });
  const reply = buildReply('NEW_REQ', slots);
  assert.match(reply.body, /^Hello,/);
});

test('rate confirmation repeats the offered rate, never the preferred rate', () => {
  const slots = buildSlots({ profile: PROFILE, fields: FIELDS });
  const reply = buildReply('RATE_CONFIRM', slots);
  assert.equal(reply.ok, true);
  assert.match(reply.body, /confirm the rate of \$75\/hr/i);
  assert.doesNotMatch(reply.body, /\$85\/hr|quick call|if the client can meet/i);
  assert.doesNotMatch(reply.body, /\{\{|\}\}/);
});

test('rate confirmation asks for the rate when the message does not contain one', () => {
  const slots = buildSlots({ profile: PROFILE, fields: { ...FIELDS, rate: null } });
  const reply = buildReply('RATE_CONFIRM', slots);
  assert.equal(reply.ok, true);
  assert.match(reply.body, /What is the rate/i);
});

test('requested recruiter fields are added to the protected onboarding reply', () => {
  const slots = buildSlots({
    profile: PROFILE,
    fields: { ...FIELDS, requestedProfileFields: ['linkedin', 'employmentTypes', 'dateOfBirth'] },
    onboarding: { dateOfBirth: '04/12', ssnLast4: '' }
  });
  const reply = buildReply('ONBOARDING_INFO', slots);
  assert.match(reply.body, /LinkedIn: linkedin\.com\/in\/example/);
  assert.match(reply.body, /Employment types: W2 \/ C2C/);
  assert.match(reply.body, /Date of birth: 04\/12/);
  assert.deepEqual(slots.requestedMissingFields, []);
});

test('an editable body override keeps message-aware slots', () => {
  const slots = buildSlots({ profile: PROFILE, fields: FIELDS });
  const reply = buildReply('NEW_REQ', slots, {
    NEW_REQ: 'Hi {{firstName}},\n\n{{rateResponse}}\n\n{{detailsBlock}}\n\n{{fullName}}'
  });
  assert.match(reply.body, /confirm the rate of \$75\/hr/i);
  assert.match(reply.body, /LinkedIn:/);
  assert.doesNotMatch(reply.body, /\{\{/);
});

test('an empty profile disables every template that needs a name', () => {
  const slots = buildSlots({ profile: {}, fields: FIELDS });
  const readiness = templateReadiness(slots);
  assert.ok(readiness.every((entry) => !entry.ready), 'nothing should be sendable without a name');
});

test('the RTR reply gives concise written agreement and essential details', () => {
  const slots = buildSlots({ profile: PROFILE, fields: FIELDS });
  const reply = buildReply('RTR_REQUEST', slots);
  assert.equal(reply.ok, true);
  assert.match(reply.body, /I agree to the right to represent/i);
  assert.match(reply.body, /Phone:/i);
  assert.doesNotMatch(reply.body, /quick call|let me know once|rate before submission/i);
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

test('plain-language reply wording keeps live job details and matches its preview', () => {
  const choice = {
    kind: 'guided', message: 'I would love to discuss the opportunity.', signoff: 'Best regards,',
    facts: { role: true, interestRate: true, profile: false }
  };
  const preview = sampleReply('NEW_REQ', { NEW_REQ: choice });
  assert.match(preview.body, /I would love to discuss the opportunity/);
  assert.match(preview.body, /Role: Senior Software Engineer at Northstar Labs/);
  assert.match(preview.body, /Best regards,\nJordan Lee/);
  assert.doesNotMatch(preview.body, /Phone:|\{\{/);

  const slots = buildSlots({ profile: PROFILE, fields: FIELDS });
  const actual = buildReply('NEW_REQ', slots, { NEW_REQ: choice });
  assert.match(actual.body, /Role: Sr\. Cloud Security Engineer at Charles Schwab/);
  assert.match(actual.body, /Best regards,\nJustin Williams/);
  assert.doesNotMatch(actual.body, /Northstar Labs|Jordan Lee/);
});

test('guided right-to-represent reply does not duplicate a written greeting or rate sentence', () => {
  const reply = sampleReply('RTR_REQUEST', {
    RTR_REQUEST: {
      kind: 'guided', message: 'Hello, I agree to the right to represent and confirm the rate.',
      signoff: 'Thanks,', facts: { role: true, rate: true, profile: true }
    }
  });
  assert.equal(reply.ok, true);
  assert.match(reply.body, /^Hello, I agree to the right to represent and confirm the rate\./);
  assert.doesNotMatch(reply.body, /Hi Morgan|I confirm the rate of/);
  assert.match(reply.body, /Rate: \$90\/hr/);
  assert.match(reply.body, /Phone: \(555\) 010-1234/);
  assert.doesNotMatch(reply.body, /Work authorization:|Availability:/);
});

test('guided onboarding replies keep the protected data notice', () => {
  const reply = sampleReply('ONBOARDING_INFO', {
    ONBOARDING_INFO: { kind: 'guided', message: 'Here is what I can share.', signoff: 'Thank you,', facts: { onboarding: false, rate: false, role: false } }
  });
  assert.match(reply.body, /Here is what I can share/);
  assert.match(reply.body, /I do not send full SSN, ID scans, or banking details/);
});
