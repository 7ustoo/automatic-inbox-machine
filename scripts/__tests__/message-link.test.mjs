import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceMessageUrl } from '../message-link.mjs';

const accounts = [
  { id: 'personal', email: 'person+jobs@gmail.com', transport: 'gmail' },
  { id: 'work', email: 'person@example.com', transport: 'imap' },
  { id: 'gmail-imap', email: 'jobs@gmail.com', transport: 'imap', imap: { host: 'imap.gmail.com' } }
];

test('Gmail source links open the exact thread in the correct signed-in account', () => {
  assert.equal(
    sourceMessageUrl({ accountId: 'personal', threadId: '19c123abc456def0' }, accounts),
    'https://mail.google.com/mail/u/?authuser=person%2Bjobs%40gmail.com#all/19c123abc456def0'
  );
});

test('Gmail source links fall back to the provider message id', () => {
  assert.match(sourceMessageUrl({ accountId: 'personal', providerId: '18b456' }, accounts), /#all\/18b456$/);
});

test('Gmail IMAP links use its decimal thread ID to open the exact conversation', () => {
  assert.equal(
    sourceMessageUrl({ accountId: 'gmail-imap', gmailThreadId: '1857733088378590000', rfcMessageId: '<mail@example.com>' }, accounts),
    `https://mail.google.com/mail/u/?authuser=jobs%40gmail.com#all/${BigInt('1857733088378590000').toString(16)}`
  );
});

test('older Gmail IMAP messages link to an exact Message-ID search', () => {
  assert.equal(
    sourceMessageUrl({ accountId: 'gmail-imap', threadId: '<request+2026@example.com>' }, accounts),
    'https://mail.google.com/mail/u/?authuser=jobs%40gmail.com#search/rfc822msgid%3Arequest%2B2026%40example.com'
  );
});

test('messages saved before switching a Gmail account to IMAP keep their direct links', () => {
  assert.equal(
    sourceMessageUrl({ accountId: 'gmail-imap', threadId: '19c123abc456def0' }, accounts),
    'https://mail.google.com/mail/u/?authuser=jobs%40gmail.com#all/19c123abc456def0'
  );
});

test('generic IMAP and malformed identifiers never get a misleading link', () => {
  assert.equal(sourceMessageUrl({ accountId: 'work', threadId: '<mail@example.com>' }, accounts), '');
  assert.equal(sourceMessageUrl({ accountId: 'personal', threadId: 'bad/id' }, accounts), '');
  assert.equal(sourceMessageUrl({ accountId: 'gmail-imap', threadId: '12345' }, accounts), '');
  assert.equal(sourceMessageUrl({ accountId: 'missing', threadId: '123' }, accounts), '');
});
