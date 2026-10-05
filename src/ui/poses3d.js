// Interactive 3-D view of the camera and every board pose from a calibration (canvas, no deps).
import { rodrigues } from '../calib/camera-model.js';
import { boardOutline } from '../targets/targets.js';

const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const mul = (A, B) => { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[3 * r + c] = A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c]; return o; };
const apply = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2], M[3] * p[0] + M[4] * p[1] + M[5] * p[2], M[6] * p[0] + M[7] * p[1] + M[8] * p[2]];

/**
 * Mounts the viewer on `canvas`. Returns a cleanup function.
 * result: { K, imageSize, views: [{ rvec, tvec, rms, n }], rms }, target: target model (for board outlines).
 */
export function mountPoses3D(canvas, result, target) {
  const outline = boardOutline(target);
  const boards = result.views.map((v) => {
    const R = rodrigues(v.rvec);
    const corners = outline.map(([x, y]) => { const p = apply(R, [x, y, 0]); return [p[0] + v.tvec[0], p[1] + v.tvec[1], p[2] + v.tvec[2]]; });
    return { v, corners, center: corners.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]) };
  });
  const dists = boards.map((b) => Math.hypot(...b.center)).sort((a, b) => a - b);
  const scale = dists[dists.length >> 1] || 500;
  // Frame the scene: bounding sphere of the camera (origin) and every board corner.
  const all = [[0, 0, 0], ...boards.flatMap((b) => b.corners)];
  const lo = [0, 1, 2].map((k) => Math.min(...all.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k])));
  const centroid = lo.map((v, k) => (v + hi[k]) / 2);
  const radius = Math.max(1, Math.max(...all.map((p) => Math.hypot(p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]))));
  const med = [...result.views.map((v) => v.rms)].sort((a, b) => a - b)[result.views.length >> 1] || result.rms;

  // Camera frustum at depth ~0.35·median distance.
  const { width: W, height: H } = result.imageSize, K = result.K;
  const fd = scale * 0.35;
  const frustum = [[0, 0], [W, 0], [W, H], [0, H]].map(([u, v]) => [((u - K[2]) / K[0]) * fd, ((v - K[5]) / K[4]) * fd, fd]);

  let yaw = -0.75, pitch = 0.42, zoom = 1, drag = null;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    // OpenCV camera frame is y-down; flip so "up" is up on screen.
    const V = mul(rotX(pitch), rotY(yaw));
    // Viewing distance / focal so the bounding sphere fills ~80 % of the shorter side at zoom 1
    // (a mild perspective keeps near objects from blowing up).
    const dist = (radius * 3.5) / zoom;
    const f = Math.min(cw, ch) * 1.4;
    const proj = (p) => {
      const q = apply(V, [p[0] - centroid[0], -(p[1] - centroid[1]), p[2] - centroid[2]]);
      const z = q[2] + dist;
      return z <= 1 ? null : [cw / 2 + (f * q[0]) / z, ch / 2 - (f * q[1]) / z, z];
    };
    const line = (a, b, color, w = 1) => { const A = proj(a), B = proj(b); if (!A || !B) return; ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); };

    // Camera axes (x red, y green, z blue) and frustum.
    const a = scale * 0.18;
    line([0, 0, 0], [a, 0, 0], '#ef4444', 2);
    line([0, 0, 0], [0, a, 0], '#22c55e', 2);
    line([0, 0, 0], [0, 0, a], '#3b82f6', 2);
    const fc = dark ? 'rgba(226,232,240,.7)' : 'rgba(30,41,59,.7)';
    for (let i = 0; i < 4; i++) { line([0, 0, 0], frustum[i], fc); line(frustum[i], frustum[(i + 1) % 4], fc, 1.5); }

    // Boards, far to near.
    const items = boards.map((b) => ({ b, pts: b.corners.map(proj), depth: proj(b.center)?.[2] ?? Infinity })).filter((x) => x.pts.every(Boolean));
    items.sort((x, y) => y.depth - x.depth);
    for (const { b, pts } of items) {
      const ratio = b.v.rms / med;
      const color = ratio > 3 ? [239, 68, 68] : ratio > 1.8 ? [245, 158, 11] : [99, 102, 241];
      ctx.beginPath();
      pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fillStyle = `rgba(${color.join(',')},.16)`;
      ctx.strokeStyle = `rgba(${color.join(',')},.95)`;
      ctx.lineWidth = 1.2;
      ctx.fill(); ctx.stroke();
      // Board origin corner marker.
      ctx.fillStyle = `rgb(${color.join(',')})`;
      ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], 2.2, 0, Math.PI * 2); ctx.fill();
      const c = proj(b.center);
      ctx.fillStyle = dark ? '#e2e8f0' : '#334155';
      ctx.font = '10px ui-sans-serif, system-ui';
      ctx.fillText(String(b.v.n), c[0] + 3, c[1] - 3);
    }
  }

  const onDown = (e) => { drag = { x: e.clientX, y: e.clientY, yaw, pitch }; canvas.setPointerCapture(e.pointerId); };
  const onMove = (e) => {
    if (!drag) return;
    yaw = drag.yaw + (e.clientX - drag.x) * 0.008;
    pitch = Math.max(-1.45, Math.min(1.45, drag.pitch + (e.clientY - drag.y) * 0.008));
    draw();
  };
  const onUp = () => { drag = null; };
  const onWheel = (e) => { e.preventDefault(); zoom = Math.max(0.3, Math.min(5, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); draw(); };
  const onKey = (e) => {
    const k = { ArrowLeft: [-0.12, 0], ArrowRight: [0.12, 0], ArrowUp: [0, -0.12], ArrowDown: [0, 0.12] }[e.key];
    if (k) { e.preventDefault(); yaw += k[0]; pitch = Math.max(-1.45, Math.min(1.45, pitch + k[1])); draw(); }
    if (e.key === '+' || e.key === '=') { zoom = Math.min(5, zoom * 1.12); draw(); }
    if (e.key === '-') { zoom = Math.max(0.3, zoom / 1.12); draw(); }
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas);
  draw();
  return () => {
    ro.disconnect();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKey);
  };
}
