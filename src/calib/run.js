// Calibration orchestration: session → solver → (robust re-solve) → result record.
import { vision } from '../engine/vision.js';
import { solverViews, enabledViews } from './session.js';
import { coverageGrid, coverageFraction, coverageProgress } from './coverage.js';
import { uid } from '../ui/dom.js';

export const MODELS = [
  { id: 'standard4', model: 'pinhole', label: 'Standard', detail: 'k1, k2, p1, p2', blurb: 'Most webcams, phones and machine-vision lenses. The safe default.' },
  { id: 'standard5', model: 'pinhole', label: 'Standard + k3', detail: 'k1, k2, p1, p2, k3', blurb: 'Wide-angle lenses (> ~90°). Needs views right into the image corners.' },
  { id: 'rational', model: 'pinhole', label: 'Rational', detail: '8 coefficients', blurb: 'Strong distortion that the standard model cannot follow. Needs many well-spread views.' },
  { id: 'fisheye', model: 'fisheye', label: 'Fisheye', detail: 'Kannala–Brandt k1–k4', blurb: 'Fisheye / ultra-wide lenses (≈ 120°–200°).' },
  { id: 'radial2', model: 'pinhole', label: 'Radial only', detail: 'k1, k2', blurb: 'Telephoto or narrow lenses where tangential terms are noise.' },
  { id: 'none', model: 'pinhole', label: 'No distortion', detail: 'pinhole', blurb: 'Already-rectified images or ideal pinhole cameras.' },
];
export const ADVANCED_MODELS = [
  { id: 'thinprism', model: 'pinhole', label: 'Thin prism', detail: '12 coefficients', blurb: 'Rational + thin-prism terms for lens/sensor misalignment.' },
  { id: 'tilted', model: 'pinhole', label: 'Tilted sensor', detail: '14 coefficients', blurb: 'Scheimpflug / tilted-sensor setups.' },
];
export const modelInfo = (id) => [...MODELS, ...ADVANCED_MODELS].find((m) => m.id === id) || MODELS[0];

const MIN_POINTS = 6;

function median(a) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Removes points whose residual exceeds a robust threshold (median + 6·MAD, at least 0.5 px).
 * Returns { views, removed } where views keep only inliers (views left with too few points are dropped).
 */
function rejectOutliers(views, solved) {
  const mags = [];
  solved.views.forEach((v) => { for (let i = 0; i < v.residuals.length; i += 2) mags.push(Math.hypot(v.residuals[i], v.residuals[i + 1])); });
  const med = median(mags);
  const mad = median(mags.map((m) => Math.abs(m - med))) * 1.4826;
  const thr = Math.max(0.5, med + 6 * mad);
  let removed = 0;
  const out = [];
  views.forEach((v, k) => {
    const r = solved.views[k].residuals;
    const keep = [];
    for (let i = 0; i < r.length / 2; i++) if (Math.hypot(r[2 * i], r[2 * i + 1]) <= thr) keep.push(i);
    removed += r.length / 2 - keep.length;
    if (keep.length === r.length / 2) { out.push(v); return; }
    if (keep.length < MIN_POINTS) return; // too few inliers left: drop the whole view
    out.push({
      ...v,
      obj: Float32Array.from(keep.flatMap((i) => [v.obj[3 * i], v.obj[3 * i + 1], v.obj[3 * i + 2]])),
      img: Float32Array.from(keep.flatMap((i) => [v.img[2 * i], v.img[2 * i + 1]])),
      keep,
    });
  });
  return { views: out, removed, threshold: thr };
}

/**
 * Calibrates the session's enabled views.
 * settings = { modelId, fixAspectRatio, zeroTangent, fixPrincipalPoint, robust }
 * onStatus(text) reports progress.
 */
export async function calibrateSession(session, settings, { onStatus = () => {}, camera = null, groundTruth = null } = {}) {
  const info = modelInfo(settings.modelId);
  const used = enabledViews(session);
  let views = solverViews(session, used);
  if (views.length < 3) throw new Error('Capture at least 3 views (10–30 recommended) before calibrating.');
  const req = (vs) => ({
    views: vs.map((v) => ({ obj: v.obj, img: v.img })),
    imageSize: session.imageSize,
    model: info.model,
    distortion: info.id,
    options: { fixAspectRatio: !!settings.fixAspectRatio, zeroTangent: !!settings.zeroTangent, fixPrincipalPoint: !!settings.fixPrincipalPoint },
  });

  onStatus(`Solving with ${views.length} views…`);
  let solved = await vision.call('calibrate', { req: req(views) });
  let removedPoints = 0, removedViews = 0, threshold = null;
  if (settings.robust) {
    for (let iter = 0; iter < 2; iter++) {
      const r = rejectOutliers(views, solved);
      if (!r.removed) break;
      if (r.views.length < 3) break;
      onStatus(`Removed ${r.removed} outlier point${r.removed > 1 ? 's' : ''}; re-solving…`);
      removedPoints += r.removed;
      removedViews += views.length - r.views.length;
      threshold = r.threshold;
      views = r.views;
      solved = await vision.call('calibrate', { req: req(views) });
    }
  }

  const byId = new Map(used.map((v) => [v.id, v]));
  const cov = coverageGrid(used.map((v) => v.points), session.imageSize);
  return {
    id: uid(),
    name: '',
    createdAt: Date.now(),
    camera: camera || session.source || { label: 'Camera' },
    imageSize: { ...session.imageSize },
    model: info.model,
    distortion: info.id,
    options: { ...settings },
    K: solved.K,
    D: solved.D,
    rms: solved.rms,
    stdDevs: solved.stdDevs,
    target: session.target,
    views: views.map((v, k) => {
      const src = byId.get(v.id);
      return {
        id: v.id, n: src.n, name: src.name, thumb: src.thumb || null,
        rvec: solved.views[k].rvec, tvec: solved.views[k].tvec, rms: solved.views[k].rms,
        points: v.img, ids: v.keep ? null : src.ids, residuals: solved.views[k].residuals,
        count: src.count, used: v.img.length / 2,
      };
    }),
    excludedViews: session.views.filter((v) => !v.enabled).length,
    stats: {
      views: views.length,
      points: views.reduce((s, v) => s + v.img.length / 2, 0),
      removedPoints, removedViews, threshold,
      coverage: coverageFraction(cov),
      progress: coverageProgress(used.map((v) => v.params)).map((p) => ({ key: p.key, label: p.label, progress: p.progress })),
      solveMs: solved.ms,
    },
    groundTruth: groundTruth || null,
  };
}
