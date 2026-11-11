/**
 * Browser links back to the exact source message.
 *
 * Gmail's web client accepts the API thread id in its #all route. Gmail IMAP
 * exposes the same id as a decimal X-GM-THRID; older ledger entries can use
 * an exact Message-ID search instead. `authuser` selects the right mailbox.
 * Generic IMAP has no portable webmail URL.
 */
export function sourceMessageUrl(row = {}, accounts = []) {
  const account = accounts.find((candidate) => candidate.id === row.accountId);
  if (!account) return '';

  const email = String(account.email || row.accountEmail || '').trim();
  if (!email) return '';
  const base = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}`;

  if (account.transport === 'gmail') {
    const sourceId = String(row.threadId || row.providerId || '').trim();
    if (!sourceId || /[\s/#?&]/.test(sourceId)) return '';
    return `${base}#all/${encodeURIComponent(sourceId)}`;
  }

  if (account.transport !== 'imap' || String(account.imap?.host || '').toLowerCase() !== 'imap.gmail.com') return '';

  const gmailThreadId = String(row.gmailThreadId || '').trim();
  if (/^\d+$/.test(gmailThreadId) && BigInt(gmailThreadId) > 0n) {
    return `${base}#all/${BigInt(gmailThreadId).toString(16)}`;
  }

  // A mailbox may have been connected through the Gmail API before switching
  // to IMAP. Its saved thread IDs are already in Gmail's web format.
  const legacyThreadId = String(row.threadId || '').trim();
  if (/^[0-9a-f]{12,32}$/i.test(legacyThreadId)) return `${base}#all/${legacyThreadId}`;

  // Entries recorded before Gmail thread IDs were saved still have the RFC
  // Message-ID in threadId. An IMAP UID cannot identify a Gmail web message.
  const messageId = String(row.rfcMessageId || row.threadId || '').trim().replace(/^<|>$/g, '');
  if (!messageId || !/^[^\s<>]+@[^\s<>]+$/.test(messageId)) return '';
  return `${base}#search/${encodeURIComponent(`rfc822msgid:${messageId}`)}`;
}
