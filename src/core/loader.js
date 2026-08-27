window.__cvSettled = false;

export function initOpenCV() {
  return new Promise((resolve, reject) => {
    const statusText = document.getElementById('loadingText');
    if (statusText) statusText.innerText = "Downloading WebAssembly Engine...";

    const script = document.createElement('script');
    script.src = './opencv4.13.js'; // Served statically from /public
    
    script.onload = async () => {
      if (statusText) statusText.innerText = "Initializing Memory Space...";
      
      try {
        if (typeof cv === 'function') window.cv = await cv();
        else if (typeof cv !== 'undefined' && cv instanceof Promise) window.cv = await cv;
        else if (typeof cv !== 'undefined' && cv.ready instanceof Promise) await cv.ready;

        if (typeof cv !== 'undefined' && cv.Mat && !window.__cvSettled) {
          window.__cvSettled = true;
          resolve(window.cv);
        } else {
          reject(new Error("cv.Mat undefined after engine load."));
        }
      } catch (err) {
        reject(err);
      }
    };

    script.onerror = () => reject(new Error("Failed to load ./opencv4.13.js static script."));
    document.head.appendChild(script);
  });
}