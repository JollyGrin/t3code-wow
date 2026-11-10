// Pixel strip codec, shared with addon/T3Code/Core/Codec.lua.
//
// Frame bytes:
//   [0x54 'T'] [0x33 '3'] [version] [seq hi, lo] [len hi, lo] [payload ...] [fletcher s1, s2]
// The Fletcher-16 checksum covers version..payload. Bytes are packed MSB-first into
// 3-bit cells. Each cell is a CELL x CELL square of physical pixels whose R, G and B
// channels are each fully on or off (bit 2 = R, bit 1 = G, bit 0 = B), laid out
// row-major, CELLS_PER_ROW cells per row, starting at the top-left of the game's UI.

import zlib from 'node:zlib';

export const MAGIC = [0x54, 0x33];
export const VERSION = 1; // plaintext (only ever a hello: the bridge ignores commands in it)
export const VERSIONS = new Set([1, 2]); // 2: encrypted, see strip-crypto.js
export const BITS = 3;
export const CELLS_PER_ROW = 160;
export const MAX_ROWS = 40;
export const HEADER_BYTES = 7;
export const MAX_PAYLOAD = Math.floor((CELLS_PER_ROW * MAX_ROWS * BITS) / 8) - HEADER_BYTES - 2;

export const US = '\x1f'; // field separator
export const RS = '\x1e'; // record separator

export function fletcher16(bytes, from = 0, to = bytes.length) {
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    s1 = (s1 + bytes[i]) % 255;
    s2 = (s2 + s1) % 255;
  }
  return [s1, s2];
}

export function encodeFrame(seq, payload, version = VERSION) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  if (body.length > MAX_PAYLOAD) throw new Error(`payload too large: ${body.length} > ${MAX_PAYLOAD}`);
  const bytes = [
    MAGIC[0], MAGIC[1], version,
    (seq >> 8) & 0xff, seq & 0xff,
    (body.length >> 8) & 0xff, body.length & 0xff,
    ...body,
  ];
  const [s1, s2] = fletcher16(bytes, 2, bytes.length);
  bytes.push(s1, s2);
  return bytesToCells(bytes);
}

export function bytesToCells(bytes) {
  const cells = [];
  let acc = 0;
  let nbits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    nbits += 8;
    while (nbits >= BITS) {
      const shift = nbits - BITS;
      cells.push((acc >> shift) & 0b111);
      nbits = shift;
      acc &= (1 << nbits) - 1;
    }
  }
  if (nbits > 0) cells.push((acc << (BITS - nbits)) & 0b111);
  return cells;
}

export function cellsToBytes(cells, count) {
  const out = [];
  let acc = 0;
  let nbits = 0;
  for (const c of cells) {
    acc = (acc << BITS) | c;
    nbits += BITS;
    if (nbits >= 8) {
      const shift = nbits - 8;
      out.push((acc >> shift) & 0xff);
      nbits = shift;
      acc &= (1 << nbits) - 1;
      if (count !== undefined && out.length >= count) break;
    }
  }
  return out;
}

export function cellsForBytes(n) {
  return Math.ceil((n * 8) / BITS);
}

// ---------------------------------------------------------------------------
// Image decoding. `img` is { width, height, data } with 3 bytes (RGB) per pixel.

function cellValueAt(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return -1;
  const i = (y * img.width + x) * 3;
  const r = img.data[i] >= 128 ? 4 : 0;
  const g = img.data[i + 1] >= 128 ? 2 : 0;
  const b = img.data[i + 2] >= 128 ? 1 : 0;
  return r | g | b;
}

function readCells(img, geo, start, n) {
  const { ox, oy } = geo;
  // `pitch` is the measured cell spacing when it isn't a whole number of pixels. The
  // game's reported screen height can be a little off from what it draws (1792 vs 1800
  // on a 2x laptop), so the addon's 3px squares land about 3.01px apart.
  const p = geo.pitch ?? geo.cell;
  const cells = new Array(n);
  for (let k = 0; k < n; k++) {
    const idx = start + k;
    const col = idx % CELLS_PER_ROW;
    const row = Math.floor(idx / CELLS_PER_ROW);
    const v = cellValueAt(img, ox + Math.floor(col * p + p / 2), oy + Math.floor(row * p + p / 2));
    if (v < 0) return null;
    cells[k] = v;
  }
  return cells;
}

const HEADER_CELLS = cellsForBytes(HEADER_BYTES);

function headerAt(img, geo) {
  const cells = readCells(img, geo, 0, HEADER_CELLS);
  if (!cells) return null;
  const b = cellsToBytes(cells, HEADER_BYTES);
  if (b[0] !== MAGIC[0] || b[1] !== MAGIC[1] || !VERSIONS.has(b[2])) return null;
  return { version: b[2], seq: (b[3] << 8) | b[4], len: (b[5] << 8) | b[6] };
}

// Find the strip. Tries the last known geometry first, then searches cell sizes and
// small offsets (a window border or misaligned capture shifts the origin a little).
// `searchY` widens the vertical search, for captures that start above the game's
// content (a macOS title bar).
export function locate(img, hint, { searchY = 0 } = {}) {
  if (hint && headerAt(img, hint)) return hint;
  for (let cell = 2; cell <= 8; cell++) {
    for (let oy = 0; oy <= cell * 3 + searchY; oy++) {
      for (let ox = 0; ox <= cell * 3; ox++) {
        const geo = { ox, oy, cell };
        if (headerAt(img, geo)) return geo;
      }
    }
  }
  return null;
}

// Returns { version, seq, payload (Buffer), geo } or { error, geo } or null when no strip is visible.
export function decodeImage(img, hint, opts) {
  const geo = locate(img, hint, opts);
  if (!geo) return null;
  const head = headerAt(img, geo);
  if (head.len > MAX_PAYLOAD) return { error: 'bad length', geo };
  const total = HEADER_BYTES + head.len + 2;
  let out = readFrame(img, geo, head, total);
  if (out.error === 'checksum mismatch') out = refinePitch(img, geo, head, total) || out;
  return out;
}

function readFrame(img, geo, head, total) {
  const cells = readCells(img, geo, 0, cellsForBytes(total));
  if (!cells) return { error: 'strip clipped by capture region', geo };
  const bytes = cellsToBytes(cells, total);
  const [s1, s2] = fletcher16(bytes, 2, HEADER_BYTES + head.len);
  if (bytes[total - 2] !== s1 || bytes[total - 1] !== s2) return { error: 'checksum mismatch', geo };
  return { version: head.version, seq: head.seq, payload: Buffer.from(bytes.slice(HEADER_BYTES, HEADER_BYTES + head.len)), geo };
}

// The squares drift when the cell spacing isn't a whole number of pixels. Try spacings
// within 2% of the whole-pixel size and keep the middle of the range that reads
// cleanly, so the next frame (and longer ones) have the most margin either side.
function refinePitch(img, geo, head, total) {
  const ok = [];
  for (let p = geo.cell * 0.98; p <= geo.cell * 1.02; p += geo.cell / 1000) {
    const g = { ox: geo.ox, oy: geo.oy, cell: geo.cell, pitch: p };
    if (!headerAt(img, g)) continue;
    const out = readFrame(img, g, head, total);
    if (!out.error) ok.push(out);
  }
  return ok.length ? ok[Math.floor(ok.length / 2)] : null;
}

// Render cells into an RGB image (for tests and the probe tool).
export function renderCells(cells, { cell = 3, ox = 0, oy = 0, width, height, background = [40, 40, 48] } = {}) {
  const rows = Math.ceil(cells.length / CELLS_PER_ROW);
  const w = width ?? ox + CELLS_PER_ROW * cell + 4;
  const h = height ?? oy + rows * cell + 4;
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = background[0];
    data[i * 3 + 1] = background[1];
    data[i * 3 + 2] = background[2];
  }
  cells.forEach((v, idx) => {
    const col = idx % CELLS_PER_ROW;
    const row = Math.floor(idx / CELLS_PER_ROW);
    for (let dy = 0; dy < cell; dy++) {
      for (let dx = 0; dx < cell; dx++) {
        const x = ox + col * cell + dx;
        const y = oy + row * cell + dy;
        if (x >= w || y >= h) continue;
        const p = (y * w + x) * 3;
        data[p] = v & 4 ? 255 : 0;
        data[p + 1] = v & 2 ? 255 : 0;
        data[p + 2] = v & 1 ? 255 : 0;
      }
    }
  });
  return { width: w, height: h, data };
}

// Parse a binary PPM (P6) as produced by `grim -t ppm`.
export function parsePPM(buf) {
  let pos = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 0x23) {
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    let start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    tokens.push(buf.toString('latin1', start, pos));
  }
  pos++; // single whitespace after maxval
  const [magic, w, h, max] = tokens;
  if (magic !== 'P6') throw new Error('not a P6 ppm');
  const width = Number(w);
  const height = Number(h);
  if (Number(max) !== 255) throw new Error('unsupported ppm maxval');
  return { width, height, data: buf.subarray(pos, pos + width * height * 3) };
}

// Parse an uncompressed 24- or 32-bit BMP (as written by macOS `screencapture -t bmp`)
// into the same RGB image.
export function parseBMP(buf) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('not a bmp');
  const dataOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported bmp depth ${bpp}`);
  // 0 = BI_RGB, 3 = BI_BITFIELDS (masks after the 40-byte header). A 24-bit pixel reads
  // like a 32-bit one without its top byte, so both depths use the same masks.
  let masks = [0x00ff0000, 0x0000ff00, 0x000000ff];
  if (compression === 3) {
    if (bpp !== 32) throw new Error('unsupported bmp bitfields');
    masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62)];
  } else if (compression !== 0) {
    throw new Error(`unsupported bmp compression ${compression}`);
  }
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const bytes = bpp / 8;
  const shifts = masks.map((m) => 31 - Math.clz32(m & -m));
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const v = buf.readUIntLE(row + x * bytes, bytes);
      for (let c = 0; c < 3; c++) data[o + c] = ((v & masks[c]) >>> shifts[c]) & 0xff;
    }
  }
  return { width, height, data };
}

// Parse the raw pixels KWin's ScreenShot2 interface writes, described by its reply
// (width, height, stride, and the QImage::Format number) into the same RGB image.
// 8-bit formats are what KWin sends for SDR outputs; the 16-bit ones can come from HDR.
const QIMAGE_LAYOUTS = {
  4: { bytes: 4, rgb: [2, 1, 0] }, // RGB32: 0xffRRGGBB words, little-endian
  5: { bytes: 4, rgb: [2, 1, 0] }, // ARGB32
  6: { bytes: 4, rgb: [2, 1, 0] }, // ARGB32_Premultiplied
  16: { bytes: 4, rgb: [0, 1, 2] }, // RGBX8888: bytes in R, G, B, X order
  17: { bytes: 4, rgb: [0, 1, 2] }, // RGBA8888
  18: { bytes: 4, rgb: [0, 1, 2] }, // RGBA8888_Premultiplied
  25: { bytes: 8, rgb: [1, 3, 5] }, // RGBX64: 16-bit little-endian channels, take the high byte
  26: { bytes: 8, rgb: [1, 3, 5] }, // RGBA64
  27: { bytes: 8, rgb: [1, 3, 5] }, // RGBA64_Premultiplied
};

export function parseQImage(buf, { width, height, stride, format }) {
  const layout = QIMAGE_LAYOUTS[format];
  if (!layout) throw new Error(`unsupported KWin image format ${format}`);
  if (buf.length < stride * (height - 1) + width * layout.bytes) throw new Error('short KWin image');
  const [r, g, b] = layout.rgb;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * layout.bytes;
      const o = (y * width + x) * 3;
      data[o] = buf[i + r];
      data[o + 1] = buf[i + g];
      data[o + 2] = buf[i + b];
    }
  }
  return { width, height, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Encode an RGB image as a PNG, for screenshots when ImageMagick isn't there to make a JPEG.
export function encodePNG({ width, height, data }) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
