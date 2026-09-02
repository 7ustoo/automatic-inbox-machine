/**
 * First-run setup: host guessing, secret writing, and error translation.
 *
 * These exist because setup is the part every user touches and the part where a
 * bug is invisible to a developer who already has a working config.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { ENV_PATH } from '../os-paths.mjs';
import { accountIdFor, emailDomainOf, guessMailHosts } from '../mail-hosts.mjs';
import { friendlyError, friendlyErrorLine } from '../friendly-errors.mjs';
import { envKeyFor, removeSecret, secretsPresent, setSecret, writableFields } from '../env-writer.mjs';

const BACKUP = `${ENV_PATH}.setup-test-backup`;

/**
 * Values used here are distinct from those in other test files, and are deleted
 * from process.env afterwards.
 *
 * Both matter: these tests write into the real environment, and log.mjs scrubs by
 * *value* as well as by pattern. A token left behind here made the scrubbing
 * assertions in telegram.test.mjs see value-based redaction instead of
 * pattern-based — two tests failing for a reason that had nothing to do with
 * either of them.
 */
const TOUCHED = [
  'TG_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'NTFY_TOPIC', 'AIM_SSN_LAST4',
  'IMAP_PASSWORD_PRIMARY', 'IMAP_PASSWORD_ALPHA', 'IMAP_PASSWORD_GHOST'
];

const TEST_TOKEN = '9911223344:ZZq7WsXeDcRfVtGbYhNuJmKiLoPpQaZ';

before(() => {
  if (existsSync(ENV_PATH)) renameSync(ENV_PATH, BACKUP);
});

after(() => {
  rmSync(ENV_PATH, { force: true });
  for (const key of TOUCHED) delete process.env[key];
  if (existsSync(BACKUP)) renameSync(BACKUP, ENV_PATH);
});

/* ----- host guessing ------------------------------------------------------ */

test('known providers resolve to real hostnames', () => {
  const gmail = guessMailHosts('someone@gmail.com');
  assert.equal(gmail.provider, 'Gmail');
  assert.equal(gmail.imap.host, 'imap.gmail.com');
  assert.equal(gmail.smtp.host, 'smtp.gmail.com');
  assert.equal(gmail.supportsGmailApi, true);
  assert.ok(gmail.appPasswordUrl.startsWith('https://'));

  assert.equal(guessMailHosts('x@outlook.com').imap.host, 'outlook.office365.com');
  assert.equal(guessMailHosts('x@yahoo.com').imap.host, 'imap.mail.yahoo.com');
  assert.equal(guessMailHosts('x@icloud.com').imap.host, 'imap.mail.me.com');
  assert.equal(guessMailHosts('x@fastmail.com').imap.host, 'imap.fastmail.com');
});

test('only Gmail offers the Gmail API path', () => {
  for (const address of ['x@outlook.com', 'x@yahoo.com', 'x@custom.dev']) {
    assert.equal(guessMailHosts(address).supportsGmailApi, false, address);
  }
});

test('a custom domain gets conventional hosts, flagged as a guess', () => {
  const guess = guessMailHosts('me@mycompany.dev');
  assert.equal(guess.guessed, false, 'must not claim certainty about an unknown domain');
  assert.equal(guess.imap.host, 'imap.mycompany.dev');
  assert.match(guess.note, /check them against/i);
});

test('Proton is flagged as needing Bridge rather than silently failing later', () => {
  const guess = guessMailHosts('x@proton.me');
  assert.match(guess.note, /Bridge/);
  assert.equal(guess.imap.host, '127.0.0.1');
});

test('a malformed address yields no guess instead of a bad one', () => {
  const guess = guessMailHosts('not-an-email');
  assert.equal(guess.domain, '');
  assert.equal(guess.imap, null);
});

test('domain extraction handles display-name forms', () => {
  assert.equal(emailDomainOf('Raj <raj@apex.com>'), 'apex.com');
  assert.equal(emailDomainOf('x@GMAIL.COM'), 'gmail.com');
  assert.equal(emailDomainOf('junk'), '');
});

test('account ids are derived and de-duplicated', () => {
  assert.equal(accountIdFor('jus7o.dev@gmail.com'), 'jus7o-dev');
  assert.equal(accountIdFor('a@b.com', ['a']), 'a-2');
  assert.equal(accountIdFor('a@b.com', ['a', 'a-2']), 'a-3');
  assert.equal(accountIdFor('@@@@@@'), 'inbox');
  assert.match(accountIdFor('Weird Name+tag@x.com'), /^[a-z0-9][a-z0-9_-]*$/);
});

/* ----- secret writing ----------------------------------------------------- */

test('per-account keys are suffixed from the account id', () => {
  assert.equal(envKeyFor('IMAP_PASSWORD', 'primary'), 'IMAP_PASSWORD_PRIMARY');
  assert.equal(envKeyFor('IMAP_PASSWORD', 'work-mail'), 'IMAP_PASSWORD_WORK_MAIL');
  assert.equal(envKeyFor('TG_TOKEN'), 'TG_TOKEN');
  assert.throws(() => envKeyFor('IMAP_PASSWORD'), /needs an account id/);
});

test('only allowlisted keys can be written', () => {
  const result = setSecret('PATH', '/evil');
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot be set/);
  assert.throws(() => envKeyFor('SOMETHING_ELSE'), /not a writable key/);
});

test('a valid token round-trips and is reported present, never returned', () => {
  assert.equal(setSecret('TG_TOKEN', TEST_TOKEN).ok, true);
  assert.equal(secretsPresent().TG_TOKEN, true);

  const present = secretsPresent();
  assert.equal(JSON.stringify(present).includes('ZZq7Ws'), false, 'the presence map must never carry a value');
  assert.match(readFileSync(ENV_PATH, 'utf8'), new RegExp(`TG_TOKEN=${TEST_TOKEN}`));
});

test('a malformed value is rejected with a usable hint', () => {
  const result = setSecret('TG_TOKEN', 'not-a-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /valid Telegram bot token/);
  assert.ok(result.hint);
});

test('personal AI provider keys are allowlisted and never returned', () => {
  assert.equal(setSecret('ANTHROPIC_API_KEY', 'sk-ant-test_abcdefghijklmnopqrstuvwxyz').ok, true);
  assert.equal(setSecret('OPENAI_API_KEY', 'sk-proj-test_abcdefghijklmnopqrstuvwxyz').ok, true);
  assert.equal(setSecret('GEMINI_API_KEY', 'AIzaTest_abcdefghijklmnopqrstuvwxyz').ok, true);
  assert.equal(setSecret('GEMINI_API_KEY', 'AQ.Test_abcdefghijklmnopqrstuvwxyz').ok, true);
  const present = secretsPresent();
  assert.equal(present.ANTHROPIC_API_KEY, true);
  assert.equal(present.OPENAI_API_KEY, true);
  assert.equal(present.GEMINI_API_KEY, true);
  assert.equal(JSON.stringify(present).includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('app password spaces are stripped, because that is how they are displayed', () => {
  setSecret('IMAP_PASSWORD', 'abcd efgh ijkl mnop', { accountId: 'primary' });
  assert.match(readFileSync(ENV_PATH, 'utf8'), /IMAP_PASSWORD_PRIMARY=abcdefghijklmnop/);
});

test('a full SSN cannot be stored in the last-four field', () => {
  const result = setSecret('AIM_SSN_LAST4', '123-45-6789');
  assert.equal(result.ok, false);
  assert.equal(secretsPresent().AIM_SSN_LAST4, false);
  assert.equal(setSecret('AIM_SSN_LAST4', '6789').ok, true);
});

test('an empty value removes the key rather than writing a blank', () => {
  setSecret('NTFY_TOPIC', 'a-long-enough-topic');
  assert.equal(secretsPresent().NTFY_TOPIC, true);
  setSecret('NTFY_TOPIC', '');
  assert.equal(secretsPresent().NTFY_TOPIC, false);
  assert.doesNotMatch(readFileSync(ENV_PATH, 'utf8'), /^NTFY_TOPIC=/m);
});

test('rewriting one key preserves the others and any comments', () => {
  setSecret('TG_TOKEN', TEST_TOKEN);
  setSecret('IMAP_PASSWORD', 'firstpassword', { accountId: 'alpha' });
  setSecret('IMAP_PASSWORD', 'secondpassword', { accountId: 'alpha' });

  const text = readFileSync(ENV_PATH, 'utf8');
  assert.match(text, /TG_TOKEN=/, 'unrelated key survived');
  assert.match(text, /IMAP_PASSWORD_ALPHA=secondpassword/);
  assert.doesNotMatch(text, /firstpassword/, 'the old value must be gone, not duplicated');
  assert.equal((text.match(/IMAP_PASSWORD_ALPHA=/g) || []).length, 1, 'exactly one entry per key');
});

test('removing a key is idempotent', () => {
  removeSecret('IMAP_PASSWORD', { accountId: 'ghost' });
  assert.equal(removeSecret('IMAP_PASSWORD', { accountId: 'ghost' }).removed, false);
});

test('field metadata is exposed without any values', () => {
  const fields = writableFields();
  assert.ok(fields.length >= 10);
  for (const field of fields) {
    assert.ok(field.key && field.label);
    assert.equal('value' in field, false, 'metadata must never include a value');
  }
});

/* ----- error translation -------------------------------------------------- */

test('an auth failure explains App Passwords and 2FA', () => {
  for (const raw of ['Command failed', 'Invalid credentials (Failure)', '[AUTHENTICATIONFAILED] Invalid credentials', 'LOGIN failed']) {
    const result = friendlyError(raw);
    assert.equal(result.translated, true, raw);
    assert.match(result.message, /App Password/i, raw);
    assert.match(result.message, /2-Step Verification/i, raw);
  }
});

test('the Testing-mode token expiry is called out by name', () => {
  const result = friendlyError('invalid_grant');
  assert.match(result.message, /Testing/);
  assert.match(result.message, /7 days/);
});

test('network failures are distinguished from auth failures', () => {
  assert.match(friendlyError('getaddrinfo ENOTFOUND imap.typo.com').message, /hostname could not be found/);
  assert.match(friendlyError('connect ECONNREFUSED 1.2.3.4:993').message, /refused the connection/);
  assert.match(friendlyError('ETIMEDOUT').message, /timed out/);
});

test('an unrecognised error passes through unchanged', () => {
  const result = friendlyError('some novel failure nobody has seen');
  assert.equal(result.translated, false);
  assert.equal(result.message, 'some novel failure nobody has seen');
});

test('empty input does not produce a message', () => {
  assert.equal(friendlyError('').message, '');
  assert.equal(friendlyError(null).message, '');
  assert.equal(friendlyError(undefined).translated, false);
});

test('the log line keeps the original cause alongside the explanation', () => {
  const line = friendlyErrorLine('Invalid credentials (Failure)');
  assert.match(line, /App Password/);
  assert.match(line, /Invalid credentials/);
});
