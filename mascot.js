/**
 * Loads custom mascot frames from claude-link/mascot/<mood>.png and encodes them
 * for the GameGo: 32x32, 4 bits per pixel, MakeCode Arcade's 16-colour palette,
 * low nibble = left pixel, colour 0 = transparent.
 *
 * Images of any size are scaled (nearest neighbour) to fit 32x32, keeping the
 * aspect ratio, centred horizontally and sitting on the bottom edge.
 * Pixels with alpha < 128 become transparent; others snap to the nearest colour.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MOODS = ['sleep', 'idle', 'work', 'alert', 'happy', 'curious'];
const SIZE = 32;
const FRAME_BYTES = (SIZE * SIZE) / 2;

// MakeCode Arcade default palette (index 0 is transparent)
const PALETTE = [
  null, [0xff, 0xff, 0xff], [0xff, 0x21, 0x21], [0xff, 0x93, 0xc4], [0xff, 0x81, 0x35],
  [0xff, 0xf6, 0x09], [0x24, 0x9c, 0xa3], [0x78, 0xdc, 0x52], [0x00, 0x3f, 0xad],
  [0x87, 0xf2, 0xff], [0x8e, 0x2e, 0xc4], [0xa4, 0x83, 0x9f], [0x5c, 0x40, 0x6c],
  [0xe5, 0xcd, 0xc4], [0x91, 0x46, 0x3d], [0x00, 0x00, 0x00],
];

function nearest(r, g, b) {
  let best = 1, bestD = Infinity;
  for (let i = 1; i < PALETTE.length; i++) {
    const [pr, pg, pb] = PALETTE[i];
    // weighted RGB distance (closer to perceived difference than plain RGB)
    const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Encode an RGBA image ({width, height, data}) into a 512-byte frame + index grid. */
function encode(img) {
  const scale = Math.min(SIZE / img.width, SIZE / img.height, 1) || 1;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const ox = Math.floor((SIZE - w) / 2);
  const oy = SIZE - h;
  const idx = new Uint8Array(SIZE * SIZE); // 0 = transparent
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const sy = Math.min(img.height - 1, Math.floor(y / scale));
      const o = (sy * img.width + sx) * 4;
      const a = img.data[o + 3];
      if (a < 128) continue;
      idx[(oy + y) * SIZE + ox + x] = nearest(img.data[o], img.data[o + 1], img.data[o + 2]);
    }
  }
  const buf = Buffer.alloc(FRAME_BYTES);
  for (let p = 0; p < FRAME_BYTES; p++) buf[p] = idx[p * 2] | (idx[p * 2 + 1] << 4);
  return { buf, idx };
}

/** Load all moods from dir. Returns { mask, frames: Buffer[6], found: string[], errors: string[] }. */
function loadMascot(dir) {
  let PNG;
  try { ({ PNG } = require('pngjs')); } catch (e) {
    return { mask: 0, frames: [], found: [], errors: ['pngjs missing — run: npm install'] };
  }
  const out = { mask: 0, frames: MOODS.map(() => Buffer.alloc(FRAME_BYTES)), found: [], errors: [] };
  for (let i = 0; i < MOODS.length; i++) {
    const file = path.join(dir, MOODS[i] + '.png');
    if (!fs.existsSync(file)) continue;
    try {
      const png = PNG.sync.read(fs.readFileSync(file));
      out.frames[i] = encode(png).buf;
      out.mask |= 1 << i;
      out.found.push(MOODS[i]);
    } catch (e) {
      out.errors.push(`${MOODS[i]}.png: ${e.message}`);
    }
  }
  return out;
}

/** Render an index grid back to a PNG buffer (used for previews / tests). */
function previewPng(idx, scale = 4) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width: SIZE * scale, height: SIZE * scale });
  for (let y = 0; y < SIZE * scale; y++) {
    for (let x = 0; x < SIZE * scale; x++) {
      const c = idx[Math.floor(y / scale) * SIZE + Math.floor(x / scale)];
      const o = (y * SIZE * scale + x) * 4;
      const rgb = c ? PALETTE[c] : [0, 0, 0];
      png.data[o] = rgb[0]; png.data[o + 1] = rgb[1]; png.data[o + 2] = rgb[2]; png.data[o + 3] = c ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

module.exports = { MOODS, SIZE, FRAME_BYTES, PALETTE, encode, loadMascot, previewPng };
