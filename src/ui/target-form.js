// Compact target editor used where a full designer would be overkill (e.g. "my board is already printed").
import { html, render, on, openDialog, $ } from './dom.js';
import { TARGET_TYPES, defaultTarget, normalizeTarget, validateTarget, describeTarget, typeInfo } from '../targets/targets.js';
import { DICTIONARY_GROUPS, dictionaryLabel } from '../targets/dictionaries.js';
import { UNITS, toMm, fromMm } from '../targets/units.js';

const FIELDS = {
  checkerboard: ['cols', 'rows', 'squareSize'],
  charuco: ['cols', 'rows', 'squareSize', 'markerSize', 'dictionary', 'firstId', 'legacy'],
  gridboard: ['cols', 'rows', 'markerSize', 'markerSeparation', 'dictionary', 'firstId'],
};
const LEN = new Set(['squareSize', 'markerSize', 'markerSeparation']);
const LABELS = {
  cols: (t) => (t === 'gridboard' ? 'Markers across' : 'Squares across'),
  rows: (t) => (t === 'gridboard' ? 'Markers down' : 'Squares down'),
  squareSize: () => 'Square size (measured)',
  markerSize: () => 'Marker size (measured)',
  markerSeparation: () => 'Gap between markers',
  dictionary: () => 'Dictionary',
  firstId: () => 'First marker id',
};

function fieldsHtml(t, unit) {
  return FIELDS[t.type].map((f) => {
    const id = `tf-${f}`;
    if (f === 'dictionary') {
      return html`<div class="col-span-2"><label class="label" for="${id}">${LABELS[f](t.type)}</label>
        <select id="${id}" class="select" data-f="${f}">${DICTIONARY_GROUPS.map((g) => html`<optgroup label="${g.label}">${g.names.map((n) => html`<option value="${n}" ${t.dictionary === n ? 'selected' : ''}>${dictionaryLabel(n)}</option>`)}</optgroup>`)}</select></div>`;
    }
    if (f === 'legacy') return html`<label class="check-row col-span-2"><input type="checkbox" class="checkbox" data-f="legacy" ${t.legacy ? 'checked' : ''} /> <span>Legacy layout (OpenCV &lt; 4.6 / older generators)</span></label>`;
    const v = LEN.has(f) ? +fromMm(t[f], unit).toFixed(UNITS[unit].digits + 1) : t[f];
    return html`<div><label class="label" for="${id}">${LABELS[f](t.type)}${LEN.has(f) ? ` (${UNITS[unit].label})` : ''}</label>
      <input id="${id}" class="input" type="number" inputmode="decimal" data-f="${f}" value="${v}" step="${LEN.has(f) ? UNITS[unit].step : 1}" min="0" /></div>`;
  });
}

/**
 * Opens a dialog to edit a calibration target. Resolves with the new target, or null if cancelled.
 */
export async function editTargetDialog(target, unit = 'mm') {
  let t = normalizeTarget(target);
  if (!typeInfo(t.type).calibration) t = normalizeTarget(defaultTarget('charuco'));
  let result = null;
  await openDialog(html`
    <form class="space-y-4" novalidate>
      <fieldset class="group"><legend>Target type</legend>
        <div class="grid grid-cols-3 gap-2">
          ${TARGET_TYPES.filter((x) => x.calibration).map((x) => html`<label class="choice"><input type="radio" name="tf-type" value="${x.id}" class="sr-only" ${t.type === x.id ? 'checked' : ''} /><span class="font-semibold">${x.label}</span></label>`)}
        </div>
      </fieldset>
      <div class="grid grid-cols-2 gap-3" data-fields></div>
      <p class="hint">Enter the sizes you <strong>measured on the printed target</strong> — printers rarely print at exactly 100 %. Intrinsics do not depend on the size, but distances, stereo baselines and poses do.</p>
      <div data-msg aria-live="polite"></div>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn btn-secondary" data-close="cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Use this target</button>
      </div>
    </form>`, {
    title: 'Calibration target',
    onMount(dlg, finish) {
      const form = $('form', dlg), box = $('[data-fields]', dlg), msg = $('[data-msg]', dlg);
      const draw = () => render(box, html`${fieldsHtml(t, unit)}`);
      const check = () => {
        const v = validateTarget(t);
        render(msg, html`${v.errors.map((e) => html`<p class="callout callout-bad mb-2">${e}</p>`)}<p class="text-sm muted">${v.ok ? describeTarget(v.target, unit) : ''}</p>`);
        return v.ok;
      };
      draw(); check();
      on(form, 'change', 'input[name="tf-type"]', (e, input) => { t = normalizeTarget({ ...defaultTarget(input.value) }); draw(); check(); });
      on(form, 'input', '[data-f]', (e, input) => {
        const f = input.dataset.f;
        if (input.type === 'checkbox') t[f] = input.checked;
        else if (f === 'dictionary') t[f] = input.value;
        else if (input.value !== '') t[f] = LEN.has(f) ? toMm(Number(input.value), unit) : Math.round(Number(input.value));
        t = normalizeTarget(t);
        check();
      });
      on(form, 'change', '[data-f]', (e, input) => input.dispatchEvent(new Event('input', { bubbles: true })));
      form.addEventListener('submit', (e) => { e.preventDefault(); if (check()) { result = t; finish('ok'); } });
    },
  });
  return result;
}
