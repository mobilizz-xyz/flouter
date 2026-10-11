// Anonymisation d'une zone de l'image : aplat noir (avec ou sans émoji), pixels ou flou destructif.
// Mode : 'solid', 'pixel', 'blur', ou 'emoji:<émoji>' (émoji posé sur l'aplat noir).

export const MASK_SCALE = 1.3; // agrandissement des zones, comme deface

const tiny = document.createElement('canvas');
const tinyCtx = tiny.getContext('2d');
const mid = document.createElement('canvas');
const midCtx = mid.getContext('2d');

// Zone agrandie autour de son centre
export function grow(z, scale) {
  const w = z.w * scale, h = z.h * scale;
  return { x: z.x + (z.w - w) / 2, y: z.y + (z.h - h) / 2, w, h };
}

// Masque rectangulaire : une ellipse laisserait les coins (cheveux, oreilles, menton) visibles.
export function anonymize(ctx, zones, mode, scale = MASK_SCALE) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const emoji = mode.startsWith('emoji:') ? mode.slice(6) : null;
  for (const z0 of zones) {
    const z = grow(z0, scale);
    const x = Math.max(0, Math.floor(z.x)), y = Math.max(0, Math.floor(z.y));
    const w = Math.min(W, Math.ceil(z.x + z.w)) - x, h = Math.min(H, Math.ceil(z.y + z.h)) - y;
    if (w < 2 || h < 2) continue;
    if (mode === 'solid' || emoji) {
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
      if (emoji) {
        // L'émoji est posé sur le noir : l'aplat seul garantit le masquage, même si la police manque.
        const s = Math.min(w, h) * 0.8;
        ctx.save();
        ctx.font = `${s}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(emoji, x + w / 2, y + h / 2 + s * 0.06);
        ctx.restore();
      }
      continue;
    }
    // Réduction drastique puis agrandissement : il ne reste que quelques couleurs,
    // l'information du visage est détruite (pas un simple flou réversible).
    const n = mode === 'pixel' ? 7 : 3;
    mid.width = 24; mid.height = 24;
    midCtx.imageSmoothingEnabled = true;
    midCtx.imageSmoothingQuality = 'high';
    midCtx.drawImage(ctx.canvas, x, y, w, h, 0, 0, 24, 24);
    tiny.width = n; tiny.height = n;
    tinyCtx.imageSmoothingEnabled = true;
    tinyCtx.drawImage(mid, 0, 0, 24, 24, 0, 0, n, n);
    ctx.save();
    ctx.imageSmoothingEnabled = mode !== 'pixel';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tiny, 0, 0, n, n, x, y, w, h);
    ctx.restore();
  }
}
