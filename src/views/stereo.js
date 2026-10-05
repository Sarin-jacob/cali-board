import { html, render, $, $$, on, toast, announce, fmt, uid, download, copyText, confirmDialog, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { vision, grabFrame, nextVideoFrame } from '../engine/vision.js';
import { app } from '../app/state.js';
import { listCalibrations, calibLabel, scaleCalibration } from '../calib/library.js';
import { loadLastResult } from '../calib/session.js';
import { dbGet, dbPut, STORES } from '../app/db.js';
import { describeTarget, detectorSpec, normalizeTarget, typeInfo, validateTarget } from '../targets/targets.js';
import { viewParams, novelty, motionBetween } from '../calib/coverage.js';
import { pairDetections, rectificationError, rotationAngle, virtualRig } from '../calib/stereo.js';
import { STEREO_FORMATS, exportStereo } from '../calib/exporters.js';
import { listCameras, openCamera, stopStream, cameraErrorMessage, videoReady, cameraSupported } from '../sources/camera.js';
import { VirtualCamera, LENSES } from '../sources/virtual.js';
import { prepareOverlay, drawDetection } from '../ui/overlay.js';
import { editTargetDialog } from '../ui/target-form.js';

let S = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAIRS_KEY = 'stereo-session';
const RESULT_KEY = 'last-stereo';
const MIN_POINTS = 6;

/** The virtual lenses' true intrinsics, offered so the stereo demo works without calibrating first. */
const VIRTUAL_CALIBS = Object.entries(LENSES).map(([k, l]) => ({
  ...l.calib, id: `__virtual:${k}`, name: `Virtual ${k} lens (true intrinsics)`, rms: 0,
  distortion: l.calib.model === 'fisheye' ? 'fisheye' : 'standard5', camera: { kind: 'virtual', lens: k },
}));

export default {
  title: 'Stereo',
  async mount(root) {
    S = { root, calibs: [], c1: null, c2: null, target: null, source: null, live: false, token: 0, det: [null, null], hist: [], lastCapture: 0, busy: false, pairs: [], result: null, format: 'opencv', auto: true, urls: [] };
    const [saved, last, pairsRec, resRec] = await Promise.all([listCalibrations(), loadLastResult(), dbGet(STORES.sessions, PAIRS_KEY).catch(() => null), dbGet(STORES.sessions, RESULT_KEY).catch(() => null)]);
    if (!S) return;
    S.calibs = [...saved];
    if (last && !last.savedAt) S.calibs.unshift({ ...last, id: '__latest', name: 'Latest result (unsaved)' });
    S.calibs.push(...VIRTUAL_CALIBS);
    S.pairs = pairsRec?.pairs || [];
    S.result = resRec?.result || null;
    S.c1 = S.calibs.find((c) => c.id === pairsRec?.c1) || S.calibs[0];
    S.c2 = S.calibs.find((c) => c.id === pairsRec?.c2) || S.c1;
    S.target = normalizeTarget(pairsRec?.target || (S.c1.target && typeInfo(S.c1.target.type)?.calibration ? S.c1.target : app.target));

    const camSelect = (id) => html`<select id="${id}" class="select"><option value="">Default camera</option></select>`;
    const calSelect = (id, cur) => html`<select id="${id}" class="select">${S.calibs.map((c) => html`<option value="${c.id}" ${cur?.id === c.id ? 'selected' : ''}>${calibLabel(c)}</option>`)}</select>`;
    render(root, html`
      <div>
        <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Stereo calibration</h1>
        <p class="mt-1 max-w-3xl muted">Find how two cameras sit relative to each other (rotation and baseline), then rectify them for depth estimation. Calibrate each camera on its own first — or try the virtual stereo rig.</p>
      </div>

      <section class="card card-pad mt-5 grid gap-4 lg:grid-cols-3" aria-label="Setup">
        <div class="space-y-2">
          <h2 class="section-title">Camera 1 (left)</h2>
          <label class="label" for="cal1">Intrinsics</label>${calSelect('cal1', S.c1)}
          ${cameraSupported() ? html`<label class="label" for="dev1">Device</label>${camSelect('dev1')}` : ''}
        </div>
        <div class="space-y-2">
          <h2 class="section-title">Camera 2 (right)</h2>
          <label class="label" for="cal2">Intrinsics</label>${calSelect('cal2', S.c2)}
          ${cameraSupported() ? html`<label class="label" for="dev2">Device</label>${camSelect('dev2')}` : ''}
        </div>
        <div class="space-y-2">
          <div class="flex items-center justify-between"><h2 class="section-title">Target</h2><button type="button" class="btn btn-ghost btn-sm" data-edit-target>${icon('edit')} Change</button></div>
          <p class="text-sm" id="target-desc"></p>
          <p class="text-xs muted">ChArUco or marker grids are best: both cameras can see different parts of the board. Checkerboards must be fully visible in both.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2 lg:col-span-3">
          ${cameraSupported() ? html`<button type="button" class="btn btn-primary" data-start="cameras">${icon('play')} Start both cameras</button>` : ''}
          <button type="button" class="btn btn-secondary" data-start="virtual">${icon('sparkles')} Virtual stereo rig</button>
          <button type="button" class="btn btn-secondary" data-stop hidden>${icon('stop')} Stop</button>
          <span class="mx-1 hidden h-6 w-px bg-slate-200 sm:block dark:bg-slate-700" aria-hidden="true"></span>
          <label class="btn btn-ghost">${icon('upload')} Left photos<input type="file" accept="image/*" multiple class="sr-only" id="files1" /></label>
          <label class="btn btn-ghost">${icon('upload')} Right photos<input type="file" accept="image/*" multiple class="sr-only" id="files2" /></label>
          <span class="text-xs muted" id="files-status"></span>
        </div>
      </section>

      <section class="mt-4 grid gap-4 md:grid-cols-2" aria-label="Live views">
        ${[1, 2].map((i) => html`
          <figure class="min-w-0">
            <div class="stage" id="stage${i}" style="aspect-ratio:16/9">
              <video id="video${i}" muted playsinline autoplay aria-hidden="true"></video>
              <canvas id="overlay${i}" class="overlay" aria-hidden="true"></canvas>
              <div class="empty absolute inset-0 grid place-items-center text-sm text-slate-400">Camera ${i}</div>
            </div>
            <figcaption class="mt-1 text-xs muted" id="cap${i}">Camera ${i}</figcaption>
          </figure>`)}
      </section>

      <section class="card card-pad mt-4 flex flex-wrap items-center gap-3" aria-label="Capture">
        <button type="button" class="btn btn-primary" data-capture disabled>${icon('camera')} Capture pair</button>
        <label class="check-row items-center"><input type="checkbox" class="checkbox" data-auto checked /> <span>Auto-capture</span></label>
        <span class="text-sm" id="status" role="status"></span>
      </section>

      <section class="card card-pad mt-4" aria-labelledby="pairs-h">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pairs-h" class="section-title">Image pairs <span class="font-normal muted" id="pairs-count"></span></h2>
          <div class="flex gap-2">
            <button type="button" class="btn btn-ghost btn-sm" data-clear>${icon('trash')} Remove all</button>
            <button type="button" class="btn btn-success" data-solve disabled>${icon('sparkles')} Calibrate stereo</button>
          </div>
        </div>
        <ul class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" id="pairs"></ul>
      </section>

      <div id="result"></div>`);

    renderTarget();
    renderPairs();
    renderResult();
    bind();
    refreshDevices();
    for (const i of [1, 2]) new ResizeObserver(debounce(() => drawOverlay(i - 1), 40)).observe($(`#stage${i}`, root));
  },
  unmount() {
    if (!S) return;
    stop();
    persistPairs();
    S.urls.forEach((u) => URL.revokeObjectURL(u));
    S = null;
  },
};

function persistPairs() {
  if (!S) return;
  dbPut(STORES.sessions, { id: PAIRS_KEY, pairs: S.pairs, c1: S.c1?.id, c2: S.c2?.id, target: S.target }).catch(() => {});
}

function bind() {
  const root = S.root;
  $('#cal1', root).addEventListener('change', (e) => { S.c1 = S.calibs.find((c) => c.id === e.target.value); checkCompat(); });
  $('#cal2', root).addEventListener('change', (e) => { S.c2 = S.calibs.find((c) => c.id === e.target.value); checkCompat(); });
  on(root, 'click', '[data-start]', (e, b) => start(b.dataset.start));
  on(root, 'click', '[data-stop]', () => stop());
  on(root, 'click', '[data-capture]', () => capturePair());
  on(root, 'change', '[data-auto]', (e, i) => { S.auto = i.checked; });
  on(root, 'click', '[data-solve]', () => solve());
  on(root, 'click', '[data-clear]', async () => {
    if (!S.pairs.length) return;
    if (!(await confirmDialog(`Remove all ${S.pairs.length} pairs?`, { confirmLabel: 'Remove all', danger: true }))) return;
    S.pairs = []; persistPairs(); renderPairs();
  });
  on(root, 'click', '[data-del]', (e, b) => { S.pairs = S.pairs.filter((p) => p.id !== b.dataset.del); persistPairs(); renderPairs(); });
  on(root, 'click', '[data-edit-target]', async () => {
    const t = await editTargetDialog(S.target, app.unit);
    if (!t) return;
    if (S.pairs.length && !(await confirmDialog('Changing the target removes the captured pairs.', { confirmLabel: 'Change target' }))) return;
    S.target = t; S.pairs = []; persistPairs(); renderTarget(); renderPairs();
  });
  const files = { 1: null, 2: null };
  for (const i of [1, 2]) {
    $(`#files${i}`, root).addEventListener('change', (e) => {
      files[i] = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      e.target.value = '';
      $('#files-status', root).textContent = `${files[1]?.length || 0} left · ${files[2]?.length || 0} right`;
      if (files[1] && files[2]) { addPhotoPairs(files[1], files[2]); files[1] = files[2] = null; }
    });
  }
  window.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (!S || e.code !== 'Space' || !S.live || e.target.closest?.('input, select, textarea, button, a, dialog')) return;
  e.preventDefault();
  capturePair();
}

function renderTarget() {
  const v = validateTarget(S.target);
  render($('#target-desc', S.root), html`${describeTarget(S.target, app.unit)}${!v.ok ? html`<span class="mt-1 block callout callout-bad">${v.errors[0]}</span>` : ''}`);
}

function checkCompat() {
  const { c1, c2 } = S;
  if (c1.imageSize.width !== c2.imageSize.width || c1.imageSize.height !== c2.imageSize.height) toast('Both cameras must be calibrated at the same resolution for stereo.', { type: 'warn', timeout: 6000 });
  else if (c1.model !== c2.model) toast('Both calibrations must use the same lens model (pinhole or fisheye).', { type: 'warn', timeout: 6000 });
  persistPairs();
}

async function refreshDevices() {
  try {
    const cams = await listCameras();
    for (const [i, id] of [[0, 'dev1'], [1, 'dev2']]) {
      const sel = $(`#${id}`, S?.root);
      if (!sel) continue;
      render(sel, html`<option value="">Default camera</option>${cams.map((c, k) => html`<option value="${c.deviceId}" ${k === i ? 'selected' : ''}>${c.label}</option>`)}`);
    }
  } catch { /* ignore */ }
}

function urlFor(blob) { if (!blob) return ''; const u = URL.createObjectURL(blob); S.urls.push(u); return u; }

function renderPairs() {
  if (!S) return;
  $('#pairs-count', S.root).textContent = S.pairs.length ? `(${S.pairs.length})` : '';
  $('[data-solve]', S.root).disabled = S.pairs.length < 3;
  render($('#pairs', S.root), S.pairs.length ? html`${S.pairs.map((p) => html`
    <li class="thumb">
      <div class="grid grid-cols-2 gap-px bg-slate-300 dark:bg-slate-700">
        ${p.thumb1 ? html`<img src="${urlFor(p.thumb1)}" alt="Pair ${p.n}, camera 1" />` : html`<span class="aspect-video"></span>`}
        ${p.thumb2 ? html`<img src="${urlFor(p.thumb2)}" alt="Pair ${p.n}, camera 2" />` : html`<span class="aspect-video"></span>`}
      </div>
      <div class="flex items-center justify-between px-2 py-1.5 text-xs">
        <span><strong>#${p.n}</strong> · ${p.count} shared points${S.result?.rect?.perPair?.[S.pairs.indexOf(p)] !== undefined ? html` · <span class="tabular-nums">${fmt(S.result.rect.perPair[S.pairs.indexOf(p)], 2)} px</span>` : ''}</span>
        <button type="button" class="btn btn-ghost btn-sm min-h-7 px-1.5 text-rose-700 dark:text-rose-400" data-del="${p.id}" aria-label="Delete pair ${p.n}">${icon('trash')}</button>
      </div>
    </li>`)}` : html`<li class="col-span-full rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm muted dark:border-slate-700">No pairs yet. Both cameras must see the target at the same time.</li>`);
}

// ---------------------------------------------------------------------------------------------

function stop() {
  if (!S) return;
  S.live = false; S.token++;
  if (S.source) {
    for (const s of [S.source.a, S.source.b]) { if (s?.vcam) s.vcam.stop(); else if (s?.stream) stopStream(s.stream); }
  }
  S.source = null;
  for (const i of [1, 2]) {
    const v = $(`#video${i}`, S.root);
    if (v) { v.pause(); v.srcObject = null; }
    const e = $(`#stage${i} .empty`, S.root);
    if (e) e.hidden = false;
  }
  const b = $('[data-stop]', S.root);
  if (b) b.hidden = true;
  const c = $('[data-capture]', S.root);
  if (c) c.disabled = true;
  window.removeEventListener('keydown', onKey);
  S.det = [null, null];
  drawOverlay(0); drawOverlay(1);
}

async function start(kind) {
  stop();
  window.addEventListener('keydown', onKey);
  if (!validateTarget(S.target).ok) { toast('Fix the target first.', { type: 'bad' }); return; }
  try {
    let a, b;
    if (kind === 'virtual') {
      const lens = S.c1.camera?.kind === 'virtual' ? S.c1.camera.lens : 'webcam';
      const rig = virtualRig(60, 3);
      const t0 = performance.now() + 50;
      const v1 = new VirtualCamera(lens, S.target, { seed: 11, stereo: true, t0 });
      const v2 = new VirtualCamera(lens, S.target, { seed: 11, stereo: true, t0, extrinsic: rig });
      const [s1, s2] = await Promise.all([v1.start(), v2.start()]);
      a = { vcam: v1, stream: s1 }; b = { vcam: v2, stream: s2 };
      S.rigTruth = { R: rig.R, T: rig.t, lens };
      if (S.c1.camera?.kind !== 'virtual' || S.c2.camera?.kind !== 'virtual') {
        // Default to the true virtual intrinsics so the demo works out of the box.
        S.c1 = S.c2 = S.calibs.find((c) => c.id === `__virtual:${lens}`);
        $('#cal1', S.root).value = S.c1.id; $('#cal2', S.root).value = S.c2.id;
        toast('Using the virtual lens’ true intrinsics for both cameras.', { type: 'info' });
      }
    } else {
      const want = S.c1.imageSize;
      const d1 = $('#dev1', S.root)?.value, d2 = $('#dev2', S.root)?.value;
      if (d1 && d1 === d2) throw new Error('Choose two different cameras.');
      const c1 = await openCamera({ deviceId: d1 || undefined, ...want });
      let c2;
      try { c2 = await openCamera({ deviceId: d2 || undefined, ...S.c2.imageSize }); } catch (err) { stopStream(c1.stream); throw err; }
      a = { stream: c1.stream, track: c1.track }; b = { stream: c2.stream, track: c2.track };
      S.rigTruth = null;
    }
    S.source = { kind, a, b };
    for (const [i, s] of [[1, a], [2, b]]) {
      const v = $(`#video${i}`, S.root);
      v.srcObject = s.stream;
      try { await v.play(); } catch { /* muted autoplay */ }
      await videoReady(v);
      $(`#stage${i}`, S.root).style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
      $(`#stage${i} .empty`, S.root).hidden = true;
      $(`#cap${i}`, S.root).textContent = `Camera ${i}: ${v.videoWidth}×${v.videoHeight}${s.vcam ? ' (virtual)' : s.track?.label ? ` — ${s.track.label}` : ''}`;
    }
    $('[data-stop]', S.root).hidden = false;
    $('[data-capture]', S.root).disabled = false;
    S.live = true;
    loop(++S.token);
    announce('Stereo capture started.');
  } catch (err) {
    console.error(err);
    stop();
    toast(kind === 'cameras' ? cameraErrorMessage(err) : err.message, { type: 'bad', timeout: 8000 });
  }
}

async function detectIn(video) {
  const g = await grabFrame(video, 960);
  const det = await vision.call('detect', { frame: g.frame, spec: detectorSpec(S.target), opts: { mode: 'live' } }, g.transfer);
  if (g.scale !== 1) {
    const up = (a) => a && Float32Array.from(a, (v) => (v + 0.5) / g.scale - 0.5);
    det.points = up(det.points);
    if (det.markers) det.markers.corners = up(det.markers.corners);
  }
  det.width = video.videoWidth; det.height = video.videoHeight;
  return det;
}

async function loop(token) {
  const v1 = $('#video1', S.root), v2 = $('#video2', S.root);
  while (S && S.live && token === S.token) {
    if (!vision.ready || S.busy || v1.readyState < 2 || v2.readyState < 2) { await sleep(100); continue; }
    try {
      const d1 = await detectIn(v1);
      const d2 = await detectIn(v2);
      if (!S || token !== S.token) return;
      S.det = [d1, d2];
      const now = performance.now();
      S.hist.push({ t: now, d1, d2 });
      while (S.hist.length && now - S.hist[0].t > 1500) S.hist.shift();
      evaluate(now);
      drawOverlay(0); drawOverlay(1);
    } catch (err) {
      if (!S || token !== S.token) return;
      await sleep(200);
    }
    await nextVideoFrame(v1);
  }
}

function evaluate(now) {
  const [d1, d2] = S.det;
  const pair = pairDetections(S.target, d1, d2);
  const status = $('#status', S.root);
  if (!pair || pair.count < MIN_POINTS) {
    status.textContent = !d1?.found && !d2?.found ? 'Looking for the target in both cameras…' : !d1?.found ? 'Camera 1 cannot see the target.' : !d2?.found ? 'Camera 2 cannot see the target.' : 'Too few points visible in both cameras.';
    return;
  }
  const params = viewParams(pair.obj, pair.img1, { width: d1.width, height: d1.height });
  const d = novelty(params, S.pairs.map((p) => p.params));
  const past = S.hist.find((h) => now - h.t >= 350 && now - h.t < 1000);
  const still = past && motionBetween(d1, past.d1) < 1.2 && motionBetween(d2, past.d2) < 1.2;
  if (d < 0.2) status.textContent = `${pair.count} shared points — this position is already captured; move the board.`;
  else if (!still) status.textContent = `${pair.count} shared points — hold still…`;
  else {
    status.textContent = `${pair.count} shared points — capturing.`;
    if (S.auto && !S.busy && now - S.lastCapture > 1200) capturePair();
  }
}

function drawOverlay(i) {
  if (!S) return;
  const canvas = $(`#overlay${i + 1}`, S.root);
  const det = S.det[i];
  if (!canvas) return;
  if (!det) { prepareOverlay(canvas, { width: 1, height: 1 }); return; }
  const o = prepareOverlay(canvas, { width: det.width, height: det.height });
  drawDetection(o.ctx, det, { ...o, target: S.target, color: '#22c55e' });
}

async function analyze(source, expect) {
  const spec = detectorSpec(S.target);
  const src = source instanceof HTMLVideoElement ? await createImageBitmap(source) : source;
  const r = await vision.call('analyze', { source: src, spec, preview: { maxSide: 1280, quality: 0.85 }, thumb: { maxSide: 320, quality: 0.8 } }, src instanceof ImageBitmap ? [src] : []);
  if (r.width !== expect.width || r.height !== expect.height) throw new Error(`Image is ${r.width}×${r.height}; the intrinsics are for ${expect.width}×${expect.height}.`);
  return r;
}

function addPair(r1, r2, name) {
  const pair = pairDetections(S.target, r1, r2);
  if (!pair || pair.count < MIN_POINTS) return false;
  S.pairs.push({
    id: uid(), n: (S.pairs.at(-1)?.n || 0) + 1, name, ...pair,
    params: viewParams(pair.obj, pair.img1, { width: r1.width, height: r1.height }),
    thumb1: r1.thumb, thumb2: r2.thumb, preview1: r1.preview, preview2: r2.preview,
  });
  return true;
}

async function capturePair() {
  if (!S?.live || S.busy) return;
  S.busy = true;
  S.lastCapture = performance.now();
  for (const i of [1, 2]) { const st = $(`#stage${i}`, S.root); st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash'); }
  try {
    const [b1, b2] = await Promise.all([createImageBitmap($('#video1', S.root)), createImageBitmap($('#video2', S.root))]);
    const r1 = await analyze(b1, S.c1.imageSize);
    const r2 = await analyze(b2, S.c2.imageSize);
    if (!S) return;
    if (addPair(r1, r2)) { persistPairs(); renderPairs(); announce(`Pair ${S.pairs.length} captured.`); }
    else toast('The board was not detected well enough in both cameras.', { type: 'warn' });
  } catch (err) {
    toast(err.message, { type: 'bad', timeout: 6000 });
  } finally {
    if (S) { S.busy = false; S.lastCapture = performance.now(); }
  }
}

async function addPhotoPairs(f1, f2) {
  if (f1.length !== f2.length) toast(`Different numbers of left (${f1.length}) and right (${f2.length}) photos — pairing by sorted file name.`, { type: 'warn', timeout: 6000 });
  stop();
  await vision.start();
  let ok = 0;
  const n = Math.min(f1.length, f2.length);
  for (let i = 0; i < n; i++) {
    $('#files-status', S.root).textContent = `Analysing pair ${i + 1} of ${n}…`;
    try {
      const [r1, r2] = [await analyze(f1[i], S.c1.imageSize), await analyze(f2[i], S.c2.imageSize)];
      if (!S) return;
      if (addPair(r1, r2, `${f1[i].name} + ${f2[i].name}`)) ok++;
    } catch (err) {
      toast(`${f1[i].name}: ${err.message}`, { type: 'warn' });
    }
  }
  if (!S) return;
  $('#files-status', S.root).textContent = `${ok} of ${n} pairs usable.`;
  persistPairs();
  renderPairs();
}

// ---------------------------------------------------------------------------------------------

async function solve() {
  const { c1, c2 } = S;
  if (c1.imageSize.width !== c2.imageSize.width || c1.imageSize.height !== c2.imageSize.height) { toast('Both cameras must share one resolution.', { type: 'bad' }); return; }
  if (c1.model !== c2.model) { toast('Both cameras must use the same lens model.', { type: 'bad' }); return; }
  const btn = $('[data-solve]', S.root);
  btn.disabled = true;
  try {
    const views = S.pairs.map((p) => ({ obj: p.obj, img1: p.img1, img2: p.img2 }));
    const strip = (c) => ({ model: c.model, K: c.K, D: c.D, imageSize: c.imageSize, distortion: c.distortion, name: c.name });
    const req = { views, imageSize: c1.imageSize, calib1: strip(c1), calib2: strip(c2) };
    const out = await vision.call('stereoCalibrate', { req });
    const rect = await vision.call('stereoRectify', { req: { calib1: req.calib1, calib2: req.calib2, R: out.R, T: out.T, alpha: 0, imageSize: c1.imageSize } });
    const result = {
      createdAt: Date.now(), imageSize: c1.imageSize, units: 'mm', calib1: req.calib1, calib2: req.calib2,
      R: out.R, T: out.T, E: out.E, F: out.F, rms: out.rms, ...rect,
      baseline: Math.hypot(...out.T), rotationDeg: rotationAngle(out.R), pairs: S.pairs.map((p) => ({ n: p.n })),
      truth: S.rigTruth && c1.camera?.kind === 'virtual' ? S.rigTruth : null,
    };
    result.rect = rectificationError(result, S.pairs);
    result.rectError = result.rect.mean;
    S.result = result;
    dbPut(STORES.sessions, { id: RESULT_KEY, result }).catch(() => {});
    renderPairs();
    renderResult();
    announce(`Stereo calibration done. Baseline ${result.baseline.toFixed(1)} millimetres, rectification error ${result.rectError.toFixed(2)} pixels.`);
    $('#result-h', S.root)?.focus();
  } catch (err) {
    console.error(err);
    toast(err.fatal ? 'Stereo calibration failed inside OpenCV — check that both intrinsics belong to these cameras.' : err.message, { type: 'bad', timeout: 8000 });
  } finally {
    if (S) btn.disabled = S.pairs.length < 3;
  }
}

function renderResult() {
  const r = S.result, box = $('#result', S.root);
  if (!r) { render(box, html``); return; }
  const grade = r.rectError < 0.5 ? 'pill-ok' : r.rectError < 1.5 ? 'pill-warn' : 'pill-bad';
  const T = r.T;
  const truth = r.truth;
  render(box, html`
    <section class="card card-pad mt-4" aria-labelledby="result-h">
      <h2 id="result-h" tabindex="-1" class="section-title">Stereo result</h2>
      <div class="mt-3 grid gap-4 md:grid-cols-4">
        <div><p class="eyebrow">Baseline</p><p class="text-3xl font-bold tabular-nums">${fmt(r.baseline, 1)} <span class="text-base muted">mm</span></p></div>
        <div><p class="eyebrow">Relative rotation</p><p class="text-3xl font-bold tabular-nums">${fmt(r.rotationDeg, 2)}°</p></div>
        <div><p class="eyebrow">Reprojection RMS</p><p class="text-3xl font-bold tabular-nums">${fmt(r.rms, 3)} <span class="text-base muted">px</span></p></div>
        <div><p class="eyebrow">Rectification error</p><p class="text-3xl font-bold tabular-nums">${fmt(r.rectError, 3)} <span class="text-base muted">px</span></p><span class="pill ${grade}">${r.rectError < 0.5 ? 'Excellent' : r.rectError < 1.5 ? 'Usable' : 'Poor'}</span></div>
      </div>
      <p class="mt-3 text-sm muted">T = (${fmt(T[0], 2)}, ${fmt(T[1], 2)}, ${fmt(T[2], 2)}) mm — where camera 1’s origin appears in camera 2’s coordinates. Rectification error = average row mismatch of matching points after rectification (should be well below 1 px).</p>
      ${truth ? html`<p class="callout callout-info mt-3 text-sm">Virtual rig truth: baseline ${fmt(Math.hypot(...truth.T), 1)} mm, rotation ${fmt(rotationAngle(truth.R), 2)}°. Estimated baseline error ${fmt(r.baseline - Math.hypot(...truth.T), 2)} mm.</p>` : ''}

      <h3 class="mt-5 font-semibold">Rectified pair</h3>
      <div class="mt-2 flex flex-wrap items-end gap-3">
        <div><label class="label" for="rect-pair">Pair</label><select id="rect-pair" class="select">${S.pairs.map((p, i) => html`<option value="${i}">#${p.n}${p.name ? ` — ${p.name}` : ''}</option>`)}</select></div>
        <p class="text-xs muted">Green lines are horizontal: the same scene point must sit on the same line in both images.</p>
      </div>
      <div class="relative mt-2 grid grid-cols-2 gap-1 overflow-hidden rounded-xl bg-slate-900">
        <canvas id="rect1" class="w-full" role="img" aria-label="Rectified camera 1 image"></canvas>
        <canvas id="rect2" class="w-full" role="img" aria-label="Rectified camera 2 image"></canvas>
        <div class="pointer-events-none absolute inset-0" style="background: repeating-linear-gradient(to bottom, transparent 0 31px, rgba(34,197,94,.75) 31px 32px)"></div>
      </div>

      <div class="mt-5 flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold">Export</h3>
        <div class="flex gap-2"><button type="button" class="btn btn-secondary btn-sm" data-sx-copy>${icon('copy')} Copy</button><button type="button" class="btn btn-primary btn-sm" data-sx-download>${icon('download')} Download</button></div>
      </div>
      <div class="seg mt-2 flex-wrap" role="tablist" aria-label="Export format">${STEREO_FORMATS.map((f) => html`<button type="button" role="tab" data-sx="${f.id}" aria-selected="${S.format === f.id}">${f.label}</button>`)}</div>
      <p class="mt-2 text-xs muted" id="sx-note"></p>
      <pre class="code mt-2" id="sx-code" tabindex="0" aria-label="Exported stereo calibration"></pre>
    </section>`);
  const code = () => {
    const f = STEREO_FORMATS.find((x) => x.id === S.format);
    $('#sx-note', box).textContent = f.note;
    $('#sx-code', box).textContent = exportStereo(r, S.format);
  };
  code();
  on(box, 'click', '[data-sx]', (e, b) => { S.format = b.dataset.sx; $$('[data-sx]', box).forEach((x) => x.setAttribute('aria-selected', String(x === b))); code(); });
  on(box, 'click', '[data-sx-copy]', () => copyText($('#sx-code', box).textContent));
  on(box, 'click', '[data-sx-download]', () => { const f = STEREO_FORMATS.find((x) => x.id === S.format); download($('#sx-code', box).textContent, `stereo_${S.format}.${f.ext}`, f.mime); });
  $('#rect-pair', box)?.addEventListener('change', (e) => drawRectified(Number(e.target.value)));
  drawRectified(0);
}

/** Scales a 3×4 projection matrix to an image resized by `s` (pixel-centre convention). */
function scaleP(P, s) {
  const o = [...P];
  for (const r of [0, 1]) { for (let c = 0; c < 4; c++) o[4 * r + c] = P[4 * r + c] * s; o[4 * r + 2] += (0.5 * s - 0.5) * P[10]; }
  return o;
}

async function drawRectified(index) {
  const p = S.pairs[index], r = S.result;
  if (!p || !r) return;
  for (const [k, blob, calib, R, P] of [[1, p.preview1 || p.thumb1, r.calib1, r.R1, r.P1], [2, p.preview2 || p.thumb2, r.calib2, r.R2, r.P2]]) {
    if (!blob) continue;
    try {
      const bmp = await createImageBitmap(blob);
      const s = bmp.width / r.imageSize.width;
      const c = Math.abs(s - 1) < 1e-6 ? calib : scaleCalibration(calib, s, { width: bmp.width, height: bmp.height });
      const out = await vision.call('undistort', { frame: bmp, calib: c, opts: { R, P: Math.abs(s - 1) < 1e-6 ? P : scaleP(P, s) } }, [bmp]);
      if (!S) return;
      const canvas = $(`#rect${k}`, S.root);
      canvas.width = out.width; canvas.height = out.height;
      const ctx = canvas.getContext('2d');
      if (out.bitmap) { ctx.drawImage(out.bitmap, 0, 0); out.bitmap.close(); } else ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    } catch (err) {
      console.error(err);
      toast(`Rectification preview failed: ${err.message}`, { type: 'bad' });
      return;
    }
  }
}
