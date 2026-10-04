// Small, dependency-free SVG charts with text alternatives.
import { html, raw, esc } from './dom.js';

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Bar chart of per-view RMS error. Bars are focusable buttons (data-view = view id). */
export function viewErrorChart(views, { rms }) {
  const W = 640, H = 220, L = 40, R = 10, T = 12, B = 28;
  const maxV = niceMax(Math.max(rms * 1.5, ...views.map((v) => v.rms)));
  const med = [...views.map((v) => v.rms)].sort((a, b) => a - b)[views.length >> 1] || rms;
  const pw = W - L - R, ph = H - T - B;
  const bw = pw / Math.max(1, views.length);
  const y = (v) => T + ph - (v / maxV) * ph;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);
  const bars = views.map((v, i) => {
    const ratio = v.rms / med;
    const fill = ratio > 3 ? '#ef4444' : ratio > 1.8 ? '#f59e0b' : '#6366f1';
    const x = L + i * bw + Math.max(1, bw * 0.15);
    const w = Math.max(2, bw * 0.7);
    return `<rect class="cursor-pointer outline-none focus-visible:stroke-2 focus-visible:stroke-slate-900 dark:focus-visible:stroke-white" x="${x.toFixed(1)}" y="${y(v.rms).toFixed(1)}" width="${w.toFixed(1)}" height="${(T + ph - y(v.rms)).toFixed(1)}" rx="2" fill="${fill}" data-view="${esc(v.id)}" tabindex="0" role="button" aria-label="View ${v.n}: ${v.rms.toFixed(3)} pixels. Press Enter to inspect."><title>View #${v.n}: ${v.rms.toFixed(3)} px</title></rect>`;
  }).join('');
  const labelEvery = Math.ceil(views.length / 16);
  const xlabels = views.map((v, i) => (i % labelEvery ? '' : `<text x="${(L + (i + 0.5) * bw).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="fill-slate-500 text-[10px]">${v.n}</text>`)).join('');
  const grid = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="stroke-slate-200 dark:stroke-slate-800"/><text x="${L - 6}" y="${y(t) + 3}" text-anchor="end" class="fill-slate-500 text-[10px]">${t.toFixed(maxV < 1 ? 2 : 1)}</text>`).join('');
  return raw(`<svg viewBox="0 0 ${W} ${H}" class="h-auto w-full" role="group" aria-label="Reprojection error per view; overall ${rms.toFixed(3)} pixels">
    ${grid}
    <line x1="${L}" x2="${W - R}" y1="${y(rms)}" y2="${y(rms)}" stroke="#10b981" stroke-dasharray="5 4" stroke-width="1.5"/>
    <text x="${W - R}" y="${y(rms) - 4}" text-anchor="end" class="fill-emerald-600 text-[10px] font-semibold">overall ${rms.toFixed(3)} px</text>
    ${bars}${xlabels}
    <text x="12" y="${T + ph / 2}" transform="rotate(-90 12 ${T + ph / 2})" text-anchor="middle" class="fill-slate-500 text-[10px]">px</text>
  </svg>`);
}

/** Scatter of all residual vectors (should be a tight, round, centred blob). */
export function residualScatter(views, { maxPoints = 5000 } = {}) {
  const S = 260, C = S / 2;
  const pts = [];
  for (const v of views) for (let i = 0; i < v.residuals.length; i += 2) pts.push([v.residuals[i], v.residuals[i + 1]]);
  const step = Math.max(1, Math.ceil(pts.length / maxPoints));
  const mags = pts.map(([x, y]) => Math.hypot(x, y)).sort((a, b) => a - b);
  const p99 = mags[Math.floor(mags.length * 0.99)] || 1;
  const range = niceMax(Math.max(0.5, p99 * 1.15));
  const sc = (C - 14) / range;
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length || 1; my /= pts.length || 1;
  const dots = [];
  for (let i = 0; i < pts.length; i += step) {
    const [x, y] = pts[i];
    const cx = C + Math.max(-range, Math.min(range, x)) * sc, cy = C + Math.max(-range, Math.min(range, y)) * sc;
    dots.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="1.4"/>`);
  }
  const rings = [range / 2, range].map((r) => `<circle cx="${C}" cy="${C}" r="${r * sc}" fill="none" class="stroke-slate-300 dark:stroke-slate-700" stroke-dasharray="3 3"/><text x="${C + r * sc * 0.72}" y="${C - r * sc * 0.72}" class="fill-slate-500 text-[9px]">${+r.toFixed(2)} px</text>`).join('');
  return raw(`<svg viewBox="0 0 ${S} ${S}" class="mx-auto h-auto w-full max-w-xs" role="img" aria-label="Residual scatter of ${pts.length} points; mean offset (${mx.toFixed(3)}, ${my.toFixed(3)}) px; 99% within ${p99.toFixed(2)} px">
    <line x1="0" x2="${S}" y1="${C}" y2="${C}" class="stroke-slate-200 dark:stroke-slate-800"/><line y1="0" y2="${S}" x1="${C}" x2="${C}" class="stroke-slate-200 dark:stroke-slate-800"/>
    ${rings}
    <g class="fill-indigo-500/50 dark:fill-indigo-400/50">${dots.join('')}</g>
    <circle cx="${C + mx * sc}" cy="${C + my * sc}" r="3.5" fill="none" stroke="#ef4444" stroke-width="1.5"/>
  </svg>`);
}

/** Visually hidden data table to accompany a chart. */
export function srTable(caption, headers, rows) {
  return html`<table class="sr-only"><caption>${caption}</caption><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table>`;
}
