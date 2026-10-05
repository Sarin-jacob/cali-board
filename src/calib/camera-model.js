// Pure-JS camera models matching OpenCV's conventions, so overlays, previews and the virtual camera
// work without a round-trip to the WebAssembly worker.
//
// A calibration is { model: 'pinhole' | 'fisheye', K: [9] row-major, D: [...], imageSize: {width, height} }.
// Pinhole D layout (OpenCV): [k1, k2, p1, p2, k3, k4, k5, k6, s1, s2, s3, s4, τx, τy]; missing = 0.
// Fisheye D layout (Kannala–Brandt): [k1, k2, k3, k4].

const d = (D, i) => (D && D[i]) || 0;

/** Applies lens distortion to normalised, undistorted image coordinates. */
export function distortNormalized(calib, x, y) {
  const D = calib.D;
  if (calib.model === 'fisheye') {
    const r = Math.hypot(x, y);
    if (r < 1e-12) return [x, y];
    const th = Math.atan(r), t2 = th * th, t4 = t2 * t2, t6 = t4 * t2, t8 = t4 * t4;
    const thd = th * (1 + d(D, 0) * t2 + d(D, 1) * t4 + d(D, 2) * t6 + d(D, 3) * t8);
    const s = thd / r;
    return [x * s, y * s];
  }
  const r2 = x * x + y * y, r4 = r2 * r2, r6 = r4 * r2;
  const radial = (1 + d(D, 0) * r2 + d(D, 1) * r4 + d(D, 4) * r6) / (1 + d(D, 5) * r2 + d(D, 6) * r4 + d(D, 7) * r6);
  const xd = x * radial + 2 * d(D, 2) * x * y + d(D, 3) * (r2 + 2 * x * x) + d(D, 8) * r2 + d(D, 9) * r4;
  const yd = y * radial + d(D, 2) * (r2 + 2 * y * y) + 2 * d(D, 3) * x * y + d(D, 10) * r2 + d(D, 11) * r4;
  return [xd, yd];
}

/**
 * Inverse of distortNormalized (iterative, like cv::undistortPoints). Returns null where the model
 * cannot be inverted (e.g. beyond the fold-over radius of an over-fitted polynomial, or behind a fisheye).
 */
export function undistortNormalized(calib, xd, yd) {
  const D = calib.D;
  if (calib.model === 'fisheye') {
    const thd = Math.hypot(xd, yd);
    if (thd < 1e-12) return [xd, yd];
    let th = Math.min(thd, Math.PI / 2 - 1e-3);
    for (let i = 0; i < 30; i++) {
      const t2 = th * th, t4 = t2 * t2, t6 = t4 * t2, t8 = t4 * t4;
      const f = th * (1 + d(D, 0) * t2 + d(D, 1) * t4 + d(D, 2) * t6 + d(D, 3) * t8) - thd;
      const df = 1 + 3 * d(D, 0) * t2 + 5 * d(D, 1) * t4 + 7 * d(D, 2) * t6 + 9 * d(D, 3) * t8;
      if (!(df > 0)) return null;
      const step = f / df;
      th -= step;
      if (Math.abs(step) < 1e-12) break;
    }
    if (!(th > 0 && th < Math.PI / 2)) return null;
    const s = Math.tan(th) / thd;
    return [xd * s, yd * s];
  }
  let x = xd, y = yd;
  for (let i = 0; i < 40; i++) {
    const r2 = x * x + y * y, r4 = r2 * r2, r6 = r4 * r2;
    const icdist = (1 + d(D, 5) * r2 + d(D, 6) * r4 + d(D, 7) * r6) / (1 + d(D, 0) * r2 + d(D, 1) * r4 + d(D, 4) * r6);
    if (!(icdist > 0)) return null;
    const dx = 2 * d(D, 2) * x * y + d(D, 3) * (r2 + 2 * x * x) + d(D, 8) * r2 + d(D, 9) * r4;
    const dy = d(D, 2) * (r2 + 2 * y * y) + 2 * d(D, 3) * x * y + d(D, 10) * r2 + d(D, 11) * r4;
    x = (xd - dx) * icdist;
    y = (yd - dy) * icdist;
  }
  const [cx, cy] = distortNormalized(calib, x, y);
  if (!(Math.abs(cx - xd) < 1e-6 && Math.abs(cy - yd) < 1e-6)) return null;
  return [x, y];
}

/** Pixel → undistorted normalised ray (x, y, 1), or null. */
export function pixelToRay(calib, u, v) {
  const K = calib.K;
  const yd = (v - K[5]) / K[4];
  const xd = (u - K[2] - K[1] * yd) / K[0];
  return undistortNormalized(calib, xd, yd);
}

/** Normalised point → pixel (applies distortion). */
export function normalizedToPixel(calib, x, y) {
  const [xd, yd] = distortNormalized(calib, x, y);
  const K = calib.K;
  return [K[0] * xd + K[1] * yd + K[2], K[4] * yd + K[5]];
}

/** Rodrigues vector → row-major 3×3 rotation matrix. */
export function rodrigues(r) {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const kx = r[0] / th, ky = r[1] / th, kz = r[2] / th;
  const c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  ];
}

/** Rotation matrix (row-major) → Rodrigues vector. */
export function rotationToRodrigues(R) {
  const tr = R[0] + R[4] + R[8];
  const th = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // 180°: axis from the diagonal.
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)) * (R[1] >= 0 ? 1 : -1), z = Math.sqrt(Math.max(0, (R[8] + 1) / 2)) * (R[2] >= 0 ? 1 : -1);
    return [x * th, y * th, z * th];
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** Projects a 3-D point in the target frame through pose (R row-major, t) to pixels; null if behind. */
export function projectPoint(calib, R, t, X, Y, Z = 0) {
  const xc = R[0] * X + R[1] * Y + R[2] * Z + t[0];
  const yc = R[3] * X + R[4] * Y + R[5] * Z + t[1];
  const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
  if (!(zc > 1e-9)) return null;
  return normalizedToPixel(calib, xc / zc, yc / zc);
}

/** Field of view in degrees (horizontal, vertical, diagonal) across the image edges, through the centre. */
export function fieldOfView(calib) {
  const { width: W, height: H } = calib.imageSize;
  const K = calib.K;
  const angle = (u, v) => {
    const r = pixelToRay(calib, u, v);
    return r ? Math.atan(Math.hypot(r[0], r[1])) : null;
  };
  const span = (a, b) => (a === null || b === null ? null : (a + b) * 180 / Math.PI);
  // Measure from the principal point to opposite edges along the image axes / diagonal.
  const h = span(angle(-0.5, K[5]), angle(W - 0.5, K[5]));
  const v = span(angle(K[2], -0.5), angle(K[2], H - 0.5));
  const dg = span(angle(-0.5, -0.5), angle(W - 0.5, H - 0.5));
  // Pinhole-only fallback (ignores distortion) when the model cannot be inverted at the edges.
  const lin = (n, f) => 2 * Math.atan(n / (2 * f)) * 180 / Math.PI;
  return {
    horizontal: h ?? lin(W, K[0]),
    vertical: v ?? lin(H, K[4]),
    diagonal: dg ?? lin(Math.hypot(W, H), (K[0] + K[4]) / 2),
  };
}

/** Number of distortion coefficients that carry meaning for a pinhole distortion preset. */
export function coefficientNames(calib) {
  if (calib.model === 'fisheye') return ['k1', 'k2', 'k3', 'k4'];
  const names = ['k1', 'k2', 'p1', 'p2', 'k3', 'k4', 'k5', 'k6', 's1', 's2', 's3', 's4', 'τx', 'τy'];
  return names.slice(0, Math.min(names.length, calib.D.length));
}
