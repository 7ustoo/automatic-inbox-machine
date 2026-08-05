/**
 * Recovers the requisition record behind a queued reply.
 *
 * The pipeline has the req in memory when it queues an auto-send, but a reply
 * approved from Telegram hours later is a fresh process with no such context. The
 * outbound row carries the fingerprint, so the req is recoverable from the
 * ledger — and it has to be, or a manually approved submission would never get
 * logged and the dedupe engine would go blind to it.
 */
import { readAll } from './ledger.mjs';

/** The req behind an outbound row, or null when it cannot be identified. */
export function findOutboundReq(row) {
  if (!row) return null;
  const reqs = readAll('reqs');

  if (row.reqFingerprint) {
    const byFingerprint = reqs.filter((req) => req.fingerprint === row.reqFingerprint);
    if (byFingerprint.length) return byFingerprint.at(-1);
  }

  // Fall back to the thread. A req and its reply always share one thread, so
  // this is exact whenever the fingerprint is missing from an older row.
  const byThread = reqs.filter((req) => req.accountId === row.accountId && req.threadId === row.threadId);
  if (byThread.length) return byThread.at(-1);

  const byMessage = reqs.filter((req) => req.messageKey === row.messageKey);
  return byMessage.length ? byMessage.at(-1) : null;
}
