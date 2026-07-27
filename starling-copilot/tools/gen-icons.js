// Generates brand icons (indigo→violet gradient tile with a light copy-dot).
// No dependencies — hand-rolled PNG encoder. Run: node tools/gen-icons.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function png(size) {
  const IHDR = Buffer.alloc(13);
  IHDR.writeUInt32BE(size, 0); IHDR.writeUInt32BE(size, 4);
  IHDR[8] = 8; IHDR[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  const cx = size / 2, cy = size / 2, dotR = size * 0.26, ringR = size * 0.34;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      let r = lerp(0x4f, 0x7c, t), g = lerp(0x46, 0x3a, t), b = lerp(0xe5, 0xed, t);
      const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      if (d < dotR) { r = 0xf5; g = 0xf5; b = 0xff; }          // light copy-dot
      else if (d < ringR) { r = 0xe0; g = 0xe0; b = 0xf8; }    // soft ring
      // rounded corners → transparent
      const m = size * 0.16;
      const inX = Math.min(x, size - 1 - x), inY = Math.min(y, size - 1 - y);
      let a = 255;
      if (inX < m && inY < m) { const cd = Math.hypot(m - inX, m - inY); if (cd > m) a = 0; }
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', IHDR), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const outDir = path.join(__dirname, '..', 'icons');
for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), png(s));
  console.log('wrote icon' + s + '.png');
}
