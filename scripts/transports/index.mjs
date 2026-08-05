/**
 * Transport factory. One interface, two implementations, so the ingest pipeline
 * never knows or cares which mail provider it is talking to.
 *
 * The contract every transport honours:
 *   connect()                            -> { ok, email }
 *   listNewIds(cursor)                   -> { ids, ...nextCursor, resetReason }
 *   getMessage(id)                       -> normalized message | null
 *   archive(message, labelName)          -> { archived }
 *   applyLabel(message, labelName)       -> { labeled }
 *   markRead(message)                    -> void
 *   sendReply({ to, subject, body, ... }) -> { ok, providerId, threadId }
 *   health()                             -> { ok, ... }
 *   disconnect()                         -> void
 *
 * Cursors are transport-shaped and opaque to callers: Gmail carries historyId,
 * IMAP carries uidNext + uidValidity. state.mjs just stores whatever comes back.
 */
import { GmailTransport } from './gmail.mjs';
import { ImapTransport } from './imap.mjs';

export const TRANSPORTS = { gmail: GmailTransport, imap: ImapTransport };

export function createTransport(account) {
  const Transport = TRANSPORTS[account?.transport];
  if (!Transport) {
    throw new Error(`account "${account?.id}" has unknown transport "${account?.transport}" (expected gmail or imap)`);
  }
  return new Transport(account);
}

/** Extracts just the cursor fields a transport cares about. */
export function cursorFor(transportKind, stored = {}) {
  if (transportKind === 'gmail') return { historyId: stored.historyId || '' };
  return { uidNext: stored.uidNext || 0, uidValidity: stored.uidValidity || '' };
}

/** Reduces a listNewIds() result back to the cursor to persist. */
export function nextCursor(transportKind, result = {}) {
  if (transportKind === 'gmail') return { historyId: result.historyId || '' };
  return { uidNext: result.uidNext || 0, uidValidity: result.uidValidity || '' };
}

export { GmailTransport, ImapTransport };
