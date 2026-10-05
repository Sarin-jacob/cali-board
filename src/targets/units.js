// Physical units. Everything is stored in millimetres internally.
export const UNITS = {
  mm: { label: 'mm', name: 'millimetres', perMm: 1, step: 0.5, digits: 1 },
  cm: { label: 'cm', name: 'centimetres', perMm: 0.1, step: 0.05, digits: 2 },
  in: { label: 'in', name: 'inches', perMm: 1 / 25.4, step: 0.01, digits: 3 },
};

export const toMm = (value, unit) => Number(value) / UNITS[unit].perMm;
export const fromMm = (mm, unit) => mm * UNITS[unit].perMm;

export function formatLength(mm, unit = 'mm', digits) {
  const u = UNITS[unit];
  const v = fromMm(mm, unit);
  const d = digits ?? u.digits;
  return `${Number(v.toFixed(d))} ${u.label}`;
}

// Paper sizes in millimetres (portrait).
export const PAPER = {
  a4: { label: 'A4', w: 210, h: 297 },
  a3: { label: 'A3', w: 297, h: 420 },
  a2: { label: 'A2', w: 420, h: 594 },
  a1: { label: 'A1', w: 594, h: 841 },
  a0: { label: 'A0', w: 841, h: 1189 },
  letter: { label: 'US Letter', w: 215.9, h: 279.4 },
  legal: { label: 'US Legal', w: 215.9, h: 355.6 },
  tabloid: { label: 'Tabloid / Ledger', w: 279.4, h: 431.8 },
};
