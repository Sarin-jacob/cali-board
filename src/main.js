import { vision } from './engine/vision.js';
import { html, render, toast, $ } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { preloadDictionaries } from './targets/dictionaries.js';

const NAV = [
  { route: 'targets', label: 'Targets', icon: 'grid' },
  { route: 'calibrate', label: 'Calibrate', icon: 'aperture' },
  { route: 'stereo', label: 'Stereo', icon: 'stereo' },
  { route: 'validate', label: 'Validate', icon: 'axes' },
  { route: 'library', label: 'Library', icon: 'library' },
  { route: 'help', label: 'Guide', icon: 'help' },
];

const VIEWS = {
  '': () => import('./views/home.js'),
  targets: () => import('./views/targets.js'),
  calibrate: () => import('./views/calibrate.js'),
  results: () => import('./views/results.js'),
  stereo: () => import('./views/stereo.js'),
  validate: () => import('./views/validate.js'),
  library: () => import('./views/library.js'),
  help: () => import('./views/help.js'),
};

// Views that need the OpenCV engine; others (home, targets, guide) work without the 5 MB download.
const NEEDS_ENGINE = new Set(['calibrate', 'results', 'stereo', 'validate']);

function renderNav(active) {
  const items = NAV.map((n) => html`
    <li><a class="nav-link" href="#/${n.route}" ${n.route === active ? html`aria-current="page"` : ''}>${icon(n.icon)}<span>${n.label}</span></a></li>`);
  render($('#nav-desktop'), html`${items}`);
  render($('#nav-mobile'), html`${items}`);
}

function renderEngineStatus() {
  const box = $('#engine-status');
  const s = vision.state;
  let content;
  if (s === 'ready') {
    content = html`<a href="#/help/engine" class="pill pill-ok" title="OpenCV ${vision.info?.version} is running locally">${icon('cpu', 'size-3.5')}<span>Engine ready</span></a>`;
  } else if (s === 'loading') {
    const { loaded, total } = vision.progress;
    const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    const label = pct > 0 && pct < 100 ? `Engine ${pct}%` : vision.statusText.replace('…', '') || 'Loading';
    content = html`<span class="pill pill-info" role="progressbar" aria-label="Loading the vision engine" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
      <svg class="spin size-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".25" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>
      <span>${label}</span></span>`;
  } else if (s === 'error') {
    content = html`<button type="button" class="pill pill-bad" data-retry title="${vision.error}">${icon('alert', 'size-3.5')}<span>Engine failed — retry</span></button>`;
  } else {
    content = html`<button type="button" class="pill pill-neutral" data-start title="Download the OpenCV engine (≈5 MB, cached afterwards)">${icon('cpu', 'size-3.5')}<span>Load engine</span></button>`;
  }
  render(box, content);
}

$('#engine-status').addEventListener('click', (e) => {
  if (e.target.closest('[data-retry], [data-start]')) vision.start().catch(() => {});
});
vision.addEventListener('change', renderEngineStatus);
vision.addEventListener('restart', () => toast('The vision engine hit an error and was restarted.', { type: 'warn' }));

let current = null;
let firstRender = true;
let navToken = 0;

async function route() {
  const token = ++navToken;
  const [name = '', ...params] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const key = VIEWS[name] ? name : '';
  if (NEEDS_ENGINE.has(key)) vision.start().catch(() => {});
  let mod;
  try {
    mod = await VIEWS[key]();
  } catch (err) {
    console.error(err);
    toast('Could not load this page. Check your connection and reload.', { type: 'bad' });
    return;
  }
  if (token !== navToken) return; // a newer navigation won
  try { current?.unmount?.(); } catch (err) { console.error(err); }
  const main = $('#main');
  main.innerHTML = '';
  current = mod.default;
  document.title = `${current.title} · CaliBoard`;
  renderNav(key || null);
  try {
    await current.mount(main, params.filter(Boolean));
  } catch (err) {
    console.error(err);
    render(main, html`<div class="callout callout-bad">Something went wrong while opening this page: ${err.message}</div>`);
  }
  if (!firstRender) {
    window.scrollTo({ top: 0 });
    const h1 = main.querySelector('h1');
    if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); }
  }
  firstRender = false;
}

window.addEventListener('hashchange', route);
renderEngineStatus();
route();

// Warm caches while the user reads the first page.
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
idle(() => {
  preloadDictionaries();
  const name = location.hash.replace(/^#\/?/, '').split('/')[0];
  if (name !== 'targets' && name !== 'help') vision.start().catch(() => {});
});

// Offline support (production builds only — the dev server must always serve fresh files).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('CaliBoard was updated — reload the page to use the new version.', { type: 'info', timeout: 10000 });
  });
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
