/* CaliBoard vision core — OpenCV-backed routines shared by the web worker (cv-worker.js) and the
 * Node test-suite. Classic script: defines globalThis.createCvCore(cv).
 *
 * Contract: every function takes and returns plain JS data (numbers, typed arrays, objects) and
 * frees every cv.Mat it creates. Inputs are validated *before* reaching OpenCV because this
 * OpenCV.js build is compiled without C++ exception support: a failed CV_Assert aborts the
 * WebAssembly runtime instead of throwing a catchable error.
 */
(function (root) {
  'use strict';

  function createCvCore(cv) {
    const isFiniteArray = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const median = (arr) => { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

    /** Collects Mats so a single finally-block can free them all. */
    function scope() {
      const items = [];
      return {
        add(m) { items.push(m); return m; },
        free() { for (let i = items.length - 1; i >= 0; i--) { try { items[i].delete(); } catch (e) { /* already freed */ } } items.length = 0; },
      };
    }

    const subpixCriteria = () => new cv.TermCriteria(cv.TermCriteria_EPS + cv.TermCriteria_COUNT, 40, 0.001);

    function dictionary(name) {
      const id = cv[name];
      if (id === undefined) throw new Error(`Dictionary ${name} is not available in this OpenCV build`);
      return cv.getPredefinedDictionary(typeof id === 'object' && 'value' in id ? id.value : id);
    }

    // -------------------------------------------------------------------------------------------
    // Images
    // -------------------------------------------------------------------------------------------

    /** RGBA bytes → new gray Mat (caller frees). */
    function grayFromRGBA(data, width, height) {
      if (!(width > 0 && height > 0) || data.length < width * height * 4) throw new Error('Invalid image buffer');
      const rgba = new cv.Mat(height, width, cv.CV_8UC4);
      try {
        rgba.data.set(data.length === width * height * 4 ? data : data.subarray(0, width * height * 4));
        const gray = new cv.Mat();
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
        return gray;
      } finally { rgba.delete(); }
    }

    /** Returns { img, scale } where img is gray downscaled so its longer side ≤ maxSide (scale ≤ 1). */
    function workingImage(gray, maxSide, s) {
      const side = Math.max(gray.cols, gray.rows);
      if (!maxSide || side <= maxSide) return { img: gray, scale: 1 };
      const scale = maxSide / side;
      const small = s.add(new cv.Mat());
      cv.resize(gray, small, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, cv.INTER_AREA);
      return { img: small, scale };
    }

    /** Scales points from a downscaled image back to full resolution (pixel-centre convention). */
    function upscalePoints(pts, scale) {
      if (scale === 1) return pts;
      const out = new Float32Array(pts.length);
      for (let i = 0; i < pts.length; i++) out[i] = (pts[i] + 0.5) / scale - 0.5;
      return out;
    }

    /** cornerSubPix on an arbitrary Float32Array of points (in place), half-window `w`. */
    function refinePoints(gray, pts, w) {
      const n = pts.length / 2;
      if (n === 0 || w < 1) return pts;
      w = Math.round(w);
      if (gray.cols < 2 * w + 5 || gray.rows < 2 * w + 5) return pts;
      const m = cv.matFromArray(n, 1, cv.CV_32FC2, pts);
      try {
        cv.cornerSubPix(gray, m, new cv.Size(w, w), new cv.Size(-1, -1), subpixCriteria());
        const out = Float32Array.from(m.data32F);
        // Reject refinements that wandered off (e.g. into a neighbouring corner).
        for (let i = 0; i < n; i++) {
          const dx = out[2 * i] - pts[2 * i], dy = out[2 * i + 1] - pts[2 * i + 1];
          if (!(Math.hypot(dx, dy) <= w)) { out[2 * i] = pts[2 * i]; out[2 * i + 1] = pts[2 * i + 1]; }
        }
        return out;
      } finally { m.delete(); }
    }

    /** Bilinear sample of a gray Mat's bytes (no bounds checks beyond clamping). */
    function bilinear(data, W, H, x, y) {
      if (x < 0) x = 0; else if (x > W - 1.001) x = W - 1.001;
      if (y < 0) y = 0; else if (y > H - 1.001) y = H - 1.001;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0;
      return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + W] * (1 - fx) + data[i + W + 1] * fx) * fy;
    }

    /**
     * Edge-based refinement of square-marker corners (the AprilTag/Kalibr approach). Marker corners
     * are "L" corners, and gradient-based cornerSubPix is biased on blurred L corners. Instead, find
     * each black/white edge with sub-pixel precision along its normals, fit a line per side, and
     * intersect neighbouring sides. corners: Float32Array(8·M), TL, TR, BR, BL per marker.
     */
    function refineMarkerEdges(gray, corners, bits, sepRatio) {
      const W = gray.cols, H = gray.rows, data = gray.data;
      const out = Float32Array.from(corners);
      const M = corners.length / 8;
      for (let m = 0; m < M; m++) {
        const c = corners.subarray(8 * m, 8 * m + 8);
        const cxm = (c[0] + c[2] + c[4] + c[6]) / 4, cym = (c[1] + c[3] + c[5] + c[7]) / 4;
        const lines = [];
        let ok = true;
        for (let s = 0; s < 4 && ok; s++) {
          const ax = c[2 * s], ay = c[2 * s + 1], bx = c[(2 * s + 2) % 8], by = c[(2 * s + 3) % 8];
          const len = Math.hypot(bx - ax, by - ay);
          const bitPx = len / bits;
          if (!(bitPx >= 1.5)) { ok = false; break; }
          const dx = (bx - ax) / len, dy = (by - ay) / len;
          let nx = -dy, ny = dx;
          if (nx * (cxm - ax) + ny * (cym - ay) < 0) { nx = -nx; ny = -ny; } // normal points into the (black) border
          const rin = 0.75 * bitPx, rout = Math.min(0.75 * bitPx, Math.max(1, 0.75 * bitPx * sepRatio));
          const step = 0.25, samples = Math.max(4, Math.min(24, Math.floor(len / 3)));
          const pts = [];
          for (let k = 0; k < samples; k++) {
            const tt = 0.2 + 0.6 * (k + 0.5) / samples;
            const px = ax + (bx - ax) * tt, py = ay + (by - ay) * tt;
            // Strongest white→black transition along the normal, with parabolic sub-sample fit.
            let best = -Infinity, bestO = 0, gBest = [0, 0, 0];
            const n = Math.floor((rin + rout) / step);
            const prof = new Float32Array(n + 3);
            for (let j = 0; j < n + 3; j++) { const o = -rout + (j - 1) * step; prof[j] = bilinear(data, W, H, px + nx * o, py + ny * o); }
            for (let j = 1; j <= n + 1; j++) {
              const g = prof[j - 1] - prof[j + 1]; // positive where intensity drops going inward
              if (g > best) { best = g; bestO = -rout + (j - 1) * step; gBest = [j > 1 ? prof[j - 2] - prof[j] : g, g, j < n + 1 ? prof[j] - prof[j + 2] : g]; }
            }
            if (!(best > 8)) continue; // too little contrast — skip this sample
            const den = gBest[0] - 2 * gBest[1] + gBest[2];
            const off = Math.abs(den) > 1e-9 ? 0.5 * (gBest[0] - gBest[2]) / den : 0;
            const o = bestO + clamp(off, -0.5, 0.5) * step;
            pts.push(px + nx * o, py + ny * o);
          }
          if (pts.length < 6) { ok = false; break; }
          // Total-least-squares line through the edge points.
          let mx = 0, my = 0;
          const np = pts.length / 2;
          for (let i = 0; i < pts.length; i += 2) { mx += pts[i]; my += pts[i + 1]; }
          mx /= np; my /= np;
          let sxx = 0, syy = 0, sxy = 0;
          for (let i = 0; i < pts.length; i += 2) { const ex = pts[i] - mx, ey = pts[i + 1] - my; sxx += ex * ex; syy += ey * ey; sxy += ex * ey; }
          const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
          lines.push([mx, my, Math.cos(ang), Math.sin(ang)]);
        }
        if (!ok || lines.length !== 4) continue;
        // Corner k is the intersection of side k-1 (ending at k) and side k (starting at k).
        const refined = new Float32Array(8);
        let good = true;
        for (let k = 0; k < 4 && good; k++) {
          const [x1, y1, u1, v1] = lines[(k + 3) % 4], [x2, y2, u2, v2] = lines[k];
          const det = u1 * v2 - v1 * u2;
          if (Math.abs(det) < 1e-3) { good = false; break; }
          const tt = ((x2 - x1) * v2 - (y2 - y1) * u2) / det;
          refined[2 * k] = x1 + u1 * tt; refined[2 * k + 1] = y1 + v1 * tt;
          const side = Math.hypot(c[2] - c[0], c[3] - c[1]) / bits;
          if (!(Math.hypot(refined[2 * k] - c[2 * k], refined[2 * k + 1] - c[2 * k + 1]) < 0.5 * side)) good = false;
        }
        if (good) out.set(refined, 8 * m);
      }
      return out;
    }

    function sampleMean(gray, x, y, r) {
      const x0 = clamp(Math.round(x - r), 0, gray.cols - 1), x1 = clamp(Math.round(x + r), 0, gray.cols - 1);
      const y0 = clamp(Math.round(y - r), 0, gray.rows - 1), y1 = clamp(Math.round(y + r), 0, gray.rows - 1);
      let sum = 0, n = 0;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { sum += gray.ucharAt(yy, xx); n++; }
      return n ? sum / n : 128;
    }

    // -------------------------------------------------------------------------------------------
    // Detectors (cached; building ArUco dictionaries/boards per frame would be wasteful)
    // -------------------------------------------------------------------------------------------

    const detectorCache = new Map();

    function markerParams(refineSubpix) {
      const p = new cv.aruco_DetectorParameters();
      p.cornerRefinementMethod = refineSubpix ? cv.CORNER_REFINE_SUBPIX : cv.CORNER_REFINE_NONE;
      p.cornerRefinementMinAccuracy = 0.01;
      p.cornerRefinementMaxIterations = 50;
      return p;
    }

    function idsMat(first, count) {
      const ids = new Int32Array(count);
      for (let i = 0; i < count; i++) ids[i] = first + i;
      return cv.matFromArray(count, 1, cv.CV_32S, ids);
    }

    function buildDetector(spec) {
      const s = scope();
      try {
        if (spec.type === 'charuco') {
          const dict = s.add(dictionary(spec.dictionary));
          const n = Math.floor(spec.cols * spec.rows / 2);
          const ids = s.add(idsMat(spec.firstId || 0, n));
          const board = new cv.aruco_CharucoBoard(new cv.Size(spec.cols, spec.rows), spec.squareSize, spec.markerSize, dict, ids);
          if (spec.legacy) board.setLegacyPattern(true);
          const cp = s.add(new cv.aruco_CharucoParameters());
          cp.tryRefineMarkers = true;
          const dp = s.add(markerParams(false));
          const rp = s.add(new cv.aruco_RefineParameters(10, 3, true));
          const det = new cv.aruco_CharucoDetector(board, cp, dp, rp);
          return { spec, board, det, dispose() { det.delete(); board.delete(); } };
        }
        if (spec.type === 'gridboard' || spec.type === 'markers') {
          const dict = dictionary(spec.dictionary);
          const dp = s.add(markerParams(true));
          const rp = s.add(new cv.aruco_RefineParameters(10, 3, true));
          const det = new cv.aruco_ArucoDetector(dict, dp, rp);
          let board = null;
          if (spec.type === 'gridboard') {
            const ids = s.add(idsMat(spec.firstId || 0, spec.cols * spec.rows));
            board = new cv.aruco_GridBoard(new cv.Size(spec.cols, spec.rows), spec.markerSize, spec.markerSeparation, dict, ids);
          }
          return { spec, dict, det, board, dispose() { det.delete(); if (board) board.delete(); dict.delete(); } };
        }
        throw new Error(`No detector for ${spec.type}`);
      } finally { s.free(); }
    }

    function detectorFor(spec) {
      const key = JSON.stringify(spec);
      let d = detectorCache.get(key);
      if (d) { detectorCache.delete(key); detectorCache.set(key, d); return d; }
      d = buildDetector(spec);
      detectorCache.set(key, d);
      while (detectorCache.size > 6) {
        const [oldKey, old] = detectorCache.entries().next().value;
        old.dispose(); detectorCache.delete(oldKey);
      }
      return d;
    }

    function validateSpec(spec) {
      const int = (v, min) => Number.isInteger(v) && v >= min;
      if (!spec || !spec.type) throw new Error('Missing target specification');
      if (spec.type === 'checkerboard' || spec.type === 'charuco') {
        if (!int(spec.cols, 3) || !int(spec.rows, 3)) throw new Error('Board needs at least 3 × 3 squares');
      }
      if (spec.type === 'charuco') {
        if (!(spec.markerSize > 0 && spec.markerSize < spec.squareSize)) throw new Error('Marker must be smaller than the square');
      }
      if (spec.type === 'gridboard') {
        if (!int(spec.cols, 1) || !int(spec.rows, 1) || !(spec.markerSize > 0) || !(spec.markerSeparation >= 0)) throw new Error('Invalid marker grid');
      }
      if (spec.dictionary && cv[spec.dictionary] === undefined) throw new Error(`Unknown dictionary ${spec.dictionary}`);
    }

    // -------------------------------------------------------------------------------------------
    // Detection
    // -------------------------------------------------------------------------------------------

    /** Median spacing between horizontally adjacent grid corners (pixels). */
    function gridSpacing(pts, ids, cols) {
      const pos = new Map();
      for (let i = 0; i < ids.length; i++) pos.set(ids[i], i);
      const d = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if ((id % cols) === cols - 1) continue;
        const j = pos.get(id + 1);
        if (j === undefined) continue;
        d.push(Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]));
      }
      return median(d);
    }

    /**
     * Puts checkerboard corners in a canonical order so corner 0 sits next to the black corner
     * square. OpenCV may start from either end; for boards whose two far corners differ in colour
     * (odd + even square counts) this makes every view (and both cameras of a stereo rig) agree.
     */
    function canonicalizeCheckerboard(gray, pts, cols, rows) {
      const c = cols - 1, r = rows - 1, N = c * r;
      if ((cols + rows) % 2 === 0) return pts; // both far squares share a colour — ambiguous by design
      const P = (i) => [pts[2 * i], pts[2 * i + 1]];
      const [x0, y0] = P(0), [x1, y1] = P(1), [xc, yc] = P(c);
      const [xl, yl] = P(N - 1), [xl1, yl1] = P(N - 2), [xlc, ylc] = P(N - 1 - c);
      const sq = Math.hypot(x1 - x0, y1 - y0);
      const r0 = Math.max(1, sq * 0.15);
      const a = sampleMean(gray, x0 - 0.5 * (x1 - x0) - 0.5 * (xc - x0), y0 - 0.5 * (y1 - y0) - 0.5 * (yc - y0), r0);
      const b = sampleMean(gray, xl + 0.5 * (xl - xl1) + 0.5 * (xl - xlc), yl + 0.5 * (yl - yl1) + 0.5 * (yl - ylc), r0);
      if (a <= b) return pts; // corner 0 already next to the darker (black) square
      const out = new Float32Array(pts.length);
      for (let i = 0; i < N; i++) { out[2 * i] = pts[2 * (N - 1 - i)]; out[2 * i + 1] = pts[2 * (N - 1 - i) + 1]; }
      return out;
    }

    function detectCheckerboard(gray, spec, opts, s) {
      const c = spec.cols - 1, r = spec.rows - 1;
      const size = new cv.Size(c, r);
      const accurate = opts.mode === 'accurate';
      const { img, scale } = workingImage(gray, accurate ? (opts.maxSide || 2000) : (opts.maxSide || 960), s);
      const corners = s.add(new cv.Mat());
      let found = false, method = '';
      if (accurate) {
        found = cv.findChessboardCornersSB(img, size, corners, cv.CALIB_CB_NORMALIZE_IMAGE | cv.CALIB_CB_EXHAUSTIVE | cv.CALIB_CB_ACCURACY);
        method = 'sb';
      }
      if (!found) {
        found = cv.findChessboardCorners(img, size, corners, cv.CALIB_CB_ADAPTIVE_THRESH | cv.CALIB_CB_NORMALIZE_IMAGE | (accurate ? 0 : cv.CALIB_CB_FAST_CHECK));
        method = 'classic';
      }
      if (!found || corners.rows !== c * r) return { found: false };
      let pts = Float32Array.from(corners.data32F);
      if (!isFiniteArray(pts)) return { found: false };
      if (accurate) {
        // Refine at full resolution; the window must stay well inside one square.
        const ids = Int32Array.from({ length: c * r }, (_, i) => i);
        pts = upscalePoints(pts, scale);
        const sq = gridSpacing(pts, ids, c);
        const w = clamp(Math.floor(sq * 0.3), 2, 15);
        if (method === 'classic' || scale !== 1) pts = refinePoints(gray, pts, w);
      } else {
        pts = upscalePoints(pts, scale);
        if (opts.refine) {
          const ids = Int32Array.from({ length: c * r }, (_, i) => i);
          pts = refinePoints(gray, pts, clamp(Math.floor(gridSpacing(pts, ids, c) * 0.3), 2, 15));
        }
      }
      pts = canonicalizeCheckerboard(gray, pts, spec.cols, spec.rows);
      return { found: true, points: pts, ids: null, method };
    }

    function readMarkers(cornersVec, idsMat) {
      const n = idsMat.rows;
      const ids = new Int32Array(n), corners = new Float32Array(8 * n);
      for (let i = 0; i < n; i++) {
        ids[i] = idsMat.data32S[i];
        const m = cornersVec.get(i);
        corners.set(m.data32F.subarray(0, 8), 8 * i);
        m.delete();
      }
      return { ids, corners };
    }

    function detectCharuco(gray, spec, opts, s) {
      const d = detectorFor(spec);
      const accurate = opts.mode === 'accurate';
      const { img, scale } = workingImage(gray, accurate ? (opts.maxSide || 2000) : (opts.maxSide || 1280), s);
      const cc = s.add(new cv.Mat()), ci = s.add(new cv.Mat()), mc = s.add(new cv.MatVector()), mi = s.add(new cv.Mat());
      d.det.detectBoard(img, cc, ci, mc, mi);
      const markers = readMarkers(mc, mi);
      markers.corners = upscalePoints(markers.corners, scale);
      const n = ci.rows;
      if (n === 0) return { found: false, markers };
      let pts = upscalePoints(Float32Array.from(cc.data32F), scale);
      const ids = Int32Array.from(ci.data32S);
      const valid = isFiniteArray(pts);
      if (valid && (accurate || opts.refine)) {
        // CharucoDetector output is biased by ≈ +0.5 px in this build (see tests/geometry.test.mjs).
        // Re-refine on the full-resolution image with a window that stays inside the marker inset.
        const sq = gridSpacing(pts, ids, spec.cols - 1) || 20;
        const inset = sq * (spec.squareSize - spec.markerSize) / (2 * spec.squareSize);
        const w = clamp(Math.floor(inset * 0.75), 2, 12);
        if (inset >= 2.5) pts = refinePoints(gray, pts, w);
      }
      let collinear = false;
      if (n >= 3) {
        const idv = s.add(cv.matFromArray(n, 1, cv.CV_32S, ids));
        try { collinear = !!d.board.checkCharucoCornersCollinear(idv); } catch (e) { collinear = false; }
      }
      return { found: valid && n >= 4 && !collinear, points: pts, ids, markers, collinear };
    }

    function detectMarkers(gray, spec, opts, s) {
      const d = detectorFor(spec);
      const accurate = opts.mode === 'accurate';
      const { img, scale } = workingImage(gray, accurate ? (opts.maxSide || 2000) : (opts.maxSide || 1280), s);
      const mc = s.add(new cv.MatVector()), mi = s.add(new cv.Mat()), rej = s.add(new cv.MatVector());
      d.det.detectMarkers(img, mc, mi, rej);
      if (d.board && mi.rows > 0) {
        try { d.det.refineDetectedMarkers(img, d.board, mc, mi, rej); } catch (e) { /* optional step */ }
      }
      let { ids, corners } = readMarkers(mc, mi);
      corners = upscalePoints(corners, scale);
      if (spec.type === 'gridboard') {
        // Keep only markers that belong to this board.
        const first = spec.firstId || 0, last = first + spec.cols * spec.rows;
        const keep = [];
        for (let i = 0; i < ids.length; i++) if (ids[i] >= first && ids[i] < last) keep.push(i);
        if (keep.length !== ids.length) {
          ids = Int32Array.from(keep, (i) => ids[i]);
          corners = Float32Array.from({ length: keep.length * 8 }, (_, k) => corners[8 * keep[k >> 3] + (k & 7)]);
        }
      }
      if ((accurate || opts.refine) && ids.length) {
        // Marker corners are L-corners; refine them from fitted edge lines at full resolution.
        const bits = d.dict.markerSize + 2;
        const sepBits = spec.type === 'gridboard' ? spec.markerSeparation * bits / spec.markerSize : bits;
        corners = refineMarkerEdges(gray, corners, bits, sepBits);
      }
      const markers = { ids, corners };
      if (spec.type === 'markers') return { found: ids.length > 0, points: null, ids: null, markers };
      return { found: ids.length >= 1 && isFiniteArray(corners), points: corners, ids, markers };
    }

    /**
     * Detects a calibration target in a gray image.
     * opts.mode: 'live' (fast, for preview) or 'accurate' (for captured views).
     * Returns { found, points: Float32Array(2N) | null, ids: Int32Array | null, markers, ms, size }.
     */
    function detect(gray, spec, opts = {}) {
      validateSpec(spec);
      const t0 = now();
      const s = scope();
      try {
        let res;
        if (spec.type === 'checkerboard') res = detectCheckerboard(gray, spec, opts, s);
        else if (spec.type === 'charuco') res = detectCharuco(gray, spec, opts, s);
        else res = detectMarkers(gray, spec, opts, s);
        res.ms = now() - t0;
        res.width = gray.cols; res.height = gray.rows;
        res.count = res.points ? res.points.length / 2 : 0;
        return res;
      } finally { s.free(); }
    }

    /** Sharpness score (variance of the Laplacian) inside the bounding box of `pts`. */
    function sharpness(gray, pts) {
      if (!pts || pts.length < 4) return 0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
      x0 = clamp(Math.floor(x0), 0, gray.cols - 2); y0 = clamp(Math.floor(y0), 0, gray.rows - 2);
      x1 = clamp(Math.ceil(x1), x0 + 1, gray.cols - 1); y1 = clamp(Math.ceil(y1), y0 + 1, gray.rows - 1);
      const s = scope();
      try {
        const roi = s.add(gray.roi(new cv.Rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1)));
        const lap = s.add(new cv.Mat());
        cv.Laplacian(roi, lap, cv.CV_32F, 3, 1, 0, cv.BORDER_DEFAULT);
        const mean = s.add(new cv.Mat()), std = s.add(new cv.Mat());
        cv.meanStdDev(lap, mean, std);
        return std.data64F[0] * std.data64F[0];
      } finally { s.free(); }
    }

    // -------------------------------------------------------------------------------------------
    // Calibration
    // -------------------------------------------------------------------------------------------

    const PINHOLE_MODELS = {
      // name: [flags, number of coefficients reported]
      none: [() => cv.CALIB_FIX_K1 | cv.CALIB_FIX_K2 | cv.CALIB_FIX_K3 | cv.CALIB_ZERO_TANGENT_DIST, 5],
      radial2: [() => cv.CALIB_FIX_K3 | cv.CALIB_ZERO_TANGENT_DIST, 5],
      standard4: [() => cv.CALIB_FIX_K3, 5],
      standard5: [() => 0, 5],
      rational: [() => cv.CALIB_RATIONAL_MODEL, 8],
      thinprism: [() => cv.CALIB_RATIONAL_MODEL | cv.CALIB_THIN_PRISM_MODEL, 12],
      tilted: [() => cv.CALIB_RATIONAL_MODEL | cv.CALIB_THIN_PRISM_MODEL | cv.CALIB_TILTED_MODEL, 14],
    };
    const STD_NAMES = ['fx', 'fy', 'cx', 'cy', 'k1', 'k2', 'p1', 'p2', 'k3', 'k4', 'k5', 'k6', 's1', 's2', 's3', 's4', 'tx', 'ty'];

    function validateViews(views, imageSize, minViews, minPoints) {
      if (!imageSize || !(imageSize.width > 0 && imageSize.height > 0)) throw new Error('Image size is missing');
      if (!Array.isArray(views) || views.length < minViews) throw new Error(`Need at least ${minViews} views (have ${views ? views.length : 0})`);
      views.forEach((v, i) => {
        const n = v.img.length / 2;
        if (v.obj.length !== 3 * n) throw new Error(`View ${i + 1}: object/image point counts differ`);
        if (n < minPoints) throw new Error(`View ${i + 1} has only ${n} points (need ${minPoints})`);
        if (!isFiniteArray(v.obj) || !isFiniteArray(v.img)) throw new Error(`View ${i + 1} contains invalid coordinates`);
        for (let k = 0; k < v.obj.length; k += 3) if (v.obj[k + 2] !== 0) throw new Error('Object points must be planar (z = 0)');
        // Need non-collinear object points (rank-2 spread).
        let sxx = 0, syy = 0, sxy = 0, mx = 0, my = 0;
        for (let k = 0; k < n; k++) { mx += v.obj[3 * k]; my += v.obj[3 * k + 1]; }
        mx /= n; my /= n;
        for (let k = 0; k < n; k++) { const dx = v.obj[3 * k] - mx, dy = v.obj[3 * k + 1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
        const det = sxx * syy - sxy * sxy, tr = sxx + syy;
        if (!(det > 1e-6 * tr * tr)) throw new Error(`View ${i + 1}: points are (nearly) collinear`);
      });
    }

    function pushViews(views, s, key) {
      const vec = s.add(new cv.MatVector());
      for (const v of views) {
        const data = v[key];
        const ch = key === 'obj' ? 3 : 2;
        const m = cv.matFromArray(data.length / ch, 1, ch === 3 ? cv.CV_32FC3 : cv.CV_32FC2, data);
        vec.push_back(m);
        m.delete();
      }
      return vec;
    }

    const vec3 = (m) => [m.data64F[0], m.data64F[1], m.data64F[2]];

    function residualsFor(obj, img, rvec, tvec, K, D, fisheye, s) {
      const n = img.length / 2;
      const o = s.add(cv.matFromArray(n, 1, cv.CV_32FC3, obj));
      const rv = s.add(cv.matFromArray(3, 1, cv.CV_64F, rvec)), tv = s.add(cv.matFromArray(3, 1, cv.CV_64F, tvec));
      const proj = s.add(new cv.Mat());
      if (fisheye) cv.fisheye_projectPoints(o, proj, rv, tv, K, D);
      else cv.projectPoints(o, rv, tv, K, D, proj);
      const p = proj.type() === cv.CV_64FC2 ? proj.data64F : proj.data32F;
      const res = new Float32Array(2 * n);
      let sq = 0;
      for (let i = 0; i < 2 * n; i++) { res[i] = p[i] - img[i]; sq += res[i] * res[i]; }
      return { residuals: res, sqSum: sq, rms: Math.sqrt(sq / n) };
    }

    /**
     * Calibrates one camera.
     * req = { views: [{ obj: Float32Array(3N), img: Float32Array(2N) }], imageSize: { width, height },
     *         model: 'pinhole' | 'fisheye', distortion: one of PINHOLE_MODELS keys (pinhole),
     *         options: { fixAspectRatio, zeroTangent, fixPrincipalPoint, guess: { K, D }, fixK: [1..4] (fisheye) } }
     */
    function calibrate(req) {
      const t0 = now();
      const fisheye = req.model === 'fisheye';
      validateViews(req.views, req.imageSize, 3, fisheye ? 6 : 4);
      const opt = req.options || {};
      const s = scope();
      try {
        const size = new cv.Size(req.imageSize.width, req.imageSize.height);
        const objVec = pushViews(req.views, s, 'obj');
        const imgVec = pushViews(req.views, s, 'img');
        const rvecs = s.add(new cv.MatVector()), tvecs = s.add(new cv.MatVector());
        const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, opt.maxIter || 100, 1e-12);
        let K, D, rms, stdDevs = null, flags = 0;

        if (fisheye) {
          flags = cv.FISHEYE_CALIB_RECOMPUTE_EXTRINSIC | cv.FISHEYE_CALIB_FIX_SKEW;
          const fix = opt.fixK || [];
          if (fix.includes(1)) flags |= cv.FISHEYE_CALIB_FIX_K1;
          if (fix.includes(2)) flags |= cv.FISHEYE_CALIB_FIX_K2;
          if (fix.includes(3)) flags |= cv.FISHEYE_CALIB_FIX_K3;
          if (fix.includes(4)) flags |= cv.FISHEYE_CALIB_FIX_K4;
          if (opt.fixPrincipalPoint) flags |= cv.FISHEYE_CALIB_FIX_PRINCIPAL_POINT;
          if (opt.guess) {
            K = s.add(cv.matFromArray(3, 3, cv.CV_64F, opt.guess.K));
            D = s.add(cv.matFromArray(4, 1, cv.CV_64F, (opt.guess.D || [0, 0, 0, 0]).slice(0, 4)));
            flags |= cv.FISHEYE_CALIB_USE_INTRINSIC_GUESS;
          } else {
            K = s.add(new cv.Mat()); D = s.add(new cv.Mat());
          }
          rms = cv.fisheye_calibrate(objVec, imgVec, size, K, D, rvecs, tvecs, flags, criteria);
        } else {
          const model = PINHOLE_MODELS[req.distortion || 'standard4'];
          if (!model) throw new Error(`Unknown distortion model ${req.distortion}`);
          flags = model[0]();
          if (opt.zeroTangent) flags |= cv.CALIB_ZERO_TANGENT_DIST;
          if (opt.fixPrincipalPoint) flags |= cv.CALIB_FIX_PRINCIPAL_POINT;
          if (opt.guess) {
            K = s.add(cv.matFromArray(3, 3, cv.CV_64F, opt.guess.K));
            const g = (opt.guess.D || []).slice(0, model[1]);
            while (g.length < model[1]) g.push(0);
            D = s.add(cv.matFromArray(1, model[1], cv.CV_64F, g));
            flags |= cv.CALIB_USE_INTRINSIC_GUESS;
          } else {
            // FIX_ASPECT_RATIO keeps fx/fy of the input matrix, so start from the identity.
            K = s.add(cv.Mat.eye(3, 3, cv.CV_64F));
            D = s.add(new cv.Mat());
          }
          if (opt.fixAspectRatio) flags |= cv.CALIB_FIX_ASPECT_RATIO;
          const sdI = s.add(new cv.Mat()), sdE = s.add(new cv.Mat()), pve = s.add(new cv.Mat());
          rms = cv.calibrateCameraExtended(objVec, imgVec, size, K, D, rvecs, tvecs, sdI, sdE, pve, flags, criteria);
          stdDevs = {};
          const sd = sdI.data64F;
          for (let i = 0; i < STD_NAMES.length && i < sd.length; i++) stdDevs[STD_NAMES[i]] = sd[i];
        }

        const Karr = Array.from(K.data64F);
        const Darr = Array.from(D.data64F);
        if (!isFiniteArray(Karr) || !isFiniteArray(Darr) || !(Karr[0] > 0 && Karr[4] > 0)) throw new Error('Calibration did not converge (non-finite or negative focal length)');

        const views = [];
        let total = 0, count = 0;
        for (let i = 0; i < req.views.length; i++) {
          const rv = s.add(rvecs.get(i)), tv = s.add(tvecs.get(i));
          const rvec = vec3(rv), tvec = vec3(tv);
          const r = residualsFor(req.views[i].obj, req.views[i].img, rvec, tvec, K, D, fisheye, s);
          total += r.sqSum; count += req.views[i].img.length / 2;
          views.push({ rvec, tvec, rms: r.rms, residuals: r.residuals });
        }
        return {
          model: fisheye ? 'fisheye' : 'pinhole',
          distortion: fisheye ? 'fisheye' : (req.distortion || 'standard4'),
          imageSize: { width: req.imageSize.width, height: req.imageSize.height },
          K: Karr, D: Darr, rms: Math.sqrt(total / count), cvRms: rms, stdDevs, flags,
          views, ms: now() - t0,
        };
      } finally { s.free(); }
    }

    // -------------------------------------------------------------------------------------------
    // Undistortion / rectification
    // -------------------------------------------------------------------------------------------

    function calibMats(calib, s) {
      const K = s.add(cv.matFromArray(3, 3, cv.CV_64F, calib.K));
      const D = calib.model === 'fisheye'
        ? s.add(cv.matFromArray(4, 1, cv.CV_64F, calib.D.slice(0, 4)))
        : s.add(cv.matFromArray(1, calib.D.length, cv.CV_64F, calib.D));
      return { K, D };
    }

    /**
     * New camera matrix for undistorted output. `alpha` ∈ [0, 1]: 0 = only valid pixels (crop),
     * 1 = keep all source pixels. For fisheye it maps to the `balance` parameter.
     */
    function newCameraMatrix(calib, alpha, outSize, fovScale) {
      const s = scope();
      try {
        const { K, D } = calibMats(calib, s);
        const size = new cv.Size(calib.imageSize.width, calib.imageSize.height);
        const out = outSize ? new cv.Size(outSize.width, outSize.height) : size;
        let nk;
        if (calib.model === 'fisheye') {
          nk = s.add(new cv.Mat());
          const R = s.add(cv.Mat.eye(3, 3, cv.CV_64F));
          cv.fisheye_estimateNewCameraMatrixForUndistortRectify(K, D, size, R, nk, clamp(alpha, 0, 1), out, fovScale || 1);
        } else {
          nk = s.add(cv.getOptimalNewCameraMatrix(K, D, size, clamp(alpha, 0, 1), out));
        }
        const arr = Array.from(nk.data64F);
        if (!isFiniteArray(arr) || !(arr[0] > 0)) return calib.K.slice();
        return arr;
      } finally { s.free(); }
    }

    let mapCache = null; // { key, map1, map2, newK, size }

    function freeMaps() { if (mapCache) { mapCache.map1.delete(); mapCache.map2.delete(); mapCache = null; } }

    /** Builds (and caches) undistort-rectify maps. opts: { alpha, R (9), P (9 or 12), outSize }. */
    function prepareMaps(calib, opts) {
      opts = opts || {};
      const outSize = opts.outSize || calib.imageSize;
      const key = JSON.stringify([calib.model, calib.K, calib.D, calib.imageSize, opts.alpha, opts.R, opts.P, outSize]);
      if (mapCache && mapCache.key === key) return mapCache;
      freeMaps();
      const s = scope();
      try {
        const { K, D } = calibMats(calib, s);
        const newK = opts.P ? (opts.P.length === 12 ? [opts.P[0], opts.P[1], opts.P[2], opts.P[4], opts.P[5], opts.P[6], opts.P[8], opts.P[9], opts.P[10]] : opts.P)
          : newCameraMatrix(calib, opts.alpha ?? 0, outSize);
        const P = s.add(cv.matFromArray(3, 3, cv.CV_64F, newK));
        const R = s.add(opts.R ? cv.matFromArray(3, 3, cv.CV_64F, opts.R) : cv.Mat.eye(3, 3, cv.CV_64F));
        const map1 = new cv.Mat(), map2 = new cv.Mat();
        const size = new cv.Size(outSize.width, outSize.height);
        if (calib.model === 'fisheye') cv.fisheye_initUndistortRectifyMap(K, D, R, P, size, cv.CV_16SC2, map1, map2);
        else cv.initUndistortRectifyMap(K, D, R, P, size, cv.CV_16SC2, map1, map2);
        mapCache = { key, map1, map2, newK, size: outSize };
        return mapCache;
      } finally { s.free(); }
    }

    /** Undistorts an RGBA buffer. Returns { data: Uint8ClampedArray, width, height, newK }. */
    function undistortRGBA(data, width, height, calib, opts) {
      if (width !== calib.imageSize.width || height !== calib.imageSize.height) {
        throw new Error(`Image is ${width}×${height} but the calibration is for ${calib.imageSize.width}×${calib.imageSize.height}`);
      }
      const maps = prepareMaps(calib, opts);
      const s = scope();
      try {
        const src = s.add(new cv.Mat(height, width, cv.CV_8UC4));
        src.data.set(data);
        const dst = s.add(new cv.Mat());
        cv.remap(src, dst, maps.map1, maps.map2, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));
        return { data: new Uint8ClampedArray(dst.data), width: dst.cols, height: dst.rows, newK: maps.newK };
      } finally { s.free(); }
    }

    // -------------------------------------------------------------------------------------------
    // Pose
    // -------------------------------------------------------------------------------------------

    /** Undistorts fisheye pixels to normalised coordinates (no fisheye_undistortPoints in this build). */
    function fisheyeNormalize(img, K, D) {
      const out = new Float64Array(img.length);
      const [fx, , cx, , fy, cy] = [K[0], K[1], K[2], K[3], K[4], K[5]];
      for (let i = 0; i < img.length; i += 2) {
        const x = (img[i] - cx) / fx, y = (img[i + 1] - cy) / fy;
        const td = Math.hypot(x, y);
        let th = td;
        for (let k = 0; k < 20; k++) {
          const t2 = th * th, t4 = t2 * t2, t6 = t4 * t2, t8 = t4 * t4;
          const f = th * (1 + D[0] * t2 + D[1] * t4 + D[2] * t6 + D[3] * t8) - td;
          const df = 1 + 3 * D[0] * t2 + 5 * D[1] * t4 + 7 * D[2] * t6 + 9 * D[3] * t8;
          const step = f / df;
          th -= step;
          if (Math.abs(step) < 1e-12) break;
        }
        const scale = td > 1e-12 ? Math.tan(th) / td : 1;
        out[i] = x * scale; out[i + 1] = y * scale;
      }
      return out;
    }

    /** Planar-target pose: { rvec, tvec, rms, residuals }. */
    function estimatePose(req) {
      const n = req.img.length / 2;
      if (n < 4 || req.obj.length !== 3 * n || !isFiniteArray(req.img) || !isFiniteArray(req.obj)) throw new Error('Need at least 4 valid points');
      const s = scope();
      try {
        const calib = req.calib;
        const fisheye = calib.model === 'fisheye';
        const o = s.add(cv.matFromArray(n, 1, cv.CV_64FC3, Float64Array.from(req.obj)));
        const rv = s.add(new cv.Mat()), tv = s.add(new cv.Mat());
        let ok;
        if (fisheye) {
          const norm = fisheyeNormalize(req.img, calib.K, calib.D);
          const ip = s.add(cv.matFromArray(n, 1, cv.CV_64FC2, norm));
          const I = s.add(cv.Mat.eye(3, 3, cv.CV_64F)), Z = s.add(cv.Mat.zeros(1, 5, cv.CV_64F));
          ok = cv.solvePnP(o, ip, I, Z, rv, tv, false, cv.SOLVEPNP_IPPE);
        } else {
          const ip = s.add(cv.matFromArray(n, 1, cv.CV_64FC2, Float64Array.from(req.img)));
          const { K, D } = calibMats(calib, s);
          ok = cv.solvePnP(o, ip, K, D, rv, tv, false, cv.SOLVEPNP_IPPE);
          if (ok && n >= 6) { try { cv.solvePnPRefineLM(o, ip, K, D, rv, tv); } catch (e) { /* keep IPPE */ } }
        }
        if (!ok) return { ok: false };
        const rvec = vec3(rv), tvec = vec3(tv);
        const { K, D } = calibMats(calib, s);
        const r = residualsFor(req.obj, req.img, rvec, tvec, K, D, fisheye, s);
        return { ok: true, rvec, tvec, rms: r.rms, residuals: r.residuals };
      } finally { s.free(); }
    }

    /** Projects 3-D points (Float32Array 3N) with a calibration and pose → Float32Array(2N). */
    function projectPoints(req) {
      const n = req.obj.length / 3;
      if (!n) return new Float32Array(0);
      const s = scope();
      try {
        const { K, D } = calibMats(req.calib, s);
        const o = s.add(cv.matFromArray(n, 1, cv.CV_32FC3, req.obj));
        const rv = s.add(cv.matFromArray(3, 1, cv.CV_64F, req.rvec)), tv = s.add(cv.matFromArray(3, 1, cv.CV_64F, req.tvec));
        const out = s.add(new cv.Mat());
        if (req.calib.model === 'fisheye') cv.fisheye_projectPoints(o, out, rv, tv, K, D);
        else cv.projectPoints(o, rv, tv, K, D, out);
        return Float32Array.from(out.type() === cv.CV_64FC2 ? out.data64F : out.data32F);
      } finally { s.free(); }
    }

    // -------------------------------------------------------------------------------------------
    // Stereo
    // -------------------------------------------------------------------------------------------

    /**
     * req = { views: [{ obj, img1, img2 }], imageSize, calib1, calib2, fixIntrinsic: true }
     * Both calibrations must share the model (pinhole or fisheye) and the image size.
     */
    function stereoCalibrate(req) {
      const t0 = now();
      const { calib1, calib2 } = req;
      if (calib1.model !== calib2.model) throw new Error('Both cameras must use the same lens model');
      const fisheye = calib1.model === 'fisheye';
      const v1 = req.views.map((v) => ({ obj: v.obj, img: v.img1 }));
      const v2 = req.views.map((v) => ({ obj: v.obj, img: v.img2 }));
      validateViews(v1, req.imageSize, 3, 4);
      validateViews(v2, req.imageSize, 3, 4);
      const s = scope();
      try {
        const size = new cv.Size(req.imageSize.width, req.imageSize.height);
        const objVec = pushViews(v1, s, 'obj');
        const img1 = pushViews(v1, s, 'img'), img2 = pushViews(v2, s, 'img');
        const m1 = calibMats(calib1, s), m2 = calibMats(calib2, s);
        const R = s.add(new cv.Mat()), T = s.add(new cv.Mat());
        const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 100, 1e-10);
        let rms, E = null, F = null;
        if (fisheye) {
          const rvecs = s.add(new cv.MatVector()), tvecs = s.add(new cv.MatVector());
          const flags = cv.FISHEYE_CALIB_FIX_INTRINSIC | cv.FISHEYE_CALIB_FIX_SKEW;
          rms = cv.fisheye_stereoCalibrate(objVec, img1, img2, m1.K, m1.D, m2.K, m2.D, size, R, T, rvecs, tvecs, flags, criteria);
        } else {
          const Em = s.add(new cv.Mat()), Fm = s.add(new cv.Mat());
          const flags = req.fixIntrinsic === false ? cv.CALIB_USE_INTRINSIC_GUESS : cv.CALIB_FIX_INTRINSIC;
          rms = cv.stereoCalibrate(objVec, img1, img2, m1.K, m1.D, m2.K, m2.D, size, R, T, Em, Fm, flags, criteria);
          E = Array.from(Em.data64F); F = Array.from(Fm.data64F);
        }
        const Rarr = Array.from(R.data64F), Tarr = Array.from(T.data64F);
        if (!isFiniteArray(Rarr) || !isFiniteArray(Tarr)) throw new Error('Stereo calibration did not converge');
        return {
          rms, R: Rarr, T: Tarr, E, F,
          K1: Array.from(m1.K.data64F), D1: Array.from(m1.D.data64F), K2: Array.from(m2.K.data64F), D2: Array.from(m2.D.data64F),
          ms: now() - t0,
        };
      } finally { s.free(); }
    }

    /** req = { calib1, calib2, R, T, alpha, imageSize } → { R1, R2, P1, P2, Q } */
    function stereoRectify(req) {
      const s = scope();
      try {
        const m1 = calibMats(req.calib1, s), m2 = calibMats(req.calib2, s);
        const size = new cv.Size(req.imageSize.width, req.imageSize.height);
        const R = s.add(cv.matFromArray(3, 3, cv.CV_64F, req.R)), T = s.add(cv.matFromArray(3, 1, cv.CV_64F, req.T));
        const R1 = s.add(new cv.Mat()), R2 = s.add(new cv.Mat()), P1 = s.add(new cv.Mat()), P2 = s.add(new cv.Mat()), Q = s.add(new cv.Mat());
        if (req.calib1.model === 'fisheye') {
          cv.fisheye_stereoRectify(m1.K, m1.D, m2.K, m2.D, size, R, T, R1, R2, P1, P2, Q, cv.CALIB_ZERO_DISPARITY, size, clamp(req.alpha ?? 0, 0, 1), 1.0);
        } else {
          cv.stereoRectify(m1.K, m1.D, m2.K, m2.D, size, R, T, R1, R2, P1, P2, Q, cv.CALIB_ZERO_DISPARITY, req.alpha ?? -1, size);
        }
        const a = (m) => Array.from(m.data64F);
        return { R1: a(R1), R2: a(R2), P1: a(P1), P2: a(P2), Q: a(Q) };
      } finally { s.free(); }
    }

    // -------------------------------------------------------------------------------------------

    function info() {
      const build = cv.getBuildInformation();
      const version = (build.match(/General configuration for OpenCV (\S+)/) || [])[1] || 'unknown';
      const modules = ((build.match(/To be built:\s+(.+)/) || [])[1] || '').trim().split(/\s+/);
      const want = ['calibrateCameraExtended', 'fisheye_calibrate', 'stereoCalibrate', 'stereoRectify', 'findChessboardCornersSB', 'aruco_CharucoDetector', 'aruco_ArucoDetector', 'solvePnP', 'initUndistortRectifyMap', 'remap'];
      const missing = want.filter((k) => typeof cv[k] !== 'function');
      return { version, modules, missing };
    }

    function dispose() {
      for (const d of detectorCache.values()) d.dispose();
      detectorCache.clear();
      freeMaps();
    }

    return {
      cv, info, dispose,
      grayFromRGBA, detect, sharpness,
      calibrate, newCameraMatrix, prepareMaps, undistortRGBA,
      estimatePose, projectPoints, fisheyeNormalize,
      stereoCalibrate, stereoRectify,
      PINHOLE_MODELS: Object.keys(PINHOLE_MODELS),
    };
  }

  root.createCvCore = createCvCore;
  if (typeof module === 'object' && module.exports) module.exports = createCvCore;
})(typeof self !== 'undefined' ? self : globalThis);
