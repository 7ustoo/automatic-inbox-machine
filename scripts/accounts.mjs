/**
 * Per-account supervision.
 *
 * Each inbox gets its own runner with its own cursor, its own backoff, and its
 * own error state. That isolation is the point of multi-account support: an
 * expired OAuth token on one address must not stop the other three from being
 * watched, and it must be visible as one broken account rather than a dead agent.
 */
import { createTransport, cursorFor, nextCursor } from './transports/index.mjs';
import { getCursor, setCursor } from './state.mjs';
import { processMessage } from './pipeline.mjs';
import { friendlyError } from './friendly-errors.mjs';
import { log, logError } from './log.mjs';
import { scanActive } from './scan-marker.mjs';

const MIN_POLL_SECONDS = 15;
const MAX_BACKOFF_SECONDS = 15 * 60;

/** Per-tick ceiling. Keeps a first-run backfill from blocking every other inbox. */
const MAX_MESSAGES_PER_TICK = 25;

export class AccountRunner {
  constructor(account) {
    this.account = account;
    this.id = account.id;
    this.label = account.label || account.id;
    this.transport = createTransport(account);
    this.pollSeconds = Math.max(MIN_POLL_SECONDS, Number(account.pollSeconds) || 45);
    this.nextRunAt = 0;
    this.consecutiveFailures = 0;
    this.lastError = '';
    this.lastSyncAt = '';
    this.processed = 0;
    this.connected = false;
    this.prioritySeen = new Set();
    this.nextPriorityScanAt = 0;
  }

  get dueIn() {
    return Math.max(0, this.nextRunAt - Date.now());
  }

  isDue(now = Date.now()) {
    return now >= this.nextRunAt;
  }

  /** Exponential backoff on consecutive failures, capped. */
  scheduleNext(failed = false) {
    if (failed) {
      const delay = Math.min(MAX_BACKOFF_SECONDS, this.pollSeconds * 2 ** Math.min(6, this.consecutiveFailures));
      this.nextRunAt = Date.now() + delay * 1000;
      return delay;
    }
    this.nextRunAt = Date.now() + this.pollSeconds * 1000;
    return this.pollSeconds;
  }

  async ensureConnected() {
    if (this.connected) return;
    const result = await this.transport.connect();
    this.connected = Boolean(result?.ok);
    if (this.connected) log(`account ${this.id}: connected (${this.transport.kind})`, { name: 'watcher' });
  }

  /**
   * One polling cycle. Returns { ok, fetched, processed, results[], error? }.
   * Never throws — failures are recorded and backed off.
   */
  async tick({ config, index, ammCorpus }) {
    // The watcher reloads policy while it runs. A disabled or removed account
    // must stop reading immediately, even if its runner was created earlier.
    if (!(config.accounts || []).some((account) => account.id === this.id && account.enabled !== false)) {
      this.scheduleNext(false);
      return { ok: true, fetched: 0, processed: 0, results: [] };
    }
    // The seven-day scan may create approval drafts for mail already in the
    // normal backlog. Leave the live cursor in place until that pass finishes.
    if (scanActive()) {
      this.nextRunAt = Date.now() + 3000;
      return { ok: true, fetched: 0, processed: 0, results: [] };
    }
    try {
      await this.ensureConnected();

      const results = [];
      const processId = async (id) => {
        if (scanActive()) return false;
        const raw = await this.transport.getMessage(id);
        if (!raw || scanActive()) return false;
        const result = await processMessage({
          raw,
          transport: this.transport,
          config,
          index,
          account: this.account,
          ammCorpus
        });
        if (!result.skipped) {
          results.push(result);
          this.processed += 1;
        }
        return true;
      };

      // A busy inbox can leave the regular cursor thousands of messages behind.
      // Check recent likely invitations first, then continue draining the old
      // cursor. The ledger prevents a second alert when it reaches those UIDs.
      let priorityHasMore = false;
      if (typeof this.transport.listPriorityIds === 'function' && Date.now() >= this.nextPriorityScanAt) {
        try {
          const candidates = await this.transport.listPriorityIds({ lookback: 500 });
          const pending = candidates.filter((id) => !this.prioritySeen.has(id.uid));
          priorityHasMore = pending.length > 20;
          for (const id of pending.slice(0, 20)) {
            try {
              if (await processId(id)) this.prioritySeen.add(id.uid);
            } catch (error) {
              logError(`account ${this.id} priority message ${id.uid}`, error, { name: 'watcher' });
            }
          }
          if (this.prioritySeen.size > 2000) this.prioritySeen.clear();
          this.nextPriorityScanAt = Date.now() + (priorityHasMore ? 1000 : this.pollSeconds * 1000);
        } catch (error) {
          logError(`account ${this.id} priority scan`, error, { name: 'watcher' });
          this.nextPriorityScanAt = Date.now() + this.pollSeconds * 1000;
        }
      }

      const stored = getCursor(this.id);
      const cursor = cursorFor(this.transport.kind, stored);
      const listing = await this.transport.listNewIds({ ...cursor, limit: MAX_MESSAGES_PER_TICK });

      if (listing.resetReason) {
        log(`account ${this.id}: cursor reset (${listing.resetReason}) — processing recent tail only`, { name: 'watcher' });
      }

      const ids = listing.ids || [];
      let interruptedByScan = false;

      for (const id of ids) {
        if (scanActive()) { interruptedByScan = true; break; }
        try {
          await processId(id);
        } catch (error) {
          logError(`account ${this.id} message ${typeof id === 'object' ? id.uid : id}`, error, { name: 'watcher' });
        }
      }

      if (interruptedByScan || scanActive()) {
        this.nextRunAt = Date.now() + 3000;
        return { ok: true, fetched: ids.length, processed: results.length, results };
      }

      // The cursor advances even when individual messages failed, because the
      // ledger's messageKey guard already prevents reprocessing, and not
      // advancing would wedge the account on one poison message forever.
      setCursor(this.id, {
        ...nextCursor(this.transport.kind, listing),
        lastSyncAt: new Date().toISOString(),
        lastError: ''
      });

      this.consecutiveFailures = 0;
      this.lastError = '';
      this.lastSyncAt = new Date().toISOString();
      this.scheduleNext(false);
      if (listing.hasMore || priorityHasMore) this.nextRunAt = Date.now() + 1000;

      return { ok: true, fetched: ids.length, processed: results.length, results };
    } catch (error) {
      this.consecutiveFailures += 1;
      // Stored in its actionable form: this string is what the dashboard shows
      // and what the user has to work from. A raw "Command failed" tells them
      // nothing about needing an App Password.
      this.lastError = friendlyError(error?.message || error).message.slice(0, 400);
      this.connected = false;

      // A dead socket must be torn down or imapflow will keep handing back the
      // same unusable client.
      try {
        await this.transport.disconnect();
      } catch {
        /* already gone */
      }

      setCursor(this.id, { lastError: this.lastError, lastErrorAt: new Date().toISOString() });
      const delay = this.scheduleNext(true);
      logError(`account ${this.id} tick (retry in ${delay}s, failure #${this.consecutiveFailures})`, error, { name: 'watcher' });

      return { ok: false, fetched: 0, processed: 0, results: [], error: this.lastError };
    }
  }

  async health() {
    const transportHealth = await this.transport.health().catch((error) => ({ ok: false, error: String(error?.message || error) }));
    const cursor = getCursor(this.id);
    return {
      id: this.id,
      label: this.label,
      email: this.account.email,
      transport: this.transport.kind,
      ok: transportHealth.ok,
      error: transportHealth.error || this.lastError || '',
      lastSyncAt: cursor.lastSyncAt || this.lastSyncAt || '',
      consecutiveFailures: this.consecutiveFailures,
      processedThisRun: this.processed,
      pollSeconds: this.pollSeconds,
      nextRunInSeconds: Math.round(this.dueIn / 1000)
    };
  }

  async close() {
    try {
      await this.transport.disconnect();
    } catch {
      /* best effort */
    }
    this.connected = false;
  }
}

/** Builds runners for every enabled account, skipping malformed ones loudly. */
export function buildRunners(config) {
  const runners = [];
  for (const account of config.accounts || []) {
    if (account.enabled === false) {
      log(`account ${account.id}: disabled in config, skipping`, { name: 'watcher' });
      continue;
    }
    try {
      runners.push(new AccountRunner(account));
    } catch (error) {
      logError(`account ${account?.id} could not be initialized`, error, { name: 'watcher' });
    }
  }
  return runners;
}
