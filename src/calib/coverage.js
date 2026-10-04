// View-diversity guidance, modelled on ROS camera_calibration: each view is summarised by
// [X, Y, Size, Skew]; a new view is "useful" if it differs enough from every captured one, and
// overall progress is how much of each parameter's range has been covered.

export const PARAMS = [
  { key: 'x', label: 'Left ↔ right', range: 0.7, hint: 'Move the board to the left and right edges of the frame.' },
  { key: 'y', label: 'Top ↔ bottom', range: 0.7, hint: 'Move the board to the top and bottom edges of the frame.' },
  { key: 'size', label: 'Near ↔ far', range: 0.4, hint: 'Bring the board closer (filling the frame) and further away.' },
  { key: 'skew', label: 'Tilt', range: 0.5, hint: 'Tilt the board ~30–45° left/right and up/down.' },
];

/** Image positions of the board's outermost detected corners (TL, TR, BR, BL in board terms). */
export function outerQuad(obj, img) {
  const n = img.length / 2;
  let tl = 0, tr = 0, br = 0, bl = 0;
  for (let i = 1; i < n; i++) {
    const s = obj[3 * i] + obj[3 * i + 1], d = obj[3 * i] - obj[3 * i + 1];
    if (s < obj[3 * tl] + obj[3 * tl + 1]) tl = i;
    if (s > obj[3 * br] + obj[3 * br + 1]) br = i;
    if (d > obj[3 * tr] - obj[3 * tr + 1]) tr = i;
    if (d < obj[3 * bl] - obj[3 * bl + 1]) bl = i;
  }
  return [tl, tr, br, bl].map((i) => [img[2 * i], img[2 * i + 1]]);
}

function quadArea([a, b, c, d]) {
  // |p × q| / 2 with p, q the diagonals.
  const p = [c[0] - a[0], c[1] - a[1]], q = [d[0] - b[0], d[1] - b[1]];
  return Math.abs(p[0] * q[1] - p[1] * q[0]) / 2;
}

function quadSkew([ul, ur, dr]) {
  const ab = [ul[0] - ur[0], ul[1] - ur[1]], cb = [dr[0] - ur[0], dr[1] - ur[1]];
  const c = (ab[0] * cb[0] + ab[1] * cb[1]) / (Math.hypot(...ab) * Math.hypot(...cb) || 1);
  const angle = Math.acos(Math.max(-1, Math.min(1, c)));
  return Math.min(1, 2 * Math.abs(Math.PI / 2 - angle));
}

/** [x, y, size, skew] ∈ [0, 1] for one detection. */
export function viewParams(obj, img, { width, height }) {
  const quad = outerQuad(obj, img);
  const area = quadArea(quad);
  const border = Math.sqrt(area);
  let mx = 0, my = 0;
  const n = img.length / 2;
  for (let i = 0; i < n; i++) { mx += img[2 * i]; my += img[2 * i + 1]; }
  mx /= n; my /= n;
  // Shrink the frame by ~half the board so large boards are not penalised (as ROS does).
  const px = Math.min(1, Math.max(0, (mx - border / 2) / Math.max(1, width - border)));
  const py = Math.min(1, Math.max(0, (my - border / 2) / Math.max(1, height - border)));
  return [px, py, Math.sqrt(area / (width * height)), quadSkew(quad)];
}

export const paramDistance = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);

/** Distance from `p` to the closest captured view (Infinity when none). */
export function novelty(p, list) {
  let d = Infinity;
  for (const q of list) d = Math.min(d, paramDistance(p, q));
  return d;
}

/** Per-parameter coverage: [{ key, label, min, max, progress }] with progress ∈ [0, 1]. */
export function coverageProgress(list) {
  if (!list.length) return PARAMS.map((p) => ({ ...p, min: 0, max: 0, progress: 0 }));
  const min = [...list[0]], max = [...list[0]];
  for (const q of list) for (let i = 0; i < 4; i++) { min[i] = Math.min(min[i], q[i]); max[i] = Math.max(max[i], q[i]); }
  // Don't reward small boards or no tilt: size and skew ranges count from zero.
  min[2] = 0; min[3] = 0;
  return PARAMS.map((p, i) => ({ ...p, min: min[i], max: max[i], progress: Math.min(1, (max[i] - min[i]) / p.range) }));
}

/** The weakest coverage parameter, for "what should I do next" hints. */
export function weakest(progress) {
  return progress.reduce((a, b) => (b.progress < a.progress ? b : a));
}

/** Counts how many detected points fall in each cell of a cols × rows grid over the image. */
export function coverageGrid(pointSets, { width, height }, cols = 12, rows = 8) {
  const grid = new Uint16Array(cols * rows);
  for (const pts of pointSets) {
    const seen = new Uint8Array(cols * rows); // count each view once per cell
    for (let i = 0; i < pts.length; i += 2) {
      const cx = Math.min(cols - 1, Math.max(0, Math.floor((pts[i] / width) * cols)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor((pts[i + 1] / height) * rows)));
      seen[cy * cols + cx] = 1;
    }
    for (let k = 0; k < seen.length; k++) grid[k] += seen[k];
  }
  return { grid, cols, rows };
}

/** Fraction of grid cells that contain at least one detected point. */
export function coverageFraction(cov) {
  let hit = 0;
  for (const v of cov.grid) if (v > 0) hit++;
  return hit / cov.grid.length;
}

/**
 * Mean displacement (px) between two detections of the same target, matching points by id
 * (ChArUco/marker grids) or by index (checkerboards). Returns Infinity if nothing matches.
 */
export function motionBetween(a, b) {
  if (!a?.points || !b?.points) return Infinity;
  let sum = 0, n = 0;
  if (!a.ids || !b.ids) {
    if (a.points.length !== b.points.length) return Infinity;
    for (let i = 0; i < a.points.length; i += 2) { sum += Math.hypot(a.points[i] - b.points[i], a.points[i + 1] - b.points[i + 1]); n++; }
    return n ? sum / n : Infinity;
  }
  const per = a.points.length / a.ids.length; // 2 (charuco corner) or 8 (marker)
  const idx = new Map();
  for (let i = 0; i < b.ids.length; i++) idx.set(b.ids[i], i);
  for (let i = 0; i < a.ids.length; i++) {
    const j = idx.get(a.ids[i]);
    if (j === undefined) continue;
    for (let k = 0; k < per; k += 2) {
      sum += Math.hypot(a.points[per * i + k] - b.points[per * j + k], a.points[per * i + k + 1] - b.points[per * j + k + 1]);
      n++;
    }
  }
  return n ? sum / n : Infinity;
}
