/**
 * ntfy.sh sink — the zero-account phone push path.
 *
 * There is no bot to create and no token to paste: pick an unguessable topic,
 * install the ntfy app, subscribe. The tradeoff is that it is one-way, so it
 * carries alerts but never the conversation. Anyone who knows the topic name can
 * read the alerts, which is why setup nags about making it unguessable.
 */
import { env } from '../env.mjs';
import { log } from '../log.mjs';
import { toPlain } from './format.mjs';

export const name = 'ntfy';

export function available(config) {
  return Boolean(config?.notify?.ntfy?.enabled && env('NTFY_TOPIC').trim());
}

function priorityFor(event, config) {
  const urgentCategories = config?.notify?.ntfy?.priorityCategories || ['INTERVIEW'];
  if (event.urgent || urgentCategories.includes(event.category)) return '5';
  if (event.category === 'NEW_REQ' || event.category === 'RTR_REQUEST') return '4';
  return '3';
}

export async function send(event, config) {
  const topic = env('NTFY_TOPIC').trim();
  const server = env('NTFY_SERVER', 'https://ntfy.sh').trim().replace(/\/+$/, '');
  if (!topic) return { ok: false, error: 'NTFY_TOPIC is not set' };

  const body = toPlain(event.html || event.text || '').slice(0, 3800);

  try {
    const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: (event.title || 'Inbox agent').replace(/[^\x20-\x7E]/g, '').slice(0, 120),
        Priority: priorityFor(event, config),
        Tags: event.urgent ? 'rotating_light' : 'envelope'
      },
      body
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log(`ntfy notify failed: HTTP ${response.status} ${detail.slice(0, 120)}`, { name: 'notify' });
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    log(`ntfy notify failed: ${error.message}`, { name: 'notify' });
    return { ok: false, error: String(error?.message || error) };
  }
}
