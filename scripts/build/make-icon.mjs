#!/usr/bin/env node
/**
 * Generates installer/logo.ico procedurally.
 *
 * No image toolchain, no committed binary blob to trust — the icon is code, so a
 * reviewer can read what ships in the installer's title bar and on the user's
 * desktop. Uses uncompressed 32-bit BGRA DIB entries, which every Windows
 * version reads without needing PNG-in-ICO support.
 *
 * Run: node scripts/build/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { ROOT } from '../os-paths.mjs';

const SIZES = [16, 32, 48, 64, 128];

/** GitHub-console accent blue, matching the dashboard's --accent. */
const ACCENT = [0x25, 0x63, 0xd1];
const ACCENT_DARK = [0x1a, 0x45, 0x99];
const PAPER = [0xf6, 0xf8, 0xfa];
const INK = [0x1f, 0x23, 0x28];
const LIVE = [0x3f, 0xb9, 0x50];

function lerp(a, b, t) {
  return a.map((channel, index) => Math.round(channel + (b[index] - channel) * t));
}

/** Coverage of a pixel by a rounded rect, sampled 3x3 for cheap antialiasing. */
function roundedRectCoverage(x, y, size, inset, radius) {
  const min = inset;
  const max = size - inset;
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      if (px < min || px > max || py < min || py > max) continue;
      // Distance into each corner's circle.
      const cx = Math.min(Math.max(px, min + radius), max - radius);
      const cy = Math.min(Math.max(py, min + radius), max - radius);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2) hits += 1;
    }
  }
  return hits / 9;
}

/**
 * Draws one square frame: a rounded accent tile, a white envelope, and a small
 * live-status dot in the corner. Returns BGRA rows top-down.
 */
function drawFrame(size) {
  const pixels = new Uint8Array(size * size * 4);
  const inset = Math.max(0.5, size * 0.045);
  const radius = size * 0.22;

  // Below ~24px there are not enough pixels for a flap, a gradient, and a status
  // dot to coexist — they turn into noise. Small sizes get a bolder, simpler
  // glyph and no dot, which is the difference between a recognisable envelope in
  // the taskbar and a blue smudge.
  const tiny = size < 24;

  const eLeft = size * (tiny ? 0.16 : 0.22);
  const eRight = size * (tiny ? 0.84 : 0.78);
  const eTop = size * (tiny ? 0.28 : 0.32);
  const eBottom = size * (tiny ? 0.72 : 0.70);
  const eWidth = eRight - eLeft;
  const eHeight = eBottom - eTop;
  const stroke = tiny ? 1 : Math.max(1, size * 0.055);

  const dotR = size * 0.13;
  const dotX = size * 0.775;
  const dotY = size * 0.765;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const coverage = roundedRectCoverage(x, y, size, inset, radius);
      if (coverage <= 0) continue;

      // Vertical gradient on the tile so it does not read as flat. Skipped at
      // tiny sizes, where it only muddies the contrast against the glyph.
      let colour = tiny ? ACCENT : lerp(ACCENT, ACCENT_DARK, y / size);
      let alpha = coverage;

      const px = x + 0.5;
      const py = y + 0.5;

      const insideEnvelope = px >= eLeft && px <= eRight && py >= eTop && py <= eBottom;
      if (insideEnvelope) {
        if (tiny) {
          // Solid white body with one dark V. Fewer marks, far more legible.
          const t = (px - eLeft) / eWidth;
          const vY = eTop + (t <= 0.5 ? t * 2 : (1 - t) * 2) * eHeight * 0.8;
          colour = Math.abs(py - vY) <= 0.9 && py <= eTop + eHeight * 0.85 ? ACCENT_DARK : PAPER;
        } else {
          const onBorder =
            px <= eLeft + stroke || px >= eRight - stroke || py <= eTop + stroke || py >= eBottom - stroke;

          // The flap: two diagonals from the top corners meeting at the centre.
          const t = (px - eLeft) / eWidth;
          const flapY = eTop + (t <= 0.5 ? t * 2 : (1 - t) * 2) * eHeight * 0.72;
          const onFlap = Math.abs(py - flapY) <= stroke * 0.75 && py <= eTop + eHeight * 0.75;

          if (onBorder || onFlap) colour = PAPER;
          else colour = lerp(colour, INK, 0.18);
        }
      }

      // Status dot, drawn over everything with a dark rim for separation. Omitted
      // at tiny sizes — it would consume a fifth of the glyph.
      if (!tiny) {
        const dotDistance = Math.sqrt((px - dotX) ** 2 + (py - dotY) ** 2);
        if (dotDistance <= dotR) {
          colour = dotDistance > dotR - Math.max(1, size * 0.03) ? lerp(LIVE, INK, 0.55) : LIVE;
          alpha = 1;
        }
      }

      pixels[offset] = colour[2]; // B
      pixels[offset + 1] = colour[1]; // G
      pixels[offset + 2] = colour[0]; // R
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

/** One ICO image entry: BITMAPINFOHEADER + bottom-up BGRA + padded AND mask. */
function encodeDib(size, pixels) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // doubled: colour data + mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  const colour = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceRow = (size - 1 - y) * size * 4;
    pixels.subarray(sourceRow, sourceRow + size * 4).forEach((byte, index) => {
      colour[y * size * 4 + index] = byte;
    });
  }

  // 1-bit AND mask, rows padded to 4 bytes. Zeroed: the 32-bit alpha governs.
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size);

  return Buffer.concat([header, colour, mask]);
}

function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, data: encodeDib(size, drawFrame(size)) }));

  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(images.length, 4);

  let offset = directory.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette count
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4); // planes
    directory.writeUInt16LE(32, entry + 6); // bpp
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([directory, ...images.map((image) => image.data)]);
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Minimal PNG encoder.
 *
 * Needed because go-winres — which embeds the icon resource into the .exe so
 * Explorer and the taskbar show it — decodes its input with Go's image package,
 * and that cannot read the uncompressed BMP-in-ICO form above. Windows itself is
 * perfectly happy with the .ico; the build tool is not.
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encodes a frame (BGRA, top-down) as a 32-bit RGBA PNG. */
function encodePng(size, bgra) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(6, 9); // colour type: RGBA
  header.writeUInt8(0, 10); // deflate
  header.writeUInt8(0, 11); // adaptive filtering
  header.writeUInt8(0, 12); // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const source = (y * size + x) * 4;
      const target = rowStart + 1 + x * 4;
      raw[target] = bgra[source + 2]; // R
      raw[target + 1] = bgra[source + 1]; // G
      raw[target + 2] = bgra[source]; // B
      raw[target + 3] = bgra[source + 3]; // A
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

const ico = buildIco(SIZES);

// Written to both locations from one generator rather than copied by a build
// step: go:embed cannot reference a path outside its module directory, so the Go
// wrapper needs its own copy, and a manual copy step is a thing that silently
// goes stale.
const targets = [join(ROOT, 'installer', 'logo.ico'), join(ROOT, 'wrapper', 'logo.ico')];

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, ico);
  process.stdout.write(`Wrote ${target} — ${SIZES.join('/')}px, ${ico.length} bytes\n`);
}

// 256px PNG for go-winres, which embeds the .exe's own icon resource.
const png = encodePng(256, drawFrame(256));
const pngTarget = join(ROOT, 'wrapper', 'logo.png');
writeFileSync(pngTarget, png);
process.stdout.write(`Wrote ${pngTarget} — 256px PNG, ${png.length} bytes\n`);
