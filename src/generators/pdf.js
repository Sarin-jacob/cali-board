import { jsPDF } from 'jspdf';

export function exportTiledPdf(canvasId, filename, marginInches = 0.25, format = 'a4', orientation = 'p', dpi = 300) {
  const canvas = document.getElementById(canvasId);
  const pdf = new jsPDF({ orientation, unit: 'in', format });
  
  const pageSize = pdf.internal.pageSize;
  const pageW = pageSize.getWidth();
  const pageH = pageSize.getHeight();

  const printW = pageW - (marginInches * 2);
  const printH = pageH - (marginInches * 2);

  if (printW <= 0 || printH <= 0) throw new Error("Margin exceeds printable area.");

  const tileW_px = Math.round(printW * dpi);
  const tileH_px = Math.round(printH * dpi);
  const cols = Math.ceil(canvas.width / tileW_px);
  const rows = Math.ceil(canvas.height / tileH_px);

  let isFirstPage = true;
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isFirstPage) pdf.addPage(format, orientation);
      isFirstPage = false;

      const sourceX = c * tileW_px;
      const sourceY = r * tileH_px;
      const sWidth = Math.min(tileW_px, canvas.width - sourceX);
      const sHeight = Math.min(tileH_px, canvas.height - sourceY);

      if (sWidth <= 0 || sHeight <= 0) continue;

      tempCanvas.width = sWidth;
      tempCanvas.height = sHeight;
      tempCtx.fillStyle = '#ffffff';
      tempCtx.fillRect(0, 0, sWidth, sHeight);
      tempCtx.drawImage(canvas, sourceX, sourceY, sWidth, sHeight, 0, 0, sWidth, sHeight);

      const tileData = tempCanvas.toDataURL('image/png', 1.0);
      pdf.addImage(tileData, 'PNG', marginInches, marginInches, sWidth / dpi, sHeight / dpi);
    }
  }

  pdf.save(`${filename}.pdf`);
}