// Loads public/opencv/opencv4.13.js (and optionally public/cv-core.js) in Node.
// package.json has "type": "module", so a plain require() would treat these classic/UMD
// scripts as ES modules; evaluating them through `vm` keeps their CommonJS/global semantics.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const CV_FILE = path.join(PUBLIC, 'opencv', 'opencv4.13.js');
const CORE_FILE = path.join(PUBLIC, 'cv-core.js');

let cvPromise = null;

function loadOpenCV() {
  if (cvPromise) return cvPromise;
  const code = fs.readFileSync(CV_FILE, 'utf8');
  const wrapper = vm.runInThisContext(`(function (module, exports, require, __filename, __dirname) {${code}\n})`, { filename: CV_FILE });
  const mod = { exports: {} };
  wrapper(mod, mod.exports, require, CV_FILE, path.dirname(CV_FILE));
  cvPromise = Promise.resolve(mod.exports);
  return cvPromise;
}

/** Resolves to the vision core (public/cv-core.js) bound to OpenCV. */
async function loadCore() {
  const cv = await loadOpenCV();
  if (!globalThis.createCvCore) vm.runInThisContext(fs.readFileSync(CORE_FILE, 'utf8'), { filename: CORE_FILE });
  return globalThis.createCvCore(cv);
}

module.exports = loadOpenCV;
module.exports.loadOpenCV = loadOpenCV;
module.exports.loadCore = loadCore;
