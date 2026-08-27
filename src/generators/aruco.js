import { CV_UTILS, matToCanvas } from '../core/utils.js';

export function drawAruco(dpi = 300) {
  if (typeof cv === 'undefined' || !cv.Mat) return;
  
  const dictName = document.getElementById('arDict').value;
  const id = parseInt(document.getElementById('arId').value);
  const mm = parseFloat(document.getElementById('arSize').value);
  const sizePx = Math.round((mm / 25.4) * dpi);

  let dict = null;
  let markerImg = null;

  try {
    dict = CV_UTILS.getDict(dictName);
    markerImg = new cv.Mat();
    CV_UTILS.drawMarker(dict, id, sizePx, markerImg);
    matToCanvas(markerImg, 'canvasAruco');
  } catch (err) {
    console.error("ArUco Generation Error:", err);
  } finally {
    if (markerImg) markerImg.delete();
    if (dict && dict.delete) dict.delete();
  }
}