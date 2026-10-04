// Saved calibrations (IndexedDB). Stores the full result including per-view points, residuals
// and small thumbnails, so results can be re-inspected and re-exported later.
import { dbAll, dbGet, dbPut, dbDelete, STORES } from '../app/db.js';
import { uid } from '../ui/dom.js';

export async function listCalibrations() {
  const all = await dbAll(STORES.calibrations);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export const getCalibration = (id) => dbGet(STORES.calibrations, id);

export async function saveCalibration(result, name) {
  const record = { ...result, id: result.id || uid(), name: name || result.name || 'Calibration', savedAt: Date.now() };
  await dbPut(STORES.calibrations, record);
  return record;
}

export async function renameCalibration(id, name) {
  const r = await getCalibration(id);
  if (!r) return null;
  r.name = name;
  await dbPut(STORES.calibrations, r);
  return r;
}

export const deleteCalibration = (id) => dbDelete(STORES.calibrations, id);

/** Short label for menus: "Name — 1280×720 pinhole". */
export function calibLabel(r) {
  return `${r.name || 'Calibration'} — ${r.imageSize.width}×${r.imageSize.height} ${r.model}`;
}

/** Same calibration for an image scaled by `s` (e.g. thumbnails). Distortion is resolution-independent. */
export function scaleCalibration(calib, s, size) {
  const K = calib.K;
  return {
    ...calib,
    K: [K[0] * s, K[1] * s, (K[2] + 0.5) * s - 0.5, 0, K[4] * s, (K[5] + 0.5) * s - 0.5, 0, 0, 1],
    imageSize: size || { width: Math.round(calib.imageSize.width * s), height: Math.round(calib.imageSize.height * s) },
  };
}
