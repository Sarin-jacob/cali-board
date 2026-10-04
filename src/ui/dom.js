// Small DOM toolkit: safe templating, events, announcements, dialogs, downloads.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Marks a string as trusted HTML for the `html` tag. */
export const raw = (s) => ({ __html: String(s ?? '') });

function interp(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(interp).join('');
  if (typeof v === 'object' && '__html' in v) return v.__html;
  return esc(v);
}

/** Tagged template that escapes interpolations (use raw() / nested html`` for markup). */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interp(values[i]) + strings[i + 1];
  return raw(out);
}

/** Renders html`` output into an element. */
export function render(el, content) {
  el.innerHTML = typeof content === 'string' ? esc(content) : content.__html;
  return el;
}

/** Creates a single element from html`` output. */
export function el(content) {
  const t = document.createElement('template');
  t.innerHTML = content.__html.trim();
  return t.content.firstElementChild;
}

/** Delegated event listener. Returns an unsubscribe function. */
export function on(root, type, selector, handler, opts) {
  const fn = (e) => {
    const target = e.target.closest?.(selector);
    if (target && root.contains(target)) handler(e, target);
  };
  root.addEventListener(type, fn, opts);
  return () => root.removeEventListener(type, fn, opts);
}

let lastAnnounce = 0;
/** Speaks a message to screen readers via the live region (throttled for chatty sources). */
export function announce(message, { assertive = false, throttleMs = 0 } = {}) {
  const t = performance.now();
  if (throttleMs && t - lastAnnounce < throttleMs) return;
  lastAnnounce = t;
  const region = document.getElementById(assertive ? 'sr-alert' : 'sr-status');
  if (!region) return;
  region.textContent = '';
  // A short delay makes repeated identical messages announce again.
  setTimeout(() => { region.textContent = message; }, 30);
}

const TOAST_STYLE = {
  info: 'bg-slate-900 text-white dark:bg-white dark:text-slate-900',
  ok: 'bg-emerald-600 text-white',
  warn: 'bg-amber-500 text-slate-950',
  bad: 'bg-rose-600 text-white',
};

/** Brief visual notification (also announced to assistive tech). */
export function toast(message, { type = 'info', timeout = 3500 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg ${TOAST_STYLE[type] || TOAST_STYLE.info}`;
  node.textContent = message;
  host.appendChild(node);
  announce(message, { assertive: type === 'bad' });
  setTimeout(() => node.remove(), timeout);
}

export function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export function fmt(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Number(n).toFixed(digits);
}

export function formatBytes(b) {
  if (!(b > 0)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function formatDate(ts) {
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(ts); }
}

/** Triggers a file download from a string, Blob or ArrayBuffer. */
export function download(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', { type: 'ok' });
    return true;
  } catch {
    toast('Copy failed — select the text and copy manually', { type: 'warn' });
    return false;
  }
}

/**
 * Opens a modal <dialog>. `content` is html`` output; it may contain elements with
 * [data-close] to close. Resolves with the dialog's returnValue when closed.
 */
export function openDialog(content, { title = '', label, wide = false, onMount } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  if (wide) dlg.style.width = 'min(100% - 2rem, 72rem)';
  const titleId = `dlg-${uid()}`;
  dlg.setAttribute('aria-labelledby', titleId);
  if (label) dlg.setAttribute('aria-label', label);
  dlg.innerHTML = html`
    <div class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
      <h2 id="${titleId}" class="text-lg font-semibold">${title}</h2>
      <button type="button" class="btn btn-ghost btn-sm -mr-2" data-close aria-label="Close dialog">✕</button>
    </div>
    <div class="p-5" data-body></div>`.__html;
  render(dlg.querySelector('[data-body]'), content);
  document.body.appendChild(dlg);
  const opener = document.activeElement;
  return new Promise((resolve) => {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close('cancel'); // backdrop click
      const c = e.target.closest('[data-close]');
      if (c) dlg.close(c.dataset.close || 'cancel');
    });
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue);
      dlg.remove();
      opener?.focus?.();
    });
    dlg.showModal();
    onMount?.(dlg);
  });
}

/** Accessible confirm() replacement. */
export async function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
  const result = await openDialog(html`
    <p class="text-sm text-slate-700 dark:text-slate-300">${message}</p>
    <div class="mt-5 flex justify-end gap-2">
      <button type="button" class="btn btn-secondary" data-close="cancel">Cancel</button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-close="ok" autofocus>${confirmLabel}</button>
    </div>`, { title });
  return result === 'ok';
}

/** Prompt for a single line of text. Resolves with the string or null. */
export async function promptDialog(message, { title = 'Name', value = '', confirmLabel = 'Save' } = {}) {
  let input;
  const result = await openDialog(html`
    <form method="dialog" class="space-y-4">
      <label class="label" for="prompt-input">${message}</label>
      <input id="prompt-input" class="input" value="${value}" required maxlength="120" />
      <div class="flex justify-end gap-2">
        <button type="button" class="btn btn-secondary" data-close="cancel">Cancel</button>
        <button class="btn btn-primary" value="ok">${confirmLabel}</button>
      </div>
    </form>`, {
    title,
    onMount: (dlg) => {
      input = dlg.querySelector('input');
      input.select();
      dlg.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); dlg.close('ok'); });
    },
  });
  return result === 'ok' && input.value.trim() ? input.value.trim() : null;
}

/** Loads/saves small JSON preferences in localStorage, tolerating private mode. */
export const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`caliboard:${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`caliboard:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};
