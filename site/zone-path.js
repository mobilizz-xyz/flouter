// Zones manuelles : positions normalisées (0..1) posées à différents instants ;
// entre deux positions la zone glisse en ligne droite, après la dernière elle reste en place.
export function zoneAt(z, t) {
  const k = z.keys;
  if (!k.length || t < k[0].t - 0.05 || (z.end != null && t > z.end)) return null;
  let i = 0;
  while (i < k.length - 1 && k[i + 1].t <= t) i++;
  const a = k[i], b = k[i + 1];
  if (!b || t <= a.t) return a;
  const r = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r, w: a.w + (b.w - a.w) * r, h: a.h + (b.h - a.h) * r };
}

// Zones présentes à l'instant t, en pixels d'une image W×H
export function manualAt(zones, t, W, H) {
  return zones.map((z) => zoneAt(z, t)).filter(Boolean).map((p) => ({ x: p.x * W, y: p.y * H, w: p.w * W, h: p.h * H }));
}
