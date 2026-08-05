#!/usr/bin/env node
/**
 * Removes the agent's footprint outside this directory — the scheduler entries —
 * and optionally the local data.
 *
 * Deliberately conservative: it never touches your mailbox, never removes labels
 * it created, and leaves `data/` and `.env` alone unless you explicitly ask. The
 * archived mail stays archived and stays recoverable.
 */
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { DATA_DIR, LOG_DIR } from './os-paths.mjs';
import { unregister } from './scheduler-register.mjs';

const purge = process.argv.includes('--purge');
const yes = process.argv.includes('--yes');
const out = (text = '') => process.stdout.write(`${text}\n`);

async function confirm(question) {
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer.startsWith('y');
}

out('');
out('  Removing scheduler entries…');
for (const result of unregister()) {
  out(`  ${result.ok ? 'ok  ' : '--  '} ${result.name}${result.ok ? '' : ' (was not registered)'}`);
}

if (purge) {
  out('');
  out('  --purge will delete:');
  out(`    ${DATA_DIR}`);
  out(`    ${LOG_DIR}`);
  out('');
  out('  That includes your submission history, which is what the duplicate');
  out('  detection is built on. Deleting it means the agent forgets who has');
  out('  already submitted you where.');
  out('');
  if (await confirm('  Delete local data and logs?')) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(LOG_DIR, { recursive: true, force: true });
    out('  Deleted.');
  } else {
    out('  Kept.');
  }
} else {
  out('');
  out('  Left in place: config.json, .env, data/, logs/');
  out('  Add --purge to remove data and logs as well.');
}

out('');
out('  Nothing was changed in your mailbox. Archived mail is still archived and');
out('  still recoverable; the labels this created remain.');
out('');
out('  To finish, delete this directory.');
out('');
