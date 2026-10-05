// Calibration target model.
//
// A target is a plain, serialisable object. All lengths are millimetres. This module owns the
// geometry: the printed layout (black rectangles on white) and the 3-D object points that each
// detected corner / marker corresponds to. The OpenCV worker only detects things in images;
// the mapping from detected ids to physical coordinates always happens here, so rendering,
// detection and calibration can never disagree about the board.
import { dictionaryInfo, markerBits } from './dictionaries.js';
import { formatLength } from './units.js';

export const TARGET_TYPES = [
  {
    id: 'charuco', label: 'ChArUco', calibration: true,
    blurb: 'Checkerboard with ArUco markers in the white squares. Works even when part of the board is out of view — the best general-purpose choice.',
  },
  {
    id: 'checkerboard', label: 'Checkerboard', calibration: true,
    blurb: 'Classic black-and-white chessboard. Very accurate corners, but the whole board must be visible in every image.',
  },
  {
    id: 'gridboard', label: 'Marker grid', calibration: true,
    blurb: 'A grid of ArUco or AprilTag markers (similar to a Kalibr AprilGrid). Robust and partially-visible friendly.',
  },
  {
    id: 'markers', label: 'Marker sheet', calibration: false,
    blurb: 'Individually numbered markers for tracking, robotics and AR. Not used for calibration.',
  },
];

export const typeInfo = (type) => TARGET_TYPES.find((t) => t.id === type);

// Every default fits on one A4 or US Letter page with 10 mm printer margins.
const DEFAULTS = {
  checkerboard: { cols: 10, rows: 7, squareSize: 20, quietZone: 20 },
  charuco: { cols: 11, rows: 8, squareSize: 20, markerSize: 15, dictionary: 'DICT_5X5_100', legacy: false, firstId: 0, quietZone: 10 },
  gridboard: { cols: 6, rows: 8, markerSize: 24, markerSeparation: 5, dictionary: 'DICT_APRILTAG_36h11', firstId: 0, quietZone: 8 },
  markers: { cols: 3, rows: 4, markerSize: 45, markerSeparation: 15, dictionary: 'DICT_4X4_50', firstId: 0, quietZone: 10, labels: true },
};

export function defaultTarget(type = 'charuco') {
  if (!DEFAULTS[type]) throw new Error(`Unknown target type ${type}`);
  return { type, ...DEFAULTS[type] };
}

/** Fills missing fields with defaults and coerces numeric fields. */
export function normalizeTarget(input) {
  const t = { ...defaultTarget(input?.type ?? 'charuco'), ...input };
  for (const k of ['cols', 'rows', 'firstId']) if (k in t) t[k] = Math.round(Number(t[k]));
  for (const k of ['squareSize', 'markerSize', 'markerSeparation', 'quietZone']) if (k in t) t[k] = Number(t[k]);
  t.legacy = !!t.legacy;
  return t;
}

/** Number of markers a board uses (ChArUco: one per white square). */
export function markerCount(t) {
  if (t.type === 'charuco') return Math.floor((t.cols * t.rows) / 2);
  if (t.type === 'gridboard' || t.type === 'markers') return t.cols * t.rows;
  return 0;
}

/** Inner-corner grid size for checkerboards / ChArUco ({ cols, rows } of corners). */
export function innerCorners(t) {
  return { cols: t.cols - 1, rows: t.rows - 1 };
}

/** Maximum number of calibration points one fully visible view yields. */
export function maxPoints(t) {
  if (t.type === 'checkerboard' || t.type === 'charuco') return (t.cols - 1) * (t.rows - 1);
  if (t.type === 'gridboard') return t.cols * t.rows * 4;
  return 0;
}

/** Board extent in mm, excluding the quiet zone. */
export function boardSize(t) {
  if (t.type === 'checkerboard' || t.type === 'charuco') return { width: t.cols * t.squareSize, height: t.rows * t.squareSize };
  const pitch = t.markerSize + t.markerSeparation;
  return { width: t.cols * pitch - t.markerSeparation, height: t.rows * pitch - t.markerSeparation };
}

/** Total printed extent in mm, including the quiet zone. */
export function printedSize(t) {
  const b = boardSize(t);
  const q = Math.max(0, t.quietZone || 0);
  return { width: b.width + 2 * q, height: b.height + 2 * q };
}

export function validateTarget(input) {
  const t = normalizeTarget(input);
  const errors = [];
  const warnings = [];
  const pos = (v) => Number.isFinite(v) && v > 0;

  if (!(t.cols >= 1 && t.rows >= 1)) errors.push('Columns and rows must be at least 1.');
  if (t.cols * t.rows > 4000) errors.push('That board has too many cells (max 4000).');

  if (t.type === 'checkerboard' || t.type === 'charuco') {
    if (t.cols < 3 || t.rows < 3) errors.push('Use at least 3 × 3 squares.');
    if (!pos(t.squareSize)) errors.push('Square size must be a positive length.');
  }
  if (t.type === 'checkerboard') {
    if (t.cols % 2 === t.rows % 2) {
      warnings.push('This board is rotationally symmetric (both sides even or both odd). Its orientation can flip between images — fine for single-camera calibration, but use an odd × even board (e.g. 10 × 7) or ChArUco for stereo.');
    }
    if (t.cols < 5 || t.rows < 4) warnings.push('Small boards give few corners per image; 8 × 6 or larger is recommended.');
  }
  if (t.type === 'charuco') {
    if (!pos(t.markerSize)) errors.push('Marker size must be a positive length.');
    else if (t.markerSize >= t.squareSize) errors.push('Markers must be smaller than the squares they sit in.');
    else if (t.markerSize < 0.5 * t.squareSize) warnings.push('Markers smaller than half the square are hard to detect; ~70–80 % of the square is typical.');
    if (t.rows % 2 === 0) warnings.push('Even row count: boards printed by OpenCV < 4.6 (and some online generators) use a different “legacy” layout. Tick “Legacy layout” only if your printed board came from such a tool.');
  }
  if (t.type === 'gridboard' || t.type === 'markers') {
    if (!pos(t.markerSize)) errors.push('Marker size must be a positive length.');
    if (!(Number.isFinite(t.markerSeparation) && t.markerSeparation >= 0)) errors.push('Separation cannot be negative.');
    else if (t.type === 'gridboard' && t.markerSeparation < t.markerSize * 0.1) warnings.push('Very small separation makes neighbouring markers merge when blurred; 15–30 % of the marker size works well.');
    if (t.type === 'markers' && t.labels && t.markerSeparation < 6) warnings.push('Leave at least 6 mm between markers so the id labels fit.');
  }
  if (t.dictionary && t.type !== 'checkerboard') {
    let info;
    try { info = dictionaryInfo(t.dictionary); } catch { errors.push(`Unknown dictionary ${t.dictionary}.`); }
    if (info) {
      const need = markerCount(t);
      if (!(t.firstId >= 0)) errors.push('First marker id cannot be negative.');
      else if (t.firstId + need > info.count) {
        errors.push(`This board needs ${need} markers (ids ${t.firstId}–${t.firstId + need - 1}) but ${t.dictionary.replace('DICT_', '')} only has ids 0–${info.count - 1}. Choose a larger dictionary or a smaller board.`);
      }
      if (info.markerSize >= 6 && t.markerSize && t.markerSize / (info.markerSize + 2) < 1.2) {
        warnings.push(`Each marker bit would only be ${(t.markerSize / (info.markerSize + 2)).toFixed(1)} mm — consider bigger markers or a dictionary with fewer bits.`);
      }
    }
  }
  if (!(Number.isFinite(t.quietZone) && t.quietZone >= 0)) errors.push('Quiet zone cannot be negative.');
  else if (t.type === 'checkerboard' && t.quietZone < t.squareSize * 0.5) {
    warnings.push('Checkerboard detection needs a white border; keep the quiet zone at least half a square wide.');
  }
  return { target: t, errors, warnings, ok: errors.length === 0 };
}

export function describeTarget(t, unit = 'mm') {
  const L = (mm) => formatLength(mm, unit);
  const dict = t.dictionary ? t.dictionary.replace(/^DICT_/, '') : '';
  switch (t.type) {
    case 'checkerboard':
      return `Checkerboard ${t.cols}×${t.rows} squares (${t.cols - 1}×${t.rows - 1} inner corners), ${L(t.squareSize)} squares`;
    case 'charuco':
      return `ChArUco ${t.cols}×${t.rows}, ${L(t.squareSize)} squares, ${L(t.markerSize)} markers, ${dict}${t.legacy ? ' (legacy)' : ''}${t.firstId ? `, ids from ${t.firstId}` : ''}`;
    case 'gridboard':
      return `Marker grid ${t.cols}×${t.rows}, ${L(t.markerSize)} markers, ${L(t.markerSeparation)} gaps, ${dict}${t.firstId ? `, ids from ${t.firstId}` : ''}`;
    case 'markers':
      return `${t.cols * t.rows} markers (${dict}, ids ${t.firstId}–${t.firstId + t.cols * t.rows - 1}), ${L(t.markerSize)}`;
    default:
      return 'Unknown target';
  }
}

export function shortName(t) {
  switch (t.type) {
    case 'checkerboard': return `checkerboard_${t.cols}x${t.rows}_${+t.squareSize.toFixed(2)}mm`;
    case 'charuco': return `charuco_${t.cols}x${t.rows}_${+t.squareSize.toFixed(2)}mm_${t.dictionary.replace('DICT_', '').toLowerCase()}`;
    case 'gridboard': return `markergrid_${t.cols}x${t.rows}_${+t.markerSize.toFixed(2)}mm_${t.dictionary.replace('DICT_', '').toLowerCase()}`;
    default: return `markers_${t.dictionary.replace('DICT_', '').toLowerCase()}_${t.firstId}-${t.firstId + t.cols * t.rows - 1}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** True if ChArUco square (x, y) is black (and therefore carries no marker). Mirrors OpenCV. */
export function charucoSquareIsBlack(t, x, y) {
  if (t.legacy && t.rows % 2 === 0) return (y + 1) % 2 === x % 2;
  return y % 2 === x % 2;
}

/** Marker placements: [{ id, x, y, size }] with (x, y) = top-left corner in board mm. */
export function markerPlacements(t) {
  const out = [];
  if (t.type === 'charuco') {
    const inset = (t.squareSize - t.markerSize) / 2;
    let k = 0;
    for (let y = 0; y < t.rows; y++) {
      for (let x = 0; x < t.cols; x++) {
        if (charucoSquareIsBlack(t, x, y)) continue;
        out.push({ id: t.firstId + k++, x: x * t.squareSize + inset, y: y * t.squareSize + inset, size: t.markerSize });
      }
    }
  } else if (t.type === 'gridboard' || t.type === 'markers') {
    const pitch = t.markerSize + t.markerSeparation;
    for (let y = 0; y < t.rows; y++) {
      for (let x = 0; x < t.cols; x++) {
        out.push({ id: t.firstId + y * t.cols + x, x: x * pitch, y: y * pitch, size: t.markerSize });
      }
    }
  }
  return out;
}

/**
 * 3-D object points (z = 0, millimetres) for one detection.
 *  - checkerboard: all inner corners, row-major (OpenCV findChessboardCorners order)
 *  - charuco: `ids` are ChArUco corner ids
 *  - gridboard: `ids` are marker ids; 4 corners each (TL, TR, BR, BL — OpenCV order)
 * Returns a Float32Array of length 3·N, or null if an id does not belong to the board.
 */
export function objectPoints(t, ids) {
  if (t.type === 'checkerboard') {
    const c = t.cols - 1, r = t.rows - 1;
    const out = new Float32Array(c * r * 3);
    for (let i = 0; i < c * r; i++) {
      out[3 * i] = (i % c) * t.squareSize;
      out[3 * i + 1] = Math.floor(i / c) * t.squareSize;
    }
    return out;
  }
  if (t.type === 'charuco') {
    const c = t.cols - 1, total = c * (t.rows - 1);
    const out = new Float32Array(ids.length * 3);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!(id >= 0 && id < total)) return null;
      out[3 * i] = ((id % c) + 1) * t.squareSize;
      out[3 * i + 1] = (Math.floor(id / c) + 1) * t.squareSize;
    }
    return out;
  }
  if (t.type === 'gridboard') {
    const pitch = t.markerSize + t.markerSeparation, m = t.markerSize, n = t.cols * t.rows;
    const out = new Float32Array(ids.length * 12);
    for (let i = 0; i < ids.length; i++) {
      const k = ids[i] - t.firstId;
      if (!(k >= 0 && k < n)) return null;
      const x0 = (k % t.cols) * pitch, y0 = Math.floor(k / t.cols) * pitch;
      out.set([x0, y0, 0, x0 + m, y0, 0, x0 + m, y0 + m, 0, x0, y0 + m, 0], 12 * i);
    }
    return out;
  }
  return null;
}

/** Outer corners of the board in board mm (TL, TR, BR, BL) — used for pose overlays. */
export function boardOutline(t) {
  const { width, height } = boardSize(t);
  // Checkerboard object points start at the first inner corner, so shift the outline.
  const o = t.type === 'checkerboard' ? -t.squareSize : 0;
  return [[o, o], [o + width, o], [o + width, o + height], [o, o + height]];
}

/** The parameters the OpenCV worker needs to build its detector. */
export function detectorSpec(t) {
  switch (t.type) {
    case 'checkerboard': return { type: 'checkerboard', cols: t.cols, rows: t.rows };
    case 'charuco': return {
      type: 'charuco', cols: t.cols, rows: t.rows, squareSize: t.squareSize, markerSize: t.markerSize,
      dictionary: t.dictionary, legacy: t.legacy, firstId: t.firstId,
    };
    case 'gridboard': return {
      type: 'gridboard', cols: t.cols, rows: t.rows, markerSize: t.markerSize, markerSeparation: t.markerSeparation,
      dictionary: t.dictionary, firstId: t.firstId,
    };
    case 'markers': return { type: 'markers', dictionary: t.dictionary };
    default: throw new Error(`Unknown target type ${t.type}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Printable layout
// ---------------------------------------------------------------------------------------------

/** Black cells of a marker merged into rectangles (row runs, then stacked identical runs). */
function markerRects(bits, n, x0, y0, size) {
  const cells = n + 2, cell = size / cells;
  const black = (cx, cy) => (cx === 0 || cy === 0 || cx === cells - 1 || cy === cells - 1) ? true : bits[(cy - 1) * n + (cx - 1)] === 0;
  const runs = [];
  for (let cy = 0; cy < cells; cy++) {
    let cx = 0;
    while (cx < cells) {
      if (!black(cx, cy)) { cx++; continue; }
      const start = cx;
      while (cx < cells && black(cx, cy)) cx++;
      runs.push({ cx: start, cw: cx - start, cy, ch: 1 });
    }
  }
  // Merge vertically adjacent runs with identical extents to cut the rectangle count.
  const merged = [];
  for (const r of runs) {
    const prev = merged.find((m) => m.cx === r.cx && m.cw === r.cw && m.cy + m.ch === r.cy);
    if (prev) prev.ch++;
    else merged.push({ ...r });
  }
  return merged.map((m) => ({ x: x0 + m.cx * cell, y: y0 + m.cy * cell, w: m.cw * cell, h: m.ch * cell }));
}

/**
 * Layout of the printed target in mm: { width, height, board: {x, y, width, height}, rects, texts }.
 * `rects` are black rectangles on a white page; `texts` are small labels (marker sheets).
 */
export async function layoutTarget(input) {
  const t = normalizeTarget(input);
  const q = Math.max(0, t.quietZone || 0);
  const b = boardSize(t);
  const rects = [];
  const texts = [];

  if (t.type === 'checkerboard' || t.type === 'charuco') {
    for (let y = 0; y < t.rows; y++) {
      for (let x = 0; x < t.cols; x++) {
        const black = t.type === 'charuco' ? charucoSquareIsBlack(t, x, y) : (x + y) % 2 === 0;
        if (black) rects.push({ x: q + x * t.squareSize, y: q + y * t.squareSize, w: t.squareSize, h: t.squareSize });
      }
    }
  }
  if (t.type !== 'checkerboard') {
    const { markerSize: n } = dictionaryInfo(t.dictionary);
    for (const p of markerPlacements(t)) {
      const bits = await markerBits(t.dictionary, p.id);
      rects.push(...markerRects(bits, n, q + p.x, q + p.y, p.size));
      if (t.type === 'markers' && t.labels) {
        texts.push({ x: q + p.x + p.size / 2, y: q + p.y + p.size + Math.min(4, t.markerSeparation * 0.45), text: `${p.id}`, size: Math.max(2, Math.min(4, t.markerSeparation * 0.4)) });
      }
    }
  }
  return { width: b.width + 2 * q, height: b.height + 2 * q, board: { x: q, y: q, width: b.width, height: b.height }, rects, texts };
}

/**
 * Positions (layout mm) where the target may be cut when tiling it across pages: along square
 * edges for chessboards, through the white gaps for marker grids — never through a marker.
 */
export function tileCuts(input) {
  const t = normalizeTarget(input);
  const q = Math.max(0, t.quietZone || 0);
  const xs = [], ys = [];
  if (t.type === 'checkerboard' || t.type === 'charuco') {
    for (let k = 0; k <= t.cols; k++) xs.push(q + k * t.squareSize);
    for (let k = 0; k <= t.rows; k++) ys.push(q + k * t.squareSize);
  } else {
    const pitch = t.markerSize + t.markerSeparation;
    for (let k = 1; k < t.cols; k++) xs.push(q + k * pitch - t.markerSeparation / 2);
    for (let k = 1; k < t.rows; k++) ys.push(q + k * pitch - t.markerSeparation / 2);
  }
  return { x: xs, y: ys };
}

/**
 * Largest square/marker size so the printed target fits within `maxW` × `maxH` mm.
 * Sizes are rounded down to `step` mm (0.5 mm by default; pass 25.4 / 32 for 1/32-inch steps).
 */
export function fitToArea(input, maxW, maxH, step = 0.5) {
  const t = normalizeTarget(input);
  const keepQuiet = t.quietZone || 0;
  const down = (v) => Math.floor(v / step + 1e-9) * step;
  if (t.type === 'checkerboard' || t.type === 'charuco') {
    // Quiet zone scales with the square for checkerboards (one square), fixed otherwise.
    const quietSquares = t.type === 'checkerboard' ? 2 : 0;
    const fixed = t.type === 'checkerboard' ? 0 : 2 * keepQuiet;
    const square = down(Math.min((maxW - fixed) / (t.cols + quietSquares), (maxH - fixed) / (t.rows + quietSquares)));
    const out = { ...t, squareSize: square };
    if (t.type === 'checkerboard') out.quietZone = square;
    if (t.type === 'charuco') out.markerSize = down(square * (t.markerSize / t.squareSize));
    return out;
  }
  const ratio = t.markerSeparation / t.markerSize;
  const unitW = t.cols + (t.cols - 1) * ratio, unitH = t.rows + (t.rows - 1) * ratio;
  const markerSize = down(Math.min((maxW - 2 * keepQuiet) / unitW, (maxH - 2 * keepQuiet) / unitH));
  return { ...t, markerSize, markerSeparation: Math.round(markerSize * ratio * 2) / 2 };
}
