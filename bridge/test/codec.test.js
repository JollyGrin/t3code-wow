import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { encodeFrame, decodeImage, renderCells, cellsToBytes, bytesToCells, MAX_PAYLOAD, parsePPM, parseBMP, parseQImage } from '../src/codec.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lua = ['lua5.1', 'luajit', 'lua'].find((bin) => {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
});

function luaCells(seq, payloadHex) {
  const script = `
    local ns = {}
    local chunk = assert(loadfile(${JSON.stringify(path.join(root, 'addon/T3Code/Core/Codec.lua'))}))
    chunk("T3Code", ns)
    local hex = ${JSON.stringify(payloadHex)}
    local s = hex:gsub("..", function(h) return string.char(tonumber(h, 16)) end)
    local cells = ns.Codec.Encode(${seq}, s)
    io.write(table.concat(cells, ","))
  `;
  return execFileSync(lua, ['-e', script]).toString().split(',').map(Number);
}

test('bytes <-> cells round trip', () => {
  const bytes = [0, 1, 2, 250, 255, 128, 77];
  assert.deepEqual(cellsToBytes(bytesToCells(bytes), bytes.length), bytes);
});

test('encode, render and decode', () => {
  const payload = 'B\x1fsess\x1fui\x1f1\x1f1\x1fo\x1f\x1f0\x1eC\x1f1\x1fsend\x1fthread-1\x1fhello ✓ 世界';
  const cells = encodeFrame(4242, payload);
  for (const cell of [2, 3, 4, 6]) {
    for (const [ox, oy] of [[0, 0], [1, 2], [5, 3]]) {
      const img = renderCells(cells, { cell, ox, oy, width: 160 * cell + 20, height: 60 * cell });
      const out = decodeImage(img);
      assert.ok(out && !out.error, `decode failed cell=${cell} ox=${ox} oy=${oy}: ${out?.error}`);
      assert.equal(out.seq, 4242);
      assert.equal(out.payload.toString('utf8'), payload);
    }
  }
});

test('no strip -> null; corrupted -> checksum error', () => {
  const blank = renderCells([], { width: 600, height: 100 });
  assert.equal(decodeImage(blank), null);
  const cells = encodeFrame(1, 'hello world');
  cells[40] = (cells[40] + 1) % 8;
  const out = decodeImage(renderCells(cells, { cell: 3 }));
  assert.equal(out.error, 'checksum mismatch');
});

test('decodes squares that drift off whole pixels', () => {
  // The game reports a slightly smaller screen than it draws, so 3px squares land ~3.0125px apart.
  const payload = 'H\x1f1\x1fsession\x1fui\x1f14\x1f1\x1f0\x1ftg\x1f\x1f0.2.0\x1f1200\x1f';
  const cells = encodeFrame(33, payload);
  const pitch = 3.0125;
  const width = 500;
  const height = 12;
  const data = Buffer.alloc(width * height * 3, 40);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = Math.floor(x / pitch) + Math.floor(y / pitch) * 160;
      if (Math.floor(x / pitch) >= 160 || k >= cells.length) continue;
      const i = (y * width + x) * 3;
      data[i] = cells[k] & 4 ? 255 : 0;
      data[i + 1] = cells[k] & 2 ? 255 : 0;
      data[i + 2] = cells[k] & 1 ? 255 : 0;
    }
  }
  const out = decodeImage({ width, height, data });
  assert.ok(out && !out.error, out?.error);
  assert.equal(out.payload.toString('utf8'), payload);
});

test('max payload fits', () => {
  const payload = 'x'.repeat(MAX_PAYLOAD);
  const cells = encodeFrame(9, payload);
  const out = decodeImage(renderCells(cells, { cell: 3 }));
  assert.equal(out.payload.length, MAX_PAYLOAD);
  assert.throws(() => encodeFrame(9, payload + 'y'));
});

test('Lua encoder matches JS encoder', { skip: !lua && 'no lua interpreter' }, () => {
  const payload = Buffer.from('C\x1f7\x1fsend\x1fabc\x1fünïcödé | text', 'utf8');
  const fromLua = luaCells(65537, payload.toString('hex'));
  const fromJs = encodeFrame(1, payload);
  assert.deepEqual(fromLua, fromJs);
});

test('parse ppm', () => {
  const header = Buffer.from('P6\n# comment\n2 1\n255\n', 'latin1');
  const img = parsePPM(Buffer.concat([header, Buffer.from([255, 0, 0, 0, 255, 0])]));
  assert.equal(img.width, 2);
  assert.equal(img.data[3], 0);
  assert.equal(img.data[4], 255);
});

// A BMP like macOS screencapture writes: 32-bit with bitfields, or plain 24-bit, either row order.
function toBMP(img, { bpp = 32, topDown = false } = {}) {
  const stride = Math.ceil((img.width * bpp) / 32) * 4;
  const header = bpp === 32 ? 54 + 12 : 54;
  const b = Buffer.alloc(header + stride * img.height);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(header, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(img.width, 18);
  b.writeInt32LE(topDown ? -img.height : img.height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(bpp, 28);
  b.writeUInt32LE(bpp === 32 ? 3 : 0, 30);
  if (bpp === 32) {
    b.writeUInt32LE(0x00ff0000, 54);
    b.writeUInt32LE(0x0000ff00, 58);
    b.writeUInt32LE(0x000000ff, 62);
  }
  for (let y = 0; y < img.height; y++) {
    const row = header + (topDown ? y : img.height - 1 - y) * stride;
    for (let x = 0; x < img.width; x++) {
      const [r, g, bl] = img.data.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3);
      if (bpp === 32) b.writeUInt32LE(((0xff << 24) | (r << 16) | (g << 8) | bl) >>> 0, row + x * 4);
      else b.set([bl, g, r], row + x * 3);
    }
  }
  return b;
}

test('BMP captures decode like PPM ones', () => {
  const cells = encodeFrame(7, 'hello from macOS');
  const img = renderCells(cells, { cell: 6, ox: 1, oy: 2, width: 161 * 6 + 3, height: 30 });
  for (const opts of [{ bpp: 32 }, { bpp: 32, topDown: true }, { bpp: 24 }]) {
    const back = parseBMP(toBMP(img, opts));
    assert.deepEqual([back.width, back.height], [img.width, img.height]);
    assert.ok(back.data.equals(img.data), `pixels differ for ${JSON.stringify(opts)}`);
    assert.equal(decodeImage(back).payload.toString(), 'hello from macOS');
  }
});

// KWin's raw pixels in a QImage format, with rows padded past the image's width.
function toQImage(img, format) {
  const bytes = format >= 25 ? 8 : 4;
  const stride = img.width * bytes + 12;
  const b = Buffer.alloc(stride * img.height, 0x5a);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, bl] = img.data.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3);
      const o = y * stride + x * bytes;
      if (format === 6) b.writeUInt32LE(((0xff << 24) | (r << 16) | (g << 8) | bl) >>> 0, o);
      else if (format === 16) b.set([r, g, bl, 0xff], o);
      else for (const [i, v] of [r, g, bl, 0xff].entries()) b.writeUInt16LE(v * 257, o + i * 2);
    }
  }
  return { buf: b, meta: { width: img.width, height: img.height, stride, format } };
}

test('KWin raw captures decode like PPM ones, in its 8- and 16-bit formats', () => {
  const cells = encodeFrame(8, 'hello from KWin');
  const img = renderCells(cells, { cell: 4, ox: 2, oy: 1, width: 161 * 4 + 2, height: 24 });
  for (const format of [6, 16, 26]) {
    const { buf, meta } = toQImage(img, format);
    const back = parseQImage(buf, meta);
    assert.ok(back.data.equals(img.data), `pixels differ for format ${format}`);
    assert.equal(decodeImage(back).payload.toString(), 'hello from KWin');
  }
  assert.throws(() => parseQImage(Buffer.alloc(64), { width: 4, height: 4, stride: 16, format: 30 }), /unsupported KWin image format 30/);
});

test('searchY finds a strip below a title bar', () => {
  const cells = encodeFrame(9, 'under the title bar');
  const img = renderCells(cells, { cell: 6, ox: 0, oy: 56, width: 160 * 6 + 8, height: 120 });
  assert.equal(decodeImage(img), null);
  assert.equal(decodeImage(img, null, { searchY: 80 }).payload.toString(), 'under the title bar');
});
