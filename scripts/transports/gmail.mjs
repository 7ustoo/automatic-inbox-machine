/**
 * Gmail REST transport.
 *
 * Talks to the Gmail API over plain fetch — no googleapis dependency, which
 * keeps the install small and the failure modes visible. Incremental sync uses
 * history.list when a cursor exists and falls back to a bounded messages.list
 * on first run or when the cursor has aged out (Gmail expires history IDs after
 * roughly a week, and returns 404 when it does).
 */
import { getAccessToken } from './gmail-oauth.mjs';
import { log, logError } from '../log.mjs';
import { randomBytes } from 'node:crypto';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_ATTEMPTS = 4;

function decodeBase64Url(data) {
  if (!data) return '';
  const normalized = String(data).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function encodeBase64Url(input) {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 2047 encoding for headers that may contain non-ASCII. */
function encodeHeader(value) {
  const text = String(value || '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buffer.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/** Builds a standards-compliant plain-text reply, optionally multipart with files. */
export function buildReplyMime({ to, subject, body, inReplyTo, references, fromName, fromEmail, attachments = [], boundary }) {
  const sender = fromEmail;
  const displayFrom = fromName ? `${encodeHeader(fromName)} <${sender}>` : sender;
  const referenceChain = [references, inReplyTo].filter(Boolean).join(' ').trim();
  const headers = [
    `From: ${displayFrom}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(referenceChain ? [`References: ${referenceChain}`] : []),
    'MIME-Version: 1.0'
  ];

  if (!attachments.length) {
    headers.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(body)}`;
  }

  const marker = boundary || `aim_${randomBytes(18).toString('hex')}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${marker}"`);
  const parts = [
    `--${marker}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(body)}`
  ];
  for (const attachment of attachments) {
    const filename = String(attachment.filename || 'resume.pdf').replace(/[\r\n"\\]/g, '_');
    parts.push(
      `--${marker}\r\nContent-Type: ${attachment.contentType || 'application/octet-stream'}; name="${filename}"\r\n` +
      `Content-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(attachment.content)}`
    );
  }
  parts.push(`--${marker}--`);
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

function splitAddress(headerValue) {
  const raw = String(headerValue || '').trim();
  const angled = raw.match(/^(.*?)<([^>]+)>\s*$/);
  if (angled) {
    return {
      name: angled[1].trim().replace(/^["']|["']$/g, ''),
      email: angled[2].trim().toLowerCase()
    };
  }
  return { name: '', email: raw.replace(/^["']|["']$/g, '').toLowerCase() };
}

function headerMap(payload) {
  const map = {};
  for (const header of payload?.headers || []) {
    map[String(header.name || '').toLowerCase()] = header.value || '';
  }
  return map;
}

/**
 * Depth-first walk collecting the first text/plain and text/html bodies.
 * Skips attachments — the agent classifies prose, not PDFs.
 */
function collectBodies(part, found = { text: '', html: '' }) {
  if (!part) return found;
  const mime = String(part.mimeType || '').toLowerCase();
  const isAttachment = Boolean(part.filename) && part.filename.length > 0;

  if (!isAttachment && mime === 'text/plain' && !found.text) found.text = decodeBase64Url(part.body?.data);
  else if (!isAttachment && mime === 'text/html' && !found.html) found.html = decodeBase64Url(part.body?.data);

  for (const child of part.parts || []) collectBodies(child, found);
  return found;
}

export class GmailTransport {
  constructor(account) {
    this.account = account;
    this.accountId = account.id;
    this.kind = 'gmail';
    this.labelCache = new Map();
  }

  async request(path, { method = 'GET', body, query, allow404 = false } = {}) {
    const token = await getAccessToken(this.accountId);
    const url = new URL(`${BASE}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined
        });

        if (response.status === 404 && allow404) return null;

        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Gmail ${response.status} on ${method} ${path}`);
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`Gmail ${response.status} on ${method} ${path}: ${detail.slice(0, 300)}`);
        }

        if (response.status === 204) return null;
        return await response.json();
      } catch (error) {
        lastError = error;
        const retryable = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(error?.message || ''));
        if (!retryable || attempt === MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
    throw lastError || new Error('Gmail request failed');
  }

  async connect() {
    const profile = await this.request('/profile');
    this.emailAddress = profile?.emailAddress || this.account.email;
    return { ok: true, email: this.emailAddress, historyId: profile?.historyId };
  }

  async currentHistoryId() {
    const profile = await this.request('/profile');
    return profile?.historyId || '';
  }

  /* ----- labels --------------------------------------------------------- */

  async listLabels() {
    const payload = await this.request('/labels');
    const labels = payload?.labels || [];
    for (const label of labels) this.labelCache.set(label.name, label.id);
    return labels;
  }

  /** Returns the label id, creating the label (and nesting on '/') if needed. */
  async ensureLabel(name) {
    if (!name) return '';
    if (this.labelCache.has(name)) return this.labelCache.get(name);

    await this.listLabels();
    if (this.labelCache.has(name)) return this.labelCache.get(name);

    // Gmail creates nested labels implicitly from the slash-delimited name, but
    // only if the parent exists; create parents first to be safe.
    const segments = String(name).split('/');
    let built = '';
    let lastId = '';
    for (const segment of segments) {
      built = built ? `${built}/${segment}` : segment;
      if (this.labelCache.has(built)) {
        lastId = this.labelCache.get(built);
        continue;
      }
      const created = await this.request('/labels', {
        method: 'POST',
        body: { name: built, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
      });
      if (created?.id) {
        this.labelCache.set(built, created.id);
        lastId = created.id;
        log(`gmail(${this.accountId}): created label "${built}"`, { name: 'transport', stdout: false });
      }
    }
    return lastId;
  }

  /* ----- reading -------------------------------------------------------- */

  /**
   * Message ids added to the inbox since the cursor.
   * Returns { ids, historyId, resetReason } — resetReason is set when the cursor
   * was unusable and a bounded backfill was used instead.
   */
  async listNewIds({ historyId, limit = 60, backfillQuery = 'in:inbox newer_than:2d' } = {}) {
    if (historyId) {
      const payload = await this.request('/history', {
        query: { startHistoryId: historyId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: 500 },
        allow404: true
      });

      if (payload) {
        const ids = [];
        for (const record of payload.history || []) {
          for (const added of record.messagesAdded || []) {
            const message = added.message;
            if (!message?.id) continue;
            if (!(message.labelIds || []).includes('INBOX')) continue;
            if ((message.labelIds || []).includes('DRAFT')) continue;
            if (!ids.includes(message.id)) ids.push(message.id);
          }
        }
        return { ids: ids.slice(0, limit), historyId: payload.historyId || historyId, resetReason: null };
      }
      log(`gmail(${this.accountId}): history cursor expired — backfilling`, { name: 'transport' });
    }

    const listed = await this.request('/messages', { query: { q: backfillQuery, maxResults: Math.min(limit, 100) } });
    const ids = (listed?.messages || []).map((message) => message.id).filter(Boolean);
    const nowHistoryId = await this.currentHistoryId();
    return { ids, historyId: nowHistoryId, resetReason: historyId ? 'cursor-expired' : 'first-run' };
  }

  /** Fetches and normalizes one message. Returns null if it vanished. */
  async getMessage(id) {
    const payload = await this.request(`/messages/${id}`, { query: { format: 'full' }, allow404: true });
    if (!payload) return null;

    const headers = headerMap(payload.payload);
    const bodies = collectBodies(payload.payload);
    const fromParts = splitAddress(headers.from);
    const rfcMessageId = (headers['message-id'] || '').trim();

    return {
      accountId: this.accountId,
      accountEmail: this.emailAddress || this.account.email,
      providerId: payload.id,
      threadId: payload.threadId,
      messageKey: `${this.accountId}:${rfcMessageId || payload.id}`,
      rfcMessageId,
      references: (headers.references || '').trim(),
      inReplyTo: (headers['in-reply-to'] || '').trim(),
      from: fromParts.email,
      fromName: fromParts.name,
      replyTo: splitAddress(headers['reply-to']).email || '',
      to: headers.to || '',
      cc: headers.cc || '',
      subject: headers.subject || '',
      date: headers.date || new Date(Number(payload.internalDate) || Date.now()).toISOString(),
      receivedAt: new Date(Number(payload.internalDate) || Date.now()).toISOString(),
      textBody: bodies.text,
      htmlBody: bodies.html,
      snippet: payload.snippet || '',
      labelIds: payload.labelIds || [],
      listUnsubscribe: headers['list-unsubscribe'] || '',
      autoSubmitted: headers['auto-submitted'] || '',
      precedence: headers.precedence || ''
    };
  }

  /* ----- writing -------------------------------------------------------- */

  async modify(providerId, { add = [], remove = [] } = {}) {
    return this.request(`/messages/${providerId}/modify`, {
      method: 'POST',
      body: { addLabelIds: add, removeLabelIds: remove },
      allow404: true
    });
  }

  /**
   * Moves a message out of the inbox and tags it. Archive, never delete — the
   * mail stays fully recoverable from All Mail and from the tag.
   */
  async archive(message, labelName) {
    const add = [];
    if (labelName) {
      const labelId = await this.ensureLabel(labelName);
      if (labelId) add.push(labelId);
    }
    await this.modify(message.providerId, { add, remove: ['INBOX'] });
    return { archived: true, label: labelName };
  }

  async applyLabel(message, labelName) {
    const labelId = await this.ensureLabel(labelName);
    if (!labelId) return { labeled: false };
    await this.modify(message.providerId, { add: [labelId] });
    return { labeled: true, label: labelName };
  }

  async markRead(message) {
    await this.modify(message.providerId, { remove: ['UNREAD'] });
  }

  /**
   * Sends a reply on the original thread. Threading is explicit: Gmail needs
   * threadId in the request AND In-Reply-To/References headers in the MIME, or
   * clients on the recruiter's end break the conversation into a new thread.
   */
  async sendReply({ to, subject, body, threadId, inReplyTo, references, fromName, fromEmail, attachments = [] }) {
    const sender = fromEmail || this.emailAddress || this.account.email;
    const raw = buildReplyMime({ to, subject, body, inReplyTo, references, fromName, fromEmail: sender, attachments });

    const result = await this.request('/messages/send', {
      method: 'POST',
      body: { raw: encodeBase64Url(raw), ...(threadId ? { threadId } : {}) }
    });

    return { ok: Boolean(result?.id), providerId: result?.id || '', threadId: result?.threadId || threadId };
  }

  async disconnect() {
    /* stateless over HTTP */
  }

  async health() {
    try {
      const profile = await this.request('/profile');
      return { ok: true, email: profile?.emailAddress || '', messagesTotal: profile?.messagesTotal || 0 };
    } catch (error) {
      logError(`gmail(${this.accountId}) health`, error, { name: 'transport' });
      return { ok: false, error: String(error?.message || error) };
    }
  }
}
