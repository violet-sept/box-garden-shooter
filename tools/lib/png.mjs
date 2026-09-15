/**
 * Minimal PNG codec + image statistics. Zero dependencies, Node built-ins only.
 *
 * Two consumers, one implementation, so the numbers the acceptance harness
 * asserts on and the picture the icon generator writes are produced by exactly
 * the same byte-level code:
 *
 *   1. `tools/desktop-acceptance.mjs` decodes the PNG that CDP's
 *      `Page.captureScreenshot` returns and asserts on *that*. It has to: the
 *      old probe drew the WebGL canvas into a 2D scratch canvas and read the
 *      pixels back, which is structurally blank whenever the renderer runs with
 *      `preserveDrawingBuffer: false` (see `src/main.ts`) — the drawing buffer is
 *      cleared once the frame has been composited, so `drawImage` sees a
 *      transparent nothing. That made "the canvas is a flat colour" a permanent
 *      false failure while the screenshot of the very same frame showed the
 *      scene. A composited screenshot is also strictly better evidence: it is
 *      what the player sees, so it catches a veil left over the canvas too.
 *
 *   2. `tools/make-icon.mjs` encodes the application icon.
 *
 * Supported PNG subset: 8-bit, non-interlaced, greyscale / RGB / greyscale+alpha
 * / RGBA. That is everything Chromium emits for a screenshot and everything we
 * generate. Anything else throws with the reason instead of guessing.
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour type -> channel count. */
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes 8-bit RGBA pixels as a PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba width * height * 4 bytes, row-major from the top
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`encodePng: bad dimensions ${width}x${height}`);
  }
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new Error(`encodePng: expected ${stride * height} bytes, got ${rgba.length}`);
  }

  // One filter byte per scanline; filter 0 (None) keeps the encoder honest and
  // small, and deflate still compresses flat geometry extremely well.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes a PNG into 8-bit RGBA.
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('decodePng: not a PNG (bad signature)');
  }

  let offset = 8;
  let header = null;
  const idatParts = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filterMethod: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!header) throw new Error('decodePng: no IHDR chunk');
  if (header.bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${header.bitDepth}`);
  if (header.interlace !== 0) throw new Error('decodePng: interlaced PNGs are not supported');
  if (header.compression !== 0) throw new Error(`decodePng: unsupported compression ${header.compression}`);
  if (header.filterMethod !== 0) throw new Error(`decodePng: unsupported filter method ${header.filterMethod}`);
  const channels = CHANNELS_BY_COLOR_TYPE[header.colorType];
  if (!channels) throw new Error(`decodePng: unsupported colour type ${header.colorType}`);
  if (idatParts.length === 0) throw new Error('decodePng: no IDAT data');

  const { width, height } = header;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new Error(`decodePng: pixel data truncated (${raw.length} of ${expected} bytes)`);
  }

  // Undo the per-scanline filters (PNG spec section 9.2).
  const planar = Buffer.alloc(stride * height);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[cursor];
    cursor += 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const byte = raw[cursor + x];
      const a = x >= channels ? planar[rowStart + x - channels] : 0;
      const b = y > 0 ? planar[prevStart + x] : 0;
      const c = x >= channels && y > 0 ? planar[prevStart + x - channels] : 0;
      let value;
      switch (filterType) {
        case 0:
          value = byte;
          break;
        case 1:
          value = byte + a;
          break;
        case 2:
          value = byte + b;
          break;
        case 3:
          value = byte + ((a + b) >> 1);
          break;
        case 4:
          value = byte + paeth(a, b, c);
          break;
        default:
          throw new Error(`decodePng: unknown filter type ${filterType} on row ${y}`);
      }
      planar[rowStart + x] = value & 0xff;
    }
    cursor += stride;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
    const out = i * 4;
    if (channels === 1) {
      rgba[out] = planar[p];
      rgba[out + 1] = planar[p];
      rgba[out + 2] = planar[p];
      rgba[out + 3] = 255;
    } else if (channels === 2) {
      rgba[out] = planar[p];
      rgba[out + 1] = planar[p];
      rgba[out + 2] = planar[p];
      rgba[out + 3] = planar[p + 1];
    } else if (channels === 3) {
      rgba[out] = planar[p];
      rgba[out + 1] = planar[p + 1];
      rgba[out + 2] = planar[p + 2];
      rgba[out + 3] = 255;
    } else {
      rgba[out] = planar[p];
      rgba[out + 1] = planar[p + 1];
      rgba[out + 2] = planar[p + 2];
      rgba[out + 3] = planar[p + 3];
    }
  }

  return { width, height, rgba };
}

/**
 * Luma + opacity statistics for an RGBA buffer.
 *
 * The metric set is deliberately the one the acceptance harness has always
 * asserted on (`mean` / `spread` / `opaqueFraction`), so switching the probe from
 * the WebGL canvas readback to the screenshot keeps the thresholds meaningful
 * rather than silently retuning them.
 *
 * @param {Buffer} rgba
 * @param {number} width
 * @param {number} height
 */
export function imageStats(rgba, width, height) {
  const pixels = width * height;
  if (rgba.length !== pixels * 4) {
    throw new Error(`imageStats: expected ${pixels * 4} bytes, got ${rgba.length}`);
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let opaque = 0;

  for (let i = 0; i < pixels; i += 1) {
    const base = i * 4;
    // Rec. 709 luma, matching the previous canvas probe.
    const luma = 0.2126 * rgba[base] + 0.7152 * rgba[base + 1] + 0.0722 * rgba[base + 2];
    if (luma < min) min = luma;
    if (luma > max) max = luma;
    sum += luma;
    if (rgba[base + 3] > 250) opaque += 1;
  }

  const round2 = (value) => Math.round(value * 100) / 100;
  return {
    width,
    height,
    pixels,
    mean: round2(sum / pixels),
    min: round2(min),
    max: round2(max),
    spread: round2(max - min),
    opaqueFraction: Math.round((opaque / pixels) * 1000) / 1000,
  };
}

/** Convenience: decode and measure in one step. */
export function statsOfPng(buffer) {
  const { width, height, rgba } = decodePng(buffer);
  return imageStats(rgba, width, height);
}

/**
 * Copies a sub-rectangle of an RGBA buffer into a fresh buffer.
 *
 * Used to measure the part of a frame where no HUD element is drawn: the whole
 * screenshot proves "a frame was composited", the HUD-free band proves "the 3D
 * scene inside it was drawn", and neither claim implies the other.
 *
 * Fractions are clamped to the image, and the result is always at least 1x1.
 */
export function cropRgba(rgba, width, height, x0Fraction, y0Fraction, x1Fraction, y1Fraction) {
  const clamp = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
  const x = Math.min(width - 1, Math.floor(clamp(x0Fraction) * width));
  const y = Math.min(height - 1, Math.floor(clamp(y0Fraction) * height));
  const w = Math.max(1, Math.min(width - x, Math.floor((clamp(x1Fraction) - clamp(x0Fraction)) * width)));
  const h = Math.max(1, Math.min(height - y, Math.floor((clamp(y1Fraction) - clamp(y0Fraction)) * height)));

  const out = Buffer.alloc(w * h * 4);
  const rowBytes = w * 4;
  for (let row = 0; row < h; row += 1) {
    const from = ((y + row) * width + x) * 4;
    rgba.copy(out, row * rowBytes, from, from + rowBytes);
  }
  return { rgba: out, width: w, height: h };
}
