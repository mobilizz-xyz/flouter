// Enregistrement des fichiers floutés : partage natif quand il existe, sinon téléchargement.
import { $ } from './dom.js';
import { IS_IOS } from './device.js';

// Navigateur intégré d'une appli : l'enregistrement y est souvent bloqué
export const INAPP = [
  ['Instagram', /Instagram/], ['Facebook', /FBAN|FBAV|FB_IAB/], ['Snapchat', /Snapchat/],
  ['TikTok', /TikTok|musical_ly|BytedanceWebview|trill/i], ['Messenger', /Messenger/], ['LinkedIn', /LinkedInApp/],
  ['X / Twitter', /Twitter/], ['Line', /\bLine\//],
].find(([, r]) => r.test(navigator.userAgent))?.[0] || '';

// Conseil d'ouvrir le site dans le navigateur du téléphone : une seule fois, au moment d'enregistrer
let inappTipShown = false;
function inappTip() {
  if (!INAPP || inappTipShown) return Promise.resolve();
  inappTipShown = true;
  const link = location.origin + location.pathname;
  $('#inapp-name').textContent = INAPP;
  $('#inapp-browser').textContent = IS_IOS ? 'Safari' : 'Chrome';
  $('#inapp').showModal();
  return new Promise((res) => {
    $('#inapp-go').onclick = () => { $('#inapp').close(); res(); };
    $('#inapp').onclose = () => res();
    $('#inapp-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(link);
        $('#inapp-copy').textContent = 'Copié ✓';
      } catch {
        prompt('Copie ce lien :', link);
      }
    };
  });
}

export async function download(blob, name) {
  await inappTip();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// files : un ou plusieurs File
export async function share(files) {
  await inappTip();
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); } catch { /* partage annulé */ }
    return true;
  }
  return false;
}

export async function shareOrDownload(blob, name) {
  if (!(await share([new File([blob], name, { type: blob.type })]))) await download(blob, name);
}
