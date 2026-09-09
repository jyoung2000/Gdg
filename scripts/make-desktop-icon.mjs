#!/usr/bin/env node
/**
 * Draw the Meridian application icon.
 *
 * A committed script rather than a committed binary, so the icon can be
 * reasoned about, adjusted and re-derived. It writes one 1024×1024 PNG; the
 * platform sizes come from `tauri icon`, which is better at rescaling than
 * anything worth writing here.
 *
 * The mark is a meridian: a sphere crossed by one great circle, which is the
 * line the product is named after. It has to survive being 16 pixels wide in a
 * taskbar, so it is two shapes and one accent — anything finer turns to mush at
 * that size, and a taskbar is where most people will actually see it.
 *
 *   node scripts/make-desktop-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 1024;
const OUT = resolve(ROOT, 'apps/desktop/icon-source.png');

/* The product's own palette, taken from the design tokens rather than invented. */
const INK = [11, 15, 25]; // deep slate ground
const RING = [232, 236, 245]; // near-white sphere outline
const ACCENT = [90, 140, 255]; // the accent blue the UI already uses

const pixels = Buffer.alloc(SIZE * SIZE * 4);

function put(x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || alpha <= 0) return;
  const i = (y * SIZE + x) * 4;
  const a = Math.min(1, alpha);
  // Source-over onto whatever is already there, so strokes layer cleanly.
  const dstA = pixels[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c++) {
    pixels[i + c] = Math.round((([r, g, b][c] * a) + pixels[i + c] * dstA * (1 - a)) / outA);
  }
  pixels[i + 3] = Math.round(outA * 255);
}

/** Coverage of a pixel by a shape, sampled 3×3. Cheap, and enough at this size. */
function coverage(x, y, inside) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits++;
    }
  }
  return hits / 9;
}

const C = SIZE / 2;

/* 1. The ground: a squircle, which reads as an app icon on every platform. */
const R = SIZE * 0.46;
const squircle = (px, py) => {
  const dx = Math.abs(px - C) / R;
  const dy = Math.abs(py - C) / R;
  // n=4 is the superellipse most platform icons approximate.
  return dx ** 4 + dy ** 4 <= 1;
};

/* 2. The sphere. */
const SPHERE = SIZE * 0.30;
const STROKE = SIZE * 0.030;
const ringBand = (px, py) => {
  const d = Math.hypot(px - C, py - C);
  return Math.abs(d - SPHERE) <= STROKE / 2;
};

/* 3. The meridian: one great circle seen edge-on, an ellipse across the sphere. */
const MERIDIAN_W = SPHERE * 0.44;
const meridianBand = (px, py) => {
  const dx = (px - C) / MERIDIAN_W;
  const dy = (py - C) / SPHERE;
  const d = Math.hypot(dx, dy);
  // The band has to be scaled back into pixels or it thins out at the poles.
  const half = STROKE / 2 / SPHERE;
  return Math.abs(d - 1) <= half * 1.35;
};

/* 4. The equator, cut short so the mark is not a target. */
const equatorBand = (px, py) => {
  if (Math.abs(px - C) > SPHERE * 0.98) return false;
  const dx = (px - C) / SPHERE;
  const dy = (py - C) / (SPHERE * 0.30);
  return Math.abs(Math.hypot(dx, dy) - 1) <= STROKE / 2 / (SPHERE * 0.30) * 0.42;
};

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const ground = coverage(x, y, squircle);
    if (ground > 0) put(x, y, INK, ground);
  }
}
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!squircle(x + 0.5, y + 0.5)) continue;
    const ring = coverage(x, y, ringBand);
    if (ring > 0) put(x, y, RING, ring * 0.92);
    const eq = coverage(x, y, equatorBand);
    if (eq > 0) put(x, y, RING, eq * 0.45);
    // The meridian last and in the accent colour: it is the thing the product
    // is named for, so it is the thing that should read first.
    const mer = coverage(x, y, meridianBand);
    if (mer > 0) put(x, y, ACCENT, mer);
  }
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// One filter byte (0 = none) per scanline, which is what the format requires.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
process.stdout.write(`  wrote ${OUT}  ${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(0)} KB\n`);
process.stdout.write(`  next: pnpm exec tauri icon ${OUT} --output apps/desktop/src-tauri/icons\n`);
