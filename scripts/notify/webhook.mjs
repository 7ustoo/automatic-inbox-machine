/**
 * Generic webhook sink. Posts a JSON envelope, and also fills the `content` and
 * `text` keys so a Discord or Slack incoming webhook URL works unmodified.
 *
 * Deliberately unsupported-but-available: this is how someone routes alerts to
 * Slack, Home Assistant, or their own service without the project taking on a
 * per-platform integration to maintain.
 */
import { env } from '../env.mjs';
import { log } from '../log.mjs';
import { toPlain } from './format.mjs';

export const name = 'webhook';

export function available(config) {
  return Boolean(config?.notify?.webhook?.enabled && env('WEBHOOK_URL').trim());
}

export async function send(event) {
  const url = env('WEBHOOK_URL').trim();
  if (!url) return { ok: false, error: 'WEBHOOK_URL is not set' };

  const plain = toPlain(event.html || event.text || '');
  const payload = {
    // Discord reads `content`, Slack reads `text`; anything else gets the full
    // structured event and can ignore the two convenience keys.
    content: plain.slice(0, 1900),
    text: plain.slice(0, 1900),
    event: {
      category: event.category,
      urgent: Boolean(event.urgent),
      title: event.title || '',
      accountId: event.accountId || '',
      at: new Date().toISOString()
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      log(`webhook notify failed: HTTP ${response.status}`, { name: 'notify' });
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    log(`webhook notify failed: ${error.message}`, { name: 'notify' });
    return { ok: false, error: String(error?.message || error) };
  }
}
