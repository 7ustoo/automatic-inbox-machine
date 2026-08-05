/**
 * State persistence.
 *
 * These exist because a missing import in readJson once made every state write
 * silently revert to defaults — the file on disk was correct, the read returned
 * defaults, and nothing logged. `node --check` cannot catch a ReferenceError, so
 * only a round-trip test can. Every accessor here asserts read-after-write.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { BOT_HEARTBEAT_PATH, HEARTBEAT_PATH, STATE_PATH } from '../os-paths.mjs';
import {
  beat, beatBot, botAlive, botHeartbeatAgeSeconds, clearPid, getCursor, heartbeatAgeSeconds,
  lastDigestDate, markDigestSent, processAlive, readPids, readState, recordPid, registerSelf,
  setCursor, setTelegramOffset, getTelegramOffset, consumePairingNonce, issuePairingNonce,
  watcherAlive
} from '../state.mjs';

const TEST_PIDS = ['test-alpha', 'test-beta', 'test-gamma'];

/**
 * Every file these tests touch is restored afterwards. Heartbeats matter as much
 * as state.json: a leftover fresh beat makes the launcher believe the watcher is
 * running and skip starting it, so a test run would leave a real install with
 * nothing watching mail.
 */
const MANAGED = [STATE_PATH, HEARTBEAT_PATH, BOT_HEARTBEAT_PATH];

before(() => {
  for (const path of MANAGED) {
    if (existsSync(path)) renameSync(path, `${path}.test-backup`);
  }
});

after(() => {
  for (const name of TEST_PIDS) clearPid(name);
  for (const path of MANAGED) {
    rmSync(path, { force: true });
    if (existsSync(`${path}.test-backup`)) renameSync(`${path}.test-backup`, path);
  }
});

test('a write is visible to the next read', () => {
  markDigestSent('2026-08-05');
  assert.equal(lastDigestDate(), '2026-08-05', 'read-after-write must see the value');
});

test('what lands on disk matches what comes back', () => {
  markDigestSent('2026-01-02');
  const onDisk = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  assert.equal(onDisk.lastDigestDate, '2026-01-02');
  assert.equal(lastDigestDate(), onDisk.lastDigestDate);
});

test('a BOM in state.json does not reset it to defaults', () => {
  markDigestSent('2026-03-04');
  const text = readFileSync(STATE_PATH, 'utf8');
  writeFileSync(STATE_PATH, `﻿${text}`, 'utf8');
  assert.equal(lastDigestDate(), '2026-03-04', 'a BOM must not silently discard state');
});

test('corrupt state falls back to defaults instead of throwing', () => {
  writeFileSync(STATE_PATH, '{ this is not json', 'utf8');
  assert.deepEqual(readState().accounts, {});
  assert.equal(lastDigestDate(), '');
});

test('separate keys do not clobber each other', () => {
  markDigestSent('2026-05-06');
  setCursor('acct-one', { historyId: '111', lastSyncAt: 'now' });
  setCursor('acct-two', { uidNext: 42, uidValidity: '9' });
  setTelegramOffset(777);

  assert.equal(lastDigestDate(), '2026-05-06');
  assert.equal(getCursor('acct-one').historyId, '111');
  assert.equal(getCursor('acct-two').uidNext, 42);
  assert.equal(getTelegramOffset(), 777);
});

test('a cursor update merges rather than replacing', () => {
  setCursor('acct-merge', { historyId: '1', lastError: 'boom' });
  setCursor('acct-merge', { historyId: '2' });
  const cursor = getCursor('acct-merge');
  assert.equal(cursor.historyId, '2');
  assert.equal(cursor.lastError, 'boom', 'unrelated fields must survive an update');
});

test('a pairing nonce is single-use', () => {
  issuePairingNonce('abc123');
  assert.equal(consumePairingNonce('wrong'), false);
  assert.equal(consumePairingNonce('abc123'), true);
  assert.equal(consumePairingNonce('abc123'), false, 'a nonce must not be reusable');
});

test('heartbeats are written and read back as fresh', () => {
  beat({ mode: 'test' });
  assert.ok(heartbeatAgeSeconds() < 5, `expected a fresh beat, got ${heartbeatAgeSeconds()}s`);
  beatBot({ username: 'testbot' });
  assert.ok(botHeartbeatAgeSeconds() < 5);
});

test('watcher and bot heartbeats are independent', () => {
  // The launcher must be able to tell which of the two is down. A shared file
  // would make a live bot look like a live watcher.
  rmSync(BOT_HEARTBEAT_PATH, { force: true });
  beat({ mode: 'test' });
  assert.ok(heartbeatAgeSeconds() < 5);
  assert.equal(botHeartbeatAgeSeconds(), Infinity, 'a missing bot beat must not read as fresh');
});

test('processAlive distinguishes a live pid from a dead one', () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(0), false);
  assert.equal(processAlive(-1), false);
  assert.equal(processAlive('nope'), false);
  // 2^22 is above Linux's default pid_max and unlikely to be live anywhere.
  assert.equal(processAlive(4194303), false);
});

test('liveness needs BOTH a fresh beat and a live pid', () => {
  // The exact failure this guards: a leftover heartbeat from a process that has
  // since exited. Freshness alone reported the watcher as running, so the
  // launcher skipped starting it and mail went unwatched.
  writeFileSync(HEARTBEAT_PATH, JSON.stringify({ at: new Date().toISOString(), pid: 4194303 }), 'utf8');
  assert.ok(heartbeatAgeSeconds() < 5, 'the beat is fresh');
  assert.equal(watcherAlive(), false, 'but the pid is dead, so it is not running');

  beat({ mode: 'test' });
  assert.equal(watcherAlive(), true, 'our own pid with a fresh beat is alive');
});

test('a stale beat from a live pid is also not alive', () => {
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  writeFileSync(HEARTBEAT_PATH, JSON.stringify({ at: old, pid: process.pid }), 'utf8');
  assert.equal(watcherAlive(), false);
});

test('bot liveness follows the same rule', () => {
  writeFileSync(BOT_HEARTBEAT_PATH, JSON.stringify({ at: new Date().toISOString(), pid: 4194303 }), 'utf8');
  assert.equal(botAlive(), false);
  beatBot({ username: 'testbot' });
  assert.equal(botAlive(), true);
});

test('pids are recorded per process and readable together', () => {
  recordPid('test-alpha', 4242);
  recordPid('test-beta', 4343);
  const pids = readPids();
  assert.equal(pids['test-alpha'].pid, 4242);
  assert.equal(pids['test-beta'].pid, 4343, 'a second registration must not clobber the first');
});

test('clearing one pid leaves the others', () => {
  recordPid('test-alpha', 1);
  recordPid('test-beta', 2);
  clearPid('test-alpha');
  const pids = readPids();
  assert.equal(pids['test-alpha'], undefined);
  assert.equal(pids['test-beta'].pid, 2);
});

test('an invalid process name is rejected rather than writing a stray path', () => {
  assert.throws(() => recordPid('../escape', 1), /invalid process name/);
  assert.throws(() => recordPid('Bad Name', 1), /invalid process name/);
});

test('registerSelf records this process and returns a working release', () => {
  const release = registerSelf('test-gamma');
  assert.equal(readPids()['test-gamma'].pid, process.pid);
  release();
  assert.equal(readPids()['test-gamma'], undefined);
});
