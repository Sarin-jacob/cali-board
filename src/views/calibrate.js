import { html, render, $, $$, on, toast, announce, confirmDialog, openDialog, prefs, fmt, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { vision, grabFrame } from '../engine/vision.js';
import { app, setTarget, emit } from '../app/state.js';
import { describeTarget, detectorSpec, objectPoints, typeInfo, validateTarget, maxPoints } from '../targets/targets.js';
import { createSession, addView, enabledViews, loadSession, saveSession, discardSession, saveLastResult } from '../calib/session.js';
import { viewParams, novelty, coverageProgress, weakest, coverageGrid, coverageFraction, outerQuad, motionBetween } from '../calib/coverage.js';
import { calibrateSession, MODELS, ADVANCED_MODELS, modelInfo } from '../calib/run.js';
import { RESOLUTIONS, listCameras, openCamera, stopStream, setTorch, lockFocus, cameraErrorMessage, videoReady, cameraSupported } from '../sources/camera.js';
import { VirtualCamera, LENSES } from '../sources/virtual.js';
import { prepareOverlay, drawDetection, drawGhosts, drawCoverage, drawResiduals } from '../ui/overlay.js';
import { editTargetDialog } from '../ui/target-form.js';

const LIVE_MAX_SIDE = 960;   // live detection runs on a downscaled frame
const COOLDOWN_MS = 1200;    // minimum time between automatic captures
const STILL_WINDOW_MS = 350; // compare against the detection this long ago
const NOVELTY = 0.2;         // ROS-style parameter distance for a "new" view
const RECOMMENDED_VIEWS = 20;

let S = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
/** Resolves on the next *new* video frame (avoids re-analysing duplicates), else next paint. */
const nextVideoFrame = (video) => new Promise((r) => {
  if (video.requestVideoFrameCallback) {
    const t = setTimeout(r, 250); // never stall if the stream freezes
    video.requestVideoFrameCallback(() => { clearTimeout(t); r(); });
  } else requestAnimationFrame(() => r());
});

function defaults() {
  return {
    modelId: 'standard4', fixAspectRatio: false, zeroTangent: false, fixPrincipalPoint: false, robust: true,
    auto: true, showCoverage: false, sourceTab: 'camera', resolution: '1280x720', lens: 'webcam',
    ...prefs.get('calibrate', {}),
  };
}
const savePrefs = () => S && prefs.set('calibrate', S.prefs);

export default {
  title: 'Calibrate',
  async mount(root, params) {
    S = {
      root, prefs: defaults(), session: null, source: null, live: false, loopToken: 0,
      lastDet: null, history: [], lastCaptureAt: 0, busy: false, status: 'idle', urls: new Map(),
      photoLog: [], solving: false,
    };
    if (params[0] === 'demo') S.prefs.sourceTab = 'virtual';

    // Restore an unfinished session (survives reloads), else start fresh with the current target.
    const saved = await loadSession();
    if (!S) return;
    if (saved && saved.views?.length) {
      S.session = saved;
      if (JSON.stringify(saved.target) !== JSON.stringify(app.target)) setTarget(saved.target);
    } else {
      S.session = createSession(app.target);
    }

    render(root, html`
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Calibrate a camera</h1>
          <p class="mt-1 muted">Show the target from many positions and angles. CaliBoard captures the useful views and tells you what is still missing.</p>
        </div>
        <div class="flex gap-2">
          <button type="button" class="btn btn-secondary" data-new>${icon('refresh')} New session</button>
        </div>
      </div>

      <div class="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <section class="min-w-0 space-y-4" aria-label="Capture">
          <div class="stage" id="stage" style="aspect-ratio: 16 / 9">
            <video id="video" muted playsinline autoplay aria-hidden="true"></video>
            <canvas id="overlay" class="overlay" aria-hidden="true"></canvas>
            <div id="stage-empty" class="absolute inset-0 grid place-items-center p-6 text-center text-slate-300">
              <div class="max-w-sm">
                <span class="mx-auto grid size-12 place-items-center rounded-full bg-slate-800">${icon('camera', 'size-6')}</span>
                <p class="mt-3 font-semibold text-white">No live source</p>
                <p class="mt-1 text-sm text-slate-400">Start a camera or the virtual camera on the right — or upload photos you already took.</p>
              </div>
            </div>
            <div class="pointer-events-none absolute left-3 top-3 right-3 flex flex-wrap items-start justify-between gap-2">
              <span id="hud-status" class="pill bg-slate-950/75 text-white backdrop-blur" hidden></span>
              <span id="hud-stats" class="pill bg-slate-950/60 font-mono text-slate-200 backdrop-blur" hidden></span>
            </div>
          </div>

          <div class="card card-pad flex flex-wrap items-center gap-3">
            <button type="button" class="btn btn-primary btn-lg" data-capture disabled aria-keyshortcuts="Space">${icon('camera')} Capture <kbd class="ml-1 hidden rounded bg-white/20 px-1.5 text-xs font-medium sm:inline">Space</kbd></button>
            <label class="check-row items-center"><input type="checkbox" class="checkbox" data-pref="auto" ${S.prefs.auto ? 'checked' : ''} /> <span>Auto-capture when the board is still and in a new position</span></label>
            <label class="check-row items-center"><input type="checkbox" class="checkbox" data-pref="showCoverage" ${S.prefs.showCoverage ? 'checked' : ''} /> <span>Show coverage</span></label>
          </div>

          <div class="card card-pad" aria-labelledby="cov-h">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="cov-h" class="section-title">Coverage</h2>
              <p class="text-sm muted" id="cov-summary"></p>
            </div>
            <div class="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2" id="cov-bars"></div>
            <p class="mt-3 text-sm" id="cov-hint"></p>
          </div>

          <div class="card card-pad" aria-labelledby="views-h">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 id="views-h" class="section-title">Captured views <span class="font-normal muted" id="views-count"></span></h2>
              <button type="button" class="btn btn-ghost btn-sm" data-clear-views>${icon('trash')} Remove all</button>
            </div>
            <ul class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5" id="gallery" aria-live="polite"></ul>
          </div>
        </section>

        <aside class="space-y-4" aria-label="Settings">
          <section class="card card-pad" aria-labelledby="t-h">
            <div class="flex items-center justify-between gap-2">
              <h2 id="t-h" class="section-title">1 · Target</h2>
              <div class="flex gap-1">
                <button type="button" class="btn btn-ghost btn-sm" data-edit-target>${icon('edit')} Change</button>
                <a class="btn btn-ghost btn-sm" href="#/targets">${icon('printer')} Print</a>
              </div>
            </div>
            <p class="mt-2 text-sm" id="target-desc"></p>
          </section>

          <section class="card card-pad" aria-labelledby="s-h">
            <h2 id="s-h" class="section-title">2 · Images</h2>
            <div class="seg mt-3 w-full" role="tablist" aria-label="Image source">
              ${[['camera', 'Camera'], ['photos', 'Photos'], ['virtual', 'Virtual']].map(([id, label]) => html`
                <button type="button" role="tab" class="flex-1" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${S.prefs.sourceTab === id}" data-tab="${id}">${label}</button>`)}
            </div>
            <div class="mt-4" id="panel-camera" role="tabpanel" aria-labelledby="tab-camera" ${S.prefs.sourceTab !== 'camera' ? 'hidden' : ''}></div>
            <div class="mt-4" id="panel-photos" role="tabpanel" aria-labelledby="tab-photos" ${S.prefs.sourceTab !== 'photos' ? 'hidden' : ''}></div>
            <div class="mt-4" id="panel-virtual" role="tabpanel" aria-labelledby="tab-virtual" ${S.prefs.sourceTab !== 'virtual' ? 'hidden' : ''}></div>
          </section>

          <section class="card card-pad" aria-labelledby="c-h">
            <h2 id="c-h" class="section-title">3 · Calibrate</h2>
            <fieldset class="group mt-3">
              <legend class="sr-only">Lens model</legend>
              <div class="grid gap-2" id="models"></div>
            </fieldset>
            <details class="mt-3 text-sm">
              <summary class="cursor-pointer font-medium">Advanced options</summary>
              <div class="mt-3 space-y-2">
                <label class="check-row"><input type="checkbox" class="checkbox" data-opt="robust" ${S.prefs.robust ? 'checked' : ''} /> <span>Robust fitting — drop outlier corners and re-solve</span></label>
                <label class="check-row"><input type="checkbox" class="checkbox" data-opt="fixAspectRatio" ${S.prefs.fixAspectRatio ? 'checked' : ''} /> <span>Fix aspect ratio (fx = fy, square pixels)</span></label>
                <label class="check-row"><input type="checkbox" class="checkbox" data-opt="zeroTangent" ${S.prefs.zeroTangent ? 'checked' : ''} /> <span>Assume zero tangential distortion (p1 = p2 = 0)</span></label>
                <label class="check-row"><input type="checkbox" class="checkbox" data-opt="fixPrincipalPoint" ${S.prefs.fixPrincipalPoint ? 'checked' : ''} /> <span>Fix principal point at the image centre</span></label>
              </div>
            </details>
            <button type="button" class="btn btn-success btn-lg mt-4 w-full" data-run disabled>${icon('sparkles')} Calibrate</button>
            <p class="mt-2 text-sm muted" id="run-status" role="status"></p>
          </section>
        </aside>
      </div>`);

    renderTarget();
    renderSourcePanels();
    renderModels();
    renderViews();
    bindEvents();
    new ResizeObserver(debounce(drawOverlay, 50)).observe($('#stage', root));

    if (params[0] === 'demo') startVirtual();
  },
  unmount() {
    if (!S) return;
    stopSource();
    window.removeEventListener('keydown', onKey);
    if (S.session) saveSession(S.session, true);
    for (const url of S.urls.values()) URL.revokeObjectURL(url);
    S = null;
  },
};

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function renderTarget() {
  const t = S.session.target;
  const v = validateTarget(t);
  render($('#target-desc', S.root), html`
    <span class="font-medium">${describeTarget(t, app.unit)}</span>
    ${!v.ok ? html`<span class="mt-2 block callout callout-bad">${v.errors[0]}</span>` : ''}
    ${!typeInfo(t.type).calibration ? html`<span class="mt-2 block callout callout-warn">Marker sheets cannot be used for calibration — choose another target.</span>` : ''}
    <span class="mt-1 block text-xs muted">Up to ${maxPoints(t)} points per view. Sizes should be measured on your print.</span>`);
}

function renderSourcePanels() {
  const p = S.prefs;
  render($('#panel-camera', S.root), cameraSupported() ? html`
    <div class="space-y-3">
      <div><label class="label" for="cam-device">Camera</label><select id="cam-device" class="select"><option value="">Default camera</option></select></div>
      <div><label class="label" for="cam-res">Resolution</label>
        <select id="cam-res" class="select">${RESOLUTIONS.map((r) => html`<option value="${r.id}" ${p.resolution === r.id ? 'selected' : ''}>${r.label}</option>`)}</select>
        <p class="hint">Calibrate at the resolution you will use — intrinsics change with resolution and cropping.</p></div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-primary" data-cam-start>${icon('play')} Start camera</button>
        <button type="button" class="btn btn-secondary" data-cam-stop hidden>${icon('stop')} Stop</button>
        <button type="button" class="btn btn-secondary" data-torch hidden aria-pressed="false">${icon('flash')} Light</button>
        <button type="button" class="btn btn-secondary" data-focus hidden aria-pressed="false">${icon('crosshair')} Lock focus</button>
      </div>
      <p class="hint">Turn off auto-focus / image stabilisation if you can; both change the lens geometry between frames.</p>
    </div>` : html`<p class="callout callout-warn">This browser cannot access cameras. Use the Photos tab instead.</p>`);

  render($('#panel-photos', S.root), html`
    <label class="dropzone" id="dropzone" for="photo-input">
      ${icon('upload', 'size-6')}
      <span><strong>Choose photos</strong> or drop them here</span>
      <span class="text-xs">JPEG / PNG / WebP from one camera, same resolution, 10–40 images</span>
      <input id="photo-input" type="file" accept="image/*" multiple class="sr-only" />
    </label>
    <ul class="mt-3 max-h-48 space-y-1 overflow-auto text-xs" id="photo-log" aria-live="polite"></ul>`);

  render($('#panel-virtual', S.root), html`
    <div class="space-y-3">
      <p class="text-sm muted">A simulated camera films your target through a lens with known parameters. Learn the workflow without hardware, then compare your result with the truth.</p>
      <div><label class="label" for="lens">Lens</label>
        <select id="lens" class="select">${Object.entries(LENSES).map(([k, l]) => html`<option value="${k}" ${p.lens === k ? 'selected' : ''}>${l.label}</option>`)}</select></div>
      <div class="flex gap-2">
        <button type="button" class="btn btn-primary" data-virt-start>${icon('play')} Start virtual camera</button>
        <button type="button" class="btn btn-secondary" data-virt-stop hidden>${icon('stop')} Stop</button>
      </div>
    </div>`);
  refreshDevices();
}

function renderModels() {
  const all = [...MODELS, ...ADVANCED_MODELS];
  render($('#models', S.root), html`${all.map((m) => html`
    <label class="choice ${ADVANCED_MODELS.includes(m) ? 'hidden' : ''}" data-model-row="${m.id}">
      <input type="radio" name="model" value="${m.id}" class="sr-only" ${S.prefs.modelId === m.id ? 'checked' : ''} />
      <span class="flex items-baseline justify-between gap-2"><span class="font-semibold">${m.label}</span><span class="text-xs muted">${m.detail}</span></span>
      <span class="text-xs muted">${m.blurb}</span>
    </label>`)}
    <button type="button" class="btn btn-ghost btn-sm justify-self-start" data-more-models>${icon('chevronDown')} More models</button>`);
  if (ADVANCED_MODELS.some((m) => m.id === S.prefs.modelId)) showAdvancedModels();
}

function showAdvancedModels() {
  $$('[data-model-row]', S.root).forEach((el) => el.classList.remove('hidden'));
  $('[data-more-models]', S.root)?.remove();
}

function viewUrl(view) {
  if (!view.thumb) return '';
  let url = S.urls.get(view.id);
  if (!url) { url = URL.createObjectURL(view.thumb); S.urls.set(view.id, url); }
  return url;
}

function renderViews() {
  if (!S) return;
  const views = S.session.views;
  const enabled = enabledViews(S.session);
  $('#views-count', S.root).textContent = views.length ? `(${enabled.length} of ${views.length} used)` : '';
  const sharp = views.map((v) => v.sharpness).filter((x) => x > 0).sort((a, b) => a - b);
  const medSharp = sharp.length ? sharp[sharp.length >> 1] : 0;
  render($('#gallery', S.root), views.length ? html`${views.map((v) => {
    const blurry = medSharp && v.sharpness && v.sharpness < medSharp * 0.35;
    return html`
      <li class="thumb ${v.enabled ? '' : 'is-off'}">
        <button type="button" class="block w-full" data-inspect="${v.id}" aria-label="Inspect view ${v.n}${v.name ? ` (${v.name})` : ''}">
          ${v.thumb ? html`<img src="${viewUrl(v)}" alt="" loading="lazy" />` : html`<span class="grid aspect-video place-items-center text-xs muted">no preview</span>`}
        </button>
        <div class="flex items-center justify-between gap-1 px-2 py-1.5 text-xs">
          <span class="truncate" title="${v.name || ''}"><strong>#${v.n}</strong> · ${v.count} pts ${blurry ? html`<span class="pill pill-warn ml-1" title="Much less sharp than the other views">blurry?</span>` : ''}</span>
          <span class="flex shrink-0 gap-0.5">
            <button type="button" class="btn btn-ghost btn-sm min-h-7 px-1.5" data-toggle="${v.id}" aria-pressed="${v.enabled}" aria-label="${v.enabled ? 'Exclude' : 'Include'} view ${v.n}" title="${v.enabled ? 'Exclude from calibration' : 'Include in calibration'}">${icon(v.enabled ? 'eye' : 'eyeOff')}</button>
            <button type="button" class="btn btn-ghost btn-sm min-h-7 px-1.5 text-rose-600" data-delete="${v.id}" aria-label="Delete view ${v.n}" title="Delete">${icon('trash')}</button>
          </span>
        </div>
      </li>`;
  })}` : html`<li class="col-span-full rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm muted dark:border-slate-700">No views yet. Captured frames and analysed photos appear here.</li>`);
  renderCoverage();
  const run = $('[data-run]', S.root);
  run.disabled = enabled.length < 3 || S.solving;
  if (!S.solving) {
    $('#run-status', S.root).textContent = enabled.length < 3 ? 'Capture at least 3 views (aim for 15–30).' : enabled.length < 10 ? `${enabled.length} views — more views give a more reliable result.` : `${enabled.length} views ready.`;
  }
  drawOverlay();
}

function renderCoverage() {
  const views = enabledViews(S.session);
  const prog = coverageProgress(views.map((v) => v.params));
  render($('#cov-bars', S.root), html`${prog.map((p) => html`
    <div>
      <div class="flex justify-between text-sm"><span id="bar-${p.key}">${p.label}</span><span class="tabular-nums muted">${Math.round(p.progress * 100)} %</span></div>
      <div class="progress mt-1" role="progressbar" aria-labelledby="bar-${p.key}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.progress * 100)}">
        <span style="width:${Math.round(p.progress * 100)}%" class="${p.progress >= 1 ? '!bg-emerald-500' : ''}"></span>
      </div>
    </div>`)}`);
  const size = S.session.imageSize;
  const cov = size ? coverageFraction(coverageGrid(views.map((v) => v.points), size)) : 0;
  $('#cov-summary', S.root).textContent = views.length
    ? `${views.length} view${views.length > 1 ? 's' : ''} · ${Math.round(cov * 100)} % of the image covered${size ? ` · ${size.width}×${size.height}` : ''}`
    : 'Aim for ~20 views covering the whole frame';
  const w = weakest(prog);
  const done = views.length >= RECOMMENDED_VIEWS && prog.every((p) => p.progress >= 1);
  render($('#cov-hint', S.root), done
    ? html`<span class="text-emerald-700 dark:text-emerald-400">${icon('check', 'inline size-4')} Great coverage — you can calibrate now.</span>`
    : views.length ? html`<span class="muted">Next: ${w.hint}</span>` : html`<span class="muted">Start with the board filling about half the frame, then move it around.</span>`);
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

function bindEvents() {
  const root = S.root;
  on(root, 'click', '[data-tab]', (e, btn) => selectTab(btn.dataset.tab));
  on(root, 'keydown', '[role="tab"]', (e, btn) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = $$('[role="tab"]', root);
    const i = tabs.indexOf(btn) + (e.key === 'ArrowRight' ? 1 : -1);
    const next = tabs[(i + tabs.length) % tabs.length];
    next.focus(); selectTab(next.dataset.tab);
  });
  on(root, 'change', '[data-pref]', (e, input) => { S.prefs[input.dataset.pref] = input.checked; savePrefs(); drawOverlay(); });
  on(root, 'change', '[data-opt]', (e, input) => { S.prefs[input.dataset.opt] = input.checked; savePrefs(); });
  on(root, 'change', 'input[name="model"]', (e, input) => { S.prefs.modelId = input.value; savePrefs(); });
  on(root, 'click', '[data-more-models]', () => showAdvancedModels());
  on(root, 'click', '[data-capture]', () => capture('manual'));
  on(root, 'click', '[data-run]', () => runCalibration());
  on(root, 'click', '[data-new]', () => newSession());
  on(root, 'click', '[data-clear-views]', async () => {
    if (!S.session.views.length) return;
    if (await confirmDialog(`Remove all ${S.session.views.length} captured views?`, { confirmLabel: 'Remove all', danger: true })) resetSession();
  });
  on(root, 'click', '[data-edit-target]', async () => {
    const t = await editTargetDialog(S.session.target, app.unit);
    if (!t) return;
    if (S.session.views.length && !(await confirmDialog('Changing the target starts a new session (captured views are for the old target).', { confirmLabel: 'Change target' }))) return;
    setTarget(t);
    resetSession();
    renderTarget();
  });
  on(root, 'click', '[data-toggle]', (e, btn) => {
    const v = S.session.views.find((x) => x.id === btn.dataset.toggle);
    if (!v) return;
    v.enabled = !v.enabled;
    saveSession(S.session);
    renderViews();
    announce(`View ${v.n} ${v.enabled ? 'included' : 'excluded'}.`);
  });
  on(root, 'click', '[data-delete]', (e, btn) => {
    const i = S.session.views.findIndex((x) => x.id === btn.dataset.delete);
    if (i < 0) return;
    const [v] = S.session.views.splice(i, 1);
    const url = S.urls.get(v.id);
    if (url) { URL.revokeObjectURL(url); S.urls.delete(v.id); }
    if (!S.session.views.length) S.session.imageSize = null;
    saveSession(S.session);
    renderViews();
    announce(`View ${v.n} deleted.`);
  });
  on(root, 'click', '[data-inspect]', (e, btn) => inspectView(btn.dataset.inspect));
  on(root, 'click', '[data-cam-start]', () => startCamera());
  on(root, 'click', '[data-cam-stop]', () => stopSource());
  on(root, 'click', '[data-virt-start]', () => startVirtual());
  on(root, 'click', '[data-virt-stop]', () => stopSource());
  on(root, 'click', '[data-torch]', async (e, btn) => {
    const on_ = btn.getAttribute('aria-pressed') !== 'true';
    try { await setTorch(S.source.track, on_); btn.setAttribute('aria-pressed', String(on_)); } catch { toast('Could not switch the light', { type: 'warn' }); }
  });
  on(root, 'click', '[data-focus]', async (e, btn) => {
    const on_ = btn.getAttribute('aria-pressed') !== 'true';
    try { if (await lockFocus(S.source.track, on_)) btn.setAttribute('aria-pressed', String(on_)); else toast('This camera does not allow focus control', { type: 'warn' }); } catch { toast('Could not change focus mode', { type: 'warn' }); }
  });
  on(root, 'change', '#cam-res', (e, sel) => { S.prefs.resolution = sel.value; savePrefs(); if (S.source?.kind === 'camera') startCamera(); });
  on(root, 'change', '#cam-device', () => { if (S.source?.kind === 'camera') startCamera(); });
  on(root, 'change', '#lens', (e, sel) => { S.prefs.lens = sel.value; savePrefs(); if (S.source?.kind === 'virtual') startVirtual(); });
  on(root, 'change', '#photo-input', (e, input) => { addPhotos([...input.files]); input.value = ''; });
  const dz = $('#dropzone', root);
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('is-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('is-over'); addPhotos([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))); });
  window.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (!S || e.code !== 'Space' || e.repeat) return;
  const t = e.target;
  if (t.closest?.('input, select, textarea, button, a, [role="tab"], dialog')) return;
  if (!S.live) return;
  e.preventDefault();
  capture('manual');
}

function selectTab(id) {
  S.prefs.sourceTab = id; savePrefs();
  for (const t of ['camera', 'photos', 'virtual']) {
    $(`#tab-${t}`, S.root).setAttribute('aria-selected', String(t === id));
    $(`#panel-${t}`, S.root).hidden = t !== id;
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

function resetSession(source = S.session?.source || null) {
  for (const url of S.urls.values()) URL.revokeObjectURL(url);
  S.urls.clear();
  S.session = createSession(app.target, source);
  S.photoLog = [];
  render($('#photo-log', S.root), html``);
  discardSession();
  renderViews();
  renderTarget();
}

async function newSession() {
  if (S.session.views.length && !(await confirmDialog('Start a new session? The captured views will be discarded.', { confirmLabel: 'Start new session', danger: true }))) return;
  resetSession(null);
  announce('New session started.');
}

/** Ensures new images can join this session (same camera / resolution); may start a new one. */
async function ensureCompatible(kind, label, size) {
  const s = S.session;
  const sameSource = !s.source || (s.source.kind === kind && s.source.label === label);
  const sameSize = !s.imageSize || !size || (s.imageSize.width === size.width && s.imageSize.height === size.height);
  if (!s.views.length || (sameSource && sameSize)) { s.source = { kind, label }; return true; }
  const why = !sameSize ? `This source delivers ${size.width}×${size.height} but the session was captured at ${s.imageSize.width}×${s.imageSize.height}.` : 'This is a different camera than the one used for the captured views.';
  if (await confirmDialog(`${why} Start a new session for it?`, { confirmLabel: 'Start new session' })) { resetSession({ kind, label }); return true; }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

async function refreshDevices() {
  const sel = $('#cam-device', S?.root);
  if (!sel) return;
  try {
    const cams = await listCameras();
    const current = S.source?.kind === 'camera' ? S.source.settings?.deviceId : sel.value;
    render(sel, html`<option value="">Default camera</option>${cams.map((c) => html`<option value="${c.deviceId}" ${c.deviceId === current ? 'selected' : ''}>${c.label}</option>`)}`);
  } catch { /* enumerateDevices unavailable */ }
}

function stopSource() {
  if (!S?.source) return;
  S.live = false;
  S.loopToken++;
  if (S.source.kind === 'camera') stopStream(S.source.stream);
  if (S.source.kind === 'virtual') S.source.vcam.stop();
  S.source = null;
  const video = $('#video', S.root);
  if (video) { video.pause(); video.srcObject = null; }
  setSourceUi(null);
  S.lastDet = null;
  drawOverlay();
  setHud(null);
}

function setSourceUi(kind) {
  const r = S.root;
  $('#stage-empty', r).hidden = !!kind;
  $('[data-capture]', r).disabled = !kind;
  for (const [sel, show] of [['[data-cam-start]', kind !== 'camera'], ['[data-cam-stop]', kind === 'camera'], ['[data-virt-start]', kind !== 'virtual'], ['[data-virt-stop]', kind === 'virtual']]) {
    const el = $(sel, r);
    if (el) el.hidden = !show;
  }
  const caps = kind === 'camera' ? S.source.capabilities : {};
  const torch = $('[data-torch]', r), focus = $('[data-focus]', r);
  if (torch) torch.hidden = !caps.torch;
  if (focus) focus.hidden = !(caps.focusMode && (caps.focusMode.includes('manual') || caps.focusMode.includes('fixed')));
}

async function attachStream(stream) {
  const video = $('#video', S.root);
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay may need the muted attribute; it is set */ }
  await videoReady(video);
  const size = { width: video.videoWidth, height: video.videoHeight };
  $('#stage', S.root).style.aspectRatio = `${size.width} / ${size.height}`;
  return size;
}

async function startCamera() {
  if (!validTargetOrWarn()) return;
  stopSource();
  const btn = $('[data-cam-start]', S.root);
  btn.disabled = true;
  try {
    const res = RESOLUTIONS.find((r) => r.id === S.prefs.resolution) || RESOLUTIONS[1];
    const deviceId = $('#cam-device', S.root).value || undefined;
    const cam = await openCamera({ deviceId, width: res.width, height: res.height });
    if (!S) { stopStream(cam.stream); return; }
    const label = cam.track.label || 'Camera';
    S.source = { kind: 'camera', ...cam, label };
    const size = await attachStream(cam.stream);
    if (!(await ensureCompatible('camera', label, size))) { stopSource(); return; }
    setSourceUi('camera');
    refreshDevices();
    if (size.width !== res.width || size.height !== res.height) toast(`The camera delivers ${size.width}×${size.height} (requested ${res.width}×${res.height}).`, { type: 'info', timeout: 5000 });
    startLive();
    announce(`Camera started at ${size.width} by ${size.height}. Show the target.`);
  } catch (err) {
    console.error(err);
    stopSource();
    toast(cameraErrorMessage(err), { type: 'bad', timeout: 9000 });
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

async function startVirtual() {
  if (!validTargetOrWarn()) return;
  stopSource();
  const btn = $('[data-virt-start]', S.root);
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing lens…'; }
  try {
    const vcam = new VirtualCamera(S.prefs.lens, S.session.target, { seed: (Date.now() % 1000) + 1 });
    const stream = await vcam.start();
    if (!S) { vcam.stop(); return; }
    S.source = { kind: 'virtual', vcam, stream, label: vcam.label };
    const size = await attachStream(stream);
    if (!(await ensureCompatible('virtual', vcam.label, size))) { stopSource(); return; }
    S.session.source = { kind: 'virtual', label: vcam.label, lens: vcam.lensId };
    // Suggest the matching model so the demo shows a sensible first result.
    const suggest = vcam.lens.suggest;
    if (suggest && S.session.views.length === 0) {
      S.prefs.modelId = suggest.distortion === 'fisheye' ? 'fisheye' : suggest.distortion;
      renderModels(); savePrefs();
    }
    setSourceUi('virtual');
    startLive();
    announce('Virtual camera started. It moves the board automatically; auto-capture will collect views.');
  } catch (err) {
    console.error(err);
    stopSource();
    toast(`Virtual camera failed: ${err.message}`, { type: 'bad' });
  } finally {
    if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = html`${icon('play')} Start virtual camera`.__html; }
  }
}

function validTargetOrWarn() {
  const t = S.session.target;
  if (!validateTarget(t).ok || !typeInfo(t.type).calibration) {
    toast('Choose a valid calibration target first (1 · Target → Change).', { type: 'bad' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Live detection loop
// ---------------------------------------------------------------------------------------------

function startLive() {
  S.live = true;
  S.history = [];
  const token = ++S.loopToken;
  liveLoop(token);
}

function scaleDetection(det, scale) {
  if (scale === 1) return det;
  const up = (a) => { if (!a) return a; const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = (a[i] + 0.5) / scale - 0.5; return o; };
  det.points = up(det.points);
  if (det.markers) det.markers.corners = up(det.markers.corners);
  det.width = Math.round(det.width / scale); det.height = Math.round(det.height / scale);
  return det;
}

async function liveLoop(token) {
  const video = $('#video', S.root);
  let frames = 0, t0 = performance.now(), fps = 0;
  while (S && S.live && token === S.loopToken) {
    if (!vision.ready || S.busy || video.readyState < 2 || !video.videoWidth) { setHud(vision.ready ? null : 'engine'); await sleep(120); continue; }
    let det;
    try {
      const g = await grabFrame(video, LIVE_MAX_SIDE);
      if (!g) { await sleep(50); continue; }
      det = await vision.call('detect', { frame: g.frame, spec: detectorSpec(S.session.target), opts: { mode: 'live' } }, g.transfer);
      det = scaleDetection(det, g.scale);
      det.width = video.videoWidth; det.height = video.videoHeight;
    } catch (err) {
      if (!S || token !== S.loopToken) return;
      console.warn('live detection failed', err);
      await sleep(300);
      continue;
    }
    if (!S || token !== S.loopToken) return;
    frames++;
    const now = performance.now();
    if (now - t0 > 1000) { fps = (frames * 1000) / (now - t0); frames = 0; t0 = now; }
    onDetection(det, now, fps);
    await nextVideoFrame(video);
  }
}

function onDetection(det, now, fps) {
  S.lastDet = det;
  S.history.push({ t: now, det });
  while (S.history.length && now - S.history[0].t > 1500) S.history.shift();
  const size = { width: det.width, height: det.height };
  const minPts = S.session.target.type === 'gridboard' ? 8 : 6;
  let status = 'search', p = null;
  if (det.found && det.count >= minPts) {
    const obj = objectPoints(S.session.target, det.ids);
    p = obj ? viewParams(obj, det.points, size) : null;
    const past = S.history.find((h) => now - h.t >= STILL_WINDOW_MS && now - h.t < STILL_WINDOW_MS + 600);
    const motion = past ? motionBetween(det, past.det) : Infinity;
    const still = motion < Math.max(1.0, 0.0012 * Math.hypot(size.width, size.height));
    const sizeOk = !S.session.imageSize || (S.session.imageSize.width === size.width && S.session.imageSize.height === size.height);
    const d = p ? novelty(p, enabledViews(S.session).map((v) => v.params)) : 0;
    if (!sizeOk) status = 'size';
    else if (d < NOVELTY) status = 'seen';
    else if (!still) status = 'moving';
    else status = 'ready';
    if (status === 'ready' && S.prefs.auto && !S.busy && now - S.lastCaptureAt > COOLDOWN_MS) capture('auto');
  } else if (det.found || det.count) status = 'few';
  if (status !== S.status) {
    S.status = status;
    const say = { ready: 'Hold still — ready to capture.', seen: 'This position is already covered. Move the board somewhere new.', few: 'Only part of the target is visible.', search: 'Looking for the target.' }[status];
    if (say) announce(say, { throttleMs: 1500 });
  }
  setHud(status, det, fps);
  drawOverlay();
}

const HUD = {
  engine: ['Loading vision engine…', 'bg-slate-950/75'],
  search: ['Looking for the target…', 'bg-slate-950/75'],
  few: ['Too little of the target is visible', 'bg-amber-600/90'],
  seen: ['Already covered — move to a new position', 'bg-slate-950/75'],
  moving: ['Hold still…', 'bg-indigo-600/90'],
  ready: ['Hold still — capturing', 'bg-emerald-600/90'],
  size: ['Resolution differs from this session', 'bg-rose-600/90'],
  capturing: ['Capturing…', 'bg-emerald-600/90'],
};

function setHud(status, det, fps) {
  if (!S) return;
  const pill = $('#hud-status', S.root), stats = $('#hud-stats', S.root);
  if (!status) { pill.hidden = true; stats.hidden = true; return; }
  const [text, cls] = HUD[S.busy ? 'capturing' : status] || HUD.search;
  pill.hidden = false;
  pill.className = `pill text-white backdrop-blur ${cls}`;
  pill.textContent = text;
  if (det) {
    stats.hidden = false;
    stats.textContent = `${det.count} pts · ${fmt(fps, 0)} fps · ${det.width}×${det.height}`;
  }
}

function drawOverlay() {
  if (!S) return;
  const canvas = $('#overlay', S.root);
  const size = S.lastDet ? { width: S.lastDet.width, height: S.lastDet.height } : S.session.imageSize;
  if (!canvas || !size) { canvas && prepareOverlay(canvas, { width: 1, height: 1 }); return; }
  const o = prepareOverlay(canvas, size);
  const views = enabledViews(S.session);
  if (S.prefs.showCoverage && S.session.imageSize) drawCoverage(o.ctx, coverageGrid(views.map((v) => v.points), S.session.imageSize), S.session.imageSize, o);
  if (S.live) {
    const t = S.session.target;
    drawGhosts(o.ctx, views.map((v) => outerQuad(objectPoints(t, v.ids), v.points)), o);
    const color = S.status === 'ready' ? '#22c55e' : S.status === 'seen' ? '#94a3b8' : '#38bdf8';
    drawDetection(o.ctx, S.lastDet, { ...o, target: t, color });
  }
}

// ---------------------------------------------------------------------------------------------
// Capture & photos
// ---------------------------------------------------------------------------------------------

/** Analyses a still (video frame or image file) in the worker; falls back to main-thread decoding. */
async function analyzeStill(source) {
  const spec = detectorSpec(S.session.target);
  if (vision.canDecodeInWorker) {
    const src = source instanceof HTMLVideoElement ? await createImageBitmap(source) : source;
    return vision.call('analyze', { source: src, spec, preview: { maxSide: 1600, quality: 0.85 }, thumb: { maxSide: 360, quality: 0.8 } }, src instanceof ImageBitmap ? [src] : []);
  }
  const bmp = await createImageBitmap(source);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const scaled = async (max, q) => {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', q));
  };
  const [preview, thumb] = [await scaled(1600, 0.85), await scaled(360, 0.8)];
  const res = await vision.call('analyze', { source: { data: img.data, width: img.width, height: img.height }, spec }, [img.data.buffer]);
  return { ...res, preview, thumb };
}

async function capture(reason) {
  if (!S || S.busy || !S.live) return;
  const video = $('#video', S.root);
  S.busy = true;
  S.lastCaptureAt = performance.now();
  const stage = $('#stage', S.root);
  stage.classList.remove('flash'); void stage.offsetWidth; stage.classList.add('flash');
  setHud('capturing');
  try {
    const res = await analyzeStill(video);
    if (!S) return;
    if (!res.found) {
      if (reason === 'manual') toast('No usable target in that frame — hold steadier, or show more of the board.', { type: 'warn' });
      return;
    }
    const view = addView(S.session, res, { preview: res.preview, thumb: res.thumb, origin: S.source?.kind || 'camera' });
    saveSession(S.session);
    renderViews();
    announce(`View ${view.n} captured with ${view.count} points.`);
  } catch (err) {
    console.error(err);
    toast(err.message, { type: 'bad', timeout: 6000 });
  } finally {
    if (S) { S.busy = false; S.lastCaptureAt = performance.now(); }
  }
}

async function addPhotos(files) {
  if (!files.length) return;
  if (!validTargetOrWarn()) return;
  if (S.source) stopSource();
  const log = $('#photo-log', S.root);
  const line = (cls, text) => { S.photoLog.push(html`<li class="${cls}">${text}</li>`); render(log, html`${S.photoLog}`); log.scrollTop = log.scrollHeight; };
  try { await vision.start(); } catch (err) { toast(`The vision engine could not start: ${err.message}`, { type: 'bad' }); return; }
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    $('#run-status', S.root).textContent = `Analysing photo ${i + 1} of ${files.length}…`;
    try {
      const res = await analyzeStill(f);
      if (!S) return;
      if (!res.found) { line('text-amber-700 dark:text-amber-400', `✗ ${f.name} — target not found`); continue; }
      if (!(await ensureCompatible('photos', 'Photos', { width: res.width, height: res.height }))) { line('text-rose-700 dark:text-rose-400', `✗ ${f.name} — skipped`); continue; }
      addView(S.session, res, { preview: res.preview, thumb: res.thumb, name: f.name, origin: 'photos' });
      ok++;
      line('text-emerald-700 dark:text-emerald-400', `✓ ${f.name} — ${res.count} points (${res.width}×${res.height})`);
      renderViews();
    } catch (err) {
      console.error(err);
      line('text-rose-700 dark:text-rose-400', `✗ ${f.name} — ${err.message}`);
    }
  }
  if (!S) return;
  saveSession(S.session, true);
  renderViews();
  const msg = `${ok} of ${files.length} photo${files.length > 1 ? 's' : ''} added.`;
  toast(msg, { type: ok ? 'ok' : 'warn' });
}

// ---------------------------------------------------------------------------------------------
// Inspect a view
// ---------------------------------------------------------------------------------------------

function inspectView(id) {
  const v = S.session.views.find((x) => x.id === id);
  if (!v) return;
  const blob = v.preview || v.thumb;
  const url = blob ? URL.createObjectURL(blob) : null;
  const size = S.session.imageSize;
  openDialog(html`
    <div class="space-y-3">
      <div class="relative overflow-hidden rounded-xl bg-slate-900" style="aspect-ratio:${size.width}/${size.height}">
        ${url ? html`<img src="${url}" alt="Captured view ${v.n}" class="absolute inset-0 h-full w-full object-contain" />` : ''}
        <canvas class="overlay absolute inset-0 h-full w-full" aria-hidden="true"></canvas>
      </div>
      <dl class="kv">
        <dt>Points</dt><dd>${v.count}</dd>
        <dt>Position</dt><dd>x ${fmt(v.params[0])}, y ${fmt(v.params[1])}, size ${fmt(v.params[2])}, tilt ${fmt(v.params[3])}</dd>
        ${v.sharpness ? html`<dt>Sharpness</dt><dd>${fmt(v.sharpness, 0)}</dd>` : ''}
        ${v.name ? html`<dt>File</dt><dd>${v.name}</dd>` : ''}
      </dl>
    </div>`, {
    title: `View #${v.n}`,
    wide: true,
    onMount(dlg) {
      const canvas = $('canvas', dlg);
      const draw = () => {
        const o = prepareOverlay(canvas, size);
        drawDetection(o.ctx, { points: v.points, ids: v.ids, markers: null }, { ...o, target: S.session.target });
        if (S.session.target.type === 'gridboard') {
          for (let i = 0; i < v.points.length; i += 2) { o.ctx.fillStyle = '#22c55e'; o.ctx.beginPath(); o.ctx.arc(v.points[i] * o.sx, v.points[i + 1] * o.sy, 2.5 * o.dpr, 0, 7); o.ctx.fill(); }
        }
      };
      requestAnimationFrame(draw);
      dlg.addEventListener('close', () => url && URL.revokeObjectURL(url));
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------------

async function runCalibration() {
  if (S.solving) return;
  S.solving = true;
  const btn = $('[data-run]', S.root), status = $('#run-status', S.root);
  btn.disabled = true;
  const label = btn.innerHTML;
  btn.innerHTML = html`<svg class="spin size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".3" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg> Calibrating…`.__html;
  try {
    const gt = S.source?.kind === 'virtual' ? S.source.vcam.groundTruth : (S.session.source?.kind === 'virtual' ? LENSES[S.session.source.lens]?.calib : null);
    const result = await calibrateSession(S.session, S.prefs, {
      onStatus: (t) => { status.textContent = t; },
      camera: S.session.source || { kind: 'camera', label: 'Camera' },
      groundTruth: gt,
    });
    app.result = result;
    await saveLastResult(result);
    emit('result', result);
    announce(`Calibration finished. Reprojection error ${result.rms.toFixed(2)} pixels.`);
    location.hash = '#/results';
  } catch (err) {
    console.error(err);
    status.textContent = '';
    toast(err.fatal ? 'Calibration failed inside OpenCV. Try removing views with few points, or a simpler lens model.' : err.message, { type: 'bad', timeout: 8000 });
  } finally {
    if (S) {
      S.solving = false;
      btn.innerHTML = label;
      renderViews();
    }
  }
}
