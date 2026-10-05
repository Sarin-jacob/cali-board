// Turns a calibration result into a grade and plain-language advice.
import { distortNormalized, pixelToRay } from './camera-model.js';

/**
 * Checks that radial distortion is monotonic out to the image corners. Over-fitted polynomials
 * (typically a large k3) can "fold" so that two different directions map to the same pixel —
 * undistortion then breaks near the edges.
 */
export function distortionFolds(calib) {
  const { width: W, height: H } = calib.imageSize;
  const K = calib.K;
  // Furthest image corner from the principal point, in normalised (distorted) units.
  const rMaxD = Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([u, v]) => Math.hypot((u - K[2]) / K[0], (v - K[5]) / K[4])));
  if (calib.model === 'fisheye') {
    let prev = -1;
    for (let i = 1; i <= 200; i++) {
      const th = (i / 200) * (Math.PI / 2 - 0.01);
      const [xd] = distortNormalized(calib, Math.tan(th), 0);
      if (xd <= prev) return xd < rMaxD;
      prev = xd;
    }
    return false;
  }
  let prev = 0;
  for (let i = 1; i <= 400; i++) {
    const r = (i / 400) * rMaxD * 2.5; // undistorted radius well beyond the corner
    const [xd] = distortNormalized(calib, r, 0);
    if (xd <= prev) return prev < rMaxD * 1.0001; // folded before reaching the image corner
    prev = xd;
    if (xd > rMaxD) return false;
  }
  return false;
}

export function gradeRms(rms) {
  if (rms < 0.3) return 'excellent';
  if (rms < 0.6) return 'good';
  if (rms < 1.0) return 'fair';
  return 'poor';
}

const RANK = { excellent: 3, good: 2, fair: 1, poor: 0 };
const worse = (a, b) => (RANK[a] <= RANK[b] ? a : b);

/** Returns { grade, items: [{ level: 'ok'|'warn'|'bad'|'info', text }] }. */
export function assess(result) {
  const items = [];
  let grade = gradeRms(result.rms);
  const { width: W, height: H } = result.imageSize;
  const K = result.K;

  items.push({
    level: grade === 'poor' ? 'bad' : grade === 'fair' ? 'warn' : 'ok',
    text: `Reprojection error ${result.rms.toFixed(3)} px — ${grade}. Typical results: < 0.3 px with a sharp, rigid target; up to ~1 px is usable for many applications.`,
  });

  const n = result.stats.views;
  if (n < 10) { items.push({ level: 'bad', text: `Only ${n} views were used. Capture at least 10–15 (20–30 is ideal) so every parameter is well constrained.` }); grade = worse(grade, 'fair'); }
  else if (n < 15) items.push({ level: 'warn', text: `${n} views were used — fine, but 20+ gives more reliable distortion coefficients.` });

  const cov = result.stats.coverage;
  if (cov < 0.5) { items.push({ level: 'bad', text: `Only ${Math.round(cov * 100)} % of the image area was covered by the target. Distortion near uncovered edges and corners is extrapolated — add views with the board near the edges.` }); grade = worse(grade, 'fair'); }
  else if (cov < 0.75) items.push({ level: 'warn', text: `${Math.round(cov * 100)} % of the image was covered. More views near the edges/corners will improve the distortion estimate.` });
  else items.push({ level: 'ok', text: `${Math.round(cov * 100)} % of the image area is covered by detected corners.` });

  const skew = result.stats.progress?.find((p) => p.key === 'skew');
  if (skew && skew.progress < 0.5) items.push({ level: 'warn', text: 'Few tilted views. Without tilt, focal length and principal point are poorly separated — tilt the board 30–45° in several directions.' });

  if (result.stdDevs?.fx) {
    const rel = result.stdDevs.fx / K[0];
    if (rel > 0.01) { items.push({ level: 'bad', text: `Focal length uncertainty is ±${(rel * 100).toFixed(1)} % — add more varied (tilted, closer) views.` }); grade = worse(grade, 'fair'); }
    else if (rel > 0.003) items.push({ level: 'warn', text: `Focal length uncertainty is ±${(rel * 100).toFixed(2)} %.` });
    else items.push({ level: 'ok', text: `Focal length is well determined (±${(rel * 100).toFixed(2)} %).` });
  }

  const dx = (K[2] - (W - 1) / 2) / W, dy = (K[5] - (H - 1) / 2) / H;
  if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
    items.push({ level: 'warn', text: `The principal point is far from the image centre (${(dx * 100).toFixed(0)} %, ${(dy * 100).toFixed(0)} %). This happens with cropped/stabilised video, digital zoom, or too few tilted views.` });
  }
  if (Math.abs(K[0] / K[4] - 1) > 0.05) items.push({ level: 'info', text: `fx and fy differ by ${(Math.abs(K[0] / K[4] - 1) * 100).toFixed(1)} %. Normal for anamorphic sensors or resized video; otherwise try “Fix aspect ratio”.` });

  if (distortionFolds(result)) {
    items.push({ level: 'bad', text: 'The fitted distortion folds back inside the image — the model is over-fitted near the edges. Use a simpler model (Standard) or capture more views reaching the image corners.' });
    grade = worse(grade, 'fair');
  }

  const big = result.views.filter((v) => v.rms > Math.max(1, 3 * result.rms));
  if (big.length) items.push({ level: 'warn', text: `${big.length} view${big.length > 1 ? 's have' : ' has'} much higher error than the rest (motion blur, a bent target or a bad detection). Consider excluding ${big.length > 1 ? 'them' : 'it'} and recalibrating.` });

  if (result.stats.removedPoints) items.push({ level: 'info', text: `Robust fitting discarded ${result.stats.removedPoints} outlier point${result.stats.removedPoints > 1 ? 's' : ''}${result.stats.threshold ? ` (residual > ${result.stats.threshold.toFixed(2)} px)` : ''}.` });

  // Corner check: can the corner pixels be undistorted at all?
  if (!pixelToRay(result, 0, 0) || !pixelToRay(result, W - 1, H - 1)) {
    items.push({ level: 'info', text: 'Some image corners lie outside the model’s valid range (normal for fisheye lenses with a circular image).' });
  }
  return { grade, items };
}

/** Compares a result with known ground truth (virtual camera). */
export function compareWithTruth(result, truth) {
  if (!truth) return null;
  const K = result.K, T = truth.K;
  const rel = (a, b) => (a - b) / b;
  return {
    fx: { est: K[0], truth: T[0], err: rel(K[0], T[0]) },
    fy: { est: K[4], truth: T[4], err: rel(K[4], T[4]) },
    cx: { est: K[2], truth: T[2], err: K[2] - T[2] },
    cy: { est: K[5], truth: T[5], err: K[5] - T[5] },
    D: truth.D.map((d, i) => ({ truth: d, est: result.D[i] ?? 0 })),
    sameModel: truth.model === result.model,
  };
}
