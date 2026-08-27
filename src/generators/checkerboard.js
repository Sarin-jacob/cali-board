export function drawCheckerboard(dpi = 300) {
  const cols = parseInt(document.getElementById('cbCols').value);
  const rows = parseInt(document.getElementById('cbRows').value);
  const mm = parseFloat(document.getElementById('cbSize').value);
  
  // Calculate size in pixels based on target DPI
  const sizePx = Math.round((mm / 25.4) * dpi);

  const canvas = document.getElementById('canvasCheckerboard');
  canvas.width = cols * sizePx;
  canvas.height = rows * sizePx;
  
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 2 !== 0) {
        ctx.fillRect(c * sizePx, r * sizePx, sizePx, sizePx);
      }
    }
  }
}