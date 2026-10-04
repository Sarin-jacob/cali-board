// Synthetic camera: renders a printed target as a real lens would see it — perspective plus lens
// distortion — with known ground-truth intrinsics. Powers the "virtual camera" demo source and the
// end-to-end tests (render → detect → calibrate → compare with the truth).
import { pixelToRay, rodrigues } from './camera-model.js';

/** Rasterises a target layout (mm) into an 8-bit texture at `scale` px/mm (255 = white). */
export function rasterizeLayout(layout, scale) {
  const W = Math.max(1, Math.round(layout.width * scale)), H = Math.max(1, Math.round(layout.height * scale));
  const tex = new Uint8Array(W * H).fill(255);
  for (const r of layout.rects) {
    const x0 = Math.max(0, Math.round(r.x * scale)), y0 = Math.max(0, Math.round(r.y * scale));
    const x1 = Math.min(W, Math.round((r.x + r.w) * scale)), y1 = Math.min(H, Math.round((r.y + r.h) * scale));
    for (let y = y0; y < y1; y++) tex.fill(0, y * W + x0, y * W + x1);
  }
  return { width: W, height: H, data: tex, scale };
}

/** Offset (mm) from the target's object-point origin to the layout origin. */
export function objectOriginInLayout(target, layout) {
  const extra = target.type === 'checkerboard' ? target.squareSize : 0; // checkerboard origin = first inner corner
  return [layout.board.x + extra, layout.board.y + extra];
}

/** Centre of the board in object coordinates (mm). */
export function boardCenter(target, layout) {
  const [ox, oy] = objectOriginInLayout(target, layout);
  return [layout.board.x + layout.board.width / 2 - ox, layout.board.y + layout.board.height / 2 - oy];
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SyntheticCamera {
  /**
   * @param {object} o
   * @param {object} o.calib      ground-truth calibration { model, K, D, imageSize }
   * @param {object} o.target     normalised target
   * @param {object} o.layout     layoutTarget(target)
   * @param {number} [o.texScale] texture resolution, px per mm
   * @param {number} [o.supersample] sub-samples per axis (anti-aliasing)
   */
  constructor({ calib, target, layout, texScale = 4, supersample = 1 }) {
    this.calib = calib;
    this.target = target;
    this.layout = layout;
    this.tex = rasterizeLayout(layout, texScale);
    this.origin = objectOriginInLayout(target, layout);
    this.ss = Math.max(1, Math.round(supersample));
    const { width: W, height: H } = calib.imageSize;
    this.width = W; this.height = H;
    // Precompute the undistorted ray of every (sub)pixel once; rendering is then a homography + texture fetch.
    const ss = this.ss, n = W * H * ss * ss;
    this.rays = new Float32Array(2 * n);
    let k = 0;
    for (let v = 0; v < H; v++) {
      for (let sy = 0; sy < ss; sy++) {
        const vv = v + (sy + 0.5) / ss - 0.5;
        for (let u = 0; u < W; u++) {
          for (let sx = 0; sx < ss; sx++) {
            const uu = u + (sx + 0.5) / ss - 0.5;
            const r = pixelToRay(calib, uu, vv);
            this.rays[k++] = r ? r[0] : NaN;
            this.rays[k++] = r ? r[1] : NaN;
          }
        }
      }
    }
  }

  /**
   * Renders the target at `pose` = { rvec | R, tvec }. Returns Uint8Array gray (default) or
   * Uint8ClampedArray RGBA when opts.rgba. opts: { noise (σ in gray levels), seed, lighting }.
   */
  render(pose, opts = {}) {
    const R = pose.R || rodrigues(pose.rvec);
    const t = pose.tvec;
    // H = [r1 r2 t] maps (X, Y, 1) on the board plane to camera rays; invert it once.
    const h = [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]];
    const Hi = invert3(h);
    const { width: W, height: H, ss } = this;
    const { data: tex, width: TW, height: TH, scale } = this.tex;
    const [ox, oy] = this.origin;
    const rand = rng(opts.seed ?? 7);
    const noise = opts.noise ?? 0;
    const light = opts.lighting ?? 0; // 0..1: strength of an uneven-lighting gradient
    const out = opts.rgba ? new Uint8ClampedArray(W * H * 4) : new Uint8Array(W * H);
    const inv = 1 / (ss * ss);
    let k = 0;
    for (let v = 0; v < H; v++) {
      // Each sub-row of samples is stored contiguously per pixel row: index = ((v*ss + sy)*W + u)*ss + sx.
      for (let u = 0; u < W; u++) {
        let acc = 0;
        for (let sy = 0; sy < ss; sy++) {
          let idx = (((v * ss + sy) * W + u) * ss) * 2;
          for (let sx = 0; sx < ss; sx++, idx += 2) {
            const x = this.rays[idx], y = this.rays[idx + 1];
            let val;
            if (x !== x) { val = 20; } // outside the lens' valid area
            else {
              const w = Hi[6] * x + Hi[7] * y + Hi[8];
              if (!(w > 0)) val = background(u, v, W, H);
              else {
                const X = (Hi[0] * x + Hi[1] * y + Hi[2]) / w + ox;
                const Y = (Hi[3] * x + Hi[4] * y + Hi[5]) / w + oy;
                const tx = X * scale - 0.5, ty = Y * scale - 0.5;
                if (tx < -0.5 || ty < -0.5 || tx > TW - 0.5 || ty > TH - 0.5) val = background(u, v, W, H);
                else val = sample(tex, TW, TH, tx, ty) * 0.82 + 30; // paper is not pure white, ink not pure black
              }
            }
            acc += val;
          }
        }
        let g = acc * inv;
        if (light) g *= 1 - light * 0.45 * ((u / W) * 0.7 + (v / H) * 0.3);
        if (noise) g += noise * gauss(rand);
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        if (opts.rgba) { out[k++] = g; out[k++] = g; out[k++] = g; out[k++] = 255; }
        else out[k++] = g;
      }
    }
    return out;
  }

  /** Ground-truth image positions of object points for a pose (Float32Array 2N). */
  groundTruth(pose, obj, project) {
    const out = new Float32Array((obj.length / 3) * 2);
    const R = pose.R || rodrigues(pose.rvec);
    for (let i = 0; i < obj.length / 3; i++) {
      const p = project(this.calib, R, pose.tvec, obj[3 * i], obj[3 * i + 1], obj[3 * i + 2]);
      out[2 * i] = p ? p[0] : NaN; out[2 * i + 1] = p ? p[1] : NaN;
    }
    return out;
  }
}

function background(u, v, W, H) {
  // A soft, slightly textured desk/wall so detectors have something non-trivial around the board.
  return 95 + 35 * (u / W) + 20 * Math.sin(v * 0.02) * Math.cos(u * 0.013);
}

function sample(tex, W, H, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const xa = x0 < 0 ? 0 : x0 >= W ? W - 1 : x0, xb = x0 + 1 >= W ? W - 1 : x0 + 1 < 0 ? 0 : x0 + 1;
  const ya = y0 < 0 ? 0 : y0 >= H ? H - 1 : y0, yb = y0 + 1 >= H ? H - 1 : y0 + 1 < 0 ? 0 : y0 + 1;
  const a = tex[ya * W + xa], b = tex[ya * W + xb], c = tex[yb * W + xa], d = tex[yb * W + xb];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function gauss(rand) {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error('Singular matrix');
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}

const mul3 = (A, B) => {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[3 * r + c] = A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c];
  return o;
};
const mulv = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];

/** Rotation from Euler angles (radians): roll about the optical axis, then tilts about x and y. */
export function eulerToR(tiltX, tiltY, roll) {
  const cx = Math.cos(tiltX), sx = Math.sin(tiltX), cy = Math.cos(tiltY), sy = Math.sin(tiltY), cz = Math.cos(roll), sz = Math.sin(roll);
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul3(Rx, mul3(Ry, Rz));
}

/**
 * Generates `n` varied poses that keep the whole board in view (like a person waving a board in
 * front of a camera): different positions across the frame, distances and tilts.
 * Returns [{ R, tvec }]. `fill` ∈ (0, 1] = typical fraction of the image width the board spans.
 */
export function randomPoses(n, { calib, target, layout, seed = 3, fill = 0.55, maxTilt = 0.6, margin = 0.03, project, corners }) {
  const rand = rng(seed);
  const { width: W, height: H } = calib.imageSize;
  const [bcx, bcy] = boardCenter(target, layout);
  const B = Math.max(layout.board.width, layout.board.height);
  const poses = [];
  let attempts = 0;
  while (poses.length < n && attempts++ < n * 400) {
    const f = calib.K[0];
    const span = fill * (0.6 + 0.8 * rand()) * W; // board width in pixels at this pose
    const z = (B * f) / span;
    const tiltX = (rand() * 2 - 1) * maxTilt, tiltY = (rand() * 2 - 1) * maxTilt, roll = (rand() * 2 - 1) * 0.5;
    const R = eulerToR(tiltX, tiltY, roll);
    const u = W * (0.2 + 0.6 * rand()), v = H * (0.2 + 0.6 * rand());
    const ray = [(u - calib.K[2]) / calib.K[0], (v - calib.K[5]) / calib.K[4], 1];
    const c = mulv(R, [bcx, bcy, 0]);
    const tvec = [ray[0] * z - c[0], ray[1] * z - c[1], z - c[2]];
    // Accept only if every outer board corner lands inside the image with a margin.
    const ok = corners.every(([X, Y]) => {
      const p = project(calib, R, tvec, X, Y, 0);
      return p && p[0] > W * margin && p[0] < W * (1 - margin) && p[1] > H * margin && p[1] < H * (1 - margin);
    });
    if (ok) poses.push({ R, tvec });
  }
  if (poses.length < n) throw new Error(`Could only place ${poses.length}/${n} board poses — board too large for this lens?`);
  return poses;
}

/** Outer corners of the board in object coordinates (for visibility tests). */
export function boardCornersObject(target, layout) {
  const [ox, oy] = objectOriginInLayout(target, layout);
  const { x, y, width, height } = layout.board;
  return [[x - ox, y - oy], [x + width - ox, y - oy], [x + width - ox, y + height - oy], [x - ox, y + height - oy]];
}
