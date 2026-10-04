// Detection overlays drawn on a canvas stacked over the video / image.

const ROW_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

/** Resizes an overlay canvas to its CSS box (device pixels) and returns { ctx, sx, sy }. */
export function prepareOverlay(canvas, imageSize) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, sx: w / imageSize.width, sy: h / imageSize.height, dpr };
}

function dot(ctx, x, y, r, fill) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Draws one detection. `cols` = inner corners per row for checkerboards. */
export function drawDetection(ctx, det, { sx, sy, dpr = 1, target, color = '#22c55e', showIds = false, faded = false }) {
  if (!det) return;
  const lw = Math.max(1.5, 2 * dpr);
  ctx.save();
  ctx.globalAlpha = faded ? 0.35 : 1;
  ctx.lineJoin = 'round';

  if (det.markers && det.markers.ids.length) {
    const c = det.markers.corners;
    ctx.lineWidth = Math.max(1, 1.2 * dpr);
    for (let i = 0; i < det.markers.ids.length; i++) {
      ctx.strokeStyle = target?.type === 'charuco' ? 'rgba(56,189,248,.85)' : color;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const x = c[8 * i + 2 * k] * sx, y = c[8 * i + 2 * k + 1] * sy;
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      // First corner marks orientation.
      dot(ctx, c[8 * i] * sx, c[8 * i + 1] * sy, 2.2 * dpr, '#f43f5e');
      if (showIds) {
        const cx = (c[8 * i] + c[8 * i + 4]) / 2 * sx, cy = (c[8 * i + 1] + c[8 * i + 5]) / 2 * sy;
        ctx.font = `600 ${Math.round(12 * dpr)}px ui-sans-serif, system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(0,0,0,.75)';
        ctx.strokeText(String(det.markers.ids[i]), cx, cy);
        ctx.fillStyle = '#fff';
        ctx.fillText(String(det.markers.ids[i]), cx, cy);
      }
    }
  }

  if (det.points && target?.type === 'checkerboard') {
    const cols = target.cols - 1, n = det.points.length / 2;
    ctx.lineWidth = lw;
    for (let r = 0; r * cols < n; r++) {
      ctx.strokeStyle = ROW_COLORS[r % ROW_COLORS.length];
      ctx.beginPath();
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const x = det.points[2 * i] * sx, y = det.points[2 * i + 1] * sy;
        c ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        dot(ctx, det.points[2 * i] * sx, det.points[2 * i + 1] * sy, 2.6 * dpr, ROW_COLORS[r % ROW_COLORS.length]);
      }
    }
  } else if (det.points && target?.type === 'charuco') {
    for (let i = 0; i < det.points.length; i += 2) {
      dot(ctx, det.points[i] * sx, det.points[i + 1] * sy, 3 * dpr, 'rgba(0,0,0,.6)');
      dot(ctx, det.points[i] * sx, det.points[i + 1] * sy, 2 * dpr, color);
    }
  }
  ctx.restore();
}

/** Outlines of previously captured views (their outer quads), so users see where they have been. */
export function drawGhosts(ctx, quads, { sx, sy, dpr = 1 }) {
  ctx.save();
  ctx.lineWidth = Math.max(1, dpr);
  ctx.strokeStyle = 'rgba(165,180,252,.55)';
  ctx.fillStyle = 'rgba(99,102,241,.07)';
  for (const q of quads) {
    ctx.beginPath();
    q.forEach(([x, y], k) => (k ? ctx.lineTo(x * sx, y * sy) : ctx.moveTo(x * sx, y * sy)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Coverage heatmap: tints image regions that no captured view has covered yet. */
export function drawCoverage(ctx, cov, { width, height }, { sx, sy }) {
  const cw = (width / cov.cols) * sx, ch = (height / cov.rows) * sy;
  ctx.save();
  for (let r = 0; r < cov.rows; r++) {
    for (let c = 0; c < cov.cols; c++) {
      const v = cov.grid[r * cov.cols + c];
      ctx.fillStyle = v === 0 ? 'rgba(245,158,11,.28)' : v < 3 ? 'rgba(34,197,94,.10)' : 'rgba(34,197,94,.18)';
      ctx.fillRect(c * cw, r * ch, cw, ch);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = 1;
  for (let c = 1; c < cov.cols; c++) { ctx.beginPath(); ctx.moveTo(c * cw, 0); ctx.lineTo(c * cw, cov.rows * ch); ctx.stroke(); }
  for (let r = 1; r < cov.rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * ch); ctx.lineTo(cov.cols * cw, r * ch); ctx.stroke(); }
  ctx.restore();
}

/** Residual vectors (detected → reprojected), exaggerated by `gain`, coloured by magnitude. */
export function drawResiduals(ctx, points, residuals, { sx, sy, dpr = 1, gain = 20 }) {
  ctx.save();
  ctx.lineWidth = Math.max(1, 1.2 * dpr);
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i] * sx, y = points[i + 1] * sy;
    const dx = residuals[i], dy = residuals[i + 1];
    const m = Math.hypot(dx, dy);
    const color = m < 0.3 ? '#22c55e' : m < 0.7 ? '#eab308' : m < 1.5 ? '#f97316' : '#ef4444';
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx * gain * sx, y + dy * gain * sy);
    ctx.stroke();
    dot(ctx, x, y, 1.8 * dpr, color);
  }
  ctx.restore();
}
