/**
 * Onboarding-data tiering.
 *
 * Date of birth and SSN last four are opt-in and auto-sendable once consented to.
 * Everything else in that family stays hard-blocked in every configuration. These
 * tests pin both halves — the permission and the refusal — because loosening
 * either one by accident is the expensive kind of regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, decide } from '../gate.mjs';
import { withDefaults, validate } from '../config-rw.mjs';
import { SSN_LAST4_DISCLAIMER, buildReply, buildSlots, classifySensitiveAsk } from '../templates.mjs';
import * as fixtures from './fixtures.mjs';

const NEW = { verdict: 'new', kind: null, score: 0, match: null, alreadySubmitted: false, sameAgency: false, reason: 'no prior match' };
const FIELDS = { workMode: 'remote', rate: { kind: 'hourly', min: 90, max: 90, raw: '$90/hr' }, title: 'Engineer' };

const PROFILE = {
  fullName: 'Test Candidate',
  phone: '(555) 010-2030',
  contactEmail: 'test@example.com',
  city: 'Atlanta',
  state: 'GA',
  workAuth: 'US Citizen',
  availability: '2 weeks',
  preferredRateHourly: 85
};

/** Onboarding values are injected so tests never read the developer's .env. */
function slotsFor({ dob = '', last4 = '', provideDateOfBirth = true, ssnLast4Acknowledged = false } = {}) {
  return buildSlots({
    profile: { ...PROFILE, provideDateOfBirth, ssnLast4Acknowledged },
    fields: { title: 'Cloud Engineer', client: 'Acme', recruiterName: 'Dana' },
    onboarding: { dateOfBirth: dob, ssnLast4: last4 }
  });
}

function config({ autoSendCategories = [], ...profileFlags } = {}) {
  return withDefaults({
    profile: { ...PROFILE, ...profileFlags },
    policy: {
      remoteOnly: true,
      minConfidence: 0.5,
      autoSend: { enabled: true, categories: autoSendCategories, maxPerHour: 12, maxPerThread: 2 }
    }
  });
}

/* ----- tiering ------------------------------------------------------------ */

test('date of birth is recognised as an opt-in ask, not a blocked one', () => {
  const result = classifySensitiveAsk('Please send your date of birth for the background check.');
  assert.deepEqual(result.allowed, ['dateOfBirth']);
  assert.equal(result.hasBlocked, false);
});

test('"last 4 of your SSN" is the narrow ask, not a full-SSN request', () => {
  for (const phrasing of [
    'Please provide the last 4 of your SSN',
    'we need the last four digits of your social security number',
    'SSN last 4?',
    'Last 4 SSN and DOB please'
  ]) {
    const result = classifySensitiveAsk(phrasing);
    assert.ok(result.allowed.includes('ssnLast4'), `not recognised: ${phrasing}`);
    assert.equal(result.hasBlocked, false, `wrongly blocked: ${phrasing}`);
  }
});

test('a full SSN request is still blocked', () => {
  const result = classifySensitiveAsk('Please reply with your full social security number for onboarding.');
  assert.ok(result.blocked.includes('fullSsn'));
  assert.equal(result.hasAllowed, false);
});

test('ID, passport and banking requests are blocked', () => {
  assert.ok(classifySensitiveAsk("send a copy of your driver's license").blocked.includes('driversLicense'));
  assert.ok(classifySensitiveAsk('we need your passport number').blocked.includes('passport'));
  assert.ok(classifySensitiveAsk('provide bank account and routing number').blocked.includes('bankDetails'));
  assert.ok(classifySensitiveAsk('a voided check for direct deposit').blocked.includes('bankDetails'));
  assert.ok(classifySensitiveAsk("mother's maiden name").blocked.includes('motherMaidenName'));
});

test('a mixed request is blocked by its worst element', () => {
  // The real fixture asks for last-4 + DOB + driver's licence. The two opt-in
  // items must not launder the licence request into something sendable.
  const result = classifySensitiveAsk(fixtures.SENSITIVE_ASK.body);
  assert.ok(result.hasAllowed, 'the opt-in items are still detected');
  assert.ok(result.blocked.includes('driversLicense'));
});

/* ----- slots -------------------------------------------------------------- */

test('date of birth fills when present and enabled', () => {
  assert.equal(slotsFor({ dob: '04/12' }).dateOfBirth, '04/12');
});

test('date of birth is withheld when the flag is off', () => {
  assert.equal(slotsFor({ dob: '04/12', provideDateOfBirth: false }).dateOfBirth, '');
});

test('SSN last four requires BOTH a value and acknowledgement', () => {
  assert.equal(slotsFor({ last4: '1234' }).ssnLast4, '', 'a value alone is not consent');
  assert.equal(slotsFor({ ssnLast4Acknowledged: true }).ssnLast4, '', 'consent alone has nothing to send');
  assert.equal(slotsFor({ last4: '1234', ssnLast4Acknowledged: true }).ssnLast4, '1234');
});

/* ----- template ----------------------------------------------------------- */

test('the onboarding reply includes only the fields that are available', () => {
  const reply = buildReply('ONBOARDING_INFO', slotsFor({ dob: '04/12', last4: '1234', ssnLast4Acknowledged: true }));
  assert.equal(reply.ok, true);
  assert.match(reply.body, /Date of birth: 04\/12/);
  assert.match(reply.body, /SSN \(last four\): 1234/);
  assert.match(reply.body, /I do not send full SSN, ID scans, or banking details/);
});

test('the onboarding reply omits withheld fields entirely, never blank labels', () => {
  const reply = buildReply('ONBOARDING_INFO', slotsFor({ dob: '04/12' }));
  assert.equal(reply.ok, true);
  assert.match(reply.body, /Date of birth: 04\/12/);
  assert.doesNotMatch(reply.body, /SSN \(last four\)/, 'a withheld field must not leave its label behind');
  // A dropped line must take its newline with it, or the list reads as broken.
  assert.match(reply.body, /Date of birth: 04\/12/, 'DOB remains present while the withheld SSN row disappears');
  assert.doesNotMatch(reply.body, /\n\n\n/);
});

test('withholding every optional field still renders a clean list', () => {
  const reply = buildReply('ONBOARDING_INFO', slotsFor({}));
  assert.equal(reply.ok, true);
  assert.match(reply.body, /Full name: Test Candidate/);
  assert.match(reply.body, /Location: Atlanta, GA/);
  assert.doesNotMatch(reply.body, /\{\{|\}\}/, 'no unresolved template syntax');
});

test('no other template can emit onboarding identifiers', () => {
  const slots = slotsFor({ dob: '04/12', last4: '1234', ssnLast4Acknowledged: true, });
  slots.duplicateSummary = 'already submitted by X on Jul 1';
  for (const name of ['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM', 'DUPLICATE', 'DECLINE_ONSITE', 'DECLINE_RATE']) {
    const reply = buildReply(name, slots);
    if (!reply.ok) continue;
    assert.doesNotMatch(reply.body, /1234|04\/12/, `${name} leaked onboarding data`);
  }
});

/* ----- gate --------------------------------------------------------------- */

const askMessage = (body) => ({ from: 'r@agency.com', subject: 'Onboarding details needed', body });

test('an answerable onboarding ask routes to the onboarding template', () => {
  const result = decide({
    category: 'RATE_CONFIRM',
    confidence: 0.95,
    fields: FIELDS,
    message: askMessage('Please send your date of birth and the last 4 of your SSN.'),
    duplicate: NEW,
    config: config({ ssnLast4Acknowledged: true }),
    slots: slotsFor({ dob: '04/12', last4: '1234', ssnLast4Acknowledged: true })
  });
  assert.equal(result.template, 'ONBOARDING_INFO');
});

test('onboarding replies do not inherit auto-send permission from the category', () => {
  const shared = {
    category: 'RATE_CONFIRM',
    confidence: 0.95,
    fields: FIELDS,
    message: askMessage('What is your rate, and the last 4 of your SSN?'),
    duplicate: NEW,
    slots: slotsFor({ dob: '04/12', last4: '1234', ssnLast4Acknowledged: true })
  };

  const inherited = decide({ ...shared, config: config({ autoSendCategories: ['RATE_CONFIRM'], ssnLast4Acknowledged: true }) });
  assert.equal(inherited.action, ACTIONS.APPROVE, 'RATE_CONFIRM permission must not authorise sending an SSN');
  assert.match(inherited.blockedBy, /ONBOARDING_INFO is not in policy\.autoSend\.categories/);

  const explicit = decide({ ...shared, config: config({ autoSendCategories: ['ONBOARDING_INFO'], ssnLast4Acknowledged: true }) });
  assert.equal(explicit.action, ACTIONS.AUTO_SEND, 'explicit allowlisting should work');
});

test('an ask for an unacknowledged SSN goes to approval with an actionable reason', () => {
  const result = decide({
    category: 'RATE_CONFIRM',
    confidence: 0.95,
    fields: FIELDS,
    message: askMessage('Please send the last 4 of your SSN.'),
    duplicate: NEW,
    config: config({ autoSendCategories: ['ONBOARDING_INFO'] }),
    slots: slotsFor({ last4: '1234' })
  });
  assert.equal(result.action, ACTIONS.APPROVE);
  assert.match(result.blockedBy, /not acknowledged/);
});

test('a blocked-tier ask is never auto-sent even with everything allowlisted', () => {
  const result = decide({
    category: 'RATE_CONFIRM',
    confidence: 0.99,
    fields: FIELDS,
    message: askMessage("Send your full SSN and a copy of your driver's license."),
    duplicate: NEW,
    config: config({ autoSendCategories: ['ONBOARDING_INFO', 'RATE_CONFIRM'], ssnLast4Acknowledged: true }),
    slots: slotsFor({ dob: '04/12', last4: '1234', ssnLast4Acknowledged: true })
  });
  assert.equal(result.action, ACTIONS.APPROVE);
  assert.match(result.blockedBy, /never auto-sent, in any configuration/);
});

/* ----- config validation -------------------------------------------------- */

test('a malformed AIM_SSN_LAST4 is a hard config error', () => {
  const original = process.env.AIM_SSN_LAST4;
  try {
    process.env.AIM_SSN_LAST4 = '123-45-6789';
    const result = validate(withDefaults({ accounts: [{ id: 'a', email: 'a@b.com', transport: 'gmail' }], profile: PROFILE }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /AIM_SSN_LAST4 is not exactly four digits/);
  } finally {
    if (original === undefined) delete process.env.AIM_SSN_LAST4;
    else process.env.AIM_SSN_LAST4 = original;
  }
});

test('acknowledgement without a value warns rather than failing', () => {
  const original = process.env.AIM_SSN_LAST4;
  try {
    delete process.env.AIM_SSN_LAST4;
    const result = validate(withDefaults({
      accounts: [{ id: 'a', email: 'a@b.com', transport: 'gmail' }],
      profile: { ...PROFILE, ssnLast4Acknowledged: true }
    }));
    assert.equal(result.ok, true);
    assert.match(result.warnings.join(' '), /nothing to send/);
  } finally {
    if (original !== undefined) process.env.AIM_SSN_LAST4 = original;
  }
});

test('acknowledgement ships off and the disclaimer states who carries the risk', () => {
  assert.equal(withDefaults({}).profile.ssnLast4Acknowledged, false);
  assert.equal(withDefaults({}).profile.provideDateOfBirth, true);
  assert.match(SSN_LAST4_DISCLAIMER, /risk in providing it is low/i);
  assert.match(SSN_LAST4_DISCLAIMER, /not responsible/i);
  assert.match(SSN_LAST4_DISCLAIMER, /full SSN is never stored/i);
});
