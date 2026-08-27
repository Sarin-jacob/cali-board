// Native memory transfer bypassing missing cv.imread/imshow wrappers
export function matToCanvas(mat, canvasId) {
  const canvas = typeof canvasId === 'string' ? document.getElementById(canvasId) : canvasId;
  canvas.width = mat.cols;
  canvas.height = mat.rows;
  const ctx = canvas.getContext('2d');
  
  const destMat = new cv.Mat();
  if (mat.channels() === 1) cv.cvtColor(mat, destMat, cv.COLOR_GRAY2RGBA);
  else if (mat.channels() === 3) cv.cvtColor(mat, destMat, cv.COLOR_RGB2RGBA);
  else mat.copyTo(destMat);

  const imgData = new ImageData(new Uint8ClampedArray(destMat.data), destMat.cols, destMat.rows);
  ctx.putImageData(imgData, 0, 0);
  destMat.delete();
}

export function canvasToMat(canvas) {
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return cv.matFromImageData(imgData);
}

export const CV_UTILS = {
  fn: (...names) => { for (const n of names) if (cv[n] !== undefined) return cv[n]; return null; },
  klass: (...names) => { for (const n of names) if (cv[n] !== undefined) return cv[n]; return null; },
  scalar: (a, b, c, d) => new cv.Scalar(a, b, c, d),

  getDict(dictName) {
    const fallbackMap = {
      'DICT_4X4_50': 0, 'DICT_4X4_100': 1, 'DICT_4X4_250': 2, 'DICT_4X4_1000': 3,
      'DICT_5X5_50': 4, 'DICT_5X5_100': 5, 'DICT_5X5_250': 6, 'DICT_5X5_1000': 7,
      'DICT_6X6_50': 8, 'DICT_6X6_100': 9, 'DICT_6X6_250': 10, 'DICT_6X6_1000': 11,
      'DICT_7X7_50': 12, 'DICT_7X7_100': 13, 'DICT_7X7_250': 14, 'DICT_7X7_1000': 15,
      'DICT_ARUCO_ORIGINAL': 16
    };
    let raw = cv[dictName] !== undefined ? cv[dictName] : fallbackMap[dictName];
    const dictId = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
    let f = cv.getPredefinedDictionary || cv.aruco_getPredefinedDictionary;
    if (!f && cv.aruco) f = cv.aruco.getPredefinedDictionary;
    if (!f) throw new Error("Unable to resolve getPredefinedDictionary API.");
    return f(dictId);
  },

  drawMarker(dict, id, size, img) {
    let f = cv.generateImageMarker || cv.aruco_generateImageMarker;
    if (!f && cv.aruco) f = cv.aruco.generateImageMarker;
    if (f) return f(dict, id, size, img, 1);
    throw new Error("Unable to map generateImageMarker API.");
  },

  createCharucoBoard(cols, rows, sqSz, mkSz, dict) {
    const K = this.klass('aruco_CharucoBoard', 'CharucoBoard');
    const sz = new cv.Size(cols, rows);
    try {
      return new K(sz, sqSz, mkSz, dict);
    } catch (e) {
      const emp = new cv.Mat();
      const b = new K(sz, sqSz, mkSz, dict, emp);
      emp.delete();
      return b;
    }
  },

  drawCharucoBoard(board, outSize, img) {
    if (typeof board.generateImage === 'function') return board.generateImage(outSize, img, 0, 1);
    if (typeof board.draw === 'function') return board.draw(outSize, img, 0, 1);
  },

  drawDetectedMarkers(img, corners, ids, color) {
    let f = cv.drawDetectedMarkers || cv.aruco_drawDetectedMarkers;
    if (!f && cv.aruco) f = cv.aruco.drawDetectedMarkers;
    if (!f) return;
    const c = color || this.scalar(0, 255, 0, 255);
    try { f(img, corners, ids, c); } catch (e) { f(img, corners, ids); }
  },

  drawDetectedCornersCharuco(img, corners, ids, color) {
    let f = cv.drawDetectedCornersCharuco || cv.aruco_drawDetectedCornersCharuco;
    if (!f && cv.aruco) f = cv.aruco.drawDetectedCornersCharuco;
    if (!f) return;
    const c = color || this.scalar(255, 0, 0, 255);
    try { f(img, corners, ids, c); } catch (e) { f(img, corners, ids); }
  }
};