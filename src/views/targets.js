import { html, render, $, $$, on, debounce, download, toast, announce, prefs } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { app, setTarget, setUnit } from '../app/state.js';
import {
  TARGET_TYPES, typeInfo, defaultTarget, normalizeTarget, validateTarget, describeTarget, shortName,
  layoutTarget, boardSize, printedSize, maxPoints, markerCount, fitToArea, tileCuts,
} from '../targets/targets.js';
import { DICTIONARY_GROUPS, dictionaryInfo, dictionaryLabel } from '../targets/dictionaries.js';
import { UNITS, PAPER, toMm, fromMm, formatLength } from '../targets/units.js';
import { drawLayout, layoutToSVG, layoutToPNG } from '../targets/render.js';
import { planPages, layoutToPDF, tilePlacement } from '../targets/pdf.js';

const FIELDS = {
  checkerboard: ['cols', 'rows', 'squareSize', 'quietZone'],
  charuco: ['cols', 'rows', 'squareSize', 'markerSize', 'dictionary', 'firstId', 'legacy', 'quietZone'],
  gridboard: ['cols', 'rows', 'markerSize', 'markerSeparation', 'dictionary', 'firstId', 'quietZone'],
  markers: ['cols', 'rows', 'markerSize', 'markerSeparation', 'dictionary', 'firstId', 'labels', 'quietZone'],
};
const LENGTH_FIELDS = new Set(['squareSize', 'markerSize', 'markerSeparation', 'quietZone']);
const LABEL = {
  cols: (t) => (t === 'checkerboard' || t === 'charuco' ? 'Squares across' : t === 'gridboard' ? 'Markers across' : 'Columns'),
  rows: (t) => (t === 'checkerboard' || t === 'charuco' ? 'Squares down' : t === 'gridboard' ? 'Markers down' : 'Rows'),
  squareSize: () => 'Square size',
  markerSize: () => 'Marker size',
  markerSeparation: (t) => (t === 'gridboard' ? 'Gap between markers' : 'Spacing'),
  quietZone: () => 'White border',
  dictionary: () => 'Marker dictionary',
  firstId: () => 'First marker id',
};
const HINT = {
  squareSize: 'Side of one chessboard square.',
  markerSize: 'Outer side of the black marker border.',
  quietZone: 'Blank margin around the board — detectors need it.',
  firstId: 'Use different ranges to tell several boards apart.',
};

let state = null;

function paperPrefs() {
  return { paper: 'a4', orientation: 'auto', margin: 10, view: 'page', dpi: 300, ...prefs.get('paper', {}) };
}

export default {
  title: 'Targets',
  async mount(root) {
    state = { root, paper: paperPrefs(), layout: null, renderToken: 0, ro: null };
    render(root, html`
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Calibration targets</h1>
          <p class="mt-1 muted">Design a target and print it at exact size — or show it full-screen on a monitor or tablet.</p>
        </div>
        <a class="btn btn-primary" href="#/calibrate" data-use>${icon('aperture')} Calibrate with this target</a>
      </div>

      <div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <form class="card card-pad space-y-5" id="target-form" novalidate aria-describedby="target-messages">
          <fieldset class="group">
            <legend>Target type</legend>
            <div class="grid grid-cols-2 gap-2" id="type-choices">
              ${TARGET_TYPES.map((t) => html`
                <label class="choice">
                  <input type="radio" name="type" value="${t.id}" class="sr-only" ${app.target.type === t.id ? 'checked' : ''} />
                  <span class="font-semibold">${t.label}</span>
                  <span class="text-xs muted">${t.calibration ? 'For calibration' : 'For tracking'}</span>
                </label>`)}
            </div>
            <p class="hint mt-2" id="type-blurb"></p>
          </fieldset>
          <fieldset class="group">
            <legend class="flex w-full items-center justify-between">
              <span>Layout</span>
            </legend>
            <div class="mb-3 flex items-center justify-between gap-3">
              <span class="text-sm muted" id="unit-label">Units</span>
              <div class="seg" role="radiogroup" aria-labelledby="unit-label">
                ${Object.entries(UNITS).map(([k, u]) => html`<label><input type="radio" name="unit" value="${k}" class="sr-only" ${app.unit === k ? 'checked' : ''} /><span title="${u.name}">${u.label}</span></label>`)}
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3" id="fields"></div>
          </fieldset>
          <div id="target-messages" aria-live="polite"></div>
          <dl class="kv rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60" id="summary"></dl>
        </form>

        <section class="space-y-4" aria-labelledby="preview-h">
          <div class="card card-pad">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h2 id="preview-h" class="section-title">Preview</h2>
              <div class="seg" role="group" aria-label="Preview mode">
                <button type="button" data-view="page" aria-pressed="${state.paper.view === 'page'}">Pages</button>
                <button type="button" data-view="board" aria-pressed="${state.paper.view === 'board'}">Target only</button>
              </div>
            </div>
            <div class="mt-3 grid gap-3 sm:grid-cols-3" id="paper-controls">
              <div>
                <label class="label" for="paper">Paper</label>
                <select id="paper" class="select">${Object.entries(PAPER).map(([k, p]) => html`<option value="${k}" ${state.paper.paper === k ? 'selected' : ''}>${p.label}</option>`)}</select>
              </div>
              <div>
                <label class="label" for="orientation">Orientation</label>
                <select id="orientation" class="select">
                  ${[['auto', 'Automatic'], ['portrait', 'Portrait'], ['landscape', 'Landscape']].map(([v, l]) => html`<option value="${v}" ${state.paper.orientation === v ? 'selected' : ''}>${l}</option>`)}
                </select>
              </div>
              <div>
                <label class="label" for="margin">Printer margin (mm)</label>
                <input id="margin" class="input" type="number" min="0" max="40" step="1" value="${state.paper.margin}" />
              </div>
            </div>
            <div class="mt-4 overflow-hidden rounded-xl bg-slate-200/70 p-3 dark:bg-slate-800" id="preview-box">
              <canvas id="preview" class="mx-auto block" role="img" aria-label="Target preview"></canvas>
            </div>
            <p class="mt-2 text-sm muted" id="plan-text" aria-live="polite"></p>
          </div>

          <div class="card card-pad">
            <h2 class="section-title">Get the target</h2>
            <div class="mt-3 flex flex-wrap gap-2">
              <button type="button" class="btn btn-primary" data-export="pdf">${icon('printer')} Download PDF</button>
              <button type="button" class="btn btn-secondary" data-export="svg">${icon('download')} SVG</button>
              <div class="flex items-stretch">
                <button type="button" class="btn btn-secondary rounded-r-none" data-export="png">${icon('image')} PNG</button>
                <label class="sr-only" for="dpi">PNG resolution (DPI)</label>
                <select id="dpi" class="select w-auto rounded-l-none border-l-0" title="PNG resolution">
                  ${[150, 200, 300, 600].map((d) => html`<option value="${d}" ${state.paper.dpi === d ? 'selected' : ''}>${d} dpi</option>`)}
                </select>
              </div>
              <button type="button" class="btn btn-secondary" data-display>${icon('maximize')} Show full screen</button>
              <button type="button" class="btn btn-ghost" data-fit>${icon('wand')} Fit to paper</button>
            </div>
            <details class="mt-4 text-sm">
              <summary class="cursor-pointer font-medium">Printing & mounting checklist</summary>
              <ul class="mt-2 list-disc space-y-1 pl-5 muted">
                <li>Print at <strong>100 % / “Actual size”</strong>. Then measure the scale bar — it must be exactly 50 mm (2 in).</li>
                <li>Measure several squares with a ruler or calipers and enter the measured size when calibrating.</li>
                <li>Glue the print to something <strong>flat and rigid</strong> (foam board, glass, acrylic, aluminium). A wavy target ruins accuracy.</li>
                <li>Prefer matte paper and diffuse light — glare hides corners.</li>
                <li>On a screen, squares are drawn with whole pixels; measure them on the screen itself.</li>
                <li>Large boards (A2+) are best printed by a print shop on a plotter.</li>
              </ul>
            </details>
          </div>
        </section>
      </div>`);

    const form = $('#target-form', root);
    renderFields();
    on(form, 'change', 'input[name="type"]', (e, input) => {
      const keepUnit = app.unit;
      setTarget(defaultTarget(input.value));
      setUnit(keepUnit);
      renderFields();
      refresh();
    });
    on(form, 'change', 'input[name="unit"]', (e, input) => { setUnit(input.value); renderFields(); refresh(); });
    on(form, 'input', '[data-field]', debounce((e, input) => onField(input), 120));
    on(form, 'change', '[data-field]', (e, input) => onField(input));
    form.addEventListener('submit', (e) => e.preventDefault());

    on(root, 'click', '[data-view]', (e, btn) => {
      state.paper.view = btn.dataset.view;
      $$('[data-view]', root).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      savePaper(); drawPreview();
    });
    for (const id of ['paper', 'orientation', 'margin', 'dpi']) {
      $(`#${id}`, root).addEventListener('change', (e) => {
        state.paper[id] = id === 'paper' || id === 'orientation' ? e.target.value : Number(e.target.value);
        savePaper(); drawPreview();
      });
    }
    on(root, 'click', '[data-export]', (e, btn) => exportAs(btn.dataset.export, btn));
    on(root, 'click', '[data-display]', () => showFullscreen());
    on(root, 'click', '[data-fit]', () => fitToPaper());
    on(root, 'click', '[data-use]', (e) => {
      if (!validateTarget(app.target).ok) { e.preventDefault(); toast('Fix the target settings first.', { type: 'bad' }); }
      else if (!typeInfo(app.target.type).calibration) { e.preventDefault(); toast('Marker sheets are for tracking — choose ChArUco, checkerboard or a marker grid to calibrate.', { type: 'warn', timeout: 5000 }); }
    });

    state.ro = new ResizeObserver(debounce(() => drawPreview(), 60));
    state.ro.observe($('#preview-box', root));
    await refresh();
  },
  unmount() {
    state?.ro?.disconnect();
    exitFullscreen();
    state = null;
  },
};

function savePaper() { prefs.set('paper', state.paper); }

function renderFields() {
  const t = app.target, u = app.unit, root = state.root;
  $('#type-blurb', root).textContent = typeInfo(t.type).blurb;
  const fields = FIELDS[t.type].map((f) => {
    const id = `f-${f}`;
    if (f === 'dictionary') {
      return html`
        <div class="col-span-2">
          <label class="label" for="${id}">${LABEL[f](t.type)}</label>
          <select id="${id}" class="select" data-field="${f}">
            ${DICTIONARY_GROUPS.map((g) => html`<optgroup label="${g.label}">${g.names.map((n) => html`<option value="${n}" ${t.dictionary === n ? 'selected' : ''}>${dictionaryLabel(n)}</option>`)}</optgroup>`)}
          </select>
          <p class="hint">Must match the detector. AprilTag 36h11 and 4×4/5×5 ArUco are the most common.</p>
        </div>`;
    }
    if (f === 'legacy' || f === 'labels') {
      const label = f === 'legacy' ? 'Legacy layout (boards made with OpenCV < 4.6 or older online generators)' : 'Print id labels under markers';
      return html`<label class="check-row col-span-2"><input type="checkbox" class="checkbox" id="${id}" data-field="${f}" ${t[f] ? 'checked' : ''} /> <span>${label}</span></label>`;
    }
    const isLen = LENGTH_FIELDS.has(f);
    const value = isLen ? +fromMm(t[f], u).toFixed(UNITS[u].digits + 1) : t[f];
    const step = isLen ? UNITS[u].step : 1;
    return html`
      <div class="${f === 'quietZone' || f === 'firstId' ? '' : ''}">
        <label class="label" for="${id}">${LABEL[f](t.type)}${isLen ? html` <span class="font-normal muted">(${UNITS[u].label})</span>` : ''}</label>
        <input id="${id}" class="input" type="number" inputmode="decimal" data-field="${f}" value="${value}" step="${step}" min="${isLen ? 0 : f === 'firstId' ? 0 : 1}" ${HINT[f] ? html`aria-describedby="${id}-hint"` : ''} />
        ${HINT[f] ? html`<p class="hint" id="${id}-hint">${HINT[f]}</p>` : ''}
      </div>`;
  });
  render($('#fields', root), html`${fields}`);
}

function onField(input) {
  if (!state) return;
  const f = input.dataset.field;
  const t = { ...app.target };
  if (input.type === 'checkbox') t[f] = input.checked;
  else if (f === 'dictionary') t[f] = input.value;
  else {
    if (input.value === '') return; // wait for a value
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    t[f] = LENGTH_FIELDS.has(f) ? toMm(v, app.unit) : Math.round(v);
  }
  setTarget(t);
  refresh();
}

async function refresh() {
  if (!state) return;
  const token = ++state.renderToken;
  const { target: t, errors, warnings } = validateTarget(app.target);
  const root = state.root;
  render($('#target-messages', root), html`
    ${errors.map((m) => html`<p class="callout callout-bad mb-2 flex gap-2">${icon('alert', 'mt-0.5 size-4 shrink-0')}<span>${m}</span></p>`)}
    ${warnings.map((m) => html`<p class="callout callout-warn mb-2 flex gap-2">${icon('info', 'mt-0.5 size-4 shrink-0')}<span>${m}</span></p>`)}`);
  $$('[data-export], [data-display], [data-fit]', root).forEach((b) => { b.disabled = errors.length > 0; });

  const u = app.unit, b = boardSize(t), p = printedSize(t);
  const rows = [
    ['Board', `${formatLength(b.width, u)} × ${formatLength(b.height, u)}`],
    ['With border', `${formatLength(p.width, u)} × ${formatLength(p.height, u)}`],
  ];
  if (t.type === 'checkerboard' || t.type === 'charuco') rows.push(['Inner corners', `${t.cols - 1} × ${t.rows - 1} = ${maxPoints(t)}`]);
  if (t.type !== 'checkerboard') rows.push(['Markers', `${markerCount(t)} (ids ${t.firstId}–${t.firstId + markerCount(t) - 1})`]);
  if (t.type === 'gridboard') rows.push(['Corner points', `${maxPoints(t)}`]);
  if (t.dictionary && t.type !== 'checkerboard') {
    const bits = dictionaryInfo(t.dictionary).markerSize + 2;
    rows.push(['Marker bit', formatLength(t.markerSize / bits, u, 2)]);
  }
  render($('#summary', root), html`${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}`);

  if (errors.length) { state.layout = null; drawPreview(); return; }
  const layout = await layoutTarget(t);
  if (!state || token !== state.renderToken) return;
  state.layout = layout;
  drawPreview();
}

function drawPreview() {
  if (!state) return;
  const root = state.root;
  const canvas = $('#preview', root), box = $('#preview-box', root);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const availW = Math.max(200, box.clientWidth - 24);
  const availH = Math.min(560, Math.max(260, window.innerHeight * 0.55));
  const L = state.layout;
  const planText = $('#plan-text', root);
  if (!L) {
    canvas.width = availW * dpr; canvas.height = 200 * dpr;
    canvas.style.width = `${availW}px`; canvas.style.height = '200px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, availW, 200);
    ctx.fillStyle = '#64748b'; ctx.font = '14px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Fix the settings to see a preview', availW / 2, 100);
    planText.textContent = '';
    return;
  }
  let plan;
  try { plan = planPages(L, state.paper, tileCuts(app.target)); } catch (err) { planText.textContent = err.message; return; }
  const P = PAPER[plan.paper];
  if (state.paper.view === 'board') {
    const s = Math.min(availW / L.width, availH / L.height);
    const w = Math.round(L.width * s), h = Math.round(L.height * s);
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawLayout(ctx, L, { scale: s * dpr });
    canvas.setAttribute('aria-label', `Preview of ${describeTarget(app.target, app.unit)}`);
  } else {
    const gap = 6;
    const totalW = plan.cols * plan.pageW, totalH = plan.rows * plan.pageH;
    const s = Math.min((availW - gap * (plan.cols - 1)) / totalW, (availH - gap * (plan.rows - 1)) / totalH);
    const w = Math.round(totalW * s + gap * (plan.cols - 1)), h = Math.round(totalH * s + gap * (plan.rows - 1));
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (let r = 0; r < plan.rows; r++) {
      for (let c = 0; c < plan.cols; c++) {
        const px = c * (plan.pageW * s + gap), py = r * (plan.pageH * s + gap);
        ctx.fillStyle = '#fff';
        ctx.shadowColor = 'rgba(15,23,42,.25)'; ctx.shadowBlur = 6;
        ctx.fillRect(px, py, plan.pageW * s, plan.pageH * s);
        ctx.shadowBlur = 0;
        // Printable area.
        ctx.strokeStyle = 'rgba(244,63,94,.6)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.strokeRect(px + plan.margin * s, py + plan.margin * s, plan.areaW * s, plan.areaH * s);
        ctx.setLineDash([]);
        // Tile of the target, placed exactly as in the PDF.
        const tp = tilePlacement(plan, r, c);
        ctx.save();
        ctx.beginPath(); ctx.rect(px + (tp.ox + tp.tx0) * s, py + (tp.oy + tp.ty0) * s, (tp.tx1 - tp.tx0) * s, (tp.ty1 - tp.ty0) * s); ctx.clip();
        drawLayout(ctx, L, { scale: s, ox: px + tp.ox * s, oy: py + tp.oy * s, snap: false });
        ctx.restore();
        // Footer hint.
        ctx.fillStyle = '#94a3b8';
        ctx.fillRect(px + plan.margin * s, py + (plan.pageH - plan.margin - 5) * s, Math.min(50, plan.areaW) * s, Math.max(1, 0.6 * s));
      }
    }
    canvas.setAttribute('aria-label', `Print preview: ${plan.pages} ${P.label} page${plan.pages > 1 ? 's' : ''}, ${plan.orientation}`);
  }
  planText.textContent = plan.pages === 1
    ? `Fits on one ${P.label} page (${plan.orientation}).`
    : `Needs ${plan.pages} ${P.label} pages (${plan.rows} × ${plan.cols}, ${plan.orientation}). Use larger paper or “Fit to paper” for a single sheet.`;
}

function fitToPaper() {
  if (!state?.layout) return;
  const P = PAPER[state.paper.paper];
  const m = state.paper.margin, footer = 10;
  const opts = [[P.w - 2 * m, P.h - 2 * m - footer], [P.h - 2 * m, P.w - 2 * m - footer]];
  if (state.paper.orientation === 'portrait') opts.pop();
  if (state.paper.orientation === 'landscape') opts.shift();
  let best = null;
  const step = app.unit === 'in' ? 25.4 / 32 : 0.5;
  for (const [w, h] of opts) {
    const t = fitToArea(app.target, w, h, step);
    const size = t.squareSize ?? t.markerSize;
    if (!best || size > (best.squareSize ?? best.markerSize)) best = t;
  }
  if (!best || !((best.squareSize ?? best.markerSize) > 0)) { toast('The target does not fit on this paper.', { type: 'warn' }); return; }
  setTarget(best);
  renderFields();
  refresh();
  const v = best.squareSize ?? best.markerSize;
  toast(`${best.squareSize ? 'Squares' : 'Markers'} resized to ${formatLength(v, app.unit)} to fill one ${P.label} page.`, { type: 'ok' });
}

async function exportAs(kind, btn) {
  const { target: t, ok } = validateTarget(app.target);
  if (!ok || !state?.layout) return;
  const name = shortName(t);
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    if (kind === 'pdf') {
      const { blob, plan } = await layoutToPDF(t, state.layout, { ...state.paper, unit: app.unit });
      download(blob, `${name}_${plan.paper}.pdf`);
      toast(plan.pages > 1 ? `PDF ready — ${plan.pages} pages to tile.` : 'PDF ready. Print at 100 %.', { type: 'ok' });
    } else if (kind === 'svg') {
      download(layoutToSVG(state.layout, { title: describeTarget(t, app.unit), description: 'Generated by CaliBoard.' }), `${name}.svg`, 'image/svg+xml');
    } else if (kind === 'png') {
      const dpi = Number($('#dpi', state.root).value) || 300;
      download(await layoutToPNG(state.layout, dpi), `${name}_${dpi}dpi.png`);
    }
  } catch (err) {
    console.error(err);
    toast(err.message || 'Export failed', { type: 'bad', timeout: 6000 });
  } finally {
    if (btn.isConnected) { btn.innerHTML = label; btn.disabled = false; }
  }
}

// ---------------------------------------------------------------------------------------------
// Full-screen display: pixel-exact squares so the target can be calibrated against straight from a screen.
// ---------------------------------------------------------------------------------------------

let overlay = null;

function exitFullscreen() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

async function showFullscreen() {
  if (!state?.layout) return;
  const t = normalizeTarget(app.target);
  overlay = document.createElement('div');
  overlay.className = 'fullscreen-target';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Target shown full screen. Press Escape to exit.');
  overlay.tabIndex = -1;
  const canvas = document.createElement('canvas');
  const hud = document.createElement('p');
  hud.style.cssText = 'position:fixed;left:12px;bottom:10px;margin:0;font:12px system-ui;color:#64748b;background:#fff;padding:2px 6px;border-radius:6px;cursor:default;transition:opacity .6s';
  overlay.append(canvas, hud);
  document.body.appendChild(overlay);
  try { await overlay.requestFullscreen?.({ navigationUI: 'hide' }); } catch { /* still usable as an overlay */ }
  overlay.focus();

  const draw = async () => {
    if (!overlay) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.floor(window.innerWidth * dpr), H = Math.floor(window.innerHeight * dpr);
    canvas.width = W; canvas.height = H;
    canvas.style.width = `${W / dpr}px`; canvas.style.height = `${H / dpr}px`;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    let layout, scale, ox, oy, note;
    if (t.type === 'checkerboard' || t.type === 'charuco') {
      // Whole pixels per square: chessboard corners stay exactly evenly spaced.
      const q = Math.max(t.quietZone, t.squareSize * 0.5) / t.squareSize;
      const sq = Math.floor(Math.min(W / (t.cols + 2 * q), H / (t.rows + 2 * q)));
      layout = await layoutTarget({ ...t, quietZone: 0 });
      scale = sq / t.squareSize;
      ox = Math.round((W - t.cols * sq) / 2); oy = Math.round((H - t.rows * sq) / 2);
      note = `Square = ${sq} device px. Measure 5 squares on the screen with a ruler and use (length ÷ 5) as the square size.`;
    } else {
      const bits = dictionaryInfo(t.dictionary).markerSize + 2;
      const ratio = t.markerSeparation / t.markerSize;
      const fit = Math.min(W / (t.cols + (t.cols - 1) * ratio + 0.6), H / (t.rows + (t.rows - 1) * ratio + 0.6));
      const cell = Math.max(1, Math.floor(fit / bits));
      const mPx = cell * bits, sPx = Math.round(ratio * mPx);
      const adj = { ...t, markerSize: mPx, markerSeparation: sPx, quietZone: 0 };
      layout = await layoutTarget(adj);
      scale = 1;
      ox = Math.round((W - layout.width) / 2); oy = Math.round((H - layout.height) / 2);
      const shown = sPx / mPx;
      note = `Marker = ${mPx} px, gap = ${sPx} px${Math.abs(shown - ratio) > 0.005 ? ` (gap/marker ${shown.toFixed(3)} instead of ${ratio.toFixed(3)} — set the gap to ${(t.markerSize * shown).toFixed(2)} mm when calibrating)` : ''}. Measure a marker on the screen.`;
    }
    drawLayout(ctx, layout, { scale, ox, oy });
    hud.textContent = `${note}  ·  Esc to exit`;
    hud.style.opacity = '1';
    clearTimeout(draw.t);
    draw.t = setTimeout(() => { if (hud) hud.style.opacity = '0'; }, 6000);
  };
  await draw();
  announce('Target shown full screen. Press Escape to exit.');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const onResize = debounce(draw, 100);
  const close = () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onFs);
    exitFullscreen();
    $('[data-display]', state?.root || document)?.focus();
  };
  const onFs = () => { if (!document.fullscreenElement && overlay) close(); };
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onFs);
  overlay.addEventListener('dblclick', close);
  overlay.addEventListener('pointermove', () => { hud.style.opacity = '1'; clearTimeout(draw.t); draw.t = setTimeout(() => { hud.style.opacity = '0'; }, 3000); });
}
