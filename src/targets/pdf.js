// Vector PDF export with tiling. Rectangles are drawn as PDF paths (not images), so the printout
// is razor-sharp at any printer resolution and squares come out at exactly the designed size.
import { PAPER } from './units.js';
import { describeTarget, tileCuts } from './targets.js';

// Reserved strip at the bottom of each page for the info line and scale bar. Tiled pages need a
// taller one so the corner marks (which reach 5.5 mm below the tile) clear the text.
const FOOTER_SINGLE = 10;
const FOOTER_TILED = 14;

/**
 * Splits [0, total] into pieces no longer than `area`, preferring the allowed `cuts`
 * (square edges / marker gaps) so pieces join without splitting a square or a marker.
 */
function splitAxis(total, area, cuts = []) {
  const edges = [0];
  let start = 0;
  while (total - start > area + 1e-6) {
    const limit = start + area;
    let best = null;
    for (const c of cuts) if (c > start + 1e-6 && c <= limit + 1e-6) best = c;
    if (best === null || best - start < area * 0.5) best = limit; // no usable cut: split where the page ends
    edges.push(best);
    start = best;
  }
  edges.push(total);
  return edges;
}

/** Fewest equal pieces no longer than `area`. */
function evenSplit(total, area) {
  const n = Math.max(1, Math.ceil(total / area - 1e-9));
  return Array.from({ length: n + 1 }, (_, i) => (total * i) / n);
}

/**
 * Chooses orientation and tiling for printing `layout` on `paper`.
 * Returns { orientation, pageW, pageH, areaW, areaH, xs, ys, cols, rows, pages, margin, paper }
 * where xs / ys are the tile edges in layout millimetres.
 */
export function planPages(layout, { paper = 'a4', orientation = 'auto', margin = 10 } = {}, cuts = null) {
  const P = PAPER[paper] || PAPER.a4;
  const plans = [];
  const plan = (o, footer, ignoreCuts = false) => {
    const pageW = o === 'portrait' ? P.w : P.h, pageH = o === 'portrait' ? P.h : P.w;
    const areaW = pageW - 2 * margin, areaH = pageH - 2 * margin - footer;
    if (areaW < 20 || areaH < 20) return null;
    const xs = ignoreCuts ? evenSplit(layout.width, areaW) : splitAxis(layout.width, areaW, cuts?.x);
    const ys = ignoreCuts ? evenSplit(layout.height, areaH) : splitAxis(layout.height, areaH, cuts?.y);
    const cols = xs.length - 1, rows = ys.length - 1;
    return { orientation: o, pageW, pageH, areaW, areaH, xs, ys, cols, rows, pages: cols * rows, margin, paper, footer };
  };
  for (const o of orientation === 'auto' ? ['portrait', 'landscape'] : [orientation]) {
    let p = plan(o, FOOTER_SINGLE);
    if (p && p.pages > 1) {
      // Prefer cuts along square edges / marker gaps unless they cost noticeably more paper.
      p = plan(o, FOOTER_TILED);
      const free = cuts ? plan(o, FOOTER_TILED, true) : null;
      if (free && p.pages > free.pages * 1.25) p = free;
    }
    if (p) plans.push(p);
  }
  if (!plans.length) throw new Error('The margin is too large for this paper size.');
  const wide = layout.width >= layout.height;
  plans.sort((a, b) => a.pages - b.pages || ((b.pageW >= b.pageH) === wide) - ((a.pageW >= a.pageH) === wide));
  return plans[0];
}

/** Page-space placement of tile (r, c): offset (ox, oy) such that page = layout + offset. */
export function tilePlacement(plan, r, c) {
  const tx0 = plan.xs[c], tx1 = plan.xs[c + 1], ty0 = plan.ys[r], ty1 = plan.ys[r + 1];
  // Single page: centre the target. Tiles: align the joining edges with the printable area so
  // neighbouring pages line up when trimmed at the corner marks.
  let ox, oy;
  if (plan.cols === 1) ox = plan.margin + (plan.areaW - (tx1 - tx0)) / 2 - tx0;
  else ox = c === 0 ? plan.margin + plan.areaW - (tx1 - tx0) - tx0 : plan.margin - tx0;
  if (plan.rows === 1) oy = plan.margin + (plan.areaH - (ty1 - ty0)) / 2 - ty0;
  else oy = r === 0 ? plan.margin + plan.areaH - (ty1 - ty0) - ty0 : plan.margin - ty0;
  return { tx0, tx1, ty0, ty1, ox, oy };
}

function scaleBar(doc, x, y, unit) {
  // 50 mm bar (or 2 in) with ticks — lets anyone verify the printer did not rescale the page.
  const inch = unit === 'in';
  const len = inch ? 50.8 : 50;
  const step = inch ? 25.4 / 4 : 10;
  doc.setLineWidth(0.25);
  doc.setDrawColor(0);
  doc.line(x, y, x + len, y);
  for (let i = 0, k = 0; i <= len + 1e-6; i += step, k++) {
    const major = inch ? k % 4 === 0 : true;
    doc.line(x + i, y, x + i, y - (major ? 2.2 : 1.2));
  }
  doc.setFontSize(6.5);
  doc.text(inch ? 'Scale check: this bar is exactly 2 in' : 'Scale check: this bar is exactly 50 mm', x + len / 2, y + 3, { align: 'center' });
}

function cropMarks(doc, x0, y0, x1, y1) {
  const L = 4, g = 1.5;
  doc.setLineWidth(0.15);
  doc.setDrawColor(120);
  for (const [x, y, sx, sy] of [[x0, y0, -1, -1], [x1, y0, 1, -1], [x1, y1, 1, 1], [x0, y1, -1, 1]]) {
    doc.line(x + sx * g, y, x + sx * (g + L), y);
    doc.line(x, y + sy * g, x, y + sy * (g + L));
  }
}

/** Builds the PDF and returns { blob, plan }. */
export async function layoutToPDF(target, layout, { paper = 'a4', orientation = 'auto', margin = 10, unit = 'mm' } = {}) {
  const { jsPDF } = await import('jspdf');
  const plan = planPages(layout, { paper, orientation, margin }, tileCuts(target));
  const P = PAPER[plan.paper];
  const orient = plan.orientation === 'landscape' ? 'l' : 'p';
  const doc = new jsPDF({ unit: 'mm', format: [P.w, P.h], orientation: orient, compress: true });
  const desc = describeTarget(target, unit);
  doc.setProperties({ title: `Calibration target - ${desc}`, subject: desc, creator: 'CaliBoard', keywords: 'camera calibration target' });

  for (let r = 0; r < plan.rows; r++) {
    for (let c = 0; c < plan.cols; c++) {
      if (r || c) doc.addPage([P.w, P.h], orient);
      const { tx0, tx1, ty0, ty1, ox, oy } = tilePlacement(plan, r, c);
      doc.setFillColor(0, 0, 0);
      // All rectangles go into ONE path filled once: abutting rectangles filled separately show
      // hairline seams in anti-aliased viewers/RIPs; a single fill of their union cannot.
      const parts = [];
      for (const rc of layout.rects) {
        const x0 = Math.max(rc.x, tx0), y0 = Math.max(rc.y, ty0);
        const x1 = Math.min(rc.x + rc.w, tx1), y1 = Math.min(rc.y + rc.h, ty1);
        if (x1 - x0 > 1e-6 && y1 - y0 > 1e-6) parts.push([ox + x0, oy + y0, x1 - x0, y1 - y0]);
      }
      parts.forEach(([x, y, w, h], i) => doc.rect(x, y, w, h, i === parts.length - 1 ? 'F' : null));
      if (layout.texts.length) {
        doc.setTextColor(60);
        for (const t of layout.texts) {
          if (t.x < tx0 || t.x > tx1 || t.y < ty0 || t.y > ty1) continue;
          doc.setFontSize(Math.max(4, t.size * 2.835)); // mm → pt
          doc.text(t.text, ox + t.x, oy + t.y + t.size * 0.8, { align: 'center' });
        }
        doc.setTextColor(0);
      }
      if (plan.pages > 1) cropMarks(doc, ox + tx0, oy + ty0, ox + tx1, oy + ty1);

      // Footer: description, tile position, scale bar (below the crop marks, which reach 5.5 mm down).
      const fy = plan.pageH - plan.margin - plan.footer + (plan.pages > 1 ? 8 : 4);
      doc.setFontSize(7);
      doc.setTextColor(70);
      const tile = plan.pages > 1 ? `  |  Tile row ${r + 1}, column ${c + 1} of ${plan.rows} x ${plan.cols} - trim at the corner marks and butt-join` : '';
      doc.text(`CaliBoard  |  ${desc}${tile}`, plan.margin, fy, { maxWidth: plan.pageW - 2 * plan.margin - 60 });
      doc.text('Print at 100% / "Actual size" - never "Fit to page". Mount flat and rigid.', plan.margin, fy + 3.5, { maxWidth: plan.pageW - 2 * plan.margin - 60 });
      doc.setTextColor(0);
      scaleBar(doc, plan.pageW - plan.margin - (unit === 'in' ? 50.8 : 50), fy + 1, unit);
    }
  }
  return { blob: doc.output('blob'), plan };
}
