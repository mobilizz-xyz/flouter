// Petits utilitaires d'interface.

export const $ = (s) => document.querySelector(s);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Élément créé à partir d'un gabarit HTML fixe (jamais de texte venant de l'utilisateur)
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtTime(s) {
  if (!isFinite(s)) return '…';
  s = Math.round(s);
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}` : `${s} s`;
}

// Nom de fichier neutre : rien du nom d'origine
export const randName = (ext) => `anonyme-${Math.random().toString(36).slice(2, 8)}.${ext}`;
