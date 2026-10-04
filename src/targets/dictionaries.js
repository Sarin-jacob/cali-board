// ArUco / AprilTag dictionary catalogue.
// Bit patterns come from dictionaries.data.js (extracted from OpenCV by scripts/extract-dictionaries.cjs)
// and are lazy-loaded, so nothing here needs the WebAssembly engine.

export const DICTIONARY_GROUPS = [
  { label: 'ArUco 4×4', names: ['DICT_4X4_50', 'DICT_4X4_100', 'DICT_4X4_250', 'DICT_4X4_1000'] },
  { label: 'ArUco 5×5', names: ['DICT_5X5_50', 'DICT_5X5_100', 'DICT_5X5_250', 'DICT_5X5_1000'] },
  { label: 'ArUco 6×6', names: ['DICT_6X6_50', 'DICT_6X6_100', 'DICT_6X6_250', 'DICT_6X6_1000'] },
  { label: 'ArUco 7×7', names: ['DICT_7X7_50', 'DICT_7X7_100', 'DICT_7X7_250', 'DICT_7X7_1000'] },
  { label: 'AprilTag', names: ['DICT_APRILTAG_16h5', 'DICT_APRILTAG_25h9', 'DICT_APRILTAG_36h10', 'DICT_APRILTAG_36h11'] },
  { label: 'Other', names: ['DICT_ARUCO_ORIGINAL', 'DICT_ARUCO_MIP_36h12'] },
];

// Static facts so the UI can validate targets before the JSON has loaded.
const SIZES = {
  DICT_4X4_50: [4, 50], DICT_4X4_100: [4, 100], DICT_4X4_250: [4, 250], DICT_4X4_1000: [4, 1000],
  DICT_5X5_50: [5, 50], DICT_5X5_100: [5, 100], DICT_5X5_250: [5, 250], DICT_5X5_1000: [5, 1000],
  DICT_6X6_50: [6, 50], DICT_6X6_100: [6, 100], DICT_6X6_250: [6, 250], DICT_6X6_1000: [6, 1000],
  DICT_7X7_50: [7, 50], DICT_7X7_100: [7, 100], DICT_7X7_250: [7, 250], DICT_7X7_1000: [7, 1000],
  DICT_ARUCO_ORIGINAL: [5, 1024], DICT_ARUCO_MIP_36h12: [6, 250],
  DICT_APRILTAG_16h5: [4, 30], DICT_APRILTAG_25h9: [5, 35], DICT_APRILTAG_36h10: [6, 2320], DICT_APRILTAG_36h11: [6, 587],
};

export function dictionaryInfo(name) {
  const s = SIZES[name];
  if (!s) throw new Error(`Unknown dictionary ${name}`);
  return { name, markerSize: s[0], count: s[1] };
}

export function dictionaryLabel(name) {
  const { markerSize, count } = dictionaryInfo(name);
  const short = name.replace(/^DICT_/, '');
  return `${short} (${markerSize}×${markerSize} bits, ${count} ids)`;
}

let tablePromise = null;
const decoded = new Map(); // family -> Uint8Array of bits (1 = white)

function loadTable() {
  tablePromise ??= import('./dictionaries.data.js').then((m) => m.default);
  return tablePromise;
}

/** Preload the bit table (call early; it is ~46 KB). */
export function preloadDictionaries() { return loadTable(); }

/**
 * Returns the inner bits of marker `id` as a Uint8Array of markerSize² values,
 * row-major, 1 = white cell, 0 = black cell (the black border is not included).
 */
export async function markerBits(name, id) {
  const table = await loadTable();
  const meta = table.dictionaries[name];
  if (!meta) throw new Error(`Unknown dictionary ${name}`);
  if (!(id >= 0 && id < meta.count)) throw new Error(`Marker id ${id} is outside ${name} (0–${meta.count - 1})`);
  let bits = decoded.get(meta.family);
  if (!bits) {
    const fam = table.families[meta.family];
    const bin = atob(fam.bits);
    bits = new Uint8Array(fam.count * fam.markerSize * fam.markerSize);
    for (let i = 0; i < bits.length; i++) bits[i] = (bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
    decoded.set(meta.family, bits);
  }
  const n = meta.markerSize * meta.markerSize;
  return bits.subarray(id * n, id * n + n);
}
