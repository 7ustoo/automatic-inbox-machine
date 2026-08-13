/**
 * Browser links back to the exact source message.
 *
 * Gmail's web client accepts the API thread id in its #all route. `authuser`
 * selects the right signed-in mailbox when a user has multiple Gmail accounts.
 * Generic IMAP has no portable webmail URL, so it deliberately returns blank.
 */
export function sourceMessageUrl(row = {}, accounts = []) {
  const account = accounts.find((candidate) => candidate.id === row.accountId);
  if (!account || account.transport !== 'gmail') return '';

  const email = String(account.email || row.accountEmail || '').trim();
  const sourceId = String(row.threadId || row.providerId || '').trim();
  if (!email || !sourceId || /[\s/#?&]/.test(sourceId)) return '';

  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(sourceId)}`;
}
