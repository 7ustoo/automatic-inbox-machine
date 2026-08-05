import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReqRecord, checkDuplicate, describeMatch, jdSketch, reqFingerprint, sketchSimilarity } from '../dedupe.mjs';
import { extractFields } from '../extract.mjs';
import { prepareMessage } from '../classify.mjs';
import * as fixtures from './fixtures.mjs';

const OPTIONS = { titleSimilarity: 0.82, jdSimilarity: 0.7, sameClientWindowDays: 45 };

function recordFor(fixture, { accountId = 'primary', threadId = fixture.subject } = {}) {
  const prepared = prepareMessage({ textBody: fixture.body });
  const fields = extractFields({ subject: fixture.subject, body: prepared.body, from: fixture.from, fromName: fixture.fromName });
  return buildReqRecord({
    fields,
    message: {
      ...fixture,
      body: prepared.body,
      accountId,
      threadId,
      messageKey: `${accountId}:${threadId}`
    },
    category: 'NEW_REQ'
  });
}

test('fingerprints ignore title decoration and company suffixes', () => {
  const a = reqFingerprint({ title: 'Sr. Java Developer (Remote) - W2 Only', client: 'Deloitte Consulting LLP' });
  const b = reqFingerprint({ title: 'Senior Java Developer', client: 'Deloitte' });
  assert.equal(a, b, 'normalized title + client should collapse to one fingerprint');
});

test('a fresh req against an empty ledger is new', () => {
  const incoming = recordFor(fixtures.NEW_REQ_REMOTE);
  const result = checkDuplicate(incoming, { reqs: [], submissions: [] }, OPTIONS);
  assert.equal(result.verdict, 'new');
});

test('the same role from a second agency on a different inbox is a duplicate', () => {
  const first = recordFor(fixtures.NEW_REQ_REMOTE, { accountId: 'primary', threadId: 't1' });
  const second = recordFor(fixtures.DUPLICATE_REQ, { accountId: 'secondary', threadId: 't2' });

  const result = checkDuplicate(second, { reqs: [first], submissions: [] }, OPTIONS);
  assert.equal(result.verdict, 'duplicate');
  assert.ok(['fingerprint', 'title+client', 'jd'].includes(result.kind), `unexpected kind ${result.kind}`);
  assert.equal(result.sameAgency, false, 'two different agencies must not read as the same party');
});

test('cross-account detection is the point — same inbox is not required', () => {
  const first = recordFor(fixtures.NEW_REQ_REMOTE, { accountId: 'work', threadId: 'a' });
  const second = recordFor(fixtures.DUPLICATE_REQ, { accountId: 'personal', threadId: 'b' });
  const result = checkDuplicate(second, { reqs: [first], submissions: [] }, OPTIONS);
  assert.equal(result.verdict, 'duplicate');
});

test('an already-submitted role reports alreadySubmitted', () => {
  const incoming = recordFor(fixtures.DUPLICATE_REQ);
  const submission = {
    titleNorm: 'senior cloud security engineer',
    clientNorm: 'charles schwab',
    titleRaw: 'Senior Cloud Security Engineer',
    clientRaw: 'Charles Schwab',
    agencyRaw: 'Nexus IT Solutions',
    agencyNorm: 'nexus it',
    submittedAt: new Date(Date.now() - 3 * 86400000).toISOString()
  };
  const result = checkDuplicate(incoming, { reqs: [], submissions: [submission] }, OPTIONS);
  assert.equal(result.verdict, 'duplicate');
  assert.equal(result.alreadySubmitted, true);
  assert.match(describeMatch(result), /already submitted/i);
});

test('a different role at the same client is a client collision, not a duplicate', () => {
  const incoming = recordFor(fixtures.NEW_REQ_REMOTE);
  const priorAtSameClient = {
    titleNorm: 'database administrator',
    titleRaw: 'Database Administrator',
    clientNorm: incoming.clientNorm,
    clientRaw: 'Charles Schwab',
    agencyRaw: 'Some Other Agency',
    agencyNorm: 'some other',
    submittedAt: new Date(Date.now() - 5 * 86400000).toISOString()
  };
  const result = checkDuplicate(incoming, { reqs: [], submissions: [priorAtSameClient] }, OPTIONS);
  assert.equal(result.verdict, 'client_collision');
});

test('an old client collision falls outside the window', () => {
  const incoming = recordFor(fixtures.NEW_REQ_REMOTE);
  const stale = {
    titleNorm: 'database administrator',
    clientNorm: incoming.clientNorm,
    clientRaw: 'Charles Schwab',
    submittedAt: new Date(Date.now() - 200 * 86400000).toISOString()
  };
  const result = checkDuplicate(incoming, { reqs: [], submissions: [stale] }, OPTIONS);
  assert.equal(result.verdict, 'new');
});

test('a message never matches itself', () => {
  const record = recordFor(fixtures.NEW_REQ_REMOTE);
  const result = checkDuplicate(record, { reqs: [record], submissions: [] }, OPTIONS);
  assert.equal(result.verdict, 'new');
});

test('unrelated roles at unrelated clients do not collide', () => {
  const a = recordFor(fixtures.NEW_REQ_REMOTE, { threadId: 'a' });
  const b = recordFor(fixtures.NEW_REQ_ONSITE_LOWRATE, { threadId: 'b' });
  const result = checkDuplicate(b, { reqs: [a], submissions: [] }, OPTIONS);
  assert.equal(result.verdict, 'new');
});

test('jd sketches estimate overlap and survive added boilerplate', () => {
  const base = 'design and implement cloud security controls across aws and azure lead incident response for cloud workloads';
  const padded = `our client is a fortune 500 leader ${base} we offer competitive benefits and a collaborative culture`;
  const similarity = sketchSimilarity(jdSketch(base), jdSketch(padded));
  assert.ok(similarity > 0.6, `expected containment-style overlap, got ${similarity}`);

  const unrelated = sketchSimilarity(jdSketch(base), jdSketch('we need a warehouse forklift operator for night shifts in ohio'));
  assert.ok(unrelated < 0.2, `unrelated text should not overlap, got ${unrelated}`);
});
