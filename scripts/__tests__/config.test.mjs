import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, behaviorMode, validate, withDefaults } from '../config-rw.mjs';
import { CONFIG_EXAMPLE_PATH } from '../os-paths.mjs';

const ACCOUNT = { id: 'primary', label: 'Main', email: 'me@gmail.com', transport: 'gmail', enabled: true };

test('defaults fill in missing branches without clobbering user values', () => {
  const merged = withDefaults({ policy: { rateFloorHourly: 90 } });
  assert.equal(merged.policy.rateFloorHourly, 90);
  assert.equal(merged.policy.minConfidence, DEFAULTS.policy.minConfidence);
  assert.equal(merged.dedupe.enabled, true);
  assert.deepEqual(merged.accounts, []);
});

test('_comment keys from the shipping template are dropped', () => {
  const merged = withDefaults({ _comment: 'template note', policy: { _comment: 'gates', remoteOnly: false } });
  assert.equal(merged._comment, undefined);
  assert.equal(merged.policy._comment, undefined);
  assert.equal(merged.policy.remoteOnly, false);
});

test('arrays are replaced whole, not merged element-wise', () => {
  const merged = withDefaults({ profile: { employmentTypes: ['W2'] } });
  assert.deepEqual(merged.profile.employmentTypes, ['W2']);
});

test('a valid single-account config passes', () => {
  const result = validate(withDefaults({ accounts: [ACCOUNT], profile: { fullName: 'Justin Williams' } }));
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('no accounts is an error', () => {
  const result = validate(withDefaults({}));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /No accounts/);
});

test('duplicate account ids are rejected', () => {
  const result = validate(withDefaults({ accounts: [ACCOUNT, { ...ACCOUNT, email: 'other@gmail.com' }] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /duplicated/);
});

test('a malformed account id is rejected', () => {
  const result = validate(withDefaults({ accounts: [{ ...ACCOUNT, id: 'Primary Inbox' }] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /lowercase/);
});

test('an unknown transport is rejected', () => {
  const result = validate(withDefaults({ accounts: [{ ...ACCOUNT, transport: 'pop3' }] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /transport/);
});

test('an imap account without a host is rejected', () => {
  const result = validate(withDefaults({ accounts: [{ ...ACCOUNT, transport: 'imap', imap: {} }] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /imap\.host/);
});

test('an imap account without smtp warns rather than fails', () => {
  const result = validate(withDefaults({
    accounts: [{ ...ACCOUNT, transport: 'imap', imap: { host: 'imap.example.com' } }],
    profile: { fullName: 'Justin Williams' }
  }));
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' '), /smtp\.host/);
});

test('auto-send without a full name is a hard error', () => {
  const result = validate(withDefaults({
    accounts: [ACCOUNT],
    policy: { autoSend: { enabled: true } }
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /fullName/);
});

test('auto-send with a loose confidence threshold warns', () => {
  const result = validate(withDefaults({
    accounts: [ACCOUNT],
    profile: { fullName: 'Justin Williams' },
    policy: { autoSend: { enabled: true }, minConfidence: 0.5 }
  }));
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' '), /low bar/);
});

test('an out-of-range confidence is an error', () => {
  const result = validate(withDefaults({ accounts: [ACCOUNT], policy: { minConfidence: 1.4 } }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /minConfidence/);
});

test('a too-fast poll interval warns', () => {
  const result = validate(withDefaults({
    accounts: [{ ...ACCOUNT, pollSeconds: 3 }],
    profile: { fullName: 'Justin Williams' }
  }));
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' '), /pollSeconds/);
});

test('auto-send ships disabled by default', () => {
  assert.equal(DEFAULTS.policy.autoSend.enabled, false);
  assert.equal(DEFAULTS.policy.autoArchive.enabled, false);
  assert.equal(DEFAULTS.policy.interviewAlertsOnly, false);
  assert.equal(DEFAULTS.policy.approvals.enabled, true);
  assert.equal(DEFAULTS.paused, false);
});

test('new installs start in interviews-only mode while legacy settings remain intact', () => {
  const fresh = withDefaults(JSON.parse(readFileSync(CONFIG_EXAMPLE_PATH, 'utf8')));
  assert.equal(fresh.dashboard.setupComplete, false);
  assert.equal(fresh.policy.interviewAlertsOnly, true);
  assert.equal(fresh.policy.autoArchive.enabled, false);
  assert.equal(behaviorMode(fresh), 'alerts');

  const legacy = withDefaults({ accounts: [ACCOUNT], policy: { autoArchive: { enabled: true } } });
  assert.equal(legacy.dashboard.setupComplete, true);
  assert.equal(legacy.policy.autoArchive.enabled, true);
  assert.equal(behaviorMode(legacy), 'review');
  assert.equal(behaviorMode(withDefaults({ policy: { autoSend: { enabled: true } } })), 'automate');
});
