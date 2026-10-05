// A capture session: the target, the image size and the captured views (points + small images).
// Persisted to IndexedDB so a reload, crash or closed tab never loses captured views.
import { dbGet, dbPut, dbDelete, STORES } from '../app/db.js';
import { uid } from '../ui/dom.js';
import { objectPoints, normalizeTarget } from '../targets/targets.js';
import { viewParams } from './coverage.js';

const CURRENT_KEY = 'current';

export function createSession(target, source = null) {
  return { id: CURRENT_KEY, uid: uid(), createdAt: Date.now(), target: normalizeTarget(target), imageSize: null, source, views: [], seq: 0 };
}

/** Adds an analysed image to the session. `det` = worker detection result. */
export function addView(session, det, { preview = null, thumb = null, name = null, origin = 'camera' } = {}) {
  const size = { width: det.width, height: det.height };
  if (!session.imageSize) session.imageSize = size;
  else if (session.imageSize.width !== size.width || session.imageSize.height !== size.height) {
    throw new Error(`This image is ${size.width}×${size.height}, but the session uses ${session.imageSize.width}×${session.imageSize.height}. All views must come from the same camera at the same resolution.`);
  }
  const obj = objectPoints(session.target, det.ids);
  if (!obj) throw new Error('Detected ids do not belong to this target — check the dictionary and first id.');
  const view = {
    id: uid(),
    n: ++session.seq,
    createdAt: Date.now(),
    origin,
    name,
    points: det.points,
    ids: det.ids,
    count: det.points.length / 2,
    sharpness: det.sharpness ?? null,
    params: viewParams(obj, det.points, size),
    enabled: true,
    preview,
    thumb,
  };
  session.views.push(view);
  return view;
}

export function enabledViews(session) { return session.views.filter((v) => v.enabled); }

/** Views shaped for the calibration solver: { id, obj, img }. */
export function solverViews(session, only = enabledViews(session)) {
  return only.map((v) => ({ id: v.id, obj: objectPoints(session.target, v.ids), img: v.points }));
}

export async function loadSession() {
  try { return await dbGet(STORES.sessions, CURRENT_KEY); } catch { return null; }
}

let saveTimer = null;
/** Debounced persistence; pass immediate=true to flush now. */
export function saveSession(session, immediate = false) {
  clearTimeout(saveTimer);
  const run = () => dbPut(STORES.sessions, session).catch((err) => console.warn('Could not save the session', err));
  if (immediate) return run();
  saveTimer = setTimeout(run, 400);
  return Promise.resolve();
}

export async function discardSession() {
  clearTimeout(saveTimer);
  try { await dbDelete(STORES.sessions, CURRENT_KEY); } catch { /* ignore */ }
}

// The most recent calibration result is kept too, so a reload never loses an unsaved result.
const LAST_RESULT_KEY = 'last-result';

export async function saveLastResult(result) {
  try { await dbPut(STORES.sessions, { id: LAST_RESULT_KEY, result }); } catch (err) { console.warn('Could not persist the result', err); }
}

export async function loadLastResult() {
  try { return (await dbGet(STORES.sessions, LAST_RESULT_KEY))?.result ?? null; } catch { return null; }
}
