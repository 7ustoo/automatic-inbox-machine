/** Nightly read-only tracker summary sent only to the paired Telegram chat. */
import { applicationTracker } from './application-tracker.mjs';
import { interviewTracker } from './interview-research.mjs';
import { localDay } from './local-day.mjs';
import { escapeHtml } from './telegram-api.mjs';
import * as telegram from './notify/telegram.mjs';
import { lastTrackerDigestDate, markTrackerDigestSent } from './state.mjs';
import { log } from './log.mjs';

const TIMEZONE = 'America/Chicago';
const HOUR = 22;
let lastAttemptAt = 0;

export function trackerDigestMessage({ date, applications, interviews }) {
  const current = interviews.today || { total: 0, counts: {} };
  const c = current.counts || {};
  const week = interviews.counts || {};
  return [
    `<b>AIM tracker · ${escapeHtml(date)} (Central)</b>`,
    '',
    `<b>Today</b>`,
    `Application confirmation emails: <b>${applications.today || 0}</b>`,
    `New interview roles: <b>${current.total || 0}</b>`,
    `Remote ${c.remote || 0} · Hybrid ${c.hybrid || 0} · On site ${c.onsite || 0} · Unknown ${c.unknown || 0}`,
    '',
    `<b>Last 7 days</b>`,
    `Confirmation emails: ${applications.last7d || 0}`,
    `Interview roles: ${interviews.total || 0} (remote ${week.remote || 0}, hybrid ${week.hybrid || 0}, on site ${week.onsite || 0}, unknown ${week.unknown || 0})`,
    '',
    'Confirmation counts are estimates from email; unknown roles have no verified work location.'
  ].join('\n');
}

/** Runs from the watcher loop. Catches up before midnight if AIM starts late. */
export async function maybeSendTrackerDigest(config, {
  now = Date.now(), getLastSent = lastTrackerDigestDate, markSent = markTrackerDigestSent,
  sender = telegram.send, isAvailable = telegram.available,
  getApplications = applicationTracker, getInterviews = interviewTracker, retryIntervalMs = 60_000
} = {}) {
  if (config.notify?.trackerDigest?.enabled !== true || !isAvailable(config)) return false;
  const { date, hour } = localDay(now, TIMEZONE);
  if (hour < HOUR || getLastSent() === date || now - lastAttemptAt < retryIntervalMs) return false;
  lastAttemptAt = now;
  const applications = getApplications({ now, timezone: TIMEZONE });
  const interviews = getInterviews({ now, timezone: TIMEZONE });
  const result = await sender({ category: 'TRACKER_DIGEST', urgent: false,
    html: trackerDigestMessage({ date, applications, interviews }) }, config);
  if (!result?.ok) {
    log(`watcher: tracker digest failed for ${date}: ${result?.error || 'unknown error'}`, { name: 'watcher' });
    return false;
  }
  markSent(date);
  log(`watcher: tracker digest sent for ${date}`, { name: 'watcher' });
  return true;
}
