import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWorkMode, extractEmploymentType, extractFields, extractLabelled, extractRate } from '../extract.mjs';
import * as fixtures from './fixtures.mjs';

test('labelled lines are extracted', () => {
  const found = extractLabelled(fixtures.NEW_REQ_REMOTE.body);
  assert.equal(found.title, 'Sr. Cloud Security Engineer');
  assert.equal(found.client, 'Charles Schwab');
  assert.equal(found.location, '100% Remote (USA)');
  assert.equal(found.duration, '12+ months contract');
});

test('hourly rates parse with their unit', () => {
  assert.deepEqual(extractRate('Rate: $75/hr on W2'), { kind: 'hourly', min: 75, max: 75, raw: '$75/hr' });
  const range = extractRate('rate is 70-80 per hour');
  assert.equal(range.kind, 'hourly');
  assert.equal(range.min, 70);
  assert.equal(range.max, 80);
  assert.equal(range.raw, '$70-$80/hr');
});

test('raw is a canonical form, not the surrounding sentence', () => {
  // The old parser leaked trailing context into raw, so "$75/hr on W2" ended up
  // rendered verbatim in reply drafts and Telegram cards.
  assert.equal(extractRate('max bill rate of $78/hr on C2C but flexible').raw, '$78/hr');
});

test('annual salaries are distinguished from hourly rates', () => {
  const salary = extractRate('base salary of $145,000 per year');
  assert.equal(salary.kind, 'annual');
  assert.equal(salary.min, 145000);

  const shorthand = extractRate('130k-150k salary');
  assert.equal(shorthand.kind, 'annual');
  assert.equal(shorthand.min, 130000);
  assert.equal(shorthand.max, 150000);
});

test('years of experience is not mistaken for a rate', () => {
  assert.equal(extractRate('looking for 10+ years of experience in AWS'), null);
  assert.equal(extractRate('this is a 12 month contract'), null);
});

test('work mode prefers the most restrictive signal', () => {
  assert.equal(detectWorkMode('100% Remote (USA)'), 'remote');
  assert.equal(detectWorkMode('Remote, hybrid 3 days a week in office'), 'hybrid');
  assert.equal(detectWorkMode('Dallas, TX - onsite 5 days, local candidates only'), 'onsite');
  assert.equal(detectWorkMode('Location: Austin, TX'), 'unknown');
});

test('employment types are collected', () => {
  assert.deepEqual(extractEmploymentType('W2 only, no C2C').sort(), ['C2C', 'W2']);
  assert.ok(extractEmploymentType('contract to hire role').includes('C2H'));
});

test('full extraction on a real requirement', () => {
  const fields = extractFields({
    subject: fixtures.NEW_REQ_REMOTE.subject,
    body: fixtures.NEW_REQ_REMOTE.body,
    from: fixtures.NEW_REQ_REMOTE.from,
    fromName: fixtures.NEW_REQ_REMOTE.fromName
  });

  assert.equal(fields.client, 'Charles Schwab');
  assert.equal(fields.workMode, 'remote');
  assert.equal(fields.rate.kind, 'hourly');
  assert.equal(fields.rate.min, 75);
  assert.equal(fields.recruiterName, 'Sandeep Reddy');
  assert.equal(fields.recruiterDomain, 'nexusitsolutions.com');
  assert.equal(fields.agency, 'nexusitsolutions');
  assert.ok(fields.employmentType.includes('W2'));
});

test('recruiter name survives a title suffix in the From header', () => {
  const fields = extractFields({
    subject: fixtures.INTERVIEW_REQUEST.subject,
    body: fixtures.INTERVIEW_REQUEST.body,
    from: fixtures.INTERVIEW_REQUEST.from,
    fromName: fixtures.INTERVIEW_REQUEST.fromName
  });
  assert.equal(fields.recruiterName, 'Priya Nair');
  assert.equal(fields.recruiterPhone, '(469) 555-0182');
});

test('a decorated subject line still yields a usable title', () => {
  const fields = extractFields({ subject: 'URGENT :: Sr. Java Developer (Remote) - W2 Only - 10+ yrs', body: '', from: 'x@y.com' });
  assert.match(fields.title, /Java Developer/i);
});

test('an onsite low-rate req extracts both disqualifiers', () => {
  const fields = extractFields({
    subject: fixtures.NEW_REQ_ONSITE_LOWRATE.subject,
    body: fixtures.NEW_REQ_ONSITE_LOWRATE.body,
    from: fixtures.NEW_REQ_ONSITE_LOWRATE.from,
    fromName: fixtures.NEW_REQ_ONSITE_LOWRATE.fromName
  });
  assert.equal(fields.workMode, 'onsite');
  assert.equal(fields.rate.min, 45);
});
