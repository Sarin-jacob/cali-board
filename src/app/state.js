// Shared application state + a tiny event bus.
import { prefs } from '../ui/dom.js';
import { defaultTarget, normalizeTarget } from '../targets/targets.js';

export const app = {
  /** The calibration target currently being designed / used. */
  target: normalizeTarget(prefs.get('target', defaultTarget('charuco'))),
  /** Display unit for lengths: 'mm' | 'cm' | 'in'. */
  unit: prefs.get('unit', 'mm'),
  /** The in-progress capture session (see calib/session.js). */
  session: null,
  /** The latest calibration result that has not been saved yet. */
  result: null,
};

const bus = new EventTarget();

export function emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); }

/** Subscribes to an app event; returns an unsubscribe function. */
export function listen(type, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

export function setTarget(t) {
  app.target = normalizeTarget(t);
  prefs.set('target', app.target);
  emit('target', app.target);
}

export function setUnit(u) {
  app.unit = u;
  prefs.set('unit', u);
  emit('unit', u);
}
