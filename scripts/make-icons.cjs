// Renders the app icon (same geometry as public/favicon.svg) to PNG for the web app manifest.
// Usage: node scripts/make-icons.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '..', 'public');
const INDIGO = [79, 70, 229], WHITE = [255, 255, 255], AMBER = [251, 191, 36];
const SQUARES = [[12, 12], [32, 12], [22, 22], [42, 22], [12, 32], [32, 32], [22, 42], [42, 42]];

/** Colour at a point of the 64×64 design, or null if transparent. */
function shade(x, y, { rounded }) {
  if (x < 0 || y < 0 || x > 64 || y > 64) return null;
  if (rounded) {
    const r = 14;
    const cx = Math.min(Math.max(x, r), 64 - r), cy = Math.min(Math.max(y, r), 64 - r);
    if (Math.hypot(x - cx, y - cy) > r) return null;
  }
  const d = Math.hypot(x - 32, y - 32);
  if (d >= 5.5 && d <= 8.5) return AMBER;
  if (SQUARES.some(([sx, sy]) => x >= sx && x < sx + 10 && y >= sy && y < sy + 10)) return WHITE;
  return INDIGO;
}

function render(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;
  const scale = maskable ? 0.72 : 1; // maskable: keep the artwork inside the 80 % safe zone
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x + (sx + 0.5) / SS) / size - 0.5) / scale * 64 + 32;
          const v = ((y + (sy + 0.5) / SS) / size - 0.5) / scale * 64 + 32;
          let c = shade(u, v, { rounded: !maskable });
          if (!c && maskable) c = INDIGO; // full-bleed background
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS, i = 4 * (y * size + x);
      const k = a ? 255 / a : 0;
      px[i] = Math.round(r * k); px[i + 1] = Math.round(g * k); px[i + 2] = Math.round(b * k); px[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(px, size, size);
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size, opts] of [['icon-192.png', 192, {}], ['icon-512.png', 512, {}], ['icon-maskable-512.png', 512, { maskable: true }]]) {
  const png = render(size, opts);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(name, png.length, 'bytes');
}
