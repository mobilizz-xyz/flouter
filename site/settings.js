// Réglages choisis sur la page : style du masque (au-dessus du bouton) et section « Réglages ».
import { $, el } from './dom.js';

// Émojis proposés ; n'importe quel autre peut être saisi dans le champ « Ou le tien ».
const EMOJIS = ['🙈', '✊', '🫥', '🥷', '👽', '🤖', '👻', '🎭', '🕶️', '🦊', '🐱', '🐼', '🐝', '🦄', '🌻', '🌹', '🔥', '⭐', '💜', '🏴'];
let emoji = EMOJIS[0];

export function settings() {
  const sens = $('input[name=sens]:checked').value;
  const mode = $('input[name=mode]:checked').value;
  return {
    mode: mode === 'emoji' ? 'emoji:' + emoji : mode,
    oval: $('input[name=shape]:checked').value === 'oval',
    threshold: sens === 'high' ? 0.1 : 0.2,
    high: sens === 'high',
    keepAudio: $('#keep-audio').checked,
  };
}

// Appelle fn à chaque changement de réglage ; renvoie de quoi se désabonner.
export function onSettingsChange(fn) {
  const boxes = [$('#styles'), $('#settings')];
  for (const b of boxes) b.addEventListener('change', fn);
  return () => { for (const b of boxes) b.removeEventListener('change', fn); };
}

// Premier caractère visible du texte saisi (un émoji composé compte pour un seul)
function firstGlyph(text) {
  const t = text.trim();
  if (!t) return '';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const { segment } of new Intl.Segmenter().segment(t)) return segment;
  }
  return Array.from(t)[0];
}

// Mémorisé sur cet appareil seulement (confort) : la page marche aussi sans.
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage bloqué */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

function pickEmoji(e) {
  emoji = e;
  $('#emoji-current').textContent = e;
  for (const b of $('#emojis .emoji-list').children) b.setAttribute('aria-pressed', b.dataset.e === e);
  remember('flouter-emoji', e);
  $('input[name=mode][value=emoji]').checked = true;
  $('#styles').dispatchEvent(new Event('change'));
}

function initStyles() {
  const list = $('#emojis .emoji-list');
  for (const e of EMOJIS) {
    const b = el(`<button type="button" class="emoji-btn" aria-pressed="false"></button>`);
    b.textContent = e;
    b.dataset.e = e;
    b.onclick = () => pickEmoji(e);
    list.appendChild(b);
  }
  $('#emoji-own').addEventListener('input', (ev) => {
    const g = firstGlyph(ev.target.value);
    if (g) pickEmoji(g);
  });
  const showPanel = () => {
    const m = $('input[name=mode]:checked').value;
    $('#emojis').hidden = m !== 'emoji';
    remember('flouter-mode', m);
    remember('flouter-shape', $('input[name=shape]:checked').value);
  };
  $('#styles').addEventListener('change', showPanel);

  const saved = recall('flouter-emoji');
  if (saved) {
    emoji = saved;
    $('#emoji-current').textContent = saved;
  }
  for (const b of list.children) b.setAttribute('aria-pressed', b.dataset.e === emoji);
  const mode = recall('flouter-mode');
  const radio = mode && $(`input[name=mode][value="${CSS.escape(mode)}"]`);
  if (radio) radio.checked = true;
  if (recall('flouter-shape') === 'oval') $('input[name=shape][value=oval]').checked = true;
  showPanel();
}
initStyles();
