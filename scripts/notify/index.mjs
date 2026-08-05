/**
 * Notification fan-out.
 *
 * One notify() call reaches every enabled channel. The channel list is data, not
 * control flow, which is the whole point — adding SMS or a desktop toast later is
 * a new file in this directory and one line in CHANNELS, not a change to the
 * pipeline.
 *
 * Quiet hours hold non-urgent pushes in the events ledger and flush them when the
 * window closes. Urgent events (interviews) always break through, because the
 * entire product promise is that you find out about an interview immediately.
 */
import { append, filter, update } from '../ledger.mjs';
import { inQuietHours } from '../gate.mjs';
import { log } from '../log.mjs';
import * as telegram from './telegram.mjs';
import * as ntfy from './ntfy.mjs';
import * as webhook from './webhook.mjs';

export const CHANNELS = [telegram, ntfy, webhook];

/** Which channels are live right now, for the health panel and setup output. */
export function activeChannels(config) {
  return CHANNELS.filter((channel) => channel.available(config)).map((channel) => channel.name);
}

/**
 * Sends one event everywhere. Returns { delivered: [], failed: [], held: bool }.
 *
 * An event is { category, title, html, text?, urgent?, keyboard?, accountId? }.
 * Failure on one channel never blocks the others.
 */
export async function notify(event, config, { force = false } = {}) {
  const urgent = Boolean(event.urgent);

  if (!force && !urgent && inQuietHours(config)) {
    append('events', { type: 'notification_held', held: true, event: serializable(event) });
    log(`notify: held ${event.category} for quiet hours`, { name: 'notify', stdout: false });
    return { delivered: [], failed: [], held: true };
  }

  const targets = CHANNELS.filter((channel) => channel.available(config));
  if (!targets.length) {
    log(`notify: no channel configured — ${event.category} went nowhere. Run \`npm run setup\` or /pair in Telegram.`, { name: 'notify' });
    return { delivered: [], failed: ['none-configured'], held: false };
  }

  const delivered = [];
  const failed = [];

  await Promise.all(
    targets.map(async (channel) => {
      try {
        const result = await channel.send(event, config);
        if (result?.ok) delivered.push(channel.name);
        else failed.push(`${channel.name}: ${result?.error || 'unknown'}`);
      } catch (error) {
        failed.push(`${channel.name}: ${String(error?.message || error)}`);
      }
    })
  );

  return { delivered, failed, held: false };
}

/** Drops the keyboard and trims the body so a held event round-trips as JSON. */
function serializable(event) {
  return {
    category: event.category,
    title: event.title || '',
    html: String(event.html || event.text || '').slice(0, 3500),
    urgent: Boolean(event.urgent),
    accountId: event.accountId || ''
  };
}

/**
 * Flushes anything held during quiet hours. Called from the watcher tick, so it
 * fires within one poll interval of the window closing.
 */
export async function flushHeld(config) {
  if (inQuietHours(config)) return 0;

  const held = filter('events', (row) => row.type === 'notification_held' && row.held === true);
  if (!held.length) return 0;

  let flushed = 0;
  for (const row of held) {
    const result = await notify({ ...row.event, urgent: false }, config, { force: true });
    if (result.delivered.length) flushed += 1;
    update('events', (candidate) => candidate.id === row.id, { held: false, flushedAt: new Date().toISOString() });
  }

  if (flushed) log(`notify: flushed ${flushed} held notification(s) after quiet hours`, { name: 'notify' });
  return flushed;
}
