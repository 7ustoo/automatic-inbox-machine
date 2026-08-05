import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agencyFromDomain, emailDomain, htmlToText, isPublicMailDomain, jdSimilarity,
  normalizeCompany, normalizeTitle, shortHash, stripQuoted, titleSimilarity, trigramSimilarity
} from '../normalize.mjs';

test('titles normalize past recruiter decoration', () => {
  assert.equal(normalizeTitle('URGENT :: Sr. Java Developer (Remote) - W2 Only - 10+ yrs'), 'senior java developer');
  assert.equal(normalizeTitle('Re: Senior Java Developer'), 'senior java developer');
  assert.equal(normalizeTitle('Jr Cloud Engineer - Immediate Need'), 'junior cloud engineer');
});

test('company names drop legal and filler suffixes', () => {
  assert.equal(normalizeCompany('Deloitte Consulting LLP'), 'deloitte');
  assert.equal(normalizeCompany('Charles Schwab & Co., Inc.'), 'charles schwab');
  assert.equal(normalizeCompany('Charles Schwab'), normalizeCompany('Charles Schwab & Co., Inc.'),
    'the long legal name and the short name must collapse together — this is the double-submission case');
  assert.equal(normalizeCompany('Nexus IT Solutions Pvt Ltd'), 'nexus it');
});

test('similar titles score high, unrelated ones score low', () => {
  assert.ok(titleSimilarity('Sr. Cloud Security Engineer', 'Senior Cloud Security Engineer') > 0.9);
  assert.ok(titleSimilarity('Cloud Security Engineer', 'Forklift Operator') < 0.2);
});

test('identical titles are exactly 1', () => {
  assert.equal(titleSimilarity('Data Engineer', 'data engineer'), 1);
});

test('trigram similarity tolerates typos', () => {
  assert.ok(trigramSimilarity('kubernetes administrator', 'kubernets administrator') > 0.7);
});

test('jd similarity uses containment so padded JDs still match', () => {
  const base = 'design and implement cloud security controls across aws and azure and lead incident response';
  const padded = `about our client: a fortune 500 firm. ${base}. benefits include medical dental vision and a 401k match.`;
  assert.ok(jdSimilarity(base, padded) > 0.7);
  assert.ok(jdSimilarity(base, 'we are hiring a pastry chef for a downtown bakery') < 0.15);
});

test('short bodies still compare rather than scoring zero against everything', () => {
  assert.ok(jdSimilarity('remote java developer', 'remote java developer') > 0.9);
});

test('quoted replies are stripped at the fold', () => {
  const stripped = stripQuoted(`Sounds good, I will let you know.

Lisa

On Tue, Aug 4, 2026 at 9:14 AM Justin <me@example.com> wrote:
> Can you schedule an interview?`);
  assert.match(stripped, /Sounds good/);
  assert.doesNotMatch(stripped, /schedule an interview/);
});

test('confidentiality boilerplate is cut', () => {
  const stripped = stripQuoted(`Here is the requirement for the remote engineer role, please review it.

CONFIDENTIALITY NOTICE: This email may contain privileged information.`);
  assert.match(stripped, /requirement/);
  assert.doesNotMatch(stripped, /privileged/);
});

test('a short body without a fold is untouched', () => {
  assert.equal(stripQuoted('Are you available Tuesday?'), 'Are you available Tuesday?');
});

test('html mail converts to readable text', () => {
  const text = htmlToText('<div><style>.x{}</style><p>Job Title: <b>Engineer</b></p><ul><li>AWS</li></ul><br>Rate: $80&nbsp;/hr</div>');
  assert.match(text, /Job Title: Engineer/);
  assert.match(text, /- AWS/);
  assert.match(text, /\$80 \/hr/);
  assert.doesNotMatch(text, /\.x\{\}/);
});

test('domains and agency names come off addresses', () => {
  assert.equal(emailDomain('Raj <raj@apextalentgroup.com>'), 'apextalentgroup.com');
  assert.equal(agencyFromDomain('raj@apextalentgroup.com'), 'apextalentgroup');
  assert.equal(agencyFromDomain('someone@gmail.com'), '', 'public mail hosts are not agencies');
  assert.equal(isPublicMailDomain('gmail.com'), true);
});

test('hashes are stable and differ between inputs', () => {
  assert.equal(shortHash('abc'), shortHash('abc'));
  assert.notEqual(shortHash('abc'), shortHash('abd'));
  assert.match(shortHash('abc'), /^[0-9a-f]{8}$/);
});
