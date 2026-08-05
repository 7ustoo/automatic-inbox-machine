/**
 * Telegram notification sink. Push only — the interactive half lives in
 * telegram-bot.mjs, which owns the poll loop and the callback router.
 */
import { isConfigured, sendMessage } from '../telegram-api.mjs';
import { log } from '../log.mjs';

export const name = 'telegram';

export function available(config) {
  return Boolean(isConfigured() && config?.notify?.telegram?.enabled && config?.notify?.telegram?.chatId);
}

export async function send(event, config) {
  const settings = config?.notify?.telegram || {};
  const chatId = settings.chatId;
  if (!chatId) return { ok: false, error: 'no chatId — pair the bot first' };

  const silent = Boolean(
    !event.urgent && Array.isArray(settings.silentCategories) && settings.silentCategories.includes(event.category)
  );

  const result = await sendMessage(chatId, event.html || event.text || '', {
    keyboard: event.keyboard || null,
    silent
  });

  if (!result.ok) log(`telegram notify failed: ${result.error}`, { name: 'notify' });
  return result;
}
