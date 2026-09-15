/**
 * Generates the Windows application icon: `build/icon.ico` (+ `build/icon.png`).
 *
 * Run with `npm run assets:icon`.
 *
 * Why generate it instead of shipping a binary:
 *   - zero dependencies. Node's `zlib` plus the PNG encoder in `tools/lib/png.mjs`
 *     is the whole toolchain, so the icon is reproducible from source and there
 *     is no design file to lose.
 *   - the default Electron icon is the single loudest "this is an unfinished
 *     Electron app" signal a desktop build can carry, and `build/` did not exist,
 *     so every package made so far shipped that default.
 *
 * The mark is a reticle (ring + four ticks + centre dot) on a dark rounded
 * plaque: it survives being drawn at 16x16, and it is unmistakably not the
 * Electron atom.
 *
 * Format notes:
 *   - `electron-builder` requires a 256x256 entry in the `.ico`.
 *   - entries of 128 and 256 px are stored as PNG (smaller, and supported by
 *     Windows Vista and later); the smaller sizes are stored as classic 32-bit
 *     DIBs, which is the layout every icon tool emits and the most compatible.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from './lib/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Samples per axis per output pixel. 4 means 16 subsamples: plenty for curves. */
const SUPERSAMPLE = 4;

/** Uses PNG for the large entries; DIB below that. */
const PNG_FROM_SIZE = 128;

// --- palette -----------------------------------------------------------------
// Kept in one place so the mark can be recoloured without hunting through maths.
const PLAQUE_TOP = [31, 43, 62];
const PLAQUE_BOTTOM = [11, 14, 20];
const RIM = [150, 175, 210];
const RIM_ALPHA = 0.34;
const ACCENT_TOP = [111, 211, 255];
const ACCENT_BOTTOM = [70, 166, 255];

// --- geometry (normalised to a unit square) ----------------------------------
// Tuned so that the ring stays a *ring* at 16 px: a thicker annulus turns into a
// cyan disc once one pixel of antialiasing covers the hole.
const CORNER_RADIUS = 0.2;
const RIM_INSET = 0.016;
const RIM_WIDTH = 0.012;
const RING_RADIUS = 0.285;
const RING_HALF_WIDTH = 0.032;
const TICK_INNER = 0.345;
const TICK_OUTER = 0.415;
const DOT_RADIUS = 0.05;

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const mix = (a, b, t) => a + (b - a) * t;

/**
 * Signed-distance test for a rounded square filling the unit square.
 *
 * Written as an SDF rather than as a per-axis branch: the branch form ("if
 * either axis is inside the flat span, the other one decides") silently clips the
 * shape to a smaller centred square, which is exactly the bug this replaced.
 *
 * @param {number} radius corner radius in unit coordinates
 * @returns {boolean} true when the point is inside
 */
function inRoundedSquare(x, y, radius) {
  const qx = Math.abs(x - 0.5) - (0.5 - radius);
  const qy = Math.abs(y - 0.5) - (0.5 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius <= 0;
}

/** Distance from a point to a segment, used for the rounded tick marks. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : clamp01((wx * vx + wy * vy) / lengthSquared);
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  return Math.hypot(px - cx, py - cy);
}

/** Vertical two-stop gradient over the unit square. */
function gradient(top, bottom, y) {
  const t = clamp01(y);
  return [mix(top[0], bottom[0], t), mix(top[1], bottom[1], t), mix(top[2], bottom[2], t)];
}

/**
 * Composites one point of the mark.
 *
 * @returns {[number, number, number, number]} straight (non-premultiplied) RGBA, 0..255
 */
function samplePoint(x, y) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;

  const blend = (color, alpha) => {
    if (alpha <= 0) return;
    const src = alpha;
    const out = src + a * (1 - src);
    if (out <= 0) return;
    r = (color[0] * src + r * a * (1 - src)) / out;
    g = (color[1] * src + g * a * (1 - src)) / out;
    b = (color[2] * src + b * a * (1 - src)) / out;
    a = out;
  };

  // Plaque.
  if (inRoundedSquare(x, y, CORNER_RADIUS)) {
    const base = gradient(PLAQUE_TOP, PLAQUE_BOTTOM, y);
    // A soft vignette keeps the flat fill from looking like a solid swatch.
    const dist = Math.hypot(x - 0.5, y - 0.5) / 0.72;
    const shade = 1 - 0.35 * clamp01(dist) ** 2;
    blend([base[0] * shade, base[1] * shade, base[2] * shade], 1);

    // Inner rim: only within the plaque, so it reads as a bevel.
    const rimOuter = inRoundedSquare(x, y, CORNER_RADIUS - RIM_INSET);
    const rimInner = inRoundedSquare(x, y, CORNER_RADIUS - RIM_INSET - RIM_WIDTH);
    if (rimOuter && !rimInner) blend(RIM, RIM_ALPHA);
  }

  const accent = gradient(ACCENT_TOP, ACCENT_BOTTOM, y);

  // Ring.
  const radius = Math.hypot(x - 0.5, y - 0.5);
  if (Math.abs(radius - RING_RADIUS) <= RING_HALF_WIDTH) blend(accent, 1);

  // Four ticks.
  const tickHalfWidth = RING_HALF_WIDTH;
  const ticks = [
    [0.5, 0.5 - TICK_INNER, 0.5, 0.5 - TICK_OUTER],
    [0.5, 0.5 + TICK_INNER, 0.5, 0.5 + TICK_OUTER],
    [0.5 - TICK_INNER, 0.5, 0.5 - TICK_OUTER, 0.5],
    [0.5 + TICK_INNER, 0.5, 0.5 + TICK_OUTER, 0.5],
  ];
  for (const [ax, ay, bx, by] of ticks) {
    if (distanceToSegment(x, y, ax, ay, bx, by) <= tickHalfWidth) {
      blend(accent, 1);
      break;
    }
  }

  // Centre dot.
  if (radius <= DOT_RADIUS) blend([240, 248, 255], 1);

  return [r, g, b, a * 255];
}

/** Rasterises the mark at `size` px with supersampled coverage. */
export function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const step = 1 / SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) * step) / size;
          const y = (py + (sy + 0.5) * step) / size;
          const [r, g, b, a] = samplePoint(x, y);
          const alpha = a / 255;
          // Accumulate premultiplied, then un-premultiply once at the end.
          sumR += r * alpha;
          sumG += g * alpha;
          sumB += b * alpha;
          sumA += alpha;
        }
      }

      const out = (py * size + px) * 4;
      const coverage = sumA / samples;
      if (sumA > 0) {
        rgba[out] = Math.round(clamp01(sumR / sumA / 255) * 255);
        rgba[out + 1] = Math.round(clamp01(sumG / sumA / 255) * 255);
        rgba[out + 2] = Math.round(clamp01(sumB / sumA / 255) * 255);
      }
      rgba[out + 3] = Math.round(clamp01(coverage) * 255);
    }
  }

  return rgba;
}

/**
 * Classic 32-bit bottom-up DIB for an ICO entry, plus the (all-zero, i.e.
 * "use the alpha channel") AND mask every reader expects to find.
 */
function encodeDib(rgba, size) {
  const xorSize = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const andSize = maskStride * size;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: XOR + AND stacked
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression: BI_RGB
  header.writeUInt32LE(xorSize + andSize, 20); // biSizeImage

  const xor = Buffer.alloc(xorSize);
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4; // bottom-up
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  return Buffer.concat([header, xor, Buffer.alloc(andSize)]);
}

/** Assembles an ICO container from per-size payloads. */
export function encodeIco(entries) {
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(entries.length, 4);

  let offset = directory.length;
  entries.forEach((entry, index) => {
    const base = 6 + index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size; // 0 encodes 256
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0; // palette size
    directory[base + 3] = 0; // reserved
    directory.writeUInt16LE(1, base + 4); // colour planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

export function buildEntries(sizes = SIZES) {
  return sizes.map((size) => {
    const rgba = renderIcon(size);
    const data = size >= PNG_FROM_SIZE ? encodePng(size, size, rgba) : encodeDib(rgba, size);
    return { size, rgba, data };
  });
}

/** Side of one cell in the review sheet, in pixels. */
const CONTACT_CELL = 128;

/**
 * Lays every shipped size out side by side, each nearest-neighbour scaled into a
 * `CONTACT_CELL` box, over a checkerboard so transparent corners are visible.
 *
 * Nearest-neighbour on purpose: smoothing would hide exactly the artefact this
 * sheet exists to reveal (a ring collapsing into a blob at 16 px).
 */
export function renderContactSheet(entries, cell = CONTACT_CELL) {
  const gap = 10;
  const pad = 10;
  const width = pad * 2 + entries.length * cell + (entries.length - 1) * gap;
  const height = pad * 2 + cell;
  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 88 : 72;
      rgba[i] = checker;
      rgba[i + 1] = checker;
      rgba[i + 2] = checker;
      rgba[i + 3] = 255;
    }
  }

  entries.forEach((entry, index) => {
    const originX = pad + index * (cell + gap);
    for (let y = 0; y < cell; y += 1) {
      for (let x = 0; x < cell; x += 1) {
        const sx = Math.min(entry.size - 1, Math.floor((x * entry.size) / cell));
        const sy = Math.min(entry.size - 1, Math.floor((y * entry.size) / cell));
        const s = (sy * entry.size + sx) * 4;
        const d = ((pad + y) * width + originX + x) * 4;
        const alpha = entry.rgba[s + 3] / 255;
        rgba[d] = Math.round(entry.rgba[s] * alpha + rgba[d] * (1 - alpha));
        rgba[d + 1] = Math.round(entry.rgba[s + 1] * alpha + rgba[d + 1] * (1 - alpha));
        rgba[d + 2] = Math.round(entry.rgba[s + 2] * alpha + rgba[d + 2] * (1 - alpha));
      }
    }
  });

  return { width, height, rgba };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const entries = buildEntries();

  const icoPath = path.join(OUT_DIR, 'icon.ico');
  writeFileSync(icoPath, encodeIco(entries));

  // A plain PNG of the 256 px master, for a human to eyeball without an icon viewer.
  const large = entries.find((entry) => entry.size === 256);
  const pngPath = path.join(OUT_DIR, 'icon.png');
  writeFileSync(pngPath, encodePng(256, 256, large.rgba));

  // Every shipped size, side by side and nearest-neighbour scaled to the same
  // box. This is the check that the mark survives 16x16 — writing it into the
  // generator rather than keeping it as a scratch script is what makes "it is
  // still legible when small" a repeatable claim instead of a one-off look.
  const sheetPath = path.join(OUT_DIR, 'icon-preview.png');
  const sheet = renderContactSheet(entries);
  writeFileSync(sheetPath, encodePng(sheet.width, sheet.height, sheet.rgba));

  console.log(`[icon] wrote ${path.relative(ROOT, icoPath)} (${SIZES.join(', ')} px)`);
  console.log(`[icon] wrote ${path.relative(ROOT, pngPath)}`);
  console.log(`[icon] wrote ${path.relative(ROOT, sheetPath)} (all sizes at ${CONTACT_CELL} px, for review)`);
  console.log(`[icon] 256x256 entry: ${large.data.length} bytes (required by electron-builder)`);
}

// Only when run as a script; importing this module (tests, the preview helper)
// must not write files.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
