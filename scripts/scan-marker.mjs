/** A short-lived cross-process signal so the watcher leaves scan mail alone. */
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, ensureDirs } from './os-paths.mjs';
import { processAlive } from './state.mjs';

const file = join(DATA_DIR, 'scan-now-active');
const STALE_MS = 10 * 60 * 1000;

export function scanActive() {
  try {
    if (!existsSync(file) || Date.now() - statSync(file).mtimeMs >= STALE_MS) return false;
    return process.platform === 'win32' || processAlive(Number(readFileSync(file, 'utf8')));
  }
  catch { return false; }
}

export function markScanActive() {
  ensureDirs();
  if (scanActive()) return false;
  writeFileSync(file, String(process.pid), 'utf8');
  return true;
}

export function touchScanActive() {
  try { utimesSync(file, new Date(), new Date()); } catch { /* scan can finish first */ }
}

export function clearScanActive() {
  try { rmSync(file, { force: true }); } catch { /* stale marker expires */ }
}
