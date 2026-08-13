/**
 * Self-update: the pure decision logic. The download/spawn half is exercised
 * for real by using the app; what belongs under test is asset selection and
 * checksum parsing, where a mistake means running an unverified binary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksumFor, installerAssetFor, updaterScriptFor } from '../self-update.mjs';
import { parseOAuthClientConfig } from '../transports/gmail-oauth.mjs';

const ASSETS = [
  { name: 'SHA256SUMS.txt' },
  { name: 'aim-setup-v1.5.0.exe' },
  { name: 'something-else.zip' }
];

test('the Windows installer asset is selected by name', () => {
  assert.equal(installerAssetFor(ASSETS, true)?.name, 'aim-setup-v1.5.0.exe');
});

test('no asset is ever selected on non-Windows platforms', () => {
  assert.equal(installerAssetFor(ASSETS, false), null);
});

test('an AMM installer would never be picked up by mistake', () => {
  assert.equal(installerAssetFor([{ name: 'amm-setup-v7.11.0.exe' }], true), null);
});

test('missing or empty asset lists resolve to null, not a throw', () => {
  assert.equal(installerAssetFor(undefined, true), null);
  assert.equal(installerAssetFor([], true), null);
  assert.equal(installerAssetFor([{}], true), null);
});

const SUMS = [
  '6616703b0b09313ad97854683b95e43f3f25fd1885ef0d23e69e0fa9fc11fd30  aim-setup-v1.5.0.exe',
  'deadbeef00000000000000000000000000000000000000000000000000000000  SHA256SUMS.txt'
].join('\n');

test('the checksum line for the asset is found, case-insensitively', () => {
  assert.equal(checksumFor(SUMS, 'aim-setup-v1.5.0.exe'), '6616703b0b09313ad97854683b95e43f3f25fd1885ef0d23e69e0fa9fc11fd30');
  assert.equal(checksumFor(SUMS, 'AIM-SETUP-V1.5.0.EXE'), '6616703b0b09313ad97854683b95e43f3f25fd1885ef0d23e69e0fa9fc11fd30');
});

test('an unlisted asset or malformed hash yields empty, never a partial match', () => {
  assert.equal(checksumFor(SUMS, 'aim-setup-v9.9.9.exe'), '');
  assert.equal(checksumFor('not-a-hash  aim-setup-v1.5.0.exe', 'aim-setup-v1.5.0.exe'), '');
  assert.equal(checksumFor('', 'aim-setup-v1.5.0.exe'), '');
});

test('updater stops registered processes without killing its own process tree, then relaunches', () => {
  const script = updaterScriptFor({
    pids: { dashboard: { pid: 101 }, watcher: { pid: 202 } },
    dest: 'C:\\update.exe', root: 'C:\\AIM', aimExe: 'C:\\AIM\\wrapper\\dist\\AIM.exe',
    logPath: 'C:\\AIM\\data\\update\\update.log', latest: '1.5.3'
  });
  assert.match(script, /taskkill \/PID 101 \/F/);
  assert.match(script, /taskkill \/PID 202 \/F/);
  assert.match(script, /taskkill \/IM AIM\.exe \/F/);
  assert.doesNotMatch(script, /taskkill .*\/T/);
  assert.match(script, /--after-update/);
  assert.match(script, /installer exit %aimExit%/);
});

/* ----- OAuth client parsing (AMM-compatible shapes) ----------------------- */

test('Google Cloud download format parses ({installed})', () => {
  const parsed = parseOAuthClientConfig({
    installed: { client_id: 'abc.apps.googleusercontent.com', client_secret: 'GOCSPX-xyz' }
  });
  assert.equal(parsed.clientId, 'abc.apps.googleusercontent.com');
  assert.equal(parsed.clientSecret, 'GOCSPX-xyz');
});

test('the flat CI shape parses ({clientId, clientSecret})', () => {
  const parsed = parseOAuthClientConfig({ clientId: 'flat-id', clientSecret: 'flat-secret' });
  assert.equal(parsed.clientId, 'flat-id');
  assert.equal(parsed.clientSecret, 'flat-secret');
});

test('a {web} client and garbage inputs are handled', () => {
  assert.equal(parseOAuthClientConfig({ web: { client_id: 'web-id' } }).clientId, 'web-id');
  assert.deepEqual(parseOAuthClientConfig(null), { clientId: '', clientSecret: '' });
  assert.deepEqual(parseOAuthClientConfig({}), { clientId: '', clientSecret: '' });
});
