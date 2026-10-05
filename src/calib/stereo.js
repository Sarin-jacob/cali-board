// Stereo helpers: pairing detections between two cameras and judging rectification quality.
import { objectPoints } from '../targets/targets.js';
import { pixelToRay, rotationToRodrigues } from './camera-model.js';

/**
 * Points seen by both cameras: { ids, obj, img1, img2, count } or null.
 * ChArUco corners / grid markers are matched by id; checkerboards must be fully visible in both.
 */
export function pairDetections(target, d1, d2) {
  if (!d1?.found || !d2?.found) return null;
  if (target.type === 'checkerboard') {
    if (d1.points.length !== d2.points.length) return null;
    return { ids: null, obj: objectPoints(target), img1: d1.points, img2: d2.points, count: d1.points.length / 2 };
  }
  const per = target.type === 'gridboard' ? 8 : 2; // floats per id
  const where = new Map();
  for (let j = 0; j < d2.ids.length; j++) where.set(d2.ids[j], j);
  const ids = [], img1 = [], img2 = [];
  for (let i = 0; i < d1.ids.length; i++) {
    const j = where.get(d1.ids[i]);
    if (j === undefined) continue;
    ids.push(d1.ids[i]);
    for (let k = 0; k < per; k++) { img1.push(d1.points[per * i + k]); img2.push(d2.points[per * j + k]); }
  }
  if (!ids.length) return null;
  const idArr = Int32Array.from(ids);
  const obj = objectPoints(target, idArr);
  return obj ? { ids: idArr, obj, img1: Float32Array.from(img1), img2: Float32Array.from(img2), count: img1.length / 2 } : null;
}

const mat3 = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];

/** Rectified coordinates of a pixel: undistort → rotate by Ri → project with Pi (3×4). */
function rectify(calib, Ri, Pi, u, v) {
  const ray = pixelToRay(calib, u, v);
  if (!ray) return null;
  const X = mat3(Ri, [ray[0], ray[1], 1]);
  const w = Pi[8] * X[0] + Pi[9] * X[1] + Pi[10] * X[2];
  return [(Pi[0] * X[0] + Pi[1] * X[1] + Pi[2] * X[2]) / w, (Pi[4] * X[0] + Pi[5] * X[1] + Pi[6] * X[2]) / w];
}

/**
 * Rectification error: after rectification, matching points must share a row (or a column for
 * vertical rigs). Returns { mean, perPair: [mean |Δ| per pair], vertical }.
 */
export function rectificationError(stereo, pairs) {
  const vertical = Math.abs(stereo.P2[7]) > Math.abs(stereo.P2[3]);
  const perPair = pairs.map((p) => {
    let sum = 0, n = 0;
    for (let i = 0; i < p.img1.length; i += 2) {
      const a = rectify(stereo.calib1, stereo.R1, stereo.P1, p.img1[i], p.img1[i + 1]);
      const b = rectify(stereo.calib2, stereo.R2, stereo.P2, p.img2[i], p.img2[i + 1]);
      if (!a || !b) continue;
      sum += Math.abs(vertical ? a[0] - b[0] : a[1] - b[1]);
      n++;
    }
    return n ? sum / n : NaN;
  });
  const valid = perPair.filter(Number.isFinite);
  return { mean: valid.reduce((s, v) => s + v, 0) / (valid.length || 1), perPair, vertical };
}

/** Angle (degrees) of a rotation matrix. */
export function rotationAngle(R) {
  const r = rotationToRodrigues(R);
  return (Math.hypot(...r) * 180) / Math.PI;
}

/** Ground truth for the virtual stereo rig: camera 2 sits `baseline` mm to the right, turned `toeIn` degrees. */
export function virtualRig(baseline = 60, toeIn = 3) {
  const a = (-toeIn * Math.PI) / 180;
  const R = [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
  const C = [baseline, 0, 0]; // camera-2 centre in camera-1 coordinates
  const t = mat3(R, C).map((v) => -v);
  return { R, t };
}
