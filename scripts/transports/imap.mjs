/**
 * IMAP + SMTP transport.
 *
 * This is the adapter that lets the app ship to other people. The Gmail API path
 * needs a `gmail.modify` restricted scope, which for a *distributed* app means
 * Google verification plus a CASA security assessment — real money and weeks of
 * process. An app password over IMAP needs none of that, and works with Outlook,
 * Fastmail, and custom domains too.
 *
 * Archiving is implemented as a move out of INBOX into the configured folder,
 * which is exactly what "archive + label" means on Gmail-over-IMAP and the
 * closest equivalent everywhere else. Nothing is ever flagged \Deleted.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { accountEnv } from '../env.mjs';
import { log, logError, maskEmail } from '../log.mjs';

/** Messages larger than this skip the full-source download. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export class ImapTransport {
  constructor(account) {
    this.account = account;
    this.accountId = account.id;
    this.kind = 'imap';
    this.client = null;
    this.delimiter = '/';
    this.mailboxes = new Set();
  }

  password() {
    const primary = accountEnv('IMAP_PASSWORD', this.accountId);
    if (!primary) {
      throw new Error(
        `no IMAP password for account "${this.accountId}". Add IMAP_PASSWORD_${this.accountId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')} to .env`
      );
    }
    return primary;
  }

  smtpPassword() {
    return accountEnv('SMTP_PASSWORD', this.accountId) || this.password();
  }

  async connect() {
    if (this.client?.usable) return { ok: true, email: this.account.email };

    const { host, port = 993, secure = true } = this.account.imap || {};
    if (!host) throw new Error(`account "${this.accountId}" has no imap.host configured`);

    this.client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user: this.account.email, pass: this.password() },
      logger: false,
      emitLogs: false
    });

    // imapflow emits 'error' on transient socket trouble; without a listener
    // Node turns that into an unhandled 'error' event and kills the process.
    this.client.on('error', (error) => logError(`imap(${this.accountId}) socket`, error, { name: 'transport' }));

    await this.client.connect();

    const boxes = await this.client.list();
    for (const box of boxes) {
      this.mailboxes.add(box.path);
      if (box.delimiter) this.delimiter = box.delimiter;
    }

    log(`imap(${this.accountId}): connected as ${maskEmail(this.account.email)}`, { name: 'transport' });
    return { ok: true, email: this.account.email };
  }

  /** Translates a slash-style label into this server's hierarchy delimiter. */
  mailboxPath(name) {
    return String(name || '').split('/').join(this.delimiter);
  }

  async ensureMailbox(name) {
    const path = this.mailboxPath(name);
    if (!path || this.mailboxes.has(path)) return path;
    try {
      await this.client.mailboxCreate(path);
      this.mailboxes.add(path);
      log(`imap(${this.accountId}): created mailbox "${path}"`, { name: 'transport', stdout: false });
    } catch (error) {
      // ALREADYEXISTS is fine and common when two accounts share a server.
      if (!/alreadyexists|already exists/i.test(String(error?.message || ''))) throw error;
      this.mailboxes.add(path);
    }
    return path;
  }

  /**
   * UIDs newer than the cursor. IMAP UIDs are only meaningful within a
   * uidValidity generation — if the server rolls it, the cursor is meaningless
   * and we resync from the tail rather than replaying the entire mailbox.
   */
  async listNewIds({ uidNext, uidValidity, limit = 60 } = {}) {
    await this.connect();
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      const status = this.client.mailbox;
      const currentValidity = String(status.uidValidity || '');
      const currentNext = Number(status.uidNext || 1);

      const validityChanged = uidValidity && currentValidity && String(uidValidity) !== currentValidity;
      let startUid = Number(uidNext) || 0;
      let resetReason = null;

      if (!startUid || validityChanged) {
        // First run or a validity roll: take only the recent tail so a 40k-message
        // mailbox does not get replayed into the ledger on install.
        startUid = Math.max(1, currentNext - limit);
        resetReason = validityChanged ? 'uidvalidity-changed' : 'first-run';
      }

      if (currentNext <= startUid) {
        return { ids: [], uidNext: currentNext, uidValidity: currentValidity, resetReason };
      }

      const ids = [];
      for await (const message of this.client.fetch(
        { uid: `${startUid}:*` },
        { uid: true, flags: true, size: true },
        { uid: true }
      )) {
        if (message.uid < startUid) continue;
        ids.push({ uid: message.uid, size: message.size || 0 });
        if (ids.length >= limit) break;
      }

      return { ids, uidNext: currentNext, uidValidity: currentValidity, resetReason };
    } finally {
      lock.release();
    }
  }

  /** Fetches and normalizes one message by UID. */
  async getMessage(idOrEntry) {
    const uid = typeof idOrEntry === 'object' ? idOrEntry.uid : idOrEntry;
    const size = typeof idOrEntry === 'object' ? idOrEntry.size || 0 : 0;

    await this.connect();
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      const wantSource = !size || size <= MAX_SOURCE_BYTES;
      const message = await this.client.fetchOne(
        String(uid),
        { uid: true, flags: true, envelope: true, internalDate: true, source: wantSource, size: true },
        { uid: true }
      );
      if (!message) return null;

      let parsed = { text: '', html: '', headers: new Map(), subject: '', from: null };
      if (message.source) {
        parsed = await simpleParser(message.source, { skipImageLinks: true, skipTextToHtml: true });
      } else {
        log(`imap(${this.accountId}): uid ${uid} is ${size} bytes — headers only`, { name: 'transport', stdout: false });
      }

      const envelope = message.envelope || {};
      const fromEntry = parsed.from?.value?.[0] || envelope.from?.[0] || {};
      const rfcMessageId = String(parsed.messageId || envelope.messageId || '').trim();
      const references = parsed.references
        ? (Array.isArray(parsed.references) ? parsed.references.join(' ') : String(parsed.references))
        : '';

      return {
        accountId: this.accountId,
        accountEmail: this.account.email,
        providerId: String(uid),
        uid,
        threadId: rfcMessageId || String(uid),
        messageKey: `${this.accountId}:${rfcMessageId || `uid-${uid}`}`,
        rfcMessageId,
        references,
        inReplyTo: String(parsed.inReplyTo || envelope.inReplyTo || '').trim(),
        from: String(fromEntry.address || '').toLowerCase(),
        fromName: String(fromEntry.name || ''),
        replyTo: String(parsed.replyTo?.value?.[0]?.address || '').toLowerCase(),
        to: (parsed.to?.text || (envelope.to || []).map((entry) => entry.address).join(', ') || ''),
        cc: parsed.cc?.text || '',
        subject: String(parsed.subject || envelope.subject || ''),
        date: (parsed.date || envelope.date || message.internalDate || new Date()).toISOString?.() || new Date().toISOString(),
        receivedAt: (message.internalDate || new Date()).toISOString?.() || new Date().toISOString(),
        textBody: String(parsed.text || ''),
        htmlBody: typeof parsed.html === 'string' ? parsed.html : '',
        snippet: String(parsed.text || '').slice(0, 200),
        labelIds: message.flags ? [...message.flags] : [],
        listUnsubscribe: String(parsed.headers?.get?.('list-unsubscribe') || ''),
        autoSubmitted: String(parsed.headers?.get?.('auto-submitted') || ''),
        precedence: String(parsed.headers?.get?.('precedence') || '')
      };
    } finally {
      lock.release();
    }
  }

  /** Moves the message out of INBOX into the configured folder. Never deletes. */
  async archive(message, labelName) {
    await this.connect();
    const target = await this.ensureMailbox(labelName || 'Archive');
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      await this.client.messageMove(String(message.uid ?? message.providerId), target, { uid: true });
      return { archived: true, label: target };
    } finally {
      lock.release();
    }
  }

  /** IMAP has no labels, so a "label" is a copy into a folder. */
  async applyLabel(message, labelName) {
    await this.connect();
    const target = await this.ensureMailbox(labelName);
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      await this.client.messageCopy(String(message.uid ?? message.providerId), target, { uid: true });
      return { labeled: true, label: target };
    } finally {
      lock.release();
    }
  }

  async markRead(message) {
    await this.connect();
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      await this.client.messageFlagsAdd(String(message.uid ?? message.providerId), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  }

  transporter() {
    if (this._transporter) return this._transporter;
    const { host, port = 465, secure = true } = this.account.smtp || {};
    if (!host) throw new Error(`account "${this.accountId}" has no smtp.host configured — cannot send`);

    this._transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user: this.account.email, pass: this.smtpPassword() }
    });
    return this._transporter;
  }

  async sendReply({ to, subject, body, inReplyTo, references, fromName, fromEmail, attachments = [] }) {
    const sender = fromEmail || this.account.email;
    const referenceChain = [references, inReplyTo].filter(Boolean).join(' ').trim();

    const info = await this.transporter().sendMail({
      from: fromName ? { name: fromName, address: sender } : sender,
      to,
      subject,
      text: body,
      ...(attachments.length ? { attachments: attachments.map(({ filename, contentType, path }) => ({ filename, contentType, path })) } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(referenceChain ? { references: referenceChain } : {})
    });

    return { ok: Boolean(info?.messageId), providerId: info?.messageId || '', threadId: inReplyTo || '' };
  }

  async disconnect() {
    try {
      if (this.client?.usable) await this.client.logout();
    } catch {
      /* closing a dead socket is not an error worth surfacing */
    }
    this.client = null;
    if (this._transporter) {
      this._transporter.close?.();
      this._transporter = null;
    }
  }

  async health() {
    try {
      await this.connect();
      const lock = await this.client.getMailboxLock('INBOX');
      try {
        return { ok: true, email: this.account.email, exists: this.client.mailbox?.exists || 0 };
      } finally {
        lock.release();
      }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }
}
