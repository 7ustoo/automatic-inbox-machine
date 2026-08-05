/**
 * Optional read-only bridge to automatic-munyun-machine.
 *
 * AMM is the outbound half of the same problem — it finds and ranks roles. This
 * reads the roles it has already surfaced so the inbox agent can say "AMM
 * already showed you this one at this company" alongside the agency collisions.
 *
 * Hard constraints, because AMM is a separate shipped product:
 *   - Read-only. This module never writes into AMM's directory.
 *   - No imports from AMM. It reads documented JSON shapes and nothing else.
 *   - Never throws. A missing, renamed, or reshaped AMM file degrades to [].
 *
 * Shapes consumed (AMM v7.x):
 *   data/profiles/<profile>/last-batch.json      { date, jobs: [{ title, company, ... }] }
 *   data/profiles/<profile>/batch-archive/*.json same shape, older batches
 *   data/profiles/<profile>/seen-jobs.json       { jobs: { <url>: { firstSeenAt } } }
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.mjs';
import { normalizeCompany, normalizeTitle } from './normalize.mjs';

const MAX_ARCHIVE_FILES = 40;

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function listDirSafe(path) {
  try {
    return existsSync(path) ? readdirSync(path) : [];
  } catch {
    return [];
  }
}

/** True if the path looks like an AMM checkout. */
export function looksLikeAmm(root) {
  if (!root) return false;
  try {
    const pkg = readJsonSafe(join(root, 'package.json'));
    if (pkg?.name === 'automatic-munyun-machine') return true;
    return existsSync(join(root, 'data', 'profiles')) && existsSync(join(root, 'scripts', 'daily-batch.mjs'));
  } catch {
    return false;
  }
}

/** Guesses AMM's location: configured path, then a sibling of this repo. */
export function resolveAmmPath(configuredPath, repoRoot) {
  const candidates = [configuredPath, join(repoRoot, '..', 'automatic-munyun-machine')].filter(Boolean);
  for (const candidate of candidates) {
    if (looksLikeAmm(candidate)) return candidate;
  }
  return '';
}

function jobsFromBatch(batch, sourceLabel) {
  const jobs = Array.isArray(batch?.jobs) ? batch.jobs : [];
  const date = batch?.date || batch?.generatedAt || '';
  return jobs
    .map((job) => ({
      titleRaw: String(job?.title || '').slice(0, 160),
      titleNorm: normalizeTitle(job?.title),
      clientRaw: String(job?.company || '').slice(0, 120),
      clientNorm: normalizeCompany(job?.company),
      matchPct: Number(job?.matchPct) || 0,
      url: String(job?.directUrl || job?.viewjobUrl || '').slice(0, 400),
      surfacedAt: date,
      source: `amm:${sourceLabel}`
    }))
    .filter((job) => job.titleNorm && job.clientNorm);
}

/**
 * Every role AMM has surfaced, newest batch first, deduped by title+company.
 * Returns [] for any failure — callers treat an empty bridge as "no signal".
 */
export function loadAmmHistory(ammRoot, { maxAgeDays = 120 } = {}) {
  if (!looksLikeAmm(ammRoot)) return [];

  const profilesDir = join(ammRoot, 'data', 'profiles');
  const profiles = listDirSafe(profilesDir).filter((name) => {
    try {
      return statSync(join(profilesDir, name)).isDirectory();
    } catch {
      return false;
    }
  });

  const cutoff = Date.now() - maxAgeDays * 86400000;
  const seen = new Set();
  const out = [];

  for (const profile of profiles) {
    const profileDir = join(profilesDir, profile);

    const sources = [{ path: join(profileDir, 'last-batch.json'), label: `${profile}/last-batch` }];

    const archiveDir = join(profileDir, 'batch-archive');
    const archives = listDirSafe(archiveDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, MAX_ARCHIVE_FILES);
    for (const name of archives) sources.push({ path: join(archiveDir, name), label: `${profile}/archive/${name}` });

    for (const { path, label } of sources) {
      const batch = readJsonSafe(path);
      if (!batch) continue;
      for (const job of jobsFromBatch(batch, label)) {
        const stamp = Date.parse(job.surfacedAt);
        if (Number.isFinite(stamp) && stamp < cutoff) continue;
        const key = `${job.titleNorm}|${job.clientNorm}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(job);
      }
    }
  }

  if (out.length) log(`amm-bridge: loaded ${out.length} role(s) from ${profiles.length} AMM profile(s)`, { name: 'bridge', stdout: false });
  return out;
}

/**
 * Adapts AMM rows into the shape checkDuplicate() expects for its `reqs` list,
 * tagged so the alert text can say where the signal came from.
 */
export function ammRowsAsReqs(rows) {
  return rows.map((row) => ({
    fingerprint: '',
    titleRaw: row.titleRaw,
    titleNorm: row.titleNorm,
    clientRaw: row.clientRaw,
    clientNorm: row.clientNorm,
    agencyRaw: 'direct posting',
    agencyNorm: '',
    recruiterDomain: '',
    accountId: '',
    threadId: '',
    jdSample: '',
    jdSketch: [],
    firstSeenAt: row.surfacedAt || '',
    ts: row.surfacedAt || '',
    _fromAmm: true,
    _url: row.url
  }));
}

/** Convenience: bridge rows ready to merge into the dedupe corpus. */
export function ammDedupeCorpus(config, repoRoot) {
  if (!config?.ammBridge?.enabled) return [];
  const root = resolveAmmPath(config.ammBridge.path, repoRoot);
  if (!root) {
    log('amm-bridge: enabled but no AMM install found — set ammBridge.path', { name: 'bridge' });
    return [];
  }
  return ammRowsAsReqs(loadAmmHistory(root));
}
