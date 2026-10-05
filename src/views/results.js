import { html, render, $, $$, on, toast, announce, openDialog, promptDialog, download, copyText, fmt, formatDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { vision } from '../engine/vision.js';
import { app, emit } from '../app/state.js';
import { assess, compareWithTruth } from '../calib/quality.js';
import { fieldOfView, normalizedToPixel, pixelToRay, coefficientNames } from '../calib/camera-model.js';
import { FORMATS, exportAs, safeName } from '../calib/exporters.js';
import { modelInfo, calibrateSession } from '../calib/run.js';
import { getCalibration, saveCalibration, scaleCalibration } from '../calib/library.js';
import { loadSession, saveSession, saveLastResult, loadLastResult } from '../calib/session.js';
import { describeTarget } from '../targets/targets.js';
import { viewErrorChart, residualScatter, srTable } from '../ui/charts.js';
import { mountPoses3D } from '../ui/poses3d.js';
import { prepareOverlay, drawResiduals } from '../ui/overlay.js';

let S = null;

export default {
  title: 'Calibration result',
  async mount(root, params) {
    S = { root, result: null, saved: false, newK0: null, format: 'opencv', cleanup: [], urls: [], session: null, alpha: 0 };
    if (params[0]) {
      S.result = await getCalibration(params[0]);
      S.saved = !!S.result;
    } else {
      S.result = app.result ?? await loadLastResult();
      S.saved = !!S.result?.savedAt;
      app.result = S.result;
    }
    if (!S) return;
    if (!S.result) {
      render(root, html`
        <h1 class="text-2xl font-bold">Calibration result</h1>
        <div class="card card-pad mt-6 max-w-xl">
          <p>No calibration to show yet.</p>
          <div class="mt-4 flex gap-2"><a class="btn btn-primary" href="#/calibrate">${icon('aperture')} Calibrate a camera</a><a class="btn btn-secondary" href="#/library">${icon('library')} Open the library</a></div>
        </div>`);
      return;
    }
    S.session = await loadSession();
    if (!S) return;
    renderAll();
    vision.call('newCameraMatrix', { calib: S.result, alpha: 0 })
      .then((k) => { if (S) { S.newK0 = k; renderExport(); } })
      .catch(() => {});
  },
  unmount() {
    if (!S) return;
    S.cleanup.forEach((fn) => fn());
    S.urls.forEach((u) => URL.revokeObjectURL(u));
    S = null;
  },
};

const GRADE_STYLE = {
  excellent: ['pill-ok', 'Excellent'],
  good: ['pill-ok', 'Good'],
  fair: ['pill-warn', 'Fair'],
  poor: ['pill-bad', 'Needs work'],
};

function sessionMatches() {
  const r = S.result, s = S.session;
  if (!s || r.imported || !r.views.length) return false;
  const ids = new Set(s.views.map((v) => v.id));
  return r.views.every((v) => ids.has(v.id));
}

function renderAll() {
  const r = S.result;
  const q = assess(r);
  const fov = fieldOfView(r);
  const [gcls, glabel] = GRADE_STYLE[q.grade];
  const sd = r.stdDevs || {};
  const pm = (k, d = 2) => (sd[k] ? html` <span class="text-xs muted">± ${fmt(sd[k], d)}</span>` : '');
  const truth = compareWithTruth(r, r.groundTruth);
  const f35 = r.model === 'pinhole' ? 21.633 / Math.tan((fov.diagonal * Math.PI) / 360) : null;
  const names = coefficientNames(r);
  const med = [...r.views.map((v) => v.rms)].sort((a, b) => a - b)[r.views.length >> 1] || r.rms;
  const worst = r.views.filter((v) => v.rms > Math.max(2 * med, r.rms * 1.5, 0.3));

  render(S.root, html`
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="eyebrow">${S.saved ? 'Saved calibration' : 'New calibration'}</p>
        <h1 class="mt-1 truncate text-2xl font-bold tracking-tight sm:text-3xl">${r.name || r.camera?.label || 'Calibration result'}</h1>
        <p class="mt-1 text-sm muted">${r.imageSize.width} × ${r.imageSize.height} · ${r.model === 'fisheye' ? 'Fisheye (Kannala–Brandt)' : `Pinhole, ${modelInfo(r.distortion).label.toLowerCase()} distortion`} · ${formatDate(r.createdAt)}${r.target ? ` · ${describeTarget(r.target, app.unit)}` : ''}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        ${!S.saved ? html`<button type="button" class="btn btn-primary" data-save>${icon('library')} Save to library</button>` : ''}
        ${sessionMatches() ? html`<a class="btn btn-secondary" href="#/calibrate">${icon('camera')} Back to capture</a>` : ''}
        <a class="btn btn-secondary" href="#/validate/${S.saved ? r.id : ''}">${icon('axes')} Validate live</a>
      </div>
    </div>

    <section class="mt-6 grid gap-4 md:grid-cols-[auto_1fr]" aria-label="Summary">
      <div class="card card-pad flex flex-col items-center justify-center text-center md:min-w-56">
        <p class="eyebrow">Reprojection error</p>
        <p class="mt-1 text-5xl font-bold tabular-nums tracking-tight">${fmt(r.rms, 3)}<span class="ml-1 text-xl font-semibold muted">px</span></p>
        <span class="pill ${gcls} mt-2">${glabel}</span>
        <p class="mt-2 text-xs muted">${r.stats.views} views · ${r.stats.points} points${r.excludedViews ? ` · ${r.excludedViews} excluded` : ''}</p>
      </div>
      <div class="card card-pad">
        <h2 class="section-title">Assessment</h2>
        <ul class="mt-2 space-y-1.5 text-sm">
          ${q.items.map((it) => html`<li class="flex gap-2">${icon(it.level === 'ok' ? 'check' : it.level === 'info' ? 'info' : 'alert', `mt-0.5 size-4 shrink-0 ${it.level === 'ok' ? 'text-emerald-600' : it.level === 'warn' ? 'text-amber-600' : it.level === 'bad' ? 'text-rose-600' : 'text-indigo-500'}`)}<span><span class="sr-only">${it.level === 'ok' ? 'Good: ' : it.level === 'bad' ? 'Problem: ' : it.level === 'warn' ? 'Warning: ' : 'Note: '}</span>${it.text}</span></li>`)}
        </ul>
        ${worst.length && sessionMatches() ? html`<button type="button" class="btn btn-secondary btn-sm mt-3" data-drop-worst>${icon('refresh')} Exclude ${worst.length} high-error view${worst.length > 1 ? 's' : ''} and recalibrate</button>` : ''}
      </div>
    </section>

    ${truth ? html`
    <section class="card card-pad mt-4" aria-labelledby="gt-h">
      <h2 id="gt-h" class="section-title">Compared with the virtual camera’s true lens</h2>
      <div class="mt-2 overflow-x-auto" tabindex="0" role="region" aria-label="Ground-truth comparison table"><table class="table">
        <thead><tr><th>Parameter</th><th>Estimated</th><th>Truth</th><th>Error</th></tr></thead>
        <tbody>
          <tr><td>fx</td><td>${fmt(truth.fx.est, 2)}</td><td>${fmt(truth.fx.truth, 2)}</td><td>${fmt(truth.fx.err * 100, 3)} %</td></tr>
          <tr><td>fy</td><td>${fmt(truth.fy.est, 2)}</td><td>${fmt(truth.fy.truth, 2)}</td><td>${fmt(truth.fy.err * 100, 3)} %</td></tr>
          <tr><td>cx</td><td>${fmt(truth.cx.est, 2)}</td><td>${fmt(truth.cx.truth, 2)}</td><td>${fmt(truth.cx.err, 2)} px</td></tr>
          <tr><td>cy</td><td>${fmt(truth.cy.est, 2)}</td><td>${fmt(truth.cy.truth, 2)}</td><td>${fmt(truth.cy.err, 2)} px</td></tr>
          ${truth.sameModel ? truth.D.map((d, i) => html`<tr><td>${coefficientNames(r.groundTruth)[i]}</td><td>${fmt(d.est, 5)}</td><td>${fmt(d.truth, 5)}</td><td>${fmt(d.est - d.truth, 5)}</td></tr>`) : ''}
        </tbody></table></div>
      ${!truth.sameModel ? html`<p class="mt-2 text-sm muted">The fitted model differs from the true one, so only intrinsics are compared.</p>` : ''}
    </section>` : ''}

    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <section class="card card-pad" aria-labelledby="k-h">
        <h2 id="k-h" class="section-title">Intrinsics</h2>
        <dl class="kv mt-3">
          <dt>Focal length fx</dt><dd>${fmt(r.K[0], 3)} px${pm('fx')}</dd>
          <dt>Focal length fy</dt><dd>${fmt(r.K[4], 3)} px${pm('fy')}</dd>
          <dt>Principal point cx</dt><dd>${fmt(r.K[2], 3)} px${pm('cx')}</dd>
          <dt>Principal point cy</dt><dd>${fmt(r.K[5], 3)} px${pm('cy')}</dd>
          <dt>Field of view</dt><dd>${fmt(fov.horizontal, 1)}° × ${fmt(fov.vertical, 1)}° (diag. ${fmt(fov.diagonal, 1)}°)</dd>
          ${f35 && Number.isFinite(f35) ? html`<dt>35 mm equivalent</dt><dd>≈ ${fmt(f35, 1)} mm</dd>` : ''}
          <dt>Aspect fx / fy</dt><dd>${fmt(r.K[0] / r.K[4], 5)}</dd>
        </dl>
        <details class="mt-3 text-sm">
          <summary class="cursor-pointer font-medium">Camera matrix</summary>
          <pre class="code mt-2">${matrixText(r.K, 3)}</pre>
        </details>
        <p class="mt-3 text-xs muted">± values are 1σ standard deviations estimated by OpenCV${r.model === 'fisheye' ? ' (not available for the fisheye model)' : ''}.</p>
      </section>

      <section class="card card-pad" aria-labelledby="d-h">
        <h2 id="d-h" class="section-title">Lens distortion</h2>
        <dl class="kv mt-3">${names.map((n, i) => html`<dt>${n}</dt><dd>${fmt(r.D[i] ?? 0, 6)}${pm(n.replace('τ', 't'), 5)}</dd>`)}</dl>
        <figure class="mt-3">
          <canvas id="distortion" class="aspect-video w-full rounded-lg bg-slate-100 dark:bg-slate-800" role="img" aria-label="How straight lines appear through this lens; colours show pixel displacement"></canvas>
          <figcaption class="mt-1 text-xs muted" id="distortion-caption"></figcaption>
        </figure>
      </section>
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
      <section class="card card-pad" aria-labelledby="pv-h">
        <div class="flex items-baseline justify-between gap-2">
          <h2 id="pv-h" class="section-title">Error per view</h2>
          <p class="text-xs muted">Select a bar to inspect a view</p>
        </div>
        <div class="mt-2" id="pv-chart">${viewErrorChart(r.views, { rms: r.rms })}</div>
        ${srTable('Reprojection error per view', ['View', 'RMS (px)', 'Points used'], r.views.map((v) => [`#${v.n}`, fmt(v.rms, 3), v.used]))}
      </section>
      <section class="card card-pad" aria-labelledby="res-h">
        <h2 id="res-h" class="section-title">Residuals</h2>
        <p class="text-xs muted">Every point’s reprojection error. A round blob centred on the cross is healthy; streaks or offsets mean systematic error.</p>
        <div class="mt-2">${r.views.some((v) => v.residuals) ? residualScatter(r.views.filter((v) => v.residuals)) : html`<p class="muted text-sm">Not stored for imported calibrations.</p>`}</div>
      </section>
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <section class="card card-pad" aria-labelledby="ud-h">
        <h2 id="ud-h" class="section-title">Undistortion preview</h2>
        <div class="mt-3 flex flex-wrap items-end gap-3">
          <div class="min-w-40 flex-1"><label class="label" for="ud-source">Image</label><select id="ud-source" class="select"></select></div>
          <label class="btn btn-secondary">${icon('upload')} Your photo<input type="file" accept="image/*" class="sr-only" id="ud-file" /></label>
        </div>
        <div class="mt-3">
          <label class="label" for="ud-alpha">${r.model === 'fisheye' ? 'Balance' : 'Alpha'}: <span id="ud-alpha-val">0</span> <span class="font-normal muted">(0 = crop to valid pixels, 1 = keep everything)</span></label>
          <input id="ud-alpha" type="range" min="0" max="1" step="0.05" value="0" class="w-full accent-indigo-600" />
        </div>
        <div class="relative mt-3 overflow-hidden rounded-xl bg-slate-900" id="ud-stage" style="aspect-ratio:${r.imageSize.width}/${r.imageSize.height}">
          <img id="ud-before" alt="Original image" class="absolute inset-0 h-full w-full object-contain" />
          <canvas id="ud-after" class="absolute inset-0 h-full w-full" style="clip-path: inset(0 0 0 50%)" role="img" aria-label="Undistorted image"></canvas>
          <div id="ud-divider" class="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 bg-white/80"></div>
          <span class="pill absolute left-2 top-2 bg-slate-950/70 text-white">Original</span>
          <span class="pill absolute right-2 top-2 bg-slate-950/70 text-white">Undistorted</span>
        </div>
        <label class="label mt-2 sr-only" for="ud-split">Comparison position</label>
        <input id="ud-split" type="range" min="0" max="100" value="50" class="mt-2 w-full accent-indigo-600" aria-label="Comparison divider position" />
        <div class="mt-2 flex justify-end"><button type="button" class="btn btn-secondary btn-sm" data-ud-download>${icon('download')} Download undistorted</button></div>
      </section>

      <section class="card card-pad" aria-labelledby="p3-h">
        <h2 id="p3-h" class="section-title">Board poses</h2>
        <p class="text-xs muted">Where the target was relative to the camera in each view. Drag or use arrow keys to orbit, scroll or +/− to zoom.</p>
        ${r.target && r.views.length && r.views[0].rvec ? html`<canvas id="poses" class="mt-2 aspect-[4/3] w-full cursor-grab touch-none rounded-lg bg-slate-50 dark:bg-slate-950" tabindex="0" aria-label="3D view of the camera and ${r.views.length} board poses. Use arrow keys to rotate."></canvas>
          ${srTable('Board pose per view', ['View', 'Distance (mm)', 'RMS (px)'], r.views.map((v) => [`#${v.n}`, fmt(Math.hypot(...v.tvec), 0), fmt(v.rms, 3)]))}` : html`<p class="mt-2 text-sm muted">Pose data is not available for this calibration.</p>`}
      </section>
    </div>

    <section class="card card-pad mt-4" aria-labelledby="ex-h">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ex-h" class="section-title">Export</h2>
        <div class="flex gap-2">
          <button type="button" class="btn btn-secondary btn-sm" data-copy>${icon('copy')} Copy</button>
          <button type="button" class="btn btn-primary btn-sm" data-download>${icon('download')} Download</button>
        </div>
      </div>
      <div class="seg mt-3 flex-wrap" role="tablist" aria-label="Export format">
        ${FORMATS.map((f) => html`<button type="button" role="tab" data-format="${f.id}" aria-selected="${S.format === f.id}">${f.label}</button>`)}
      </div>
      <p class="mt-2 text-xs muted" id="ex-note"></p>
      <pre class="code mt-2" id="ex-code" tabindex="0" aria-label="Exported calibration"></pre>
    </section>`);

  renderExport();
  drawDistortion();
  setupUndistort();
  if ($('#poses', S.root)) S.cleanup.push(mountPoses3D($('#poses', S.root), r, r.target));
  bind();
}

function matrixText(K, d) {
  const rows = [K.slice(0, 3), K.slice(3, 6), K.slice(6, 9)].map((row) => row.map((v) => fmt(v, d).padStart(12)).join(' '));
  return `[${rows.join('\n ')}]`;
}

function bind() {
  const root = S.root;
  on(root, 'click', '[data-format]', (e, b) => { S.format = b.dataset.format; $$('[data-format]', root).forEach((x) => x.setAttribute('aria-selected', String(x === b))); renderExport(); });
  on(root, 'click', '[data-copy]', () => copyText($('#ex-code', root).textContent));
  on(root, 'click', '[data-download]', () => {
    const f = FORMATS.find((x) => x.id === S.format);
    const base = safeName(S.result.name || S.result.camera?.label || 'camera');
    const file = S.format === 'colmap' ? 'cameras.txt' : `${base}_${S.result.imageSize.width}x${S.result.imageSize.height}_${S.format}.${f.ext}`;
    download($('#ex-code', root).textContent, file, f.mime);
  });
  on(root, 'click', '[data-save]', () => save());
  on(root, 'click', '[data-drop-worst]', () => dropWorst());
  on(root, 'click', '[data-view]', (e, el) => inspect(el.dataset.view));
  on(root, 'keydown', '[data-view]', (e, el) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspect(el.dataset.view); } });
}

function renderExport() {
  if (!S) return;
  const f = FORMATS.find((x) => x.id === S.format);
  $('#ex-note', S.root).textContent = f.note;
  $('#ex-code', S.root).textContent = exportAs(S.result, S.format, { name: S.result.name || S.result.camera?.label, newK: S.newK0 || undefined });
}

async function save() {
  const r = S.result;
  const def = `${r.camera?.label || 'Camera'} ${r.imageSize.width}×${r.imageSize.height}`;
  const name = await promptDialog('Name this calibration (e.g. the camera model and lens setting).', { title: 'Save to library', value: def });
  if (!name || !S) return;
  const rec = await saveCalibration(r, name);
  app.result = rec;
  await saveLastResult(rec);
  toast('Saved to the library.', { type: 'ok' });
  location.hash = `#/results/${rec.id}`;
}

async function dropWorst() {
  const r = S.result;
  const med = [...r.views.map((v) => v.rms)].sort((a, b) => a - b)[r.views.length >> 1];
  const bad = new Set(r.views.filter((v) => v.rms > Math.max(2 * med, r.rms * 1.5, 0.3)).map((v) => v.id));
  const session = S.session;
  session.views.forEach((v) => { if (bad.has(v.id)) v.enabled = false; });
  await saveSession(session, true);
  const btn = $('[data-drop-worst]', S.root);
  btn.disabled = true; btn.textContent = 'Recalibrating…';
  try {
    const next = await calibrateSession(session, r.options, { camera: r.camera, groundTruth: r.groundTruth });
    if (!S) return;
    app.result = next;
    S.result = next;
    S.saved = false;
    await saveLastResult(next);
    emit('result', next);
    announce(`Recalibrated without ${bad.size} views. Error ${next.rms.toFixed(3)} pixels (was ${r.rms.toFixed(3)}).`);
    toast(`RMS ${r.rms.toFixed(3)} → ${next.rms.toFixed(3)} px`, { type: 'ok' });
    S.cleanup.forEach((fn) => fn()); S.cleanup = [];
    renderAll();
  } catch (err) {
    toast(err.message, { type: 'bad' });
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------

function drawDistortion() {
  const r = S.result;
  const canvas = $('#distortion', S.root);
  const draw = () => {
    if (!S) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientWidth * (r.imageSize.height / r.imageSize.width);
    canvas.style.aspectRatio = `${r.imageSize.width} / ${r.imageSize.height}`;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    const sx = canvas.width / r.imageSize.width, sy = canvas.height / r.imageSize.height;
    // Displacement heat map (pixel → where a perfect pinhole would put it).
    const GX = 64, GY = Math.max(8, Math.round(64 * r.imageSize.height / r.imageSize.width));
    const disp = new Float32Array(GX * GY);
    let max = 0;
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const u = ((i + 0.5) / GX) * r.imageSize.width, v = ((j + 0.5) / GY) * r.imageSize.height;
      const ray = pixelToRay(r, u, v);
      const d = ray ? Math.hypot(r.K[0] * ray[0] + r.K[2] - u, r.K[4] * ray[1] + r.K[5] - v) : NaN;
      disp[j * GX + i] = d;
      if (Number.isFinite(d)) max = Math.max(max, d);
    }
    const sorted = Array.from(disp).filter(Number.isFinite).sort((a, b) => a - b);
    const cap = sorted[Math.floor(sorted.length * 0.97)] || 1;
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const d = disp[j * GX + i];
      const t = Number.isFinite(d) ? Math.min(1, d / cap) : 1;
      ctx.fillStyle = Number.isFinite(d) ? `hsl(${250 - 210 * t} 75% ${55 + 10 * (1 - t)}% / .55)` : 'rgba(15,23,42,.6)';
      ctx.fillRect(Math.floor((i * canvas.width) / GX), Math.floor((j * canvas.height) / GY), Math.ceil(canvas.width / GX) + 1, Math.ceil(canvas.height / GY) + 1);
    }
    // World-straight lines as the lens images them.
    const corners = [[0, 0], [r.imageSize.width, 0], [0, r.imageSize.height], [r.imageSize.width, r.imageSize.height]].map(([u, v]) => pixelToRay(r, u, v)).filter(Boolean);
    const xs = corners.map((c) => Math.abs(c[0])), ys = corners.map((c) => Math.abs(c[1]));
    const ext = Math.min(3, Math.max(...xs, 0.3)), eyt = Math.min(3, Math.max(...ys, 0.2));
    ctx.strokeStyle = 'rgba(15,23,42,.8)';
    ctx.lineWidth = Math.max(1, dpr);
    const N = 7;
    for (let k = -N; k <= N; k++) {
      for (const horizontal of [true, false]) {
        ctx.beginPath();
        let started = false;
        for (let s = -60; s <= 60; s++) {
          const a = (k / N) * (horizontal ? eyt : ext) * 1.05, b = (s / 60) * (horizontal ? ext : eyt) * 1.05;
          const [x, y] = horizontal ? [b, a] : [a, b];
          const [u, v] = normalizedToPixel(r, x, y);
          if (!Number.isFinite(u) || u < -50 || v < -50 || u > r.imageSize.width + 50 || v > r.imageSize.height + 50) { started = false; continue; }
          started ? ctx.lineTo(u * sx, v * sy) : ctx.moveTo(u * sx, v * sy);
          started = true;
        }
        ctx.stroke();
      }
    }
    $('#distortion-caption', S.root).textContent = `Grid: straight lines in the world as this lens images them. Colour: how far each pixel is from where a perfect pinhole camera would put it (up to ${fmt(max, 1)} px${max > cap * 1.01 ? `; scale capped at ${fmt(cap, 1)} px` : ''}).`;
  };
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas);
  S.cleanup.push(() => ro.disconnect());
}

// ---------------------------------------------------------------------------------------------
// Undistortion preview
// ---------------------------------------------------------------------------------------------

function imageSources() {
  const r = S.result;
  const out = [];
  const byId = new Map((S.session?.views || []).map((v) => [v.id, v]));
  for (const v of r.views) {
    const sv = byId.get(v.id);
    const blob = sv?.preview || sv?.thumb || v.thumb;
    if (blob) out.push({ id: v.id, label: `View #${v.n}${v.name ? ` — ${v.name}` : ''}`, blob });
  }
  return out;
}

function setupUndistort() {
  const root = S.root;
  const sel = $('#ud-source', root);
  S.sources = imageSources();
  render(sel, S.sources.length ? html`${S.sources.map((s, i) => html`<option value="${i}">${s.label}</option>`)}` : html`<option value="">No stored images — upload a photo</option>`);
  const split = $('#ud-split', root);
  split.addEventListener('input', () => {
    $('#ud-after', root).style.clipPath = `inset(0 0 0 ${split.value}%)`;
    $('#ud-divider', root).style.left = `${split.value}%`;
  });
  sel.addEventListener('change', () => { S.current = S.sources[Number(sel.value)]?.blob; updateUndistort(); });
  const alpha = $('#ud-alpha', root);
  alpha.addEventListener('change', () => { S.alpha = Number(alpha.value); $('#ud-alpha-val', root).textContent = alpha.value; updateUndistort(); });
  alpha.addEventListener('input', () => { $('#ud-alpha-val', root).textContent = alpha.value; });
  $('#ud-file', root).addEventListener('change', (e) => { const f = e.target.files[0]; if (f) { S.current = f; updateUndistort(); } e.target.value = ''; });
  on(root, 'click', '[data-ud-download]', () => {
    const c = $('#ud-after', root);
    if (!c.width) return;
    c.toBlob((b) => b && download(b, 'undistorted.png'), 'image/png');
  });
  S.current = S.sources[0]?.blob || null;
  updateUndistort();
}

async function updateUndistort() {
  if (!S || !S.current) return;
  const root = S.root, r = S.result;
  const token = (S.udToken = (S.udToken || 0) + 1);
  const before = $('#ud-before', root), canvas = $('#ud-after', root);
  const url = URL.createObjectURL(S.current);
  S.urls.push(url);
  before.src = url;
  try {
    const bmp = await createImageBitmap(S.current);
    const s = bmp.width / r.imageSize.width;
    if (Math.abs(bmp.height / r.imageSize.height - s) > 0.01 * s) {
      bmp.close();
      toast(`That image is ${bmp.width}×${bmp.height}; the calibration is for ${r.imageSize.width}×${r.imageSize.height} (different aspect ratio).`, { type: 'warn', timeout: 6000 });
      return;
    }
    const calib = Math.abs(s - 1) < 1e-6 ? r : scaleCalibration(r, s, { width: bmp.width, height: bmp.height });
    const out = await vision.call('undistort', { frame: bmp, calib, opts: { alpha: S.alpha } }, [bmp]);
    if (!S || token !== S.udToken) { out.bitmap?.close?.(); return; }
    canvas.width = out.width; canvas.height = out.height;
    const ctx = canvas.getContext('2d');
    if (out.bitmap) { ctx.drawImage(out.bitmap, 0, 0); out.bitmap.close(); }
    else ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
  } catch (err) {
    console.error(err);
    toast(`Undistortion failed: ${err.message}`, { type: 'bad' });
  }
}

// ---------------------------------------------------------------------------------------------
// Inspect one view: image, detected points and exaggerated residual vectors
// ---------------------------------------------------------------------------------------------

function inspect(id) {
  const r = S.result;
  const v = r.views.find((x) => x.id === id);
  if (!v) return;
  const sv = S.session?.views.find((x) => x.id === id);
  const blob = sv?.preview || sv?.thumb || v.thumb;
  const url = blob ? URL.createObjectURL(blob) : null;
  let gain = 20;
  openDialog(html`
    <div class="space-y-3">
      <div class="relative overflow-hidden rounded-xl bg-slate-900" style="aspect-ratio:${r.imageSize.width}/${r.imageSize.height}">
        ${url ? html`<img src="${url}" alt="View ${v.n}" class="absolute inset-0 h-full w-full object-contain opacity-80" />` : ''}
        <canvas class="absolute inset-0 h-full w-full" aria-hidden="true"></canvas>
      </div>
      <div class="flex flex-wrap items-center gap-4 text-sm">
        <span>RMS <strong class="tabular-nums">${fmt(v.rms, 3)} px</strong></span>
        <span>${v.used} points</span>
        <span>Distance ${fmt(Math.hypot(...v.tvec), 0)} mm</span>
        <label class="flex items-center gap-2">Arrow scale <input type="range" min="5" max="100" value="20" data-gain class="accent-indigo-600" /> <span data-gain-val>×20</span></label>
      </div>
      <p class="text-xs muted">Arrows point from each detected corner to where the calibrated model projects it, magnified. Colour: green &lt; 0.3 px, yellow &lt; 0.7, orange &lt; 1.5, red above.</p>
    </div>`, {
    title: `View #${v.n}${v.name ? ` — ${v.name}` : ''}`,
    wide: true,
    onClose: () => url && URL.revokeObjectURL(url),
    onMount(dlg) {
      const canvas = $('canvas', dlg);
      const draw = () => { const o = prepareOverlay(canvas, r.imageSize); if (v.residuals) drawResiduals(o.ctx, v.points, v.residuals, { ...o, gain }); };
      requestAnimationFrame(draw);
      $('[data-gain]', dlg).addEventListener('input', (e) => { gain = Number(e.target.value); $('[data-gain-val]', dlg).textContent = `×${gain}`; draw(); });
    },
  });
}
