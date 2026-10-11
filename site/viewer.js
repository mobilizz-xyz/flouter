// Visionneuse plein écran : affiche un fichier (it.open le dessine) avec ses actions.
import { $ } from './dom.js';
import { download, shareOrDownload } from './save.js';

let onClose = null;

// Écran personnalisé dans la visionneuse (éditeur de zones…) : leaveScreen() ferme l'écran affiché,
// setViewerClose(fn) indique quoi faire quand on quittera le nouveau.
export function leaveScreen() {
  onClose?.();
  onClose = null;
}

export function setViewerClose(fn) { onClose = fn; }

export function openViewer(it) {
  $('#v-title').textContent = it.title;
  $('#v-media').textContent = '';
  $('#v-hint').textContent = '';
  $('#v-actions').innerHTML = '<button class="btn primary" data-a="save">Enregistrer / Partager</button><button class="btn" data-a="dl">Télécharger</button>';
  $('#v-actions [data-a=save]').onclick = async () => shareOrDownload(await it.export(), it.name);
  $('#v-actions [data-a=dl]').onclick = async () => download(await it.export(), it.name);
  onClose = it.open($('#v-media'), $('#v-status'), $('#v-hint'), $('#v-actions'));
  $('#viewer').hidden = false;
  document.body.classList.add('noscroll');
}

export function closeViewer() {
  onClose?.();
  onClose = null;
  $('#viewer').hidden = true;
  $('#v-media').textContent = '';
  document.body.classList.remove('noscroll');
}

$('#v-close').onclick = closeViewer;
