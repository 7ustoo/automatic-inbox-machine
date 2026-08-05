/**
 * Append-only JSONL ledger.
 *
 * Chosen over SQLite on purpose: better-sqlite3 is a native addon, and this app
 * ships to end users on three platforms who should never see a node-gyp error.
 * At this volume (a few hundred messages a day) an append + in-memory index
 * rebuilt at startup is both faster to reason about and trivially greppable
 * when something looks wrong.
 *
 * Every row is one JSON object on one line. Corrupt lines are skipped rather
 * than fatal — a half-written line from a hard kill must not brick the agent.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LEDGERS, ensureDirs } from './os-paths.mjs';
import { log } from './log.mjs';

function pathFor(name) {
  const file = LEDGERS[name];
  if (!file) throw new Error(`unknown ledger "${name}" (have: ${Object.keys(LEDGERS).join(', ')})`);
  return file;
}

/** Appends one record, stamping id and ts if absent. Returns the stored row. */
export function append(name, record) {
  ensureDirs();
  const row = { id: record.id || randomUUID(), ts: record.ts || new Date().toISOString(), ...record };
  const line = `${JSON.stringify(row)}\n`;

  // Windows can hand back EBUSY when another process is mid-append. Retry
  // briefly with a synchronous spin rather than dropping the row.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      appendFileSync(pathFor(name), line, 'utf8');
      return row;
    } catch (error) {
      if (attempt === 4) {
        log(`ledger append failed for ${name}: ${error.message}`, { name: 'ledger' });
        return row;
      }
      const until = Date.now() + 25 * (attempt + 1);
      while (Date.now() < until) { /* brief backoff */ }
    }
  }
  return row;
}

/** Reads every valid row. Skips and counts malformed lines. */
export function readAll(name) {
  const file = pathFor(name);
  if (!existsSync(file)) return [];

  const rows = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
    }
  }
  if (skipped) log(`ledger ${name}: skipped ${skipped} malformed line(s)`, { name: 'ledger', stdout: false });
  return rows;
}

/**
 * Rewrites a ledger keeping only rows the predicate accepts. Used by /forget
 * and by compaction; atomic via temp + rename so a crash cannot truncate.
 */
export function rewrite(name, keepFn) {
  const rows = readAll(name).filter(keepFn);
  const file = pathFor(name);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  renameSync(temp, file);
  return rows.length;
}

/**
 * Updates the newest row matching `matchFn` in place. JSONL has no update, so
 * this rewrites the file — fine for the outbound queue, which stays small.
 */
export function update(name, matchFn, patch) {
  const rows = readAll(name);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (matchFn(rows[index])) {
      rows[index] = { ...rows[index], ...patch, updatedAt: new Date().toISOString() };
      const file = pathFor(name);
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
      renameSync(temp, file);
      return rows[index];
    }
  }
  return null;
}

export function find(name, matchFn) {
  const rows = readAll(name);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (matchFn(rows[index])) return rows[index];
  }
  return null;
}

export function filter(name, matchFn) {
  return readAll(name).filter(matchFn);
}

/* -------------------------------------------------------------------------- */
/* Index                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Built once at startup and kept warm in the watcher. Answers the two hot
 * questions — "have I already seen this message?" and "have I already been
 * pitched this req?" — without touching disk.
 */
export class LedgerIndex {
  constructor() {
    this.seenMessageKeys = new Set();
    this.seenThreadIds = new Set();
    this.reqs = [];
    this.submissions = [];
    this.messages = [];
  }

  static load() {
    const index = new LedgerIndex();
    index.messages = readAll('messages');
    index.reqs = readAll('reqs');
    index.submissions = readAll('submissions');
    for (const message of index.messages) {
      if (message.messageKey) index.seenMessageKeys.add(message.messageKey);
      if (message.threadId) index.seenThreadIds.add(`${message.accountId}:${message.threadId}`);
    }
    return index;
  }

  hasMessage(messageKey) {
    return this.seenMessageKeys.has(messageKey);
  }

  hasThread(accountId, threadId) {
    return this.seenThreadIds.has(`${accountId}:${threadId}`);
  }

  recordMessage(row) {
    if (row.messageKey) this.seenMessageKeys.add(row.messageKey);
    if (row.threadId) this.seenThreadIds.add(`${row.accountId}:${row.threadId}`);
    this.messages.push(row);
  }

  recordReq(row) {
    this.reqs.push(row);
  }

  recordSubmission(row) {
    this.submissions.push(row);
  }
}

/* -------------------------------------------------------------------------- */
/* Query helpers used by the bot, the digest, and the dashboard               */
/* -------------------------------------------------------------------------- */

export function sinceCutoff(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

export function rowsSince(name, hours) {
  const cutoff = sinceCutoff(hours);
  return readAll(name).filter((row) => String(row.ts) >= cutoff);
}

/** Category -> count over a rolling window. */
export function categoryCounts(hours = 24) {
  const counts = {};
  for (const row of rowsSince('messages', hours)) {
    const key = row.category || 'UNKNOWN';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function stats(hours = 24) {
  const messages = rowsSince('messages', hours);
  const outbound = rowsSince('outbound', hours);
  const counts = {};
  for (const row of messages) counts[row.category || 'UNKNOWN'] = (counts[row.category || 'UNKNOWN'] || 0) + 1;

  return {
    windowHours: hours,
    processed: messages.length,
    byCategory: counts,
    interviews: messages.filter((row) => row.category === 'INTERVIEW').length,
    newReqs: messages.filter((row) => row.category === 'NEW_REQ').length,
    duplicates: messages.filter((row) => row.duplicateOf).length,
    archived: messages.filter((row) => row.archived).length,
    sent: outbound.filter((row) => row.status === 'sent').length,
    pending: readAll('outbound').filter((row) => row.status === 'pending').length,
    skipped: outbound.filter((row) => row.status === 'skipped').length
  };
}

/** Outbound rows still awaiting a Send / Edit / Skip decision. */
export function pendingApprovals({ expireHours = 24 } = {}) {
  const cutoff = sinceCutoff(expireHours);
  return readAll('outbound').filter((row) => row.status === 'pending' && String(row.ts) >= cutoff);
}

/** Marks pending rows older than the window as expired. Returns the count. */
export function expireStaleApprovals({ expireHours = 24 } = {}) {
  const cutoff = sinceCutoff(expireHours);
  const rows = readAll('outbound');
  let changed = 0;
  for (const row of rows) {
    if (row.status === 'pending' && String(row.ts) < cutoff) {
      row.status = 'expired';
      row.updatedAt = new Date().toISOString();
      changed += 1;
    }
  }
  if (changed) {
    const file = pathFor('outbound');
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    renameSync(temp, file);
  }
  return changed;
}

/** Rate-limit helper: how many replies actually went out in the last hour. */
export function sentInLastHour() {
  return rowsSince('outbound', 1).filter((row) => row.status === 'sent').length;
}

export function sentOnThread(accountId, threadId) {
  return readAll('outbound').filter(
    (row) => row.status === 'sent' && row.accountId === accountId && row.threadId === threadId
  ).length;
}

export { LEDGERS };
