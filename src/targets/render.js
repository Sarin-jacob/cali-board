// Rendering of target layouts (mm) to canvas, SVG and PNG.
import { esc } from '../ui/dom.js';

/** Draws a layout into a 2-D context. `scale` = pixels per mm; (ox, oy) = offset in pixels. */
export function drawLayout(ctx, layout, { scale, ox = 0, oy = 0, snap = true, background = '#fff', ink = '#000' }) {
  const S = (v) => (snap ? Math.round(v) : v);
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(S(ox), S(oy), S(ox + layout.width * scale) - S(ox), S(oy + layout.height * scale) - S(oy));
  ctx.fillStyle = ink;
  // One path, one fill: abutting rectangles filled separately leave anti-aliasing seams.
  const path = new Path2D();
  for (const r of layout.rects) {
    const x0 = S(ox + r.x * scale), y0 = S(oy + r.y * scale);
    const x1 = S(ox + (r.x + r.w) * scale), y1 = S(oy + (r.y + r.h) * scale);
    if (x1 > x0 && y1 > y0) path.rect(x0, y0, x1 - x0, y1 - y0);
  }
  ctx.fill(path);
  if (layout.texts.length) {
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of layout.texts) {
      ctx.font = `${Math.max(6, t.size * scale)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(t.text, ox + t.x * scale, oy + t.y * scale);
    }
  }
  ctx.restore();
}

/** Standalone SVG at true physical size (width/height in mm). */
export function layoutToSVG(layout, { title = 'Calibration target', description = '' } = {}) {
  const f = (v) => +v.toFixed(4);
  // A single path (not many <rect>s) so renderers fill the union without seams.
  const d = layout.rects.map((r) => `M${f(r.x)} ${f(r.y)}h${f(r.w)}v${f(r.h)}h${f(-r.w)}z`).join('');
  const texts = layout.texts.map((t) => `<text x="${f(t.x)}" y="${f(t.y + t.size)}" font-size="${f(t.size)}">${esc(t.text)}</text>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f(layout.width)}mm" height="${f(layout.height)}mm" viewBox="0 0 ${f(layout.width)} ${f(layout.height)}" shape-rendering="crispEdges">
<title>${esc(title)}</title>
<desc>${esc(description)} Print at 100% (actual size).</desc>
<rect width="${f(layout.width)}" height="${f(layout.height)}" fill="#fff"/>
<path fill="#000" d="${d}"/>
${texts ? `<g fill="#333" font-family="sans-serif" text-anchor="middle">${texts}</g>` : ''}
</svg>
`;
}

/** Largest canvas the browser will reliably allocate (iOS Safari is the strictest). */
export function maxCanvasPixels() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios ? 16_000_000 : 120_000_000;
}

/** PNG of the layout at `dpi`, with a pHYs chunk so viewers/printers know its physical size. */
export async function layoutToPNG(layout, dpi) {
  const scale = dpi / 25.4;
  const w = Math.round(layout.width * scale), h = Math.round(layout.height * scale);
  if (w * h > maxCanvasPixels()) throw new Error(`That is ${w}×${h} px — too large for this browser. Lower the DPI.`);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  drawLayout(ctx, layout, { scale });
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not encode the PNG (out of memory?)');
  return withPngDpi(blob, dpi);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Inserts (or replaces) the PNG pHYs chunk to record physical resolution. */
export async function withPngDpi(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Walk chunks; drop an existing pHYs, insert ours right after IHDR.
  const parts = [src.subarray(0, 8)];
  let p = 8;
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  while (p < src.length) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(src[p + 4], src[p + 5], src[p + 6], src[p + 7]);
    const end = p + 12 + len;
    if (type !== 'pHYs') parts.push(src.subarray(p, end));
    if (type === 'IHDR') parts.push(chunk);
    p = end;
  }
  return new Blob(parts, { type: 'image/png' });
}
