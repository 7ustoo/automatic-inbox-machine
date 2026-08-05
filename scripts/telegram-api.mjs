/**
 * Thin Telegram Bot API client over fetch. Shared by the notifier and the bot
 * poller so token handling, chunking, and escaping exist in exactly one place.
 *
 * All outgoing text is HTML parse_mode, so every interpolated value must go
 * through escapeHtml() — a recruiter subject line containing "<" will otherwise
 * make Telegram reject the whole message with a 400.
 */
import { env } from './env.mjs';
import { log, logError } from './log.mjs';

const API_BASE = 'https://api.telegram.org';

/** Telegram's hard cap is 4096; leave headroom for the chunk counter suffix. */
export const MAX_MESSAGE_CHARS = 3900;

export function token() {
  return env('TG_TOKEN').trim();
}

export function isConfigured() {
  return Boolean(token());
}

export function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * One API call. Returns { ok, result } | { ok: false, error } and never throws,
 * because a Telegram outage must not take down the mail pipeline.
 */
export async function call(method, payload = {}, { timeoutMs = 20000 } = {}) {
  const botToken = token();
  if (!botToken) return { ok: false, error: 'TG_TOKEN is not set' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      const description = body.description || `HTTP ${response.status}`;
      // 403 means the user blocked the bot or never pressed Start. That is a
      // configuration fact, not a transient error, so it gets its own log line.
      if (response.status === 403) log(`telegram: ${description} — has /start been sent to the bot?`, { name: 'telegram' });
      return { ok: false, error: description, status: response.status };
    }
    return { ok: true, result: body.result };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Splits on blank lines, then hard-wraps anything still oversized. */
export function chunk(text, limit = MAX_MESSAGE_CHARS) {
  const source = String(text || '');
  if (source.length <= limit) return [source];

  const chunks = [];
  let current = '';
  for (const block of source.split(/\n\n/)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (block.length <= limit) {
      current = block;
      continue;
    }
    for (let index = 0; index < block.length; index += limit) chunks.push(block.slice(index, index + limit));
    current = '';
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function sendMessage(chatId, text, { keyboard = null, silent = false, preview = false } = {}) {
  const parts = chunk(text);
  let last = null;
  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1;
    last = await call('sendMessage', {
      chat_id: chatId,
      text: part,
      parse_mode: 'HTML',
      disable_notification: silent,
      link_preview_options: { is_disabled: !preview },
      // Buttons belong on the final chunk only, or they scroll away mid-message.
      ...(keyboard && isLast ? { reply_markup: { inline_keyboard: keyboard } } : {})
    });
    if (!last.ok) {
      logError('telegram sendMessage', last.error, { name: 'telegram' });
      break;
    }
  }
  return last || { ok: false, error: 'nothing to send' };
}

export async function editMessage(chatId, messageId, text, { keyboard = null } = {}) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: chunk(text)[0],
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
}

export async function clearKeyboard(chatId, messageId) {
  return call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

export async function answerCallback(callbackId, text = '', { alert = false } = {}) {
  return call('answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: alert });
}

export async function getUpdates(offset, { timeout = 25 } = {}) {
  return call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (timeout + 10) * 1000 });
}

export async function getMe() {
  return call('getMe');
}

export async function setCommands(commands) {
  return call('setMyCommands', { commands });
}

/** Typing indicator — makes the Q&A path feel responsive while Claude thinks. */
export async function sendTyping(chatId) {
  return call('sendChatAction', { chat_id: chatId, action: 'typing' });
}
