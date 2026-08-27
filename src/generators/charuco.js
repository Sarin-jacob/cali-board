import { CV_UTILS, matToCanvas } from '../core/utils.js';

export function drawCharuco(dpi = 300) {
  if (typeof cv === 'undefined' || !cv.Mat) return;

  const dictName = document.getElementById('chDict').value;
  const cols = parseInt(document.getElementById('chCols').value);
  const rows = parseInt(document.getElementById('chRows').value);
  const sqMm = parseFloat(document.getElementById('chSqSize').value);
  const mkMm = parseFloat(document.getElementById('chMkSize').value);

  if (mkMm >= sqMm) return;

  const sqPx = (sqMm / 25.4) * dpi;
  const mkPx = (mkMm / 25.4) * dpi;

  let dict = null;
  let board = null;
  let boardImg = null;

  try {
    dict = CV_UTILS.getDict(dictName);
    board = CV_UTILS.createCharucoBoard(cols, rows, sqPx, mkPx, dict);
    boardImg = new cv.Mat();
    const renderSize = new cv.Size(Math.round(cols * sqPx), Math.round(rows * sqPx));
    CV_UTILS.drawCharucoBoard(board, renderSize, boardImg);
    matToCanvas(boardImg, 'canvasCharuco');
  } catch (err) {
    console.error("ChArUco Generation Error:", err);
  } finally {
    if (boardImg) boardImg.delete();
    if (board && board.delete) board.delete();
    if (dict && dict.delete) dict.delete();
  }
}