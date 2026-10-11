// Moteur de détection de visages : un worker (detector.js) fait tourner le modèle hors du fil principal.
import { $, sleep } from './dom.js';
import { IS_IOS } from './device.js';

let worker;
let nextId = 0;
const pending = new Map();
function startWorker() {
  worker = new Worker(new URL('./detector.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    data.ok ? p.resolve(data) : p.reject(new Error(data.error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'moteur arrêté'));
    pending.clear();
  };
}

function call(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}

function setModelStatus(state, text) {
  const el = $('#model-status');
  el.dataset.state = state;
  el.textContent = text;
}

async function loadModel() {
  const threads = IS_IOS ? 1 : Math.min(4, navigator.hardwareConcurrency || 1);
  startWorker();
  try {
    await call({ type: 'load', threads });
  } catch (e) {
    if (threads === 1) throw e;
    // Mémoire insuffisante en multi-thread : on relance en mode simple
    worker.terminate();
    startWorker();
    await call({ type: 'load', threads: 1 });
  }
}

// Fichiers indispensables hors connexion : on ne l'annonce qu'une fois tous en cache
const OFFLINE_FILES = ['./', './detector.js', './vendor/ort-wasm-1g.mjs', './vendor/ort-wasm-simd-threaded.wasm', './vendor/centerface.onnx'];
async function announceOffline() {
  if (!('serviceWorker' in navigator) || !('caches' in window)) return;
  try {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 150; i++) {
      const hits = await Promise.all(OFFLINE_FILES.map((f) => caches.match(new URL(f, location.href).href, { ignoreSearch: true })));
      if (hits.every(Boolean)) return setModelStatus('ready', 'Prêt — fonctionne aussi hors connexion');
      await sleep(2000);
    }
  } catch { /* cache indisponible (navigation privée) : on reste sur « Prêt » */ }
}
export const modelReady = loadModel()
  .then(() => { setModelStatus('ready', 'Prêt'); announceOffline(); })
  .catch((e) => { setModelStatus('error', 'Impossible de charger le moteur : ' + e.message + '. Ferme les autres onglets et recharge la page.'); throw e; });

// ---------- Détection ----------
const detCanvas = document.createElement('canvas');
const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });

// source : image/vidéo/canvas de taille sw×sh. Renvoie des boîtes dans le repère source.
// night : seconde passe éclaircie sur les images très sombres (détection « Maximale »).
export async function detectFaces(source, sw, sh, maxSide, threshold, night = false) {
  const r = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(32, Math.ceil((sw * r) / 32) * 32);
  const h = Math.max(32, Math.ceil((sh * r) / 32) * 32);
  if (detCanvas.width !== w || detCanvas.height !== h) { detCanvas.width = w; detCanvas.height = h; }
  detCtx.drawImage(source, 0, 0, w, h);
  const { data } = detCtx.getImageData(0, 0, w, h);
  const { boxes } = await call({ type: 'detect', buffer: data.buffer, w, h, threshold, night }, [data.buffer]);
  const sx = sw / w, sy = sh / h;
  return boxes.map(([x1, y1, x2, y2]) => ({ x: x1 * sx, y: y1 * sy, w: (x2 - x1) * sx, h: (y2 - y1) * sy }));
}
