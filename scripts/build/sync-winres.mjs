#!/usr/bin/env node
/**
 * Rewrites wrapper/winres/winres.json's version fields from package.json.
 *
 * The .exe carries its own version resource — that is what Explorer's Details tab
 * and the taskbar read. Hand-maintaining it in a second file guarantees it drifts,
 * and a binary that claims a version it is not is worse than one with no version
 * at all. package.json stays the single source of truth.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../os-paths.mjs';
import { stripBom } from '../normalize.mjs';

const version = JSON.parse(stripBom(readFileSync(join(ROOT, 'package.json'), 'utf8'))).version;

// Win32 version resources need a four-part numeric quad.
const quad = `${version.split('-')[0].split('.').concat('0', '0', '0').slice(0, 4).join('.')}`;

const path = join(ROOT, 'wrapper', 'winres', 'winres.json');
const manifest = JSON.parse(stripBom(readFileSync(path, 'utf8')));

const fixed = manifest.RT_VERSION?.['#1']?.['0000']?.fixed;
if (fixed) {
  fixed.file_version = quad;
  fixed.product_version = quad;
}

const info = manifest.RT_VERSION?.['#1']?.['0000']?.info?.['0409'];
if (info) {
  info.FileVersion = quad;
  info.ProductVersion = version;
}

const identity = manifest.RT_MANIFEST?.['#1']?.['0409']?.identity;
if (identity) identity.version = quad;

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`winres.json synced to ${version} (${quad})\n`);
