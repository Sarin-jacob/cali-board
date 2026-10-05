// Verifies that the JS target model agrees with OpenCV:
//  1. ChArUco layouts rasterise to exactly the same pixels as OpenCV's CharucoBoard.generateImage
//  2. object points for detected ChArUco corners / grid-board markers land where OpenCV detects them
//  3. checkerboard object points follow findChessboardCorners ordering
// Run: node tests/geometry.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { layoutTarget, objectPoints, normalizeTarget, validateTarget } from '../src/targets/targets.js';

const require = createRequire(import.meta.url);
const cv = await require('../scripts/load-opencv.cjs')();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

/** Rasterises a layout (mm) at `scale` px/mm into a Uint8Array (255 = white). */
function rasterize(layout, scale) {
  const W = Math.round(layout.width * scale), H = Math.round(layout.height * scale);
  const img = new Uint8Array(W * H).fill(255);
  for (const r of layout.rects) {
    const x0 = Math.round(r.x * scale), y0 = Math.round(r.y * scale);
    const x1 = Math.round((r.x + r.w) * scale), y1 = Math.round((r.y + r.h) * scale);
    for (let y = y0; y < y1; y++) img.fill(0, y * W + x0, y * W + x1);
  }
  return { W, H, img };
}

const seq = (n, from = 0) => Array.from({ length: n }, (_, i) => i + from);

await test('ChArUco layout matches OpenCV pixel-for-pixel (new + legacy, even + odd rows, id offset)', async () => {
  const cases = [
    { cols: 11, rows: 8, squareSize: 20, markerSize: 14, dictionary: 'DICT_5X5_100', legacy: false, firstId: 0 },
    { cols: 7, rows: 5, squareSize: 20, markerSize: 14, dictionary: 'DICT_5X5_100', legacy: false, firstId: 0 },
    { cols: 6, rows: 6, squareSize: 20, markerSize: 14, dictionary: 'DICT_5X5_100', legacy: true, firstId: 0 },
    { cols: 5, rows: 4, squareSize: 24, markerSize: 16, dictionary: 'DICT_6X6_250', legacy: false, firstId: 17 },
  ];
  const scale = 4;
  for (const c of cases) {
    const t = normalizeTarget({ type: 'charuco', ...c, quietZone: 0 });
    const mine = rasterize(await layoutTarget(t), scale);
    const n = Math.floor(t.cols * t.rows / 2);
    const dict = cv.getPredefinedDictionary(cv[t.dictionary]);
    const ids = cv.matFromArray(n, 1, cv.CV_32S, seq(n, t.firstId));
    const board = new cv.aruco_CharucoBoard(new cv.Size(t.cols, t.rows), t.squareSize, t.markerSize, dict, ids);
    if (t.legacy) board.setLegacyPattern(true);
    const ref = new cv.Mat();
    board.generateImage(new cv.Size(t.cols * t.squareSize * scale, t.rows * t.squareSize * scale), ref, 0, 1);
    assert.equal(ref.cols, mine.W); assert.equal(ref.rows, mine.H);
    let diff = 0;
    for (let i = 0; i < mine.img.length; i++) if ((ref.data[i] > 127 ? 255 : 0) !== mine.img[i]) diff++;
    assert.equal(diff, 0, `${JSON.stringify(c)}: ${diff} pixels differ`);
    ref.delete(); board.delete(); dict.delete(); ids.delete();
  }
});

// Raster pixel centres sit at integer coordinates, so the raster's outer edges are at -0.5 and W-0.5.
const edgeQuad = (W, H) => [-0.5, -0.5, W - 0.5, -0.5, W - 0.5, H - 0.5, -0.5, H - 0.5];

/** Renders a target and warps it into a 1280×720 frame; returns the image and the board-mm → pixel homography. */
async function renderWarped(t, scale, quad) {
  const r = rasterize(await layoutTarget(t), scale);
  const src = cv.matFromArray(r.H, r.W, cv.CV_8UC1, r.img);
  const s = cv.matFromArray(4, 1, cv.CV_32FC2, edgeQuad(r.W, r.H));
  const d = cv.matFromArray(4, 1, cv.CV_32FC2, quad);
  const M = cv.getPerspectiveTransform(s, d);
  const img = new cv.Mat();
  cv.warpPerspective(src, img, M, new cv.Size(1280, 720), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255));
  // board mm → raster coordinates (edge at k px ⇒ coordinate k − 0.5) → image.
  const q = t.quietZone * scale - 0.5;
  const toRaster = cv.matFromArray(3, 3, cv.CV_64F, [scale, 0, q, 0, scale, q, 0, 0, 1]);
  const Hm = new cv.Mat();
  cv.gemm(M, toRaster, 1, new cv.Mat(), 0, Hm);
  const H = Array.from(Hm.data64F);
  src.delete(); s.delete(); d.delete(); M.delete(); toRaster.delete(); Hm.delete();
  return { img, H };
}
const project = (H, x, y) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
const QUAD = [330, 110, 960, 150, 990, 610, 290, 640];

// A wrong id → position mapping is off by whole squares (tens of px); detector noise is sub-pixel.
// `vecs` (detected − predicted) also exposes systematic bias, which plain distances hide.
function checkErrors(vecs, label) {
  const n = vecs.length;
  const errs = vecs.map(([dx, dy]) => Math.hypot(dx, dy));
  const bx = vecs.reduce((a, v) => a + v[0], 0) / n, by = vecs.reduce((a, v) => a + v[1], 0) / n;
  const mean = errs.reduce((a, b) => a + b, 0) / n, max = Math.max(...errs);
  console.log(`    ${label}: ${n} points, mean error ${mean.toFixed(3)} px, max ${max.toFixed(3)} px, bias (${bx.toFixed(3)}, ${by.toFixed(3)})`);
  assert.ok(mean < 0.35 && max < 1.0 && Math.hypot(bx, by) < 0.1, label);
}

await test('ChArUco corner ids map to the right object points', async () => {
  const t = normalizeTarget({ type: 'charuco', cols: 9, rows: 6, squareSize: 30, markerSize: 22, dictionary: 'DICT_5X5_100', quietZone: 15, firstId: 3 });
  const { img, H } = await renderWarped(t, 3, QUAD);
  const dict = cv.getPredefinedDictionary(cv.DICT_5X5_100);
  const n = Math.floor(t.cols * t.rows / 2);
  const ids = cv.matFromArray(n, 1, cv.CV_32S, seq(n, t.firstId));
  const board = new cv.aruco_CharucoBoard(new cv.Size(t.cols, t.rows), t.squareSize, t.markerSize, dict, ids);
  const det = new cv.aruco_CharucoDetector(board, new cv.aruco_CharucoParameters(), new cv.aruco_DetectorParameters(), new cv.aruco_RefineParameters(10, 3, true));
  const cc = new cv.Mat(), ci = new cv.Mat(), mc = new cv.MatVector(), mi = new cv.Mat();
  det.detectBoard(img, cc, ci, mc, mi);
  assert.ok(ci.rows >= 30, `only ${ci.rows} corners`);
  // CharucoDetector output carries a ≈(+0.5, +0.5) px bias in this build; the worker re-refines
  // with cornerSubPix (window inside the marker inset), which removes it. Mirror that here.
  cv.cornerSubPix(img, cc, new cv.Size(5, 5), new cv.Size(-1, -1), new cv.TermCriteria(cv.TermCriteria_EPS + cv.TermCriteria_COUNT, 50, 0.001));
  const op = objectPoints(t, Int32Array.from(ci.data32S));
  const vecs = [];
  for (let i = 0; i < ci.rows; i++) {
    const [u, v] = project(H, op[3 * i], op[3 * i + 1]);
    vecs.push([cc.data32F[2 * i] - u, cc.data32F[2 * i + 1] - v]);
  }
  checkErrors(vecs, 'charuco');
});

await test('Marker-grid ids map to the right object points (AprilTag 36h11, id offset)', async () => {
  const t = normalizeTarget({ type: 'gridboard', cols: 5, rows: 4, markerSize: 30, markerSeparation: 8, dictionary: 'DICT_APRILTAG_36h11', quietZone: 10, firstId: 40 });
  const { img, H } = await renderWarped(t, 3, QUAD);
  const dict = cv.getPredefinedDictionary(cv.DICT_APRILTAG_36h11);
  const p = new cv.aruco_DetectorParameters(); p.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
  const det = new cv.aruco_ArucoDetector(dict, p, new cv.aruco_RefineParameters(10, 3, true));
  const mc = new cv.MatVector(), mi = new cv.Mat();
  det.detectMarkers(img, mc, mi);
  assert.equal(mi.rows, 20);
  const ids = Int32Array.from(mi.data32S);
  const op = objectPoints(t, ids);
  const vecs = [];
  for (let i = 0; i < ids.length; i++) {
    const c = mc.get(i).data32F;
    for (let k = 0; k < 4; k++) {
      const [u, v] = project(H, op[12 * i + 3 * k], op[12 * i + 3 * k + 1]);
      vecs.push([c[2 * k] - u, c[2 * k + 1] - v]);
    }
  }
  checkErrors(vecs, 'grid');
});

await test('Checkerboard object points follow findChessboardCorners ordering', async () => {
  const t = normalizeTarget({ type: 'checkerboard', cols: 10, rows: 7, squareSize: 25, quietZone: 25 });
  const { img, H } = await renderWarped(t, 2, QUAD);
  const corners = new cv.Mat();
  assert.ok(cv.findChessboardCornersSB(img, new cv.Size(9, 6), corners, cv.CALIB_CB_NORMALIZE_IMAGE));
  const op = objectPoints(t);
  const N = 54, fwd = [], rev = [];
  for (let i = 0; i < N; i++) {
    // Object points start at the first inner corner, one square in from the board edge.
    const [u, v] = project(H, op[3 * i] + t.squareSize, op[3 * i + 1] + t.squareSize);
    fwd.push([corners.data32F[2 * i] - u, corners.data32F[2 * i + 1] - v]);
    const j = N - 1 - i;
    rev.push([corners.data32F[2 * j] - u, corners.data32F[2 * j + 1] - v]);
  }
  // OpenCV may start from either end of the board; the worker canonicalises this later.
  const worst = (vs) => Math.max(...vs.map(([x, y]) => Math.hypot(x, y)));
  const isFwd = worst(fwd) < worst(rev);
  checkErrors(isFwd ? fwd : rev, `checkerboard (${isFwd ? 'forward' : 'reversed'} ordering)`);
});

await test('Every default target fits on one A4 and one US Letter page', async () => {
  const { planPages } = await import('../src/targets/pdf.js');
  const { defaultTarget } = await import('../src/targets/targets.js');
  for (const type of ['checkerboard', 'charuco', 'gridboard', 'markers']) {
    const layout = await layoutTarget(defaultTarget(type));
    for (const paper of ['a4', 'letter']) {
      const plan = planPages(layout, { paper, margin: 10 });
      assert.equal(plan.pages, 1, `${type} default needs ${plan.pages} ${paper} pages`);
    }
  }
});

await test('Validation catches impossible boards', async () => {
  assert.equal(validateTarget({ type: 'charuco', cols: 20, rows: 20, dictionary: 'DICT_4X4_50' }).ok, false);
  assert.equal(validateTarget({ type: 'charuco', squareSize: 10, markerSize: 12 }).ok, false);
  assert.equal(validateTarget({ type: 'checkerboard', cols: 2, rows: 5 }).ok, false);
  assert.ok(validateTarget({ type: 'checkerboard', cols: 8, rows: 8 }).warnings.length > 0);
  assert.ok(validateTarget(normalizeTarget({ type: 'gridboard' })).ok);
});

console.log(`geometry: ${passed} tests passed`);
