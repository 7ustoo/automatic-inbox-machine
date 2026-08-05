import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareVersions, currentVersion } from '../update-checker.mjs';

test('version ordering is correct across all three components', () => {
  assert.ok(compareVersions('1.2.0', '1.1.0') > 0);
  assert.ok(compareVersions('1.1.0', '1.2.0') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0, 'must compare numerically, not as strings');
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
});

test('a leading v is ignored', () => {
  assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
  assert.ok(compareVersions('v1.3.0', 'v1.2.9') > 0);
});

test('a release beats a prerelease of the same core', () => {
  assert.ok(compareVersions('1.2.0', '1.2.0-rc1') > 0);
  assert.ok(compareVersions('1.2.0-rc1', '1.2.0') < 0);
  assert.ok(compareVersions('1.2.0-rc2', '1.2.0-rc1') > 0);
});

test('missing or malformed input does not throw', () => {
  assert.equal(compareVersions('', ''), 0);
  assert.equal(compareVersions(undefined, undefined), 0);
  assert.ok(compareVersions('1.2.0', '') > 0);
  assert.equal(compareVersions('garbage', 'garbage'), 0);
});

test('partial versions are treated as zero-filled', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.3', '1.2.9') > 0);
});

test('currentVersion matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(currentVersion(), pkg.version);
  assert.match(currentVersion(), /^\d+\.\d+\.\d+/);
});

test('an install never reports itself as behind its own version', () => {
  assert.equal(compareVersions(currentVersion(), currentVersion()) > 0, false);
});
