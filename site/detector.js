// Worker de détection de visages (CenterFace, le modèle utilisé par deface).
// Tout tourne localement dans le navigateur : aucune image ne sort de l'appareil.
import * as ort from './vendor/ort.wasm.min.mjs';

// Variante du moteur limitée à 1 Go de mémoire (Safari iOS refuse la réservation de 4 Go d'origine)
ort.env.wasm.wasmPaths = {
  mjs: new URL('./vendor/ort-wasm-1g.mjs', import.meta.url).href,
  wasm: new URL('./vendor/ort-wasm-simd-threaded.wasm', import.meta.url).href,
};
ort.env.logLevel = 'error';

let session = null;

async function load() {
  if (!session) {
    session = await ort.InferenceSession.create(new URL('./vendor/centerface.onnx', import.meta.url).href, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }
  return session;
}

// Détection « Maximale », image très sombre (luminosité moyenne sous DARK, sur 255) : le modèle voit mal dans le noir.
// On l'analyse une seconde fois éclaircie (v -> 255·√(v/255)) et on réunit les visages des deux passes :
// l'éclaircie révèle les visages noyés dans le noir, l'originale garde les tout petits que le bruit noie.
const DARK = 40;
const NIGHT = Float32Array.from({ length: 256 }, (_, v) => Math.floor(Math.sqrt(v / 255) * 255));

function brightness(rgba) {
  let sum = 0;
  for (let j = 0; j < rgba.length; j += 4) sum += rgba[j] + rgba[j + 1] + rgba[j + 2];
  return sum / (3 * (rgba.length / 4));
}

// Données RGBA (w×h, multiples de 32) -> boîtes [x1, y1, x2, y2, score] dans le repère w×h
async function detect(rgba, w, h, threshold, night) {
  if (!night || brightness(rgba) >= DARK) return nms(await pass(rgba, w, h, threshold, null), 0.3);
  const boxes = await pass(rgba, w, h, threshold, null);
  return nms(boxes.concat(await pass(rgba, w, h, threshold, NIGHT)), 0.3);
}

async function pass(rgba, w, h, threshold, lut) {
  const s = await load();
  const n = w * h;
  const input = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    input[i] = lut ? lut[rgba[j]] : rgba[j];
    input[n + i] = lut ? lut[rgba[j + 1]] : rgba[j + 1];
    input[2 * n + i] = lut ? lut[rgba[j + 2]] : rgba[j + 2];
  }
  const out = await s.run({ 'input.1': new ort.Tensor('float32', input, [1, 3, h, w]) });
  const heat = out['537'].data, scale = out['538'].data, offset = out['539'].data;
  const [, , fh, fw] = out['537'].dims;
  const plane = fh * fw;
  const boxes = [];
  for (let r = 0; r < fh; r++) {
    for (let c = 0; c < fw; c++) {
      const k = r * fw + c;
      const score = heat[k];
      if (score <= threshold) continue;
      const s0 = Math.exp(scale[k]) * 4, s1 = Math.exp(scale[plane + k]) * 4;
      const o0 = offset[k], o1 = offset[plane + k];
      const x1 = Math.min(Math.max(0, (c + o1 + 0.5) * 4 - s1 / 2), w);
      const y1 = Math.min(Math.max(0, (r + o0 + 0.5) * 4 - s0 / 2), h);
      boxes.push([x1, y1, Math.min(x1 + s1, w), Math.min(y1 + s0, h), score]);
    }
  }
  for (const t of Object.values(out)) t.dispose?.();
  return boxes;
}

function nms(boxes, thresh) {
  boxes.sort((a, b) => b[4] - a[4]);
  const keep = [];
  const dead = new Uint8Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    if (dead[i]) continue;
    const a = boxes[i];
    keep.push(a);
    const areaA = (a[2] - a[0]) * (a[3] - a[1]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (dead[j]) continue;
      const b = boxes[j];
      const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
      const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
      const inter = iw * ih;
      if (inter / (areaA + (b[2] - b[0]) * (b[3] - b[1]) - inter) >= thresh) dead[j] = 1;
    }
  }
  return keep;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') {
      // 1 seul thread sur iPhone : Safari refuse la mémoire partagée de grande taille
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, data.threads | 0) : 1;
      await load();
      self.postMessage({ id, ok: true });
    } else if (type === 'detect') {
      const boxes = await detect(new Uint8ClampedArray(data.buffer), data.w, data.h, data.threshold, data.night);
      self.postMessage({ id, ok: true, boxes });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
