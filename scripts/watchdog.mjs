#!/usr/bin/env node
/**
 * Watchdog. Runs on its own schedule (every 5 minutes) and restarts the watcher
 * if the heartbeat has gone stale.
 *
 * It exists because the failure that actually hurts is silent: a watcher that
 * died at 2am means you find out about an interview request at 9am. A stale
 * heartbeat is the only reliable way to tell "nothing arrived" from "nothing is
 * running", and this turns that distinction into a restart plus a push.
 */
import { spawn } from 'node:child_process';
import { append } from './ledger.mjs';
import { read } from './config-rw.mjs';
import { heartbeatAgeSeconds, readHeartbeat } from './state.mjs';
import { notify } from './notify/index.mjs';
import { IS_WINDOWS, ROOT, SCHTASKS, ensureDirs } from './os-paths.mjs';
import { installCrashGuards, log, logError } from './log.mjs';
import { loadEnv } from './env.mjs';
import { TASK_NAMES } from './scheduler-register.mjs';

/** Stale threshold. The watcher beats every ~3s, so 5 minutes is unambiguous. */
const STALE_SECONDS = 300;

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', (error) => resolve({ ok: false, error: String(error?.message || error) }));
    child.unref();
    // A detached start has no exit code to wait for; treat a successful spawn as
    // success and let the next watchdog pass verify the heartbeat recovered.
    setTimeout(() => resolve({ ok: true }), 400);
  });
}

async function restartWatcher() {
  if (IS_WINDOWS) {
    const result = await run(SCHTASKS, ['/run', '/tn', TASK_NAMES.watcher]);
    if (result.ok) return { ok: true, how: `schtasks /run ${TASK_NAMES.watcher}` };
    log(`watchdog: schtasks restart failed (${result.error}) — starting node directly`, { name: 'watchdog' });
  }

  const result = await run(process.execPath, ['scripts/watcher.mjs']);
  return result.ok ? { ok: true, how: 'node scripts/watcher.mjs' } : { ok: false, error: result.error };
}

async function main() {
  loadEnv();
  ensureDirs();
  installCrashGuards('watchdog');

  const config = read();
  const age = heartbeatAgeSeconds();
  const beat = readHeartbeat();

  if (age !== Infinity && age <= STALE_SECONDS) {
    log(`watchdog: healthy (last beat ${age}s ago, pid ${beat.pid})`, { name: 'watchdog', stdout: false });
    return;
  }

  const description = age === Infinity ? 'no heartbeat has ever been written' : `heartbeat is ${Math.round(age / 60)} minutes old`;
  log(`watchdog: watcher looks dead — ${description}. Restarting.`, { name: 'watchdog' });

  const result = await restartWatcher();
  append('events', { type: 'watchdog_restart', ok: result.ok, how: result.how || '', error: result.error || '', ageSeconds: age === Infinity ? null : age });

  await notify(
    {
      category: 'SYSTEM',
      urgent: true,
      title: 'Watcher restarted',
      html: [
        '🔧 <b>Watcher was not running</b>',
        '',
        `Reason: ${description}.`,
        result.ok ? `Restarted via <code>${result.how}</code>.` : `Restart failed: ${result.error}`,
        '',
        result.ok ? 'Mail is being read again. Anything that arrived while it was down gets picked up on the next pass.' : 'Start it by hand: <code>npm run watch</code>'
      ].join('\n')
    },
    config,
    { force: true }
  ).catch((error) => logError('watchdog notify', error, { name: 'watchdog' }));
}

const invokedDirectly = process.argv[1] && /watchdog\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    logError('watchdog fatal', error, { name: 'watchdog' });
    process.exit(1);
  });
}

export { STALE_SECONDS, restartWatcher };
