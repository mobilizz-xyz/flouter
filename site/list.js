// Liste des fichiers : une ligne par fichier (vignette, état, Voir / Enregistrer) et la barre
// « Tout enregistrer » en bas de l'écran.
import { $, el, randName } from './dom.js';
import { openViewer } from './viewer.js';
import { openReport } from './report.js';
import { download, share, shareOrDownload } from './save.js';
import { zip } from './zip.js';

const items = [];
let counter = { photo: 0, video: 0 };

// Une vidéo ou une photo est-elle encore en cours ?
export const busy = () => items.some((i) => i.state === 'work');

export function addItem(kind) {
  const n = ++counter[kind];
  const it = { kind, title: kind === 'photo' ? `Photo ${n}` : `Vidéo ${n}`, state: 'work', name: randName(kind === 'photo' ? 'jpg' : 'mp4') };
  it.li = el(`<li class="item">
      <div class="thumb"></div>
      <div class="meta"><b class="title"></b><span class="sub">En attente…</span><progress max="1" value="0" hidden></progress></div>
      <div class="acts"></div>
    </li>`);
  it.li.querySelector('.title').textContent = it.title;
  showActions(it, false);
  $('#items').appendChild(it.li);
  $('#queue').hidden = false;
  items.push(it);
  updateBulk();
  return it;
}

// Boutons Voir / Enregistrer de la ligne
export function showActions(it, enabled = true) {
  const acts = it.li.querySelector('.acts');
  acts.innerHTML = '<button class="btn small" data-a="view">Voir</button><button class="btn small primary" data-a="save" aria-label="Enregistrer">⤓</button>';
  for (const b of acts.children) b.disabled = !enabled;
  acts.querySelector('[data-a=view]').onclick = () => openViewer(it);
  acts.querySelector('[data-a=save]').onclick = async () => shareOrDownload(await it.export(), it.name);
}

export function setSub(it, text, cls) {
  const s = it.li.querySelector('.sub');
  s.textContent = text;
  s.className = 'sub' + (cls ? ' ' + cls : '');
}

export function setThumb(it, node) {
  const t = it.li.querySelector('.thumb');
  t.textContent = '';
  t.appendChild(node);
}

export function setReady(it) {
  it.state = 'done';
  showActions(it);
  it.li.querySelector('progress').hidden = true;
  updateBulk();
}

export function setError(it, text) {
  it.state = 'err';
  setSub(it, text, 'err');
  it.li.querySelector('progress').hidden = true;
  const acts = it.li.querySelector('.acts');
  acts.innerHTML = '<button class="btn small" data-a="report">Signaler</button>';
  acts.querySelector('[data-a=report]').onclick = () => openReport(it, text);
  updateBulk();
}

// Annulée à la demande de la personne : rien à signaler
export function setCancelled(it) {
  setError(it, 'Annulée.');
  it.li.querySelector('.acts').textContent = '';
}

export function updateBulk() {
  const done = items.filter((i) => i.state === 'done').length;
  const work = items.filter((i) => i.state === 'work').length;
  $('#bulk').hidden = !items.length;
  document.body.classList.toggle('has-bulk', items.length > 0);
  $('#bulk-info').textContent = `${done} prêt${done > 1 ? 's' : ''}` + (work ? ` · ${work} en cours` : '');
  $('#stay').hidden = !items.some((i) => i.state === 'work' && i.kind === 'video');
  $('#save-all').disabled = !done;
  $('#save-all').textContent = done > 1 ? `Tout enregistrer (${done})` : 'Enregistrer';
}

// Tout enregistrer : partage groupé si le téléphone le permet, sinon une archive .zip
$('#save-all').onclick = async () => {
  const ready = items.filter((i) => i.state === 'done');
  const files = await Promise.all(ready.map(async (i) => {
    const blob = await i.export();
    return new File([blob], i.name, { type: blob.type });
  }));
  if (!(await share(files))) {
    if (files.length === 1) await download(files[0], files[0].name);
    else await download(await zip(files), randName('zip'));
  }
};

$('#clear-all').onclick = () => {
  if (busy() && !confirm('Des fichiers sont encore en cours. Tout arrêter et vider la liste ?')) return;
  for (const i of items) { i.cancel?.(); i.dispose?.(); }
  items.length = 0;
  counter = { photo: 0, video: 0 };
  $('#items').textContent = '';
  $('#queue').hidden = true;
  updateBulk();
};
