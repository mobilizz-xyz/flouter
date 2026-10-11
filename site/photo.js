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

// Retouche : toucher un visage pour le flouter, toucher un flou pour l'enlever, glisser pour encadrer.
function openEditor(base, zones, media, status, hint, actions, refresh) {
  const W = base.width, H = base.height;
  const view = document.createElement('canvas');
  view.width = W; view.height = H;
  view.className = 'editable';
  media.appendChild(view);
  const ctx = view.getContext('2d');
  let outlines = true;

  const render = () => {
    ctx.drawImage(base, 0, 0);
    anonymize(ctx, zones, settings().mode);
    if (outlines) {
      ctx.lineWidth = Math.max(2, W / 400);
      for (const z0 of zones) {
        const z = grow(z0, MASK_SCALE);
        ctx.strokeStyle = z0.auto ? '#22d3ee' : '#facc15';
        ctx.strokeRect(z.x, z.y, z.w, z.h);
      }
    }
    const n = zones.length;
    status.textContent = n ? `${plural(n, 'flou')}. Un visage oublié ? Touche-le.` : 'Aucun visage trouvé. Touche chaque visage pour le flouter.';
    status.className = 'card-status' + (n ? '' : ' warn');
  };
  hint.innerHTML = "Touche un visage pour le <b>flouter</b>, touche un flou pour l'<b>enlever</b>. Écarte deux doigts pour zoomer. " +
    "Pour un objet (pancarte, tatouage), glisse le doigt pour l'encadrer.";
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
  const tap = (p) => {
    const hit = zones.findIndex((z0) => {
      const z = grow(z0, MASK_SCALE);
      return p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;
    });
    if (hit >= 0) return zones.splice(hit, 1);
    // Nouveau visage : taille médiane des visages déjà trouvés
    const sizes = zones.map((z) => z.w).sort((a, b) => a - b);
    const size = sizes.length ? sizes[sizes.length >> 1] : Math.min(W, H) * 0.12;
    zones.push({ x: p.x - size / 2, y: p.y - size * 0.6, w: size, h: size * 1.2, auto: false });
  };
  const frame = (a, b) => {
    // Le rendu agrandit les zones : on compense pour couvrir exactement le cadre tracé
    const w = Math.abs(b.x - a.x) / MASK_SCALE, h = Math.abs(b.y - a.y) / MASK_SCALE;
    zones.push({ x: (a.x + b.x) / 2 - w / 2, y: (a.y + b.y) / 2 - h / 2, w, h, auto: false });
  };

  // Un doigt : toucher ou encadrer. Deux doigts : zoom du navigateur, on ne touche à rien.
  let start = null;
  const fingers = new Set();
  view.addEventListener('pointerdown', (e) => {
    fingers.add(e.pointerId);
    if (fingers.size > 1) { start = null; return; }
    start = toImg(e);
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointercancel', (e) => { fingers.delete(e.pointerId); start = null; });
  view.addEventListener('pointerup', (e) => {
    fingers.delete(e.pointerId);
    if (!start) return;
    const end = toImg(e);
    const minDrag = (12 * W) / Math.max(1, view.getBoundingClientRect().width); // 12 pixels à l'écran
    if (Math.abs(end.x - start.x) < minDrag && Math.abs(end.y - start.y) < minDrag) tap(start);
    else frame(start, end);
    start = null;
    render();
  });
  render();
  const off = onSettingsChange(render);
  return () => { off(); refresh(); };
}
