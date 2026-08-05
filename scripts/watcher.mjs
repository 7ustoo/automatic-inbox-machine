#!/usr/bin/env node
/**
 * The long-running watcher. This is the process that must survive everything.
 *
 * Design constraints it exists under:
 *   - One bad account never stops the others (see accounts.mjs).
 *   - One bad message never wedges an account (the cursor still advances).
 *   - Config is re-read every tick, so /pause, threshold changes, and new
 *     accounts take effect without a restart.
 *   - It writes a heartbeat so watchdog.mjs can tell "idle" from "dead".
 *
 * Run continuously with `npm run watch`, or once with `npm run once` — the
 * single-shot mode is what a scheduled task or a CI smoke test uses.
 */
import { LedgerIndex, append, expireStaleApprovals, rowsSince, stats } from './ledger.mjs';
import { read, validate } from './config-rw.mjs';
import { buildRunners } from './accounts.mjs';
import { ammDedupeCorpus } from './amm-bridge.mjs';
import { activeChannels, flushHeld, notify } from './notify/index.mjs';
import * as cards from './notify/format.mjs';
import { beat, lastDigestDate, markDigestSent } from './state.mjs';
import { ROOT, ensureDirs } from './os-paths.mjs';
import { installCrashGuards, log, logError } from './log.mjs';
import { loadEnv } from './env.mjs';

const LOOP_INTERVAL_MS = 3000;
const AMM_REFRESH_MS = 30 * 60 * 1000;

let shuttingDown = false;

/** Local date key (YYYY-MM-DD) in the digest timezone. */
function dateKeyIn(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function hourIn(timezone) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', hour: '2-digit', hour12: false }).format(new Date()));
  } catch {
    return new Date().getHours();
  }
}

async function maybeSendDigest(config) {
  const digest = config.notify?.digest;
  if (!digest?.enabled) return false;

  const timezone = digest.timezone || 'UTC';
  const today = dateKeyIn(timezone);
  if (lastDigestDate() === today) return false;
  if (hourIn(timezone) < Number(digest.hour ?? 8)) return false;

  const summary = stats(24);
  const interviews = rowsSince('messages', 24).filter((row) => row.category === 'INTERVIEW');

  await notify(
    {
      category: 'DIGEST',
      urgent: false,
      title: 'Inbox digest',
      html: cards.digestCard({ stats: summary, pending: summary.pending, interviews })
    },
    config,
    { force: true }
  );

  markDigestSent(today);
  log(`watcher: digest sent for ${today}`, { name: 'watcher' });
  return true;
}

function summarize(results) {
  const counts = {};
  for (const result of results) {
    const key = `${result.category}/${result.action}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([key, count]) => `${key}×${count}`)
    .join(' ');
}

export async function runOnce({ config = read(), index = LedgerIndex.load(), ammCorpus = null } = {}) {
  const runners = buildRunners(config);
  const corpus = ammCorpus ?? ammDedupeCorpus(config, ROOT);
  const all = [];

  for (const runner of runners) {
    const result = await runner.tick({ config, index, ammCorpus: corpus });
    all.push(...(result.results || []));
    await runner.close();
  }

  expireStaleApprovals({ expireHours: config.policy?.approvals?.expireHours || 24 });
  await flushHeld(config);
  await maybeSendDigest(config);

  return all;
}

async function main() {
  loadEnv();
  ensureDirs();
  installCrashGuards('watcher');

  const once = process.argv.includes('--once');
  let config = read();

  const check = validate(config);
  for (const warning of check.warnings) log(`config warning: ${warning}`, { name: 'watcher' });
  if (!check.ok) {
    for (const error of check.errors) log(`config error: ${error}`, { name: 'watcher' });
    process.stderr.write('\nRefusing to start with an invalid config. Run `npm run setup`.\n');
    process.exit(1);
  }

  const index = LedgerIndex.load();
  log(
    `watcher: starting — ${config.accounts.filter((account) => account.enabled !== false).length} account(s), ` +
      `${index.messages.length} message(s) in ledger, channels: ${activeChannels(config).join(', ') || 'none'}`,
    { name: 'watcher' }
  );

  if (config.policy?.autoSend?.enabled) {
    log('watcher: AUTO-SEND IS ON — replies will go out without asking', { name: 'watcher' });
  } else {
    log('watcher: auto-send is off — everything routes to approval', { name: 'watcher' });
  }

  if (once) {
    const results = await runOnce({ config, index });
    log(`watcher: single pass done — ${results.length} message(s) ${summarize(results) || '(nothing new)'}`, { name: 'watcher' });
    beat({ mode: 'once', processed: results.length });
    return;
  }

  const runners = buildRunners(config);
  if (!runners.length) {
    process.stderr.write('No enabled accounts. Nothing to watch.\n');
    process.exit(1);
  }

  let ammCorpus = ammDedupeCorpus(config, ROOT);
  let ammRefreshedAt = Date.now();
  let configReloadAt = Date.now();

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`watcher: ${signal} received — closing ${runners.length} account connection(s)`, { name: 'watcher' });
    await Promise.all(runners.map((runner) => runner.close()));
    append('events', { type: 'watcher_stopped', signal });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  append('events', { type: 'watcher_started', accounts: runners.map((runner) => runner.id) });

  while (!shuttingDown) {
    try {
      // Re-read config every 15s so /pause and threshold edits land without a
      // restart. Account list changes still need one, and setup says so.
      if (Date.now() - configReloadAt > 15000) {
        config = read();
        configReloadAt = Date.now();
      }

      if (Date.now() - ammRefreshedAt > AMM_REFRESH_MS) {
        ammCorpus = ammDedupeCorpus(config, ROOT);
        ammRefreshedAt = Date.now();
      }

      const due = runners.filter((runner) => runner.isDue());
      for (const runner of due) {
        const result = await runner.tick({ config, index, ammCorpus });
        if (result.processed) {
          log(`watcher: ${runner.id} handled ${result.processed} — ${summarize(result.results)}`, { name: 'watcher' });
        }
      }

      expireStaleApprovals({ expireHours: config.policy?.approvals?.expireHours || 24 });
      await flushHeld(config);
      await maybeSendDigest(config);

      beat({
        mode: 'watch',
        paused: Boolean(config.paused),
        accounts: runners.map((runner) => ({
          id: runner.id,
          nextRunInSeconds: Math.round(runner.dueIn / 1000),
          failures: runner.consecutiveFailures,
          lastError: runner.lastError
        }))
      });
    } catch (error) {
      logError('watcher loop', error, { name: 'watcher' });
    }

    await new Promise((resolve) => setTimeout(resolve, LOOP_INTERVAL_MS));
  }
}

const invokedDirectly = process.argv[1] && /watcher\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    logError('watcher fatal', error, { name: 'watcher' });
    process.exit(1);
  });
}
