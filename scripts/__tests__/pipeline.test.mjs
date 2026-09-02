/**
 * End-to-end pipeline tests against a fake transport.
 *
 * These exercise the wiring the unit tests cannot: classify -> fingerprint ->
 * dedupe -> gate -> draft -> act -> record, including the ledger writes and the
 * cross-account duplicate detection that is the app's whole reason to exist.
 *
 * They use the real ledger (there is no injectable path) under a reserved
 * account id, and remove exactly their own rows afterwards so a test run leaves
 * no residue in a live install.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerIndex, pendingApprovals, readAll, rewrite } from '../ledger.mjs';
import { withDefaults } from '../config-rw.mjs';
import { processMessage } from '../pipeline.mjs';
import * as fixtures from './fixtures.mjs';
import { skipReply } from '../responder.mjs';

const TEST_ACCOUNTS = new Set(['__test_a', '__test_b']);

/** Records every call so tests can assert on side effects. */
function fakeTransport() {
  return {
    kind: 'fake',
    archived: [],
    sent: [],
    labeled: [],
    async connect() { return { ok: true }; },
    async archive(message, label) { this.archived.push({ key: message.messageKey, label }); return { archived: true }; },
    async applyLabel(message, label) { this.labeled.push(label); return { labeled: true }; },
    async markRead() {},
    async sendReply(payload) { this.sent.push(payload); return { ok: true, providerId: `fake-${this.sent.length}`, threadId: payload.threadId }; },
    async disconnect() {},
    async health() { return { ok: true }; }
  };
}

function account(id) {
  return { id, label: `Test ${id}`, email: `${id}@example.com`, transport: 'fake', enabled: true };
}

function rawFrom(fixture, { accountId, threadId, uid = 1 }) {
  return {
    accountId,
    accountEmail: `${accountId}@example.com`,
    providerId: String(uid),
    threadId,
    messageKey: `${accountId}:${threadId}-${uid}`,
    rfcMessageId: `<${threadId}-${uid}@example.com>`,
    references: '',
    inReplyTo: '',
    from: fixture.from,
    fromName: fixture.fromName,
    replyTo: '',
    to: `${accountId}@example.com`,
    cc: '',
    subject: fixture.subject,
    date: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    textBody: fixture.body,
    htmlBody: '',
    snippet: fixture.body.slice(0, 120),
    labelIds: ['INBOX'],
    listUnsubscribe: '',
    autoSubmitted: '',
    precedence: ''
  };
}

function config(overrides = {}) {
  return withDefaults({
    accounts: [account('__test_a'), account('__test_b')],
    profile: {
      fullName: 'Test Candidate',
      phone: '(555) 000-1111',
      contactEmail: 'test@example.com',
      city: 'Atlanta',
      state: 'GA',
      workAuth: 'US Citizen',
      availability: '2 weeks',
      preferredRateHourly: 85,
      employmentTypes: ['W2', 'C2C']
    },
    notify: { telegram: { enabled: false }, ntfy: { enabled: false }, webhook: { enabled: false }, digest: { enabled: false } },
    ...overrides
  });
}

async function run(fixture, { index, cfg, accountId = '__test_a', threadId = 'thread-1', uid = 1, transport = fakeTransport() } = {}) {
  const result = await processMessage({
    raw: rawFrom(fixture, { accountId, threadId, uid }),
    transport,
    config: cfg,
    index,
    account: account(accountId),
    ammCorpus: []
  });
  return { result, transport };
}

/* -------------------------------------------------------------------------- */

test('a rejection is archived and never answered', async () => {
  const { result, transport } = await run(fixtures.REJECTION_AFTER_INTERVIEW, {
    index: LedgerIndex.load(),
    cfg: config(),
    threadId: 'rej-1'
  });

  assert.equal(result.category, 'REJECTION');
  assert.equal(result.action, 'archive');
  assert.equal(result.archived, true);
  assert.equal(transport.archived.length, 1);
  assert.equal(transport.archived[0].label, 'AIM/Archived');
  assert.equal(transport.sent.length, 0);
});

test('an interview request alerts and sends nothing', async () => {
  const { result, transport } = await run(fixtures.INTERVIEW_REQUEST, {
    index: LedgerIndex.load(),
    cfg: config(),
    threadId: 'int-1'
  });

  assert.equal(result.category, 'INTERVIEW');
  assert.equal(result.action, 'alert');
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.archived.length, 0);
});

test('an iCIMS application receipt archives without creating a reply draft', async () => {
  const { result, transport } = await run(fixtures.ICIMS_ACK_DULUTH, {
    index: LedgerIndex.load(),
    cfg: config(),
    threadId: 'icims-ack-1'
  });

  assert.equal(result.category, 'ACK');
  assert.equal(result.action, 'archive');
  assert.equal(result.outboundId, null);
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.archived.length, 1);
});

test('today\'s false positives cannot create reply drafts end to end', async () => {
  const cases = [
    [fixtures.FUNCTION_HEALTH_RECEIPT, 'ACK', 'archive'],
    [fixtures.KENTRO_APPLICATION_CLOSED, 'REJECTION', 'archive'],
    [fixtures.GOVERNMENTJOBS_MARKETING, 'JOB_ALERT', 'archive'],
    [fixtures.CALENDLY_NON_INTERVIEW_REMINDER, 'RECRUITER_OTHER', 'alert']
  ];

  for (const [fixture, category, action] of cases) {
    const { result, transport } = await run(fixture, {
      index: LedgerIndex.load(),
      cfg: config(),
      threadId: `real-false-positive-${category.toLowerCase()}`
    });
    assert.equal(result.category, category);
    assert.equal(result.action, action);
    assert.equal(result.outboundId, null);
    assert.equal(transport.sent.length, 0);
  }
});

test('a clean remote req auto-sends and logs a submission when gates allow', async () => {
  const before = readAll('submissions').length;
  const cfg = config();
  cfg.policy.autoSend = { enabled: true, categories: ['NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM'], maxPerHour: 50, maxPerThread: 2 };
  cfg.policy.minConfidence = 0.5;

  const { result, transport } = await run(fixtures.NEW_REQ_REMOTE, {
    index: LedgerIndex.load(),
    cfg,
    threadId: 'req-auto'
  });

  assert.equal(result.category, 'NEW_REQ');
  assert.equal(result.action, 'auto_send');
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0].subject, /^Re: /);
  assert.match(transport.sent[0].body, /Test Candidate/);
  assert.equal(transport.sent[0].to, fixtures.NEW_REQ_REMOTE.from);
  assert.equal(readAll('submissions').length, before + 1, 'expressing interest must create a submission of record');
});

test('with auto-send off the same req becomes an approval with a draft', async () => {
  const { result } = await run(fixtures.NEW_REQ_REMOTE, {
    index: LedgerIndex.load(),
    cfg: config(),
    threadId: 'req-approve',
    uid: 2
  });

  assert.equal(result.action, 'approve');
  assert.ok(result.outboundId, 'an approval must be queued so nothing is silently dropped');

  const row = readAll('outbound').find((candidate) => candidate.id === result.outboundId);
  assert.equal(row.status, 'pending');
  assert.ok(row.body.includes('Test Candidate'));
  assert.ok(row.originalSummary, 'the queued approval should carry a readable email summary');
});

test('Skip durably removes a draft from the pending queue', async () => {
  const { result } = await run(fixtures.NEW_REQ_REMOTE, {
    index: LedgerIndex.load(),
    cfg: config(),
    threadId: 'req-skip',
    uid: 3
  });
  assert.ok(pendingApprovals().some((row) => row.id === result.outboundId));
  const skipped = skipReply(result.outboundId, 'test skip');
  assert.equal(skipped.status, 'skipped');
  assert.ok(!pendingApprovals().some((row) => row.id === result.outboundId));
});

test('the same req arriving at a second inbox is caught as a duplicate', async () => {
  const index = LedgerIndex.load();
  const cfg = config();

  await run(fixtures.NEW_REQ_REMOTE, { index, cfg, accountId: '__test_a', threadId: 'dup-a', uid: 10 });
  const second = await run(fixtures.DUPLICATE_REQ, { index, cfg, accountId: '__test_b', threadId: 'dup-b', uid: 11 });

  assert.equal(second.result.duplicate, 'duplicate');
  assert.equal(second.result.template, 'DUPLICATE');
  assert.equal(second.transport.sent.length, 0, 'duplicates are surfaced, not auto-answered');
});

test('an onsite low-rate req is archived by the location filter, not answered', async () => {
  const cfg = config();
  cfg.policy.rateFloorHourly = 70;

  const { result } = await run(fixtures.NEW_REQ_ONSITE_LOWRATE, {
    index: LedgerIndex.load(),
    cfg,
    threadId: 'onsite-1',
    uid: 20
  });

  assert.equal(result.template, null);
  assert.equal(result.action, 'archive');
  assert.equal(result.archived, true);
});

test('a request for identity documents is never auto-sent', async () => {
  const cfg = config();
  cfg.policy.autoSend = { enabled: true, categories: ['RATE_CONFIRM', 'NEW_REQ'], maxPerHour: 50, maxPerThread: 2 };
  cfg.policy.minConfidence = 0.4;

  const { result, transport } = await run(fixtures.SENSITIVE_ASK, {
    index: LedgerIndex.load(),
    cfg,
    threadId: 'sensitive-1',
    uid: 30
  });

  assert.equal(transport.sent.length, 0, 'nothing may go out in reply to an SSN/ID request');
  assert.equal(result.action, 'approve');
});

test('a job-board digest is archived, not treated as a requirement', async () => {
  const { result, transport } = await run(fixtures.JOB_BOARD_ALERT, {
    index: LedgerIndex.load(),
    cfg: config(),
    threadId: 'alert-1',
    uid: 40
  });

  assert.equal(result.category, 'JOB_ALERT');
  assert.equal(result.action, 'archive');
  assert.equal(transport.sent.length, 0);
});

test('a message is only processed once', async () => {
  const index = LedgerIndex.load();
  const cfg = config();

  const first = await run(fixtures.RATE_REQUEST, { index, cfg, threadId: 'once-1', uid: 50 });
  assert.equal(first.result.skipped, undefined);

  const second = await run(fixtures.RATE_REQUEST, { index, cfg, threadId: 'once-1', uid: 50 });
  assert.equal(second.result.skipped, 'already processed');
});

test('mail from your own address is skipped', async () => {
  const raw = rawFrom(fixtures.NEW_REQ_REMOTE, { accountId: '__test_a', threadId: 'self-1', uid: 60 });
  raw.from = '__test_a@example.com';

  const result = await processMessage({
    raw,
    transport: fakeTransport(),
    config: config(),
    index: LedgerIndex.load(),
    account: account('__test_a'),
    ammCorpus: []
  });
  assert.equal(result.skipped, 'from self');
});

test('paused stops archiving and sending but still alerts on interviews', async () => {
  const cfg = config({ paused: true });

  const rejection = await run(fixtures.REJECTION_AFTER_INTERVIEW, { index: LedgerIndex.load(), cfg, threadId: 'paused-1', uid: 70 });
  assert.equal(rejection.result.action, 'ignore');
  assert.equal(rejection.transport.archived.length, 0);

  const interview = await run(fixtures.INTERVIEW_REQUEST, { index: LedgerIndex.load(), cfg, threadId: 'paused-2', uid: 71 });
  assert.equal(interview.result.action, 'alert');
});

test('every processed message leaves exactly one explainable ledger row', async () => {
  const index = LedgerIndex.load();
  const cfg = config();
  await run(fixtures.RTR_REQUEST, { index, cfg, threadId: 'audit-1', uid: 80 });

  const row = readAll('messages').filter((candidate) => candidate.threadId === 'audit-1');
  assert.equal(row.length, 1);
  assert.equal(row[0].category, 'RTR_REQUEST');
  assert.ok(row[0].reason, 'a row must record why it was classified that way');
  assert.ok(Array.isArray(row[0].gateReasons) && row[0].gateReasons.length, 'a row must record why the action was chosen');
  assert.ok(row[0].confidence > 0);
});

/* -------------------------------------------------------------------------- */

after(() => {
  // Remove only this suite's rows, matched on the reserved account ids.
  const mine = (row) => TEST_ACCOUNTS.has(row.accountId);
  rewrite('messages', (row) => !mine(row));
  rewrite('reqs', (row) => !mine(row));
  rewrite('submissions', (row) => !mine(row));
  rewrite('outbound', (row) => !mine(row));
  rewrite('events', (row) => !mine(row) && !String(row.messageKey || '').startsWith('__test_'));
});
