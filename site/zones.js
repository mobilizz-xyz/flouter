// Zones manuelles (vidéo) : masquer un élément que la détection ne voit pas (tatouage, banderole…).
import { $, el } from './dom.js';
import { closeViewer, leaveScreen, openViewer, setViewerClose } from './viewer.js';
import { zoneAt } from './zone-path.js';

// On pose une zone sur l'élément, puis on la repositionne plus loin dans la vidéo :
// entre deux positions elle glisse toute seule, ce qui suit un tatouage ou une banderole qui bouge.
export function openZoneEditor(it, onApply) {
  leaveScreen();
  const media = $('#v-media'), status = $('#v-status'), hint = $('#v-hint'), actions = $('#v-actions');
  $('#v-title').textContent = it.title + ' — zones manuelles';
  media.textContent = '';
  const zones = JSON.parse(JSON.stringify(it.manual));
  let sel = zones.length ? zones.length - 1 : -1, adding = !zones.length;

  const wrap = el('<div class="zed"><video playsinline muted preload="auto"></video><canvas></canvas></div>');
  media.appendChild(wrap);
  const v = wrap.querySelector('video'), cv = wrap.querySelector('canvas');
  const srcUrl = URL.createObjectURL(it.file);
  v.src = srcUrl;
  const ctl = el(`<div class="zed-ctl">
      <button class="btn small" data-a="play">▶︎</button>
      <input type="range" min="0" max="1" step="0.01" value="0" aria-label="Position dans la vidéo">
      <span class="zed-time">0:00</span>
    </div>`);
  media.after(ctl);
  const seek = ctl.querySelector('input'), timeEl = ctl.querySelector('.zed-time'), playBtn = ctl.querySelector('[data-a=play]');
  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  hint.innerHTML = '1. Mets la vidéo au moment où l\'élément apparaît. 2. <b>Nouvelle zone</b>, puis touche l\'élément ou encadre-le. ' +
    '3. Avance un peu et touche (ou encadre) l\'endroit où il est maintenant : la zone le suit entre les positions. 4. <b>Fin ici</b> quand il disparaît.';
  actions.innerHTML = `<button class="btn" data-a="new">＋ Nouvelle zone</button>
    <button class="btn" data-a="end">Fin ici</button>
    <button class="btn danger" data-a="del">Supprimer la zone</button>
    <button class="btn primary" data-a="apply">Appliquer et relancer le floutage</button>
    <button class="btn" data-a="cancel">Annuler</button>`;
  const A = (a) => actions.querySelector(`[data-a=${a}]`);

  v.addEventListener('loadedmetadata', () => {
    seek.max = v.duration || 1;
    const ar = v.videoWidth / v.videoHeight;
    wrap.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
    wrap.style.width = `min(100%, calc(60vh * ${ar}))`; // l'image remplit exactement le cadre : les zones tombent juste
    render();
  });
  // iOS n'affiche pas d'image tant que la lecture n'a pas démarré
  v.play().then(() => v.pause()).catch(() => {});

  const T = () => v.currentTime || 0;
  function render() {
    const r = cv.getBoundingClientRect();
    if (cv.width !== Math.round(r.width) || cv.height !== Math.round(r.height)) { cv.width = Math.round(r.width); cv.height = Math.round(r.height); }
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    zones.forEach((z, i) => {
      const p = zoneAt(z, T());
      if (!p) return;
      c.fillStyle = i === sel ? 'rgba(250,204,21,.35)' : 'rgba(34,211,238,.25)';
      c.strokeStyle = i === sel ? '#facc15' : '#22d3ee';
      c.lineWidth = i === sel ? 3 : 2;
      c.fillRect(p.x * cv.width, p.y * cv.height, p.w * cv.width, p.h * cv.height);
      c.strokeRect(p.x * cv.width, p.y * cv.height, p.w * cv.width, p.h * cv.height);
    });
    seek.value = T();
    timeEl.textContent = fmt(T());
    const z = zones[sel];
    status.className = 'card-status';
    status.textContent = adding ? 'Touche ou encadre l\'élément à masquer.'
      : z ? `Zone ${sel + 1} sur ${zones.length} : ${z.keys.length} position${z.keys.length > 1 ? 's' : ''}, de ${fmt(z.keys[0].t)} à ${z.end != null ? fmt(z.end) : 'la fin'}.`
      : zones.length ? `${zones.length} zone(s). Touche une zone pour la choisir.` : 'Aucune zone.';
    A('end').disabled = A('del').disabled = !z || adding;
    A('new').classList.toggle('on', adding);
  }
  let raf = 0;
  const loop = () => { render(); if (!v.paused) raf = requestAnimationFrame(loop); };
  v.addEventListener('play', () => { playBtn.textContent = '❚❚'; loop(); });
  v.addEventListener('pause', () => { playBtn.textContent = '▶︎'; render(); });
  v.addEventListener('seeked', render);
  playBtn.onclick = () => (v.paused ? v.play() : v.pause());
  seek.oninput = () => { v.currentTime = +seek.value; };

  // Toucher / encadrer sur l'image
  const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  let start = null;
  cv.addEventListener('pointerdown', (e) => { e.preventDefault(); v.pause(); start = pt(e); cv.setPointerCapture(e.pointerId); });
  // Cadre en pointillés pendant qu'on glisse
  cv.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = pt(e);
    if (Math.abs(p.x - start.x) <= 0.02 && Math.abs(p.y - start.y) <= 0.02) return;
    render();
    const c = cv.getContext('2d');
    c.setLineDash([8, 6]);
    c.strokeStyle = '#facc15'; c.lineWidth = 2; c.fillStyle = 'rgba(250,204,21,.25)';
    const x = Math.min(start.x, p.x) * cv.width, y = Math.min(start.y, p.y) * cv.height;
    const w = Math.abs(p.x - start.x) * cv.width, h = Math.abs(p.y - start.y) * cv.height;
    c.fillRect(x, y, w, h); c.strokeRect(x, y, w, h);
    c.setLineDash([]);
  });
  cv.addEventListener('pointerup', (e) => {
    if (!start) return;
    const end = pt(e), t = T();
    const dragged = Math.abs(end.x - start.x) > 0.02 || Math.abs(end.y - start.y) > 0.02;
    const aspect = (v.videoWidth || 16) / (v.videoHeight || 9);
    let box;
    if (dragged) box = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    if (adding) {
      if (!box) { const w = 0.15, h = 0.15 * aspect; box = { x: start.x - w / 2, y: start.y - h / 2, w, h }; }
      zones.push({ keys: [{ t, ...box }], end: null });
      sel = zones.length - 1; adding = false;
    } else {
      // Toucher une autre zone visible : la sélectionner
      const inside = (p) => p && start.x >= p.x && start.x <= p.x + p.w && start.y >= p.y && start.y <= p.y + p.h;
      const hit = dragged ? -1 : zones.findIndex((z, i) => i !== sel && inside(zoneAt(z, t)));
      if (hit >= 0) sel = hit;
      else if (zones[sel]) {
        // Nouvelle position de la zone choisie à cet instant
        const z = zones[sel];
        const cur = zoneAt(z, t) || z.keys[z.keys.length - 1];
        if (!box) box = { x: start.x - cur.w / 2, y: start.y - cur.h / 2, w: cur.w, h: cur.h };
        z.keys = z.keys.filter((k) => Math.abs(k.t - t) > 0.1);
        z.keys.push({ t, ...box });
        z.keys.sort((a, b) => a.t - b.t);
        if (z.end != null && z.end < t) z.end = null;
      }
    }
    start = null;
    render();
  });

  A('new').onclick = () => { adding = !adding; render(); };
  A('end').onclick = () => { const z = zones[sel]; if (z) { z.end = Math.max(z.keys[0].t, T()); render(); } };
  A('del').onclick = () => { if (zones[sel]) { zones.splice(sel, 1); sel = zones.length - 1; render(); } };
  const resize = new ResizeObserver(render);
  resize.observe(wrap);
  const close = () => { cancelAnimationFrame(raf); resize.disconnect(); v.pause(); URL.revokeObjectURL(srcUrl); ctl.remove(); };
  A('cancel').onclick = () => { close(); closeViewer(); openViewer(it); };
  A('apply').onclick = () => {
    close();
    it.manual = zones.filter((z) => z.keys.length);
    closeViewer();
    onApply();
  };
  setViewerClose(close);
}
