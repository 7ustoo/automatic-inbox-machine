/**
 * Read-only AI health for the dashboard.
 *
 * The classifier runs in the watcher process while the dashboard is a separate
 * process, so an API key's presence alone cannot prove that the provider works.
 * The classifier already records every provider failure; this reads the newest
 * provider result without persisting secrets or creating another network call.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR } from './os-paths.mjs';

const LOG_NAMES = ['classify.log', 'watcher-scheduled.log', 'watcher-stdio.log', 'watcher.log'];
const TAIL_CHARS = 160_000;

function friendlyFailure(status, detail) {
  const text = String(detail || '');
  if (/credit balance|billing|purchase credits|insufficient.*(?:credit|quota)/i.test(text)) {
    return 'The provider rejected requests because the API account has no credits.';
  }
  if (status === 401 || /invalid.*(?:key|token)|authentication/i.test(text)) {
    return 'The provider rejected the API key.';
  }
  if (status === 429 || /rate limit|quota/i.test(text)) {
    return 'The provider rate limit or quota has been reached.';
  }
  return `The provider returned HTTP ${status || 'error'}.`;
}

export function aiRuntimeStatus(providerId) {
  const provider = String(providerId || '').replace(/[^a-z0-9_-]/gi, '');
  if (!provider) return { state: 'not_checked', checkedAt: '', message: 'Not checked yet.' };

  const hits = [];
  for (const name of LOG_NAMES) {
    const path = join(LOG_DIR, name);
    if (!existsSync(path)) continue;
    try {
      const size = statSync(path).size;
      const text = readFileSync(path, 'utf8').slice(-TAIL_CHARS);
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes(`classifier: ${provider} API `)) continue;
        const timestamp = line.match(/^\[([^\]]+)\]/)?.[1] || '';
        if (/ API ok\b/.test(line)) {
          hits.push({ timestamp, state: 'working', message: 'AI successfully read the latest checked email.' });
          continue;
        }
        const failure = line.match(/ API (\d+|configuration error) .*?falling back to rules\.\s*(.*)$/);
        if (failure) {
          hits.push({
            timestamp,
            state: 'failed',
            message: friendlyFailure(Number(failure[1]) || 0, failure[2])
          });
        }
      }
    } catch {
      // A locked/rotating log must not break the dashboard.
    }
  }

  hits.sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
  const latest = hits.at(-1);
  return latest
    ? { state: latest.state, checkedAt: latest.timestamp, message: latest.message }
    : { state: 'not_checked', checkedAt: '', message: 'The key has not completed a provider check yet.' };
}

