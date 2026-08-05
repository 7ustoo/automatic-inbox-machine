#!/usr/bin/env node
/**
 * The application entry point — what the Start Menu shortcut actually runs.
 *
 * This is the launcher, not a supervisor. It brings up the three long-running
 * processes as detached children, opens the dashboard in the default browser, and
 * exits. Nothing needs to stay resident holding them: the platform scheduler
 * restarts them at login and watchdog.mjs revives a dead watcher.
 *
 * Liveness is probed, never inferred from a stored PID — Windows recycles PIDs,
 * and a launcher that believes a recycled PID is "the bot" would silently leave
 * the user with no bot. So:
 *   dashboard → TCP connect to its port
 *   watcher   → heartbeat file age
 *   bot       → its own heartbeat file age
 *
 * Modes:
 *   node scripts/app.mjs            start anything not already running, open UI
 *   node scripts/app.mjs --stop     stop everything this install started
 *   node scripts/app.mjs --status   print what is up, exit 0/1
 *   node scripts/app.mjs --no-open  start without opening a browser
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { CMD_EXE, IS_WINDOWS, ROOT, ensureDirs, nodeBinary } from './os-paths.mjs';
import { configExists, read } from './config-rw.mjs';
import { botAlive, clearPid, readPids, watcherAlive } from './state.mjs';
import { env, loadEnv } from './env.mjs';
import { log, logError } from './log.mjs';

/** A heartbeat older than this means the process is gone, not merely idle. */
const ALIVE_WINDOW_SECONDS = 180;

/** How long to wait for the dashboard to answer before opening the browser. */
const DASHBOARD_TIMEOUT_MS = 12000;

const out = (text = '') => process.stdout.write(`${text}\n`);

/* -------------------------------------------------------------------------- */
/* Liveness probes                                                            */
/* -------------------------------------------------------------------------- */

function portOpen(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function probe(config) {
  const port = Number(config.dashboard?.port) || 7391;
  const host = config.dashboard?.host || '127.0.0.1';
  return {
    dashboard: await portOpen(port, host),
    watcher: watcherAlive(ALIVE_WINDOW_SECONDS),
    bot: botAlive(ALIVE_WINDOW_SECONDS),
    port,
    host
  };
}

/* -------------------------------------------------------------------------- */
/* Spawning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Starts one script fully detached, with no console window on Windows.
 *
 * `detached: true` plus `unref()` is what lets this launcher exit while the child
 * keeps running; `stdio: 'ignore'` is required with it, or the child inherits our
 * handles and dies when the console closes.
 */
function spawnDetached(script, args = []) {
  const node = nodeBinary();
  const child = spawn(node, [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

/** Opens a URL in the user's default browser, without a console flash. */
function openBrowser(url) {
  try {
    if (IS_WINDOWS) {
      // `start` is a cmd builtin, hence the shell. The empty "" is the window
      // title argument — omit it and a URL with spaces becomes the title.
      spawn(CMD_EXE, ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (error) {
    logError('app: could not open a browser', error, { name: 'app' });
    out(`Open this in your browser: ${url}`);
  }
}

async function waitForDashboard(port, host, timeoutMs = DASHBOARD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port, host)) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Modes                                                                      */
/* -------------------------------------------------------------------------- */

async function start({ open = true } = {}) {
  ensureDirs();
  const config = read();
  const state = await probe(config);
  const started = [];

  // Children register their own PIDs on startup (see state.registerSelf), so
  // nothing is recorded here — the launcher does not own that bookkeeping.
  if (!state.dashboard) {
    spawnDetached('dashboard.mjs');
    started.push('dashboard');
  }

  // The watcher refuses to run without a valid config, so starting it before
  // setup would just log an error and exit. First run opens the dashboard
  // instead, which is where setup lives.
  if (configExists() && (config.accounts || []).length) {
    if (!state.watcher) {
      spawnDetached('watcher.mjs');
      started.push('watcher');
    }
    if (!state.bot && env('TG_TOKEN').trim()) {
      spawnDetached('telegram-bot.mjs');
      started.push('bot');
    }
  }

  const url = `http://${state.host}:${state.port}`;
  const ready = state.dashboard || (await waitForDashboard(state.port, state.host));

  if (started.length) log(`app: started ${started.join(', ')}`, { name: 'app' });
  else log('app: everything was already running', { name: 'app', stdout: false });

  if (!ready) {
    out('The dashboard did not come up. Check logs\\dashboard.log.');
    return 1;
  }

  if (open) openBrowser(url);
  out(`Inbox agent → ${url}`);
  if (!configExists() || !(config.accounts || []).length) {
    out('First run — setup happens in the dashboard that just opened.');
  }
  return 0;
}

async function stop() {
  const config = read();
  const before = await probe(config);
  const pids = readPids();
  const names = Object.keys(pids);

  if (!names.length) {
    // Nothing registered. If a probe still says something is up, say so rather
    // than reporting a clean stop — a silent no-op here is how a user ends up
    // believing their mail is not being read when it still is.
    if (before.dashboard || before.watcher || before.bot) {
      out('Something is running but not registered in data/pids.json.');
      out('It was likely started outside this launcher. Stop it from Task Manager,');
      out('or run `npm run register-tasks -- --remove` to clear scheduled tasks.');
      return 1;
    }
    out('Nothing is running.');
    return 0;
  }

  for (const name of names) {
    const { pid } = pids[name] || {};
    if (!pid) continue;
    try {
      // SIGTERM lets the watcher close its mail connections and the bot flush its
      // poll offset. Windows has no real signals; Node maps this to
      // TerminateProcess, which is the best available there.
      process.kill(pid, 'SIGTERM');
      out(`stopped ${name} (pid ${pid})`);
    } catch (error) {
      if (error?.code === 'ESRCH') out(`${name} was already gone`);
      else out(`could not stop ${name}: ${error.message}`);
    }
    clearPid(name);
  }

  // Confirm rather than assume. A process that ignored the signal must not be
  // reported as stopped.
  await new Promise((resolve) => setTimeout(resolve, 900));
  const after = await probe(config);
  const stubborn = ['dashboard', 'watcher', 'bot'].filter((name) => after[name]);

  log(`app: stop requested for ${names.join(', ')}`, { name: 'app' });

  if (stubborn.length) {
    out(`still running after the signal: ${stubborn.join(', ')}`);
    return 1;
  }
  out('All stopped.');
  return 0;
}

async function status() {
  const config = read();
  const state = await probe(config);
  const mark = (ok) => (ok ? 'running' : 'stopped');

  out('');
  out(`  dashboard   ${mark(state.dashboard)}   http://${state.host}:${state.port}`);
  out(`  watcher     ${mark(state.watcher)}`);
  out(`  bot         ${mark(state.bot)}${env('TG_TOKEN').trim() ? '' : '   (no TG_TOKEN set)'}`);
  out(`  configured  ${configExists() && (config.accounts || []).length ? 'yes' : 'no — run setup'}`);
  out('');

  return state.dashboard && state.watcher ? 0 : 1;
}

/* -------------------------------------------------------------------------- */

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);

  if (argv.includes('--stop')) return stop();
  if (argv.includes('--status')) return status();
  return start({ open: !argv.includes('--no-open') });
}

const invokedDirectly = process.argv[1] && /app\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((error) => {
      logError('app fatal', error, { name: 'app' });
      process.exit(1);
    });
}

export { probe, start, status, stop };
