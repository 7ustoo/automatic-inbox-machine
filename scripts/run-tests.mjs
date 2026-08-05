#!/usr/bin/env node
/**
 * Test entry point: syntax check, then the node:test suite.
 *
 * No third-party test framework on purpose — Node's built-in runner covers this
 * and keeps the dependency tree to the three packages that actually touch mail.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './os-paths.mjs';

function step(label, command, args) {
  process.stdout.write(`\n── ${label} ${'─'.repeat(Math.max(0, 58 - label.length))}\n`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', encoding: 'utf8' });
  return result.status === 0;
}

const syntaxOk = step('syntax', process.execPath, [join(ROOT, 'scripts', 'check-syntax.mjs')]);
if (!syntaxOk) {
  process.stderr.write('\nSyntax check failed — not running the suite.\n');
  process.exit(1);
}

// Files are enumerated rather than passing the directory: Node's --test
// directory discovery is version-dependent, and an explicit list also makes the
// run order stable.
const testDir = join(ROOT, 'scripts', '__tests__');
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => relative(ROOT, join(testDir, name)));

if (!testFiles.length) {
  process.stderr.write('No test files found in scripts/__tests__.\n');
  process.exit(1);
}

const testsOk = step('node:test', process.execPath, ['--test', ...testFiles]);

process.stdout.write('\n');
if (!testsOk) {
  process.stderr.write('Tests failed.\n');
  process.exit(1);
}
process.stdout.write('All green.\n');
