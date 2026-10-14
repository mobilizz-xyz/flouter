// Photos : détection, floutage, retouche à la main (toucher un visage oublié, enlever un flou).
// L'image est ré-encodée depuis un canvas : aucune métadonnée (GPS, appareil, date) n'est conservée.
import { $, el } from './dom.js';
import { IS_MOBILE } from './device.js';
import { modelReady, detectFaces } from './engine.js';
import { MASK_SCALE, anonymize, grow } from './anonymize.js';
import { settings, onSettingsChange } from './settings.js';
import { addItem, setError, setReady, setSub, setThumb } from './list.js';

const MAX_SIDE = 4096; // limite la mémoire utilisée sur téléphone

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function thumbOf(src, W, H) {
  const c = document.createElement('canvas');
  const r = 112 / Math.max(W, H);
  c.width = Math.max(1, Math.round(W * r));
  c.height = Math.max(1, Math.round(H * r));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

export async function processImage(file) {
  const it = addItem('photo');
  setSub(it, 'Analyse…');
  let img;
  try {
    img = await loadImage(file);
  } catch {
    return setError(it, "Format d'image non lisible (essaie JPEG ou PNG).");
  }

  const r = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * r), H = Math.round(img.naturalHeight * r);
  const base = document.createElement('canvas');
  base.width = W; base.height = H;
  base.getContext('2d').drawImage(img, 0, 0, W, H);

  await modelReady;
  const s = settings();
  // Détection plus fine en haute sensibilité, et sur ordinateur (plus de mémoire)
  const detSide = IS_MOBILE ? (s.high ? 1600 : 1024) : (s.high ? 2400 : 1600);
  const zones = (await detectFaces(base, W, H, detSide, s.threshold, s.high)).map((z) => ({ ...z, auto: true }));

  const flat = () => {
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(base, 0, 0);
    anonymize(ctx, zones, settings().mode);
    return out;
  };
  it.export = () => new Promise((res) => flat().toBlob(res, 'image/jpeg', 0.92));
  const refresh = () => {
    setThumb(it, thumbOf(flat(), W, H));
    if (zones.length) setSub(it, `${plural(zones.length, 'visage')} flouté${zones.length > 1 ? 's' : ''} — vérifie`);
    else setSub(it, 'Aucun visage détecté — vérifie', 'warn');
  };
  refresh();
  it.dispose = onSettingsChange(refresh);
  it.open = (media, status, hint, actions) => openEditor(base, zones, media, status, hint, actions, refresh);
  setReady(it);
}

// Retouche : toucher un visage pour le flouter, toucher un flou pour l'enlever, glisser pour encadrer,
// tirer un coin pour agrandir ou réduire, glisser un flou pour le déplacer.
function openEditor(base, zones, media, status, hint, actions, refresh) {
  const W = base.width, H = base.height;
  const view = document.createElement('canvas');
  view.width = W; view.height = H;
  view.className = 'editable';
  media.appendChild(view);
  const ctx = view.getContext('2d');
  const touch = matchMedia('(pointer: coarse)').matches;
  let outlines = true;

  const shown = (z0) => grow(z0, MASK_SCALE);
  // Pixels de l'image par pixel d'écran
  const scr = () => W / Math.max(1, view.getBoundingClientRect().width);
  const drawBoxes = (list) => {
    const lw = Math.max(2, 2 * scr()), hs = Math.max(lw * 3, (touch ? 12 : 9) * scr());
    ctx.lineWidth = lw;
    for (const z0 of list) {
      const z = shown(z0);
      ctx.strokeStyle = ctx.fillStyle = z0.auto ? '#22d3ee' : '#facc15';
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      for (const [cx, cy] of CORNERS) ctx.fillRect(z.x + cx * z.w - hs / 2, z.y + cy * z.h - hs / 2, hs, hs);
    }
  };
  const render = () => {
    ctx.drawImage(base, 0, 0);
    anonymize(ctx, zones, settings().mode);
    if (outlines) drawBoxes(zones);
    const n = zones.length;
    status.textContent = n ? `${plural(n, 'flou')}. Un visage oublié ? ${touch ? 'Touche-le' : 'Clique dessus'}.`
      : `Aucun visage trouvé. ${touch ? 'Touche' : 'Clique sur'} chaque visage pour le flouter.`;
    status.className = 'card-status' + (n ? '' : ' warn');
  };
  hint.innerHTML = touch
    ? "Touche un visage pour le <b>flouter</b>, touche un flou pour l'<b>enlever</b>. Glisse le doigt pour <b>encadrer</b> un objet (pancarte, tatouage). " +
      "Tire le coin d'un flou pour l'<b>agrandir</b>, glisse-le pour le <b>déplacer</b>. Écarte deux doigts pour zoomer."
    : "Clique sur un visage pour le <b>flouter</b>, clique sur un flou pour l'<b>enlever</b>. Clique et glisse pour <b>encadrer</b> un objet (pancarte, tatouage). " +
      "Tire le coin d'un flou pour l'<b>agrandir</b>, fais-le glisser pour le <b>déplacer</b>.";
  const ob = el('<button class="btn">Masquer les contours</button>');
  ob.onclick = () => {
    outlines = !outlines;
    ob.textContent = outlines ? 'Masquer les contours' : 'Afficher les contours';
    render();
  };
  actions.appendChild(ob);

  const toImg = (e) => {
    const b = view.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * W, y: ((e.clientY - b.top) / b.height) * H };
  };
  const inside = (p, z) => p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;
  const hitZone = (p) => { for (let i = zones.length - 1; i >= 0; i--) if (inside(p, shown(zones[i]))) return i; return -1; };
  const hitCorner = (p) => {
    const tol = (touch ? 22 : 10) * scr();
    for (let i = zones.length - 1; i >= 0; i--) {
      const z = shown(zones[i]);
      for (const [cx, cy] of CORNERS) {
        if (Math.abs(p.x - (z.x + cx * z.w)) <= tol && Math.abs(p.y - (z.y + cy * z.h)) <= tol) return { i, cx, cy };
      }
    }
    return null;
  };
  // Cadre affiché → zone stockée (le rendu agrandit les zones de MASK_SCALE autour du centre)
  const store = (z0, b) => {
    const w = b.w / MASK_SCALE, h = b.h / MASK_SCALE;
    Object.assign(z0, { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h, auto: false });
  };
  const rect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
  const tap = (p) => {
    const hit = hitZone(p);
    if (hit >= 0) return zones.splice(hit, 1);
    // Nouveau visage : taille médiane des visages déjà trouvés
    const sizes = zones.map((z) => z.w).sort((a, b) => a - b);
    const size = sizes.length ? sizes[sizes.length >> 1] : Math.min(W, H) * 0.12;
    zones.push({ x: p.x - size / 2, y: p.y - size * 0.6, w: size, h: size * 1.2, auto: false });
  };

  // Un doigt : toucher, encadrer, déplacer ou redimensionner. Deux doigts : zoom du navigateur, on ne touche à rien.
  let drag = null;
  const fingers = new Set();
  const cancel = () => { if (drag?.moved) render(); drag = null; };
  // Pendant le geste : l'image sans la zone tenue, puis son nouveau cadre en pointillés
  const preview = (box) => {
    if (!drag.cache) {
      const others = drag.i == null ? zones : zones.filter((_, j) => j !== drag.i);
      ctx.drawImage(base, 0, 0);
      anonymize(ctx, others, settings().mode);
      if (outlines) drawBoxes(others);
      drag.cache = document.createElement('canvas');
      drag.cache.width = W; drag.cache.height = H;
      drag.cache.getContext('2d').drawImage(view, 0, 0);
    }
    ctx.drawImage(drag.cache, 0, 0);
    const lw = Math.max(2, 2 * scr());
    ctx.fillStyle = 'rgba(250, 204, 21, .25)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.lineWidth = lw;
    ctx.setLineDash([lw * 4, lw * 3]);
    ctx.strokeStyle = '#facc15';
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
  };
  const boxOf = (p) => {
    const { kind, start, box0 } = drag;
    if (kind === 'move') return { ...box0, x: box0.x + p.x - start.x, y: box0.y + p.y - start.y };
    if (kind === 'resize') {
      const o = { x: box0.x + (1 - drag.cx) * box0.w, y: box0.y + (1 - drag.cy) * box0.h };
      return rect(o, p);
    }
    return rect(start, p);
  };
  const cursorAt = (p) => {
    const c = hitCorner(p);
    if (c) return c.cx === c.cy ? 'nwse-resize' : 'nesw-resize';
    return hitZone(p) >= 0 ? 'move' : 'crosshair';
  };

  view.addEventListener('pointerdown', (e) => {
    fingers.add(e.pointerId);
    if (fingers.size > 1) return cancel();
    const p = toImg(e);
    const c = hitCorner(p), hit = c ? c.i : hitZone(p);
    drag = { start: p, moved: false, kind: c ? 'resize' : hit >= 0 ? 'move' : 'new', i: hit >= 0 ? hit : null };
    if (c) Object.assign(drag, { cx: c.cx, cy: c.cy });
    if (hit >= 0) drag.box0 = shown(zones[hit]);
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', (e) => {
    const p = toImg(e);
    if (!drag) { if (e.pointerType === 'mouse') view.style.cursor = cursorAt(p); return; }
    const min = 12 * scr(); // 12 pixels à l'écran
    if (!drag.moved && Math.abs(p.x - drag.start.x) < min && Math.abs(p.y - drag.start.y) < min) return;
    drag.moved = true;
    preview(boxOf(p));
  });
  view.addEventListener('pointercancel', (e) => { fingers.delete(e.pointerId); cancel(); });
  view.addEventListener('pointerup', (e) => {
    fingers.delete(e.pointerId);
    if (!drag) return;
    if (!drag.moved) { if (drag.i != null) zones.splice(drag.i, 1); else tap(drag.start); }
    else {
      const box = boxOf(toImg(e)), min = 8 * scr();
      if (box.w >= min && box.h >= min) {
        if (drag.kind === 'new') { const z = {}; store(z, box); zones.push(z); }
        else store(zones[drag.i], box);
      }
    }
    drag = null;
    render();
  });
  render();
  const off = onSettingsChange(render);
  return () => { off(); refresh(); };
}

const CORNERS = [[0, 0], [1, 0], [0, 1], [1, 1]];
