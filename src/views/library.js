import { html, render, $, on, toast, confirmDialog, promptDialog, formatDate, fmt, formatBytes } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { listCalibrations, deleteCalibration, renameCalibration, saveCalibration } from '../calib/library.js';
import { fromJSON, fromOpenCVYaml } from '../calib/exporters.js';
import { gradeRms } from '../calib/quality.js';
import { modelInfo } from '../calib/run.js';
import { fieldOfView } from '../calib/camera-model.js';
import { persistent, storageEstimate } from '../app/db.js';

let S = null;

const GRADE = { excellent: 'pill-ok', good: 'pill-ok', fair: 'pill-warn', poor: 'pill-bad' };

export default {
  title: 'Library',
  async mount(root) {
    S = { root };
    render(root, html`
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">Saved calibrations</h1>
          <p class="mt-1 muted">Stored privately in this browser. Open one to inspect, validate or export it again.</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <label class="btn btn-secondary">${icon('upload')} Import<input type="file" accept=".json,.yaml,.yml,application/json,text/yaml" class="sr-only" id="import" /></label>
          <a class="btn btn-primary" href="#/calibrate">${icon('aperture')} New calibration</a>
        </div>
      </div>
      <div id="storage" class="mt-4"></div>
      <ul id="list" class="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-live="polite"></ul>`);
    on(root, 'click', '[data-delete]', async (e, b) => {
      if (!(await confirmDialog(`Delete “${b.dataset.name}”? This cannot be undone.`, { confirmLabel: 'Delete', danger: true }))) return;
      await deleteCalibration(b.dataset.delete);
      toast('Calibration deleted.', { type: 'ok' });
      refresh();
    });
    on(root, 'click', '[data-rename]', async (e, b) => {
      const name = await promptDialog('New name', { title: 'Rename calibration', value: b.dataset.name, confirmLabel: 'Rename' });
      if (!name) return;
      await renameCalibration(b.dataset.rename, name);
      refresh();
    });
    on(root, 'click', '[data-persist]', async () => {
      const ok = await navigator.storage?.persist?.();
      toast(ok ? 'Storage is now persistent — the browser will not evict your calibrations.' : 'The browser declined persistent storage (it may grant it after more visits or if you bookmark/install the app).', { type: ok ? 'ok' : 'warn', timeout: 6000 });
      renderStorage();
    });
    $('#import', root).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const rec = /\.ya?ml$/i.test(file.name) || text.trimStart().startsWith('%YAML') ? fromOpenCVYaml(text) : fromJSON(text);
        if (rec.name.startsWith('Imported')) rec.name = file.name.replace(/\.[^.]+$/, '');
        const saved = await saveCalibration(rec, rec.name);
        toast(`Imported “${saved.name}”.`, { type: 'ok' });
        refresh();
      } catch (err) {
        toast(`Import failed: ${err.message}`, { type: 'bad', timeout: 7000 });
      }
    });
    await refresh();
  },
  unmount() { S = null; },
};

async function renderStorage() {
  if (!S) return;
  const est = await storageEstimate();
  const isPersisted = await navigator.storage?.persisted?.();
  if (!S) return;
  render($('#storage', S.root), !persistent
    ? html`<p class="callout callout-warn">This browser is not allowing local storage (private mode?). Calibrations will be lost when you close the tab — export them.</p>`
    : html`<p class="flex flex-wrap items-center gap-3 text-sm muted">
        ${icon('shield', 'size-4 text-emerald-600')} Nothing is uploaded anywhere.
        ${est?.usage ? html`<span>Using ${formatBytes(est.usage)}${est.quota ? ` of ${formatBytes(est.quota)}` : ''}.</span>` : ''}
        ${isPersisted ? html`<span class="pill pill-ok">Persistent storage</span>` : navigator.storage?.persist ? html`<button type="button" class="btn btn-ghost btn-sm" data-persist>Keep my data (persistent storage)</button>` : ''}
      </p>`);
}

async function refresh() {
  const items = await listCalibrations();
  if (!S) return;
  renderStorage();
  render($('#list', S.root), items.length ? html`${items.map((r) => {
    const g = gradeRms(r.rms);
    const fov = fieldOfView(r);
    return html`
      <li class="card card-pad flex flex-col gap-3">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <h2 class="truncate font-semibold"><a href="#/results/${r.id}" class="hover:underline">${r.name}</a></h2>
            <p class="text-xs muted">${formatDate(r.savedAt || r.createdAt)}${r.imported ? ' · imported' : ''}</p>
          </div>
          ${r.rms ? html`<span class="pill ${GRADE[g]}" title="Reprojection error">${fmt(r.rms, 3)} px</span>` : ''}
        </div>
        <dl class="kv">
          <dt>Image</dt><dd>${r.imageSize.width} × ${r.imageSize.height}</dd>
          <dt>Model</dt><dd>${r.model === 'fisheye' ? 'Fisheye' : modelInfo(r.distortion).label}</dd>
          <dt>Focal</dt><dd>${fmt(r.K[0], 1)} / ${fmt(r.K[4], 1)} px</dd>
          <dt>View</dt><dd>${fmt(fov.horizontal, 1)}° × ${fmt(fov.vertical, 1)}°</dd>
          ${r.stats?.views ? html`<dt>Views</dt><dd>${r.stats.views}</dd>` : ''}
        </dl>
        <div class="mt-auto flex flex-wrap gap-1.5">
          <a class="btn btn-primary btn-sm" href="#/results/${r.id}">${icon('eye')} Open</a>
          <a class="btn btn-secondary btn-sm" href="#/validate/${r.id}">${icon('axes')} Validate</a>
          <button type="button" class="btn btn-ghost btn-sm" data-rename="${r.id}" data-name="${r.name}">${icon('edit')} Rename</button>
          <button type="button" class="btn btn-ghost btn-sm text-rose-700 dark:text-rose-400" data-delete="${r.id}" data-name="${r.name}">${icon('trash')} Delete</button>
        </div>
      </li>`;
  })}` : html`<li class="col-span-full card card-pad text-center">
      <p class="font-semibold">No saved calibrations yet</p>
      <p class="mt-1 text-sm muted">Calibrate a camera and press “Save to library”, or import a CaliBoard JSON / OpenCV YAML file.</p>
    </li>`);
}
