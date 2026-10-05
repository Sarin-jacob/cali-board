import { html, render, $, on, toast, announce, fmt, prefs, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { vision, grabFrame, nextVideoFrame } from '../engine/vision.js';
import { app } from '../app/state.js';
import { listCalibrations, getCalibration, scaleCalibration, calibLabel } from '../calib/library.js';
import { loadLastResult } from '../calib/session.js';
import { describeTarget, detectorSpec, objectPoints, boardOutline, normalizeTarget, validateTarget, typeInfo } from '../targets/targets.js';
import { formatLength } from '../targets/units.js';
import { projectPoint, rodrigues, pixelToRay } from '../calib/camera-model.js';
import { listCameras, openCamera, stopStream, cameraErrorMessage, videoReady, cameraSupported } from '../sources/camera.js';
import { VirtualCamera, LENSES } from '../sources/virtual.js';
import { prepareOverlay, drawDetection } from '../ui/overlay.js';
import { editTargetDialog } from '../ui/target-form.js';

let S = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  title: 'Validate',
  async mount(root, params) {
    S = { root, calibs: [], calib: null, target: null, source: null, live: false, token: 0, pose: null, det: null, measure: null, opts: { undistort: false, axes: true, cube: true, outline: true, ...prefs.get('validate', {}) } };
    const [saved, last] = await Promise.all([listCalibrations(), loadLastResult()]);
    if (!S) return;
    S.calibs = saved;
    if (last && !last.savedAt) S.calibs.unshift({ ...last, id: '__latest', name: `Latest result (unsaved)` });
    const wanted = params[0] ? await getCalibration(params[0]) : null;
    S.calib = wanted || S.calibs[0] || null;

    render(root, html`
      <div>
        <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Validate a calibration</h1>
        <p class="mt-1 max-w-3xl muted">Show the target to the camera. If the calibration is right, the axes and cube stay glued to the board from every angle, distances match a ruler, and the live error stays close to the calibration’s.</p>
      </div>
      ${!S.calibs.length ? html`<div class="card card-pad mt-6 max-w-xl"><p>There is no calibration yet.</p><a class="btn btn-primary mt-3" href="#/calibrate">${icon('aperture')} Calibrate a camera</a></div>` : html`
      <div class="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <aside class="space-y-4 xl:col-start-2 xl:row-start-1" aria-label="Settings">
          <section class="card card-pad space-y-3">
            <h2 class="section-title">Calibration</h2>
            <label class="label sr-only" for="calib">Calibration</label>
            <select id="calib" class="select">${S.calibs.map((c) => html`<option value="${c.id}" ${S.calib?.id === c.id ? 'selected' : ''}>${calibLabel(c)}</option>`)}</select>
            <p class="text-xs muted" id="calib-info"></p>
          </section>
          <section class="card card-pad space-y-2">
            <div class="flex items-center justify-between"><h2 class="section-title">Target</h2><button type="button" class="btn btn-ghost btn-sm" data-edit-target>${icon('edit')} Change</button></div>
            <p class="text-sm" id="target-desc"></p>
          </section>
          <section class="card card-pad space-y-3">
            <h2 class="section-title">Source</h2>
            ${cameraSupported() ? html`<div><label class="label" for="device">Camera</label><select id="device" class="select"><option value="">Default camera</option></select></div>` : ''}
            <div class="flex flex-wrap gap-2">
              ${cameraSupported() ? html`<button type="button" class="btn btn-primary" data-start="camera">${icon('play')} Camera</button>` : ''}
              <button type="button" class="btn btn-secondary" data-start="virtual" id="start-virtual">${icon('sparkles')} Virtual camera</button>
              <button type="button" class="btn btn-secondary" data-stop hidden>${icon('stop')} Stop</button>
            </div>
            <p class="hint" id="source-hint"></p>
          </section>
          <section class="card card-pad space-y-2">
            <h2 class="section-title">Display</h2>
            ${[['undistort', 'Show undistorted video'], ['axes', 'Axes'], ['cube', 'Cube on the board'], ['outline', 'Board outline']].map(([k, l]) => html`<label class="check-row"><input type="checkbox" class="checkbox" data-opt="${k}" ${S.opts[k] ? 'checked' : ''} /> <span>${l}</span></label>`)}
            <div class="pt-2">
              <button type="button" class="btn btn-secondary w-full" data-measure aria-pressed="false">${icon('ruler')} Measure on the board</button>
              <p class="hint" id="measure-hint">Click two points on the target plane to measure the distance between them — e.g. across 5 squares.</p>
            </div>
          </section>
        </aside>
        <section class="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1" aria-label="Live view">
          <div class="stage" id="stage" style="aspect-ratio:16/9">
            <video id="video" muted playsinline autoplay aria-hidden="true"></video>
            <canvas id="frame" class="frame absolute inset-0" hidden aria-hidden="true"></canvas>
            <canvas id="overlay" class="overlay" aria-hidden="true"></canvas>
            <div id="empty" class="absolute inset-0 grid place-items-center p-6 text-center text-slate-300"><p>Start the camera (or the virtual camera) under “Source”.</p></div>
          </div>
          <dl class="card card-pad grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4" id="readout" aria-live="off"></dl>
          <p class="sr-only" id="readout-sr" aria-live="polite"></p>
        </section>

      </div>`}`);
    if (!S.calibs.length) return;
    selectCalibration(S.calib?.id);
    bind();
    refreshDevices();
    new ResizeObserver(debounce(draw, 40)).observe($('#stage', root));
  },
  unmount() {
    if (!S) return;
    stop();
    S = null;
  },
};

function bind() {
  const root = S.root;
  $('#calib', root).addEventListener('change', (e) => { stop(); selectCalibration(e.target.value); });
  on(root, 'click', '[data-start]', (e, b) => start(b.dataset.start));
  on(root, 'click', '[data-stop]', () => stop());
  on(root, 'change', '[data-opt]', (e, i) => { S.opts[i.dataset.opt] = i.checked; prefs.set('validate', S.opts); if (i.dataset.opt === 'undistort') { $('#frame', root).hidden = !i.checked; $('#video', root).style.visibility = i.checked ? 'hidden' : ''; } draw(); });
  on(root, 'click', '[data-edit-target]', async () => {
    const t = await editTargetDialog(S.target, app.unit);
    if (t) { S.target = t; renderTarget(); }
  });
  on(root, 'click', '[data-measure]', (e, b) => {
    const on_ = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on_));
    S.measure = on_ ? { points: [] } : null;
    $('#stage', root).style.cursor = on_ ? 'crosshair' : '';
    draw();
  });
  $('#stage', root).addEventListener('click', onStageClick);
}

function selectCalibration(id) {
  const c = S.calibs.find((x) => x.id === id) || S.calibs[0];
  S.calib = c;
  S.target = normalizeTarget(c.target && typeInfo(c.target.type)?.calibration ? c.target : app.target);
  const info = $('#calib-info', S.root);
  info.textContent = `${c.imageSize.width}×${c.imageSize.height} · ${c.model} · RMS ${fmt(c.rms, 3)} px · fx ${fmt(c.K[0], 1)}`;
  const virt = c.camera?.kind === 'virtual' && c.camera.lens && LENSES[c.camera.lens];
  $('#start-virtual', S.root).hidden = !virt;
  $('#source-hint', S.root).textContent = virt
    ? 'This calibration came from the virtual camera — validate it against the same simulated lens.'
    : `Use the camera this calibration was made with, at ${c.imageSize.width}×${c.imageSize.height}.`;
  renderTarget();
}

function renderTarget() {
  const v = validateTarget(S.target);
  render($('#target-desc', S.root), html`${describeTarget(S.target, app.unit)}${!v.ok ? html`<span class="mt-1 block callout callout-bad">${v.errors[0]}</span>` : ''}`);
}

async function refreshDevices() {
  const sel = $('#device', S?.root);
  if (!sel) return;
  try {
    const cams = await listCameras();
    render(sel, html`<option value="">Default camera</option>${cams.map((c) => html`<option value="${c.deviceId}">${c.label}</option>`)}`);
  } catch { /* ignore */ }
}

function stop() {
  if (!S) return;
  S.live = false;
  S.token++;
  if (S.source?.kind === 'camera') stopStream(S.source.stream);
  if (S.source?.kind === 'virtual') S.source.vcam.stop();
  S.source = null;
  const v = $('#video', S.root);
  if (v) { v.pause(); v.srcObject = null; }
  const empty = $('#empty', S.root);
  if (empty) empty.hidden = false;
  const stopBtn = $('[data-stop]', S.root);
  if (stopBtn) stopBtn.hidden = true;
  S.pose = null; S.det = null;
  draw();
}

async function start(kind) {
  stop();
  const c = S.calib;
  const video = $('#video', S.root);
  try {
    let stream;
    if (kind === 'virtual') {
      const vcam = new VirtualCamera(c.camera.lens, S.target, { seed: 7 });
      stream = await vcam.start();
      S.source = { kind, vcam, stream };
    } else {
      const res = { width: c.imageSize.width, height: c.imageSize.height };
      const cam = await openCamera({ deviceId: $('#device', S.root)?.value || undefined, ...res });
      S.source = { kind, ...cam };
      stream = cam.stream;
    }
    video.srcObject = stream;
    try { await video.play(); } catch { /* muted autoplay */ }
    await videoReady(video);
    $('#stage', S.root).style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    $('#empty', S.root).hidden = true;
    $('[data-stop]', S.root).hidden = false;
    // Use the calibration at this resolution (scaling is only valid for the same aspect ratio).
    const s = video.videoWidth / c.imageSize.width;
    if (Math.abs(video.videoHeight / c.imageSize.height - s) > 0.01 * s) {
      toast(`The camera delivers ${video.videoWidth}×${video.videoHeight}, which has a different aspect ratio than the calibration (${c.imageSize.width}×${c.imageSize.height}). Results will be wrong.`, { type: 'bad', timeout: 9000 });
    } else if (Math.abs(s - 1) > 1e-6) {
      toast(`Scaling the calibration from ${c.imageSize.width}×${c.imageSize.height} to ${video.videoWidth}×${video.videoHeight}. Exact only if the camera resizes (not crops) the image.`, { type: 'warn', timeout: 7000 });
    }
    S.active = Math.abs(s - 1) < 1e-6 ? c : scaleCalibration(c, s, { width: video.videoWidth, height: video.videoHeight });
    S.live = true;
    loop(++S.token);
    announce('Live validation started.');
  } catch (err) {
    console.error(err);
    stop();
    toast(kind === 'camera' ? cameraErrorMessage(err) : err.message, { type: 'bad', timeout: 8000 });
  }
}

async function loop(token) {
  const video = $('#video', S.root);
  let frames = 0, t0 = performance.now();
  while (S && S.live && token === S.token) {
    if (!vision.ready || video.readyState < 2) { await sleep(100); continue; }
    try {
      const g = await grabFrame(video, 1280);
      let det = await vision.call('detect', { frame: g.frame, spec: detectorSpec(S.target), opts: { mode: 'live', refine: true } }, g.transfer);
      if (g.scale !== 1) {
        const up = (a) => a && Float32Array.from(a, (v) => (v + 0.5) / g.scale - 0.5);
        det.points = up(det.points);
        if (det.markers) det.markers.corners = up(det.markers.corners);
      }
      let pose = null;
      if (det.found && det.count >= 4) {
        const obj = objectPoints(S.target, det.ids);
        if (obj) {
          const p = await vision.call('pose', { obj, img: det.points, calib: S.active });
          if (p.ok) pose = p;
        }
      }
      if (S.opts.undistort) {
        const bmp = await createImageBitmap(video);
        const out = await vision.call('undistort', { frame: bmp, calib: S.active, opts: { alpha: 0.5 } }, [bmp]);
        if (!S || token !== S.token) { out.bitmap?.close?.(); return; }
        const fc = $('#frame', S.root);
        fc.width = out.width; fc.height = out.height;
        const ctx = fc.getContext('2d');
        if (out.bitmap) { ctx.drawImage(out.bitmap, 0, 0); out.bitmap.close(); } else ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
        S.newK = out.newK;
      }
      if (!S || token !== S.token) return;
      S.det = det; S.pose = pose;
      frames++;
      const now = performance.now();
      if (now - t0 > 1000) { S.fps = (frames * 1000) / (now - t0); frames = 0; t0 = now; }
      draw();
      readout();
    } catch (err) {
      if (!S || token !== S.token) return;
      console.warn(err);
      await sleep(200);
    }
    await nextVideoFrame(video);
  }
}

/** Camera model used to draw over the displayed image (raw, or undistorted with the new matrix). */
function displayModel() {
  if (S.opts.undistort && S.newK) return { model: 'pinhole', K: S.newK, D: [], imageSize: S.active.imageSize };
  return S.active;
}

function unit() { return S.target.type === 'gridboard' ? S.target.markerSize : S.target.squareSize; }

function draw() {
  if (!S) return;
  const canvas = $('#overlay', S.root);
  if (!canvas || !S.active) { if (canvas) prepareOverlay(canvas, { width: 1, height: 1 }); return; }
  const size = S.active.imageSize;
  const o = prepareOverlay(canvas, size);
  if (!S.live) return;
  const ctx = o.ctx;
  if (S.det && !S.opts.undistort) drawDetection(ctx, S.det, { ...o, target: S.target, color: '#38bdf8' });
  if (!S.pose) return;
  const M = displayModel();
  const R = rodrigues(S.pose.rvec), t = S.pose.tvec;
  const P = (x, y, z = 0) => { const p = projectPoint(M, R, t, x, y, z); return p ? [p[0] * o.sx, p[1] * o.sy] : null; };
  const seg = (a, b, color, w) => {
    const A = P(...a), B = P(...b);
    if (!A || !B) return;
    ctx.strokeStyle = color; ctx.lineWidth = w * o.dpr; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(...A); ctx.lineTo(...B); ctx.stroke();
  };
  const L = 2 * unit();
  if (S.opts.outline) {
    const ol = boardOutline(S.target);
    // Sample edges so the outline follows lens distortion.
    ctx.strokeStyle = 'rgba(250,204,21,.95)'; ctx.lineWidth = 2 * o.dpr; ctx.beginPath();
    let first = true;
    for (let e = 0; e < 4; e++) {
      const [a, b] = [ol[e], ol[(e + 1) % 4]];
      for (let k = 0; k <= 20; k++) {
        const p = P(a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20);
        if (!p) continue;
        first ? ctx.moveTo(...p) : ctx.lineTo(...p);
        first = false;
      }
    }
    ctx.closePath(); ctx.stroke();
  }
  if (S.opts.cube) {
    const base = [[0, 0], [L, 0], [L, L], [0, L]];
    // The board's +z points away from the camera; the cube stands out of the board (−z).
    ctx.fillStyle = 'rgba(99,102,241,.18)';
    const top = base.map(([x, y]) => P(x, y, -L)).filter(Boolean);
    if (top.length === 4) { ctx.beginPath(); top.forEach((p, k) => (k ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.fill(); }
    for (let k = 0; k < 4; k++) {
      const [a, b] = [base[k], base[(k + 1) % 4]];
      seg([a[0], a[1], 0], [b[0], b[1], 0], '#a5b4fc', 2);
      seg([a[0], a[1], -L], [b[0], b[1], -L], '#a5b4fc', 2);
      seg([a[0], a[1], 0], [a[0], a[1], -L], '#a5b4fc', 2);
    }
  }
  if (S.opts.axes) {
    seg([0, 0, 0], [L * 1.5, 0, 0], '#ef4444', 4);
    seg([0, 0, 0], [0, L * 1.5, 0], '#22c55e', 4);
    seg([0, 0, 0], [0, 0, -L * 1.5], '#3b82f6', 4);
  }
  if (S.measure) {
    const pts = S.measure.points.map((b) => P(b[0], b[1], 0));
    ctx.fillStyle = '#facc15'; ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2.5 * o.dpr;
    pts.forEach((p) => { if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 5 * o.dpr, 0, 7); ctx.fill(); } });
    if (pts.length === 2 && pts[0] && pts[1]) {
      ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[1]); ctx.stroke();
      const d = Math.hypot(S.measure.points[0][0] - S.measure.points[1][0], S.measure.points[0][1] - S.measure.points[1][1]);
      const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
      ctx.font = `600 ${14 * o.dpr}px ui-sans-serif, system-ui`;
      const label = formatLength(d, app.unit, app.unit === 'mm' ? 1 : 3);
      ctx.lineWidth = 4 * o.dpr; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(label, mid[0] + 8, mid[1] - 8);
      ctx.fillStyle = '#fff'; ctx.fillText(label, mid[0] + 8, mid[1] - 8);
    }
  }
}

let lastSpoken = 0;
function readout() {
  const el = $('#readout', S.root);
  if (!el) return;
  const p = S.pose;
  const c = S.calib;
  if (!p) {
    render(el, html`<div class="col-span-full text-sm muted">${S.det?.count ? 'Target partly visible — show more of it.' : 'Looking for the target…'} ${S.fps ? html`<span class="ml-2 font-mono">${fmt(S.fps, 0)} fps</span>` : ''}</div>`);
    return;
  }
  const R = rodrigues(p.rvec);
  const ol = boardOutline(S.target);
  const cx = (ol[0][0] + ol[2][0]) / 2, cy = (ol[0][1] + ol[2][1]) / 2;
  const center = [R[0] * cx + R[1] * cy + p.tvec[0], R[3] * cx + R[4] * cy + p.tvec[1], R[6] * cx + R[7] * cy + p.tvec[2]];
  const dist = Math.hypot(...center);
  const tilt = (Math.acos(Math.min(1, Math.abs(R[8]))) * 180) / Math.PI;
  const ratio = p.rms / Math.max(0.05, c.rms || 0.3);
  const errCls = ratio < 2 ? 'text-emerald-700 dark:text-emerald-400' : ratio < 4 ? 'text-amber-700 dark:text-amber-400' : 'text-rose-700 dark:text-rose-400';
  render(el, html`
    <div><dt class="muted">Distance</dt><dd class="font-mono text-lg">${formatLength(dist, app.unit === 'in' ? 'in' : 'cm', 1)}</dd></div>
    <div><dt class="muted">Tilt</dt><dd class="font-mono text-lg">${fmt(tilt, 1)}°</dd></div>
    <div><dt class="muted">Live error</dt><dd class="font-mono text-lg ${errCls}">${fmt(p.rms, 2)} px</dd></div>
    <div><dt class="muted">Calibration</dt><dd class="font-mono text-lg">${fmt(c.rms, 2)} px</dd></div>
    <div class="col-span-full text-xs muted">Board centre at (${fmt(center[0], 0)}, ${fmt(center[1], 0)}, ${fmt(center[2], 0)}) mm in camera coordinates · ${S.det.count} points · ${fmt(S.fps || 0, 0)} fps</div>`);
  const now = performance.now();
  if (now - lastSpoken > 4000) {
    lastSpoken = now;
    $('#readout-sr', S.root).textContent = `Distance ${formatLength(dist, 'cm', 0)}, tilt ${Math.round(tilt)} degrees, live error ${p.rms.toFixed(1)} pixels.`;
  }
}

function onStageClick(e) {
  if (!S?.measure || !S.pose || !S.active) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const size = S.active.imageSize;
  const u = ((e.clientX - rect.left) / rect.width) * size.width - 0.5;
  const v = ((e.clientY - rect.top) / rect.height) * size.height - 0.5;
  const ray = pixelToRay(displayModel(), u, v);
  if (!ray) return;
  // Intersect the ray with the board plane (z = 0 in board coordinates).
  const R = rodrigues(S.pose.rvec), t = S.pose.tvec;
  const n = [R[2], R[5], R[8]];
  const denom = n[0] * ray[0] + n[1] * ray[1] + n[2];
  if (Math.abs(denom) < 1e-9) return;
  const s = (n[0] * t[0] + n[1] * t[1] + n[2] * t[2]) / denom;
  const X = [ray[0] * s - t[0], ray[1] * s - t[1], s - t[2]];
  const b = [R[0] * X[0] + R[3] * X[1] + R[6] * X[2], R[1] * X[0] + R[4] * X[1] + R[7] * X[2]];
  if (S.measure.points.length >= 2) S.measure.points = [];
  S.measure.points.push(b);
  if (S.measure.points.length === 2) {
    const [p, q] = S.measure.points;
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    const u0 = unit();
    $('#measure-hint', S.root).textContent = `Measured ${formatLength(d, app.unit, 2)} (≈ ${fmt(d / u0, 2)} ${S.target.type === 'gridboard' ? 'marker sizes' : 'squares'}). Click again to start a new measurement.`;
    announce(`Measured ${formatLength(d, app.unit, 1)}.`);
  }
  draw();
}
