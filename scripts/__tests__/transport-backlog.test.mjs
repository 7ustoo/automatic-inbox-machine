import test from 'node:test';
import assert from 'node:assert/strict';
import { GmailTransport } from '../transports/gmail.mjs';
import { ImapTransport } from '../transports/imap.mjs';
import { cursorFor, nextCursor } from '../transports/index.mjs';

test('IMAP keeps unread UIDs after a capped batch', async () => {
  const transport = new ImapTransport({ id: 'sample', email: 'sample@example.com' });
  transport.connect = async () => {};
  transport.client = {
    mailbox: { uidValidity: 7, uidNext: 36 },
    getMailboxLock: async () => ({ release() {} }),
    fetch: async function* ({ uid }) {
      const start = Number(uid.split(':')[0]);
      for (let number = start; number < 36; number++) yield { uid: number, size: 100 };
    }
  };
  const first = await transport.listNewIds({ uidNext: 1, uidValidity: '7', limit: 25 });
  assert.equal(first.ids.length, 25);
  assert.equal(first.uidNext, 26);
  assert.equal(first.hasMore, true);
  const second = await transport.listNewIds({ ...nextCursor('imap', first), limit: 25 });
  assert.equal(second.ids.length, 10);
  assert.equal(second.uidNext, 36);
  assert.equal(second.hasMore, false);
});

test('IMAP priority scan finds recent interview subjects without advancing the backlog cursor', async () => {
  const transport = new ImapTransport({ id: 'sample', email: 'sample@example.com' });
  transport.connect = async () => {};
  transport.client = {
    mailbox: { uidNext: 105 },
    getMailboxLock: async () => ({ release() {} }),
    fetch: async function* () {
      yield { uid: 101, size: 100, envelope: { subject: 'Security code for your application' } };
      yield { uid: 102, size: 200, envelope: { subject: 'Schedule your interview' } };
      yield { uid: 103, size: 300, envelope: { subject: 'Application received' } };
      yield { uid: 104, size: 400, envelope: { subject: 'Next steps: phone screen' } };
    }
  };
  assert.deepEqual(await transport.listPriorityIds({ lookback: 10 }), [
    { uid: 104, size: 400 }, { uid: 102, size: 200 }
  ]);
});

test('Gmail drains every ID and page before advancing history', async () => {
  const transport = new GmailTransport({ id: 'sample', email: 'sample@example.com' });
  const requests = [];
  transport.request = async (_path, { query }) => {
    requests.push(query);
    if (!query.pageToken) return {
      history: [{ messagesAdded: [1, 2, 3].map((id) => ({ message: { id: String(id), labelIds: ['INBOX'] } })) }],
      nextPageToken: 'page-2', historyId: '200'
    };
    return {
      history: [{ messagesAdded: [4, 5].map((id) => ({ message: { id: String(id), labelIds: ['INBOX'] } })) }],
      historyId: '200'
    };
  };
  let cursor = { historyId: '100' };
  const seen = [];
  for (let batch = 0; batch < 3; batch++) {
    const result = await transport.listNewIds({ ...cursorFor('gmail', cursor), limit: 2 });
    seen.push(...result.ids);
    cursor = nextCursor('gmail', result);
    if (batch < 2) assert.equal(cursor.historyId, '100');
  }
  assert.deepEqual(seen, ['1', '2', '3', '4', '5']);
  assert.equal(cursor.historyId, '200');
  assert.equal(cursor.pendingIds.length, 0);
  assert.equal(cursor.historyPageToken, '');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].pageToken, 'page-2');
});

test('Gmail first run queues a recent burst and anchors history before listing it', async () => {
  const transport = new GmailTransport({ id: 'sample', email: 'sample@example.com' });
  const order = [];
  transport.currentHistoryId = async () => { order.push('baseline'); return '500'; };
  transport.request = async (_path, { query }) => {
    order.push(query.pageToken || 'first-page');
    const start = query.pageToken ? 101 : 1;
    return {
      messages: Array.from({ length: 100 }, (_, index) => ({ id: String(start + index) })),
      nextPageToken: query.pageToken ? '' : 'second-page'
    };
  };
  const first = await transport.listNewIds({ limit: 25 });
  assert.deepEqual(order, ['baseline', 'first-page', 'second-page']);
  assert.equal(first.ids.length, 25);
  assert.equal(first.pendingIds.length, 175);
  assert.equal(first.historyId, '500');
  assert.equal(first.hasMore, true);
  const second = await transport.listNewIds({ ...nextCursor('gmail', first), limit: 25 });
  assert.equal(second.ids[0], '26');
  assert.equal(second.pendingIds.length, 150);
});

test('Gmail seven-day search pages through the inbox without using the watcher cursor', async () => {
  const transport = new GmailTransport({ id: 'sample', email: 'sample@example.com' });
  const queries = [];
  transport.request = async (path, { query }) => {
    assert.equal(path, '/messages');
    queries.push(query);
    return query.pageToken
      ? { messages: [{ id: 'third' }] }
      : { messages: [{ id: 'first' }, { id: 'second' }], nextPageToken: 'more' };
  };
  assert.deepEqual(await transport.listRecentIds({ since: '2026-11-04T16:00:00Z' }),
    ['first', 'second', 'third']);
  assert.match(queries[0].q, /in:inbox after:2026\/11\/03/);
  assert.equal(queries[1].pageToken, 'more');
});

test('archive never creates a Gmail label or IMAP folder', async () => {
  const gmail = new GmailTransport({ id: 'sample', email: 'sample@example.com' });
  const requests = [];
  gmail.request = async (path, options = {}) => {
    requests.push({ path, method: options.method });
    if (path === '/labels') return { labels: [] };
    return {};
  };
  assert.equal((await gmail.archive({ providerId: 'abc' }, 'AIM/Archived')).archived, true);
  assert.equal(requests.some((call) => call.path === '/labels' && call.method === 'POST'), false);

  const imap = new ImapTransport({ id: 'sample', email: 'sample@example.com' });
  imap.connect = async () => {};
  imap.client = { mailboxCreate() { throw new Error('must not create a folder'); } };
  assert.deepEqual(await imap.archive({ uid: 1 }, 'AIM/Archived'),
    { archived: false, reason: 'no existing archive mailbox' });
});

test('IMAP seven-day search handles an empty result', async () => {
  const imap = new ImapTransport({ id: 'sample', email: 'sample@example.com' });
  imap.connect = async () => {};
  imap.client = { getMailboxLock: async () => ({ release() {} }), search: async () => false };
  assert.deepEqual(await imap.listRecentIds({ since: '2026-11-04T16:00:00Z' }), []);
});
