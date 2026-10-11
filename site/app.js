// Flouter : floutage de visages sur photos et vidéos, entièrement dans le navigateur.
// Les fichiers ne quittent jamais l'appareil (sauf mode secours, avec accord explicite : voir fallback.js).
import { $ } from './dom.js';
import { busy } from './list.js';
import { processImage } from './photo.js';
import { processVideo } from './video.js';

// Les photos passent tout de suite ; les vidéos une par une (mémoire et puce vidéo limitées).
let videoTurn = Promise.resolve();
function handleFiles(files) {
  for (const f of files) {
    const isVideo = f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|3gp)$/i.test(f.name);
    if (isVideo) videoTurn = processVideo(f, videoTurn).catch((e) => console.error(e));
    else processImage(f).catch((e) => console.error(e));
  }
  $('#queue').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const input = $('#file');
input.addEventListener('change', () => { handleFiles([...input.files]); input.value = ''; });
const drop = $('#drop');
for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const t of ['dragleave', 'drop']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));

// Hors connexion : le site est mis en cache dès la première visite (sw.js)
if ('serviceWorker' in navigator) {
  // Nouvelle version installée : on recharge pour l'utiliser, mais jamais pendant un traitement
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded && !busy()) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => { /* hors connexion */ });
}
