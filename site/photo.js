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
    anonymize(ctx, zones, settings().mode, MASK_SCALE, settings().oval);
    return out;
  };
  it.export = () => new Promise((res) => flat().toBlob(res, 'image/jpeg', 0.92));
  const refresh = () => {
    setThumb(it, thumbOf(flat(), W, H));
    if (zones.length) setSub(it, `${plural(zones.length, 'visage')} flouté${zones.length > 1 ? 's' : ''} — vérifie`);
    else setSub(it, 'Aucun flou — vérifie', 'warn');
  };
  refresh();
  it.dispose = onSettingsChange(refresh);
  it.open = (media, status, hint, actions) => openEditor(base, zones, media, status, hint, actions, refresh);
  setReady(it);
}

// Retouche : toucher un visage pour le flouter, toucher un flou pour le choisir (coins pour l'agrandir,
// glisser pour le déplacer, barre sous l'image : − / + / Supprimer), glisser sur une zone libre pour encadrer un objet.
function openEditor(base, zones, media, status, hint, actions, refresh) {
  const W = base.width, H = base.height;
  const view = document.createElement('canvas');
  view.width = W; view.height = H;
  view.className = 'editable';
  media.appendChild(view);
  const ctx = view.getContext('2d');
  const touch = matchMedia('(pointer: coarse)').matches;
  let outlines = true;
  let sel = -1; // flou choisi : lui seul porte les poignées

  const shown = (z0) => grow(z0, MASK_SCALE);
  // Pixels de l'image par pixel d'écran
  // (avant la mise en page, largeur nulle : on suppose une image affichée sur 900 pixels au plus)
  const scr = () => W / (view.getBoundingClientRect().width || Math.min(W, 900));
  const drawBoxes = (skip = -1) => {
    const k = scr(), lw = 2 * k;
    zones.forEach((z0, i) => {
      if (i === skip) return;
      const z = shown(z0);
      ctx.lineWidth = i === sel ? lw * 2 : lw;
      ctx.strokeStyle = i === sel ? '#ffffff' : z0.auto ? '#22d3ee' : '#facc15';
      ctx.strokeRect(z.x, z.y, z.w, z.h);
    });
    const z0 = zones[sel];
    if (!z0 || sel === skip) return;
    // Repères : points aux coins, traits au milieu des bords (on peut tirer partout sur le bord)
    const z = shown(z0), hr = (touch ? 6 : 4.5) * k, t = (touch ? 5 : 4) * k, L = (touch ? 18 : 14) * k;
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#0a0e13'; ctx.lineWidth = k;
    for (const [cx, cy] of CORNERS) {
      ctx.beginPath();
      ctx.arc(z.x + cx * z.w, z.y + cy * z.h, hr, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
    const mx = z.x + z.w / 2, my = z.y + z.h / 2, lw2 = Math.min(L, z.w * 0.4), lh2 = Math.min(L, z.h * 0.4);
    for (const [x, y, w, h] of [[mx - lw2 / 2, z.y - t / 2, lw2, t], [mx - lw2 / 2, z.y + z.h - t / 2, lw2, t],
      [z.x - t / 2, my - lh2 / 2, t, lh2], [z.x + z.w - t / 2, my - lh2 / 2, t, lh2]]) {
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    }
  };
  // Barre du flou choisi : de vrais boutons, plus sûrs au doigt que des poignées sur l'image
  const bar = el(`<div class="sel-bar" hidden>
      <button type="button" class="btn small" data-a="minus" aria-label="Réduire">−</button>
      <button type="button" class="btn small" data-a="plus" aria-label="Agrandir">+</button>
      <button type="button" class="btn small danger" data-a="del">Supprimer</button>
      <button type="button" class="btn small" data-a="ok">OK</button>
    </div>`);
  media.after(bar);
  const B = (a) => bar.querySelector(`[data-a=${a}]`);
  const resizeSel = (f) => {
    const z0 = zones[sel];
    if (!z0) return;
    const b = grow(shown(z0), f);
    if (b.w < 8 * scr() || b.h < 8 * scr()) return;
    store(z0, b);
    render();
  };
  B('minus').onclick = () => resizeSel(1 / 1.15);
  B('plus').onclick = () => resizeSel(1.15);
  B('del').onclick = () => { if (zones[sel]) { zones.splice(sel, 1); sel = -1; render(); } };
  B('ok').onclick = () => { sel = -1; render(); };
  const render = () => {
    bar.hidden = sel < 0 || !zones[sel];
    // Flou choisi : le navigateur ne doit rien faire des gestes sur l'image (ni zoom, ni défilement),
    // sinon Safari reprend la main en plein geste. Sans flou choisi, le zoom à deux doigts revient.
    view.style.touchAction = zones[sel] ? 'none' : '';
    ctx.drawImage(base, 0, 0);
    anonymize(ctx, zones, settings().mode, MASK_SCALE, settings().oval);
    if (outlines) drawBoxes();
    const n = zones.length;
    status.textContent = n ? `${plural(n, 'flou')}. Un visage oublié ? ${touch ? 'Touche-le' : 'Clique dessus'}.`
      : `Aucun flou sur cette photo. ${touch ? 'Touche' : 'Clique sur'} chaque visage à flouter.`;
    status.className = 'card-status' + (n ? '' : ' warn');
  };
  hint.innerHTML = touch
    ? "Touche un visage oublié pour le <b>flouter</b>. Touche un flou pour le <b>choisir</b>, puis glisse-le pour le <b>déplacer</b> ou tire un bord ou un coin pour changer sa <b>forme</b>. " +
      "Glisse le doigt sur une zone libre pour <b>encadrer</b> un objet (pancarte, tatouage). Écarte deux doigts pour zoomer."
    : "Clique sur un visage oublié pour le <b>flouter</b>. Clique sur un flou pour le <b>choisir</b>, puis fais-le glisser pour le <b>déplacer</b> ou tire un bord ou un coin pour changer sa <b>forme</b>. " +
      "Clique et glisse sur une zone libre pour <b>encadrer</b> un objet (pancarte, tatouage).";
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
  const pad = (z, m) => ({ x: z.x - m, y: z.y - m, w: z.w + 2 * m, h: z.h + 2 * m });
  const inside = (p, z) => p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;
  // Flous sous le doigt, du plus probable au moins probable : le doigt n'a pas besoin d'être pile
  // dans le cadre, et parmi des flous qui se chevauchent le plus proche puis le plus petit gagne.
  const pickAt = (p) => {
    const tol = (touch ? 16 : 0) * scr();
    const out = [];
    zones.forEach((z0, i) => {
      const z = shown(z0);
      const dx = Math.max(z.x - p.x, 0, p.x - z.x - z.w), dy = Math.max(z.y - p.y, 0, p.y - z.y - z.h);
      const d = Math.hypot(dx, dy);
      if (d <= tol) out.push({ i, d, c: Math.hypot(p.x - z.x - z.w / 2, p.y - z.y - z.h / 2), a: z.w * z.h });
    });
    // Le flou choisi reste attrapable avec une marge, pour le glisser même s'il est fin
    if (zones[sel] && !out.some((o) => o.i === sel) && inside(p, pad(shown(zones[sel]), (touch ? 8 : 0) * scr()))) out.push({ i: sel, d: 0, c: 0, a: 0 });
    out.sort((u, v) => u.d - v.d || u.a - v.a || u.c - v.c);
    return out.map((o) => o.i);
  };
  // Bord ou coin du flou choisi sous le doigt : { ex, ey } (-1 gauche/haut, 1 droite/bas, 0 aucun).
  // Le centre du cadre sert à le déplacer ; autour, le coin le plus proche gagne (geste le plus courant),
  // et un bord s'attrape près de son trait, dedans comme dehors.
  const hitEdge = (p) => {
    if (!zones[sel] || !outlines) return null;
    const z = shown(zones[sel]), k = scr();
    const band = (touch ? 22 : 8) * k, R = (touch ? 32 : 10) * k;
    if (!inside(p, pad(z, band))) return null;
    const inX = Math.min(band, z.w * 0.3), inY = Math.min(band, z.h * 0.3);
    if (inside(p, { x: z.x + inX, y: z.y + inY, w: z.w - 2 * inX, h: z.h - 2 * inY })) return null;
    const cx = p.x < z.x + z.w / 2 ? -1 : 1, cy = p.y < z.y + z.h / 2 ? -1 : 1;
    if (Math.hypot(p.x - (cx < 0 ? z.x : z.x + z.w), p.y - (cy < 0 ? z.y : z.y + z.h)) <= R) return { ex: cx, ey: cy };
    const ex = p.x < z.x + inX ? -1 : p.x > z.x + z.w - inX ? 1 : 0;
    const ey = p.y < z.y + inY ? -1 : p.y > z.y + z.h - inY ? 1 : 0;
    return ex || ey ? { ex, ey } : null;
  };
  // Cadre affiché → zone stockée (le rendu agrandit les zones de MASK_SCALE autour du centre)
  const store = (z0, b) => {
    const w = b.w / MASK_SCALE, h = b.h / MASK_SCALE;
    Object.assign(z0, { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h, auto: false });
  };
  const rect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
  // Nouveau visage : taille médiane des visages déjà trouvés
  const addFace = (p) => {
    const sizes = zones.map((z) => z.w).sort((a, b) => a - b);
    const size = sizes.length ? sizes[sizes.length >> 1] : Math.min(W, H) * 0.12;
    zones.push({ x: p.x - size / 2, y: p.y - size * 0.6, w: size, h: size * 1.2, auto: false });
    sel = zones.length - 1;
  };

  // Un doigt : toucher, encadrer, déplacer ou redimensionner. Deux doigts : zoom du navigateur, on ne touche à rien.
  let drag = null;
  const fingers = new Set();
  const cancel = () => { if (drag?.moved) render(); drag = null; };
  // Pendant le geste : l'image sans la zone tenue, et son nouveau cadre transparent pour viser juste
  const preview = (box) => {
    if (!drag.cache) {
      const others = drag.i == null ? zones : zones.filter((_, j) => j !== drag.i);
      ctx.drawImage(base, 0, 0);
      anonymize(ctx, others, settings().mode, MASK_SCALE, settings().oval);
      if (outlines) drawBoxes(drag.i ?? -1);
      drag.cache = document.createElement('canvas');
      drag.cache.width = W; drag.cache.height = H;
      drag.cache.getContext('2d').drawImage(view, 0, 0);
    }
    ctx.drawImage(drag.cache, 0, 0);
    const lw = 2 * scr();
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
      const { ex, ey } = drag, dx = p.x - start.x, dy = p.y - start.y;
      let x1 = box0.x, y1 = box0.y, x2 = box0.x + box0.w, y2 = box0.y + box0.h;
      if (ex < 0) x1 += dx; else if (ex > 0) x2 += dx;
      if (ey < 0) y1 += dy; else if (ey > 0) y2 += dy;
      return rect({ x: x1, y: y1 }, { x: x2, y: y2 });
    }
    return rect(start, p);
  };

  view.addEventListener('pointerdown', (e) => {
    fingers.add(e.pointerId);
    if (fingers.size > 1) return cancel();
    const p = toImg(e);
    view.setPointerCapture(e.pointerId);
    const c = hitEdge(p), picks = c ? [sel] : pickAt(p);
    // On glisse le flou choisi s'il est sous le doigt, sinon le plus probable
    const hit = picks.includes(sel) ? sel : picks.length ? picks[0] : -1;
    drag = { start: p, moved: false, kind: c ? 'resize' : hit >= 0 ? 'move' : 'new', i: hit >= 0 ? hit : null, picks };
    if (c) Object.assign(drag, c);
    if (hit >= 0) drag.box0 = shown(zones[hit]);
  });
  view.addEventListener('pointermove', (e) => {
    const p = toImg(e);
    if (!drag) {
      if (e.pointerType !== 'mouse') return;
      const c = hitEdge(p);
      view.style.cursor = c ? (c.ex && c.ey ? (c.ex === c.ey ? 'nwse-resize' : 'nesw-resize') : c.ex ? 'ew-resize' : 'ns-resize') : pickAt(p).length ? 'move' : 'crosshair';
      return;
    }
    const min = 12 * scr(); // 12 pixels à l'écran
    if (!drag.moved && Math.abs(p.x - drag.start.x) < min && Math.abs(p.y - drag.start.y) < min) return;
    drag.moved = true;
    preview(boxOf(p));
  });
  // Safari : bloquer le défilement dès le premier mouvement d'un geste à un doigt sur l'image
  view.addEventListener('touchmove', (e) => { if (drag && e.touches.length === 1) e.preventDefault(); }, { passive: false });
  view.addEventListener('pointercancel', (e) => { fingers.delete(e.pointerId); cancel(); });
  view.addEventListener('pointerup', (e) => {
    fingers.delete(e.pointerId);
    if (!drag) return;
    const { kind, i, moved, picks } = drag;
    if (!moved) {
      if (kind === 'resize') { /* simple appui sur un bord : rien */ }
      else if (picks.includes(sel)) sel = -1; // retoucher le flou choisi : le lâcher
      else if (picks.length) sel = picks[0];
      else if (sel >= 0) sel = -1; // toucher à côté : d'abord lâcher le flou choisi, sans en ajouter
      else addFace(drag.start);
    } else {
      const box = boxOf(toImg(e)), min = 8 * scr();
      if (box.w >= min && box.h >= min) {
        if (kind === 'new') { const z = {}; store(z, box); zones.push(z); sel = zones.length - 1; }
        else { store(zones[i], box); sel = i; }
      }
    }
    drag = null;
    render();
  });
  render();
  const off = onSettingsChange(render);
  // Contours et poignées dépendent de la taille affichée
  let lastW = 0;
  const ro = new ResizeObserver(() => { const w = view.getBoundingClientRect().width; if (w && w !== lastW && !drag) { lastW = w; render(); } });
  ro.observe(view);
  return () => { ro.disconnect(); off(); bar.remove(); refresh(); };
}

const CORNERS = [[0, 0], [1, 0], [0, 1], [1, 1]];
