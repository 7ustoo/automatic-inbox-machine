import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceMessageUrl } from '../message-link.mjs';

const accounts = [
  { id: 'personal', email: 'person+jobs@gmail.com', transport: 'gmail' },
  { id: 'work', email: 'person@example.com', transport: 'imap' }
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

test('generic IMAP and malformed identifiers never get a misleading link', () => {
  assert.equal(sourceMessageUrl({ accountId: 'work', threadId: '<mail@example.com>' }, accounts), '');
  assert.equal(sourceMessageUrl({ accountId: 'personal', threadId: 'bad/id' }, accounts), '');
  assert.equal(sourceMessageUrl({ accountId: 'missing', threadId: '123' }, accounts), '');
});
