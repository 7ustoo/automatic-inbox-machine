import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { append, readAll, rewrite } from '../ledger.mjs';
import { withDefaults } from '../config-rw.mjs';
import { scanStatus, startScan } from '../scan-now.mjs';
import { JOB_BOARD_ALERT } from './fixtures.mjs';

const accountId = '__test_scan_now';
const now = new Date().toISOString();

function raw(fixture, id) {
  return { accountId, accountEmail: `${accountId}@example.com`, providerId: String(id),
    threadId: `thread-${id}`, messageKey: `${accountId}:message-${id}`,
    rfcMessageId: `<message-${id}@example.com>`, from: fixture.from,
    fromName: fixture.fromName, to: `${accountId}@example.com`,
    subject: fixture.subject, textBody: fixture.body, htmlBody: '',
    receivedAt: now, date: now, snippet: fixture.body.slice(0, 120) };
}

async function finished() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!scanStatus().running) return scanStatus();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('scan did not finish');
}

after(() => {
  for (const ledger of ['messages', 'reqs', 'submissions', 'outbound', 'events']) {
    rewrite(ledger, (row) => row.accountId !== accountId);
  }
});

test('seven-day scan reopens alerts-only opportunities once and never sends or creates tags', async () => {
  const scanRole = { from: 'recruiter@scan-fixture.example', fromName: 'Scan Recruiter',
    subject: 'Remote archival systems analyst contract at Arbor Test Labs',
    body: 'Hello, I have an open role for an archival systems analyst at Arbor Test Labs. ' +
      'This remote contract designs retention schedules, audits document indexes, ' +
      'and validates record retrieval. Are you interested in discussing this specific position?' };
  const account = { id: accountId, label: 'Scan test inbox', email: `${accountId}@example.com`,
    transport: 'gmail', enabled: true };
  const cfg = withDefaults({ accounts: [account], profile: { fullName: 'Test Candidate' },
    policy: { interviewAlertsOnly: false, approvals: { enabled: true },
      autoSend: { enabled: true, categories: ['NEW_REQ'] },
      autoArchive: { enabled: true } } });
  const opportunity = raw(scanRole, 1);
  const alert = raw(JOB_BOARD_ALERT, 2);
  for (const [message, category] of [[opportunity, 'NEW_REQ'], [alert, 'JOB_ALERT']]) {
    append('messages', { accountId, providerId: message.providerId, messageKey: message.messageKey,
      receivedAt: now, category, action: 'ignore', blockedBy: 'interview alerts only' });
  }
  const calls = { sent: 0, archived: 0, labeled: 0 };
  const transportFactory = () => ({
    async connect() {}, async disconnect() {},
    async listRecentIds() { return ['1', '2']; },
    async getMessage(id) { return id === '1' ? opportunity : alert; },
    async sendReply() { calls.sent += 1; },
    async archive() { calls.archived += 1; },
    async applyLabel() { calls.labeled += 1; }
  });

  assert.equal(startScan(cfg, { transportFactory }).ok, true);
  const first = await finished();
  assert.equal(first.phase, 'complete');
  assert.equal(first.drafts, 1);
  assert.equal(first.jobAlerts, 1);
  assert.equal(readAll('outbound').filter((row) => row.accountId === accountId && row.status === 'pending').length, 1);
  assert.equal(readAll('messages').filter((row) => row.accountId === accountId).length, 2);
  assert.deepEqual(calls, { sent: 0, archived: 0, labeled: 0 });

  assert.equal(startScan(cfg, { transportFactory }).ok, true);
  const second = await finished();
  assert.equal(second.drafts, 0);
  assert.equal(readAll('outbound').filter((row) => row.accountId === accountId).length, 1);
});
