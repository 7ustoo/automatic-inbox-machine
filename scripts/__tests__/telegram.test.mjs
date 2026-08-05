import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MESSAGE_CHARS, chunk, escapeHtml } from '../telegram-api.mjs';
import { approvalKeyboard, digestCard, icon, interviewAlert, labelFor, toPlain } from '../notify/format.mjs';
import { loadEnv } from '../env.mjs';
import { maskChatId, maskEmail, resetSecretCache, scrub } from '../log.mjs';

/**
 * The scrubbing assertions below check PATTERN-based redaction, so the
 * VALUE-based pass must be inert while they run.
 *
 * Two hazards, both real:
 *
 * 1. A developer with a real .env has credentials in process.env, and scrub()
 *    replaces those by value first. One once shared a substring with a fixture
 *    here, so it came back <REDACTED> instead of <API_KEY>.
 *
 * 2. `node --test` runs test files in PARALLEL, in separate processes that share
 *    one filesystem. setup.test.mjs writes a real .env while it runs, so this
 *    process could read credentials that exist for only a few milliseconds.
 *
 * Hence loadEnv() FIRST: it marks the env as loaded so nothing re-reads the file
 * later, and only then is deleting the variables effective. Deleting before the
 * first load silently did nothing, because the next scrub() triggered a fresh read.
 */
const SECRET_KEYS = [
  'TG_TOKEN', 'ANTHROPIC_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'NTFY_TOPIC', 'WEBHOOK_URL', 'AIM_SSN_LAST4', 'AIM_DATE_OF_BIRTH'
];
const saved = new Map();

before(() => {
  loadEnv();
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_KEYS.includes(key) || /^(?:IMAP|SMTP)_PASSWORD_/.test(key)) {
      saved.set(key, value);
      delete process.env[key];
    }
  }
  resetSecretCache();
});

after(() => {
  for (const [key, value] of saved) process.env[key] = value;
  resetSecretCache();
});

test('HTML is escaped so a hostile subject cannot break the message', () => {
  assert.equal(escapeHtml('<b>Sr. Dev</b> & "friends"'), '&lt;b&gt;Sr. Dev&lt;/b&gt; &amp; "friends"');
});

test('short text is a single chunk', () => {
  assert.deepEqual(chunk('hello'), ['hello']);
});

test('long text splits on blank lines and respects the cap', () => {
  const block = 'x'.repeat(1200);
  const parts = chunk([block, block, block, block].join('\n\n'));
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= MAX_MESSAGE_CHARS, `chunk of ${part.length} exceeds cap`);
});

test('a single oversized block is hard-wrapped rather than dropped', () => {
  const parts = chunk('y'.repeat(MAX_MESSAGE_CHARS * 2 + 50));
  assert.ok(parts.length >= 3);
  assert.equal(parts.join('').length, MAX_MESSAGE_CHARS * 2 + 50);
});

test('interview alerts state that nothing was auto-replied', () => {
  const html = interviewAlert({
    message: { from: 'p@agency.com', fromName: 'Priya', subject: 'Interview', snippet: 'availability?' },
    fields: { title: 'Sr. Java Developer', client: 'Deloitte', recruiterName: 'Priya', workMode: 'remote' },
    accountLabel: 'Main'
  });
  assert.match(html, /INTERVIEW REQUEST/);
  assert.match(html, /Not auto-replied/);
  assert.match(html, /Deloitte/);
});

test('the digest reports quiet days without pretending there is work', () => {
  const html = digestCard({
    stats: { processed: 0, archived: 0, sent: 0, pending: 0, byCategory: {} },
    pending: 0,
    interviews: []
  });
  assert.match(html, /Nothing waiting on you/);
});

test('approval keyboards drop Send when there is no draft', () => {
  const withDraft = approvalKeyboard('abc', { hasDraft: true }).flat().map((button) => button.callback_data);
  assert.ok(withDraft.includes('snd:abc'));
  assert.ok(withDraft.includes('edt:abc'));

  const withoutDraft = approvalKeyboard('abc', { hasDraft: false }).flat().map((button) => button.callback_data);
  assert.ok(!withoutDraft.includes('snd:abc'), 'must not offer Send with nothing to send');
  assert.ok(withoutDraft.includes('skp:abc'));
});

test('callback payloads stay inside Telegram 64-byte limit', () => {
  const long = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  for (const button of approvalKeyboard(long, { hasDraft: true }).flat()) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64, `${button.callback_data} is too long`);
  }
});

test('toPlain strips markup for text-only channels', () => {
  assert.equal(toPlain('<b>Hi</b><br>there &amp; you'), 'Hi\nthere & you');
});

test('every category has an icon and a human label', () => {
  for (const category of ['INTERVIEW', 'NEW_REQ', 'RTR_REQUEST', 'RATE_CONFIRM', 'REJECTION', 'ACK', 'JOB_ALERT']) {
    assert.ok(icon(category));
    assert.notEqual(labelFor(category), undefined);
  }
});

test('bot tokens are scrubbed from anything logged', () => {
  const line = scrub('failed POST https://api.telegram.org/bot8412345678:AAH9zQxPl0kV3nR7yTuWbEcDfGhIjKlMnOp/sendMessage');
  assert.doesNotMatch(line, /AAH9zQ/);
  assert.match(line, /<TG_TOKEN>/);
});

test('api keys and oauth tokens are scrubbed', () => {
  assert.match(scrub('key sk-ant-api03-abcdefghijklmnop1234'), /<API_KEY>/);
  assert.match(scrub('bearer ya29.a0ARrdaM-longtokenvaluehere12345'), /<OAUTH_TOKEN>/);
  assert.match(scrub('refresh 1//0gLongRefreshTokenValue12345'), /<REFRESH_TOKEN>/);
});

test('gmail app passwords are scrubbed', () => {
  assert.match(scrub('IMAP_PASSWORD_PRIMARY=abcd efgh ijkl mnop'), /<APP_PASSWORD>/);
});

test('errors and objects survive scrubbing without throwing', () => {
  assert.match(scrub(new Error('boom')), /boom/);
  assert.match(scrub({ a: 1 }), /"a":1/);
  assert.equal(scrub(null), '');

  const circular = { name: 'loop' };
  circular.self = circular;
  assert.ok(scrub(circular).length > 0, 'a circular object must not throw');
});

test('identifiers are masked, not printed', () => {
  assert.equal(maskChatId('123456789'), '***6789');
  assert.equal(maskChatId('12'), '***');
  assert.equal(maskEmail('justin@example.com'), 'j***@example.com');
  assert.equal(maskEmail(''), '');
});
