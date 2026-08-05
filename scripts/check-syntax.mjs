#!/usr/bin/env node
/**
 * Fast syntax gate. Runs `node --check` over every .mjs in the project so a typo
 * is caught in a second instead of at 3am when the watcher tries to load the
 * module that has it.
 *
 * `node --check` parses without executing, which is the whole point — importing
 * these modules would start servers and open sockets.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './os-paths.mjs';

const SKIP_DIRS = new Set(['node_modules', 'data', 'logs', '.git', 'installer']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith('.mjs')) out.push(path);
  }
  return out;
}

const files = walk(join(ROOT, 'scripts')).sort();
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push({ file: relative(ROOT, file), error: (result.stderr || '').trim() });
  }
}

if (failures.length) {
  for (const failure of failures) {
    process.stderr.write(`\n✖ ${failure.file}\n${failure.error}\n`);
  }
  process.stderr.write(`\n${failures.length} of ${files.length} file(s) failed to parse.\n`);
  process.exit(1);
}

process.stdout.write(`✔ ${files.length} module(s) parse cleanly.\n`);
