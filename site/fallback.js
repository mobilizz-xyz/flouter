// Mode secours : quand le téléphone n'arrive pas à traiter une vidéo, on propose de l'envoyer au
// serveur (api/server.py). Rien ne part sans l'accord explicite de la personne.
import { sleep } from './dom.js';
import { setCancelled, setError, setReady, setSub, showActions, updateBulk } from './list.js';
import { openReport } from './report.js';

const CHUNK = 8 * 1024 * 1024; // petits morceaux : une coupure ne fait perdre que quelques secondes d'envoi
const RETRIES = 6; // nouveaux essais par morceau après une coupure réseau

export function offerServer(it, file, s, reason) {
  it.state = 'wait';
  updateBulk();
  setSub(it, reason, 'warn');
  it.li.querySelector('progress').hidden = true;
  const acts = it.li.querySelector('.acts');
  acts.innerHTML = '<button class="btn small" data-a="report">Signaler</button><button class="btn small primary" data-a="server">Flouter sur le serveur</button>';
  acts.querySelector('[data-a=report]').onclick = () => openReport(it, reason);
  acts.querySelector('[data-a=server]').onclick = () => {
    const ok = confirm(
      `${reason}\n\nTu peux l'envoyer à notre serveur pour la flouter :\n` +
      '• elle y est traitée en mémoire, jamais enregistrée sur disque ;\n' +
      '• elle est effacée dès que tu récupères le résultat (au plus tard 15 min) ;\n' +
      '• notre serveur ne garde aucun journal.\n\n' +
      'Limites : 10 min et 600 Mo maximum (au-delà, la vidéo est coupée).\n\nEnvoyer la vidéo ?');
    if (ok) runServer(it, file, s);
  };
}

function sendChunk(url, part, onProgress, setXhr) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    setXhr(xhr);
    xhr.open('POST', url);
    xhr.timeout = 120000; // morceau bloqué (réseau mobile figé) : on abandonne et on réessaie
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      if (xhr.status === 200) return resolve();
      let error = 'envoi refusé';
      try { error = JSON.parse(xhr.responseText).error || error; } catch { /* réponse non JSON */ }
      // Erreurs des intermédiaires (Cloudflare 5xx, page HTML) : traitées comme une coupure
      reject(Object.assign(new Error(error), { network: xhr.status === 0 || xhr.status >= 500 }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('envoi impossible (réseau ?)'), { network: true }));
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => reject(new Error('cancel'));
    xhr.send(part);
  });
}

async function runServer(it, file, s) {
  const acts = it.li.querySelector('.acts');
  const bar = it.li.querySelector('progress');
  it.state = 'work';
  updateBulk();
  acts.innerHTML = '<button class="btn small" data-a="cancel">Annuler</button>';
  bar.hidden = false;
  bar.value = 0;
  let id = null, cancelled = false, xhr = null;
  it.cancel = () => {
    cancelled = true;
    xhr?.abort();
    if (id) fetch(`/api/jobs/${id}/cancel`, { method: 'POST' }).catch(() => { /* expirée de toute façon */ });
  };
  acts.querySelector('[data-a=cancel]').onclick = () => { it.cancel(); setCancelled(it); };
  const mode = { blur: 'blur', solid: 'solid', pixel: 'mosaic' }[s.mode] || 'solid'; // émojis : aplat noir côté serveur
  try {
    // Serveur plein : la vidéo reste sur le téléphone et on réessaie tout seul (rien n'est envoyé avant)
    let start, res;
    for (;;) {
      start = await fetch(`/api/uploads?size=${file.size}&mode=${mode}&thresh=${s.high ? 'high' : 'normal'}&audio=${s.keepAudio ? 1 : 0}`, { method: 'POST' });
      res = await start.json().catch(() => ({}));
      if (start.status !== 503) break;
      setSub(it, 'Beaucoup de monde en ce moment. Ta vidéo partira toute seule dès qu\'une place se libère : garde cette page ouverte.', 'warn');
      await sleep(20000 + Math.random() * 20000);
      if (cancelled) throw new Error('cancel');
    }
    if (!start.ok) throw new Error(res.error || 'serveur indisponible');
    id = res.id;

    for (let off = 0; off < file.size; off += CHUNK) {
      const part = file.slice(off, Math.min(file.size, off + CHUNK));
      for (let attempt = 0; ; attempt++) {
        try {
          await sendChunk(`/api/uploads/${id}?offset=${off}`, part, (loaded) => {
            const done = (off + loaded) / file.size;
            bar.value = done;
            setSub(it, `Envoi… ${Math.round(done * 100)} %`);
          }, (x) => { xhr = x; });
          break;
        } catch (e) {
          if (!e.network || attempt >= RETRIES || cancelled) throw e;
          // Le serveur garde ce qui est déjà arrivé : on renvoie seulement ce morceau
          const wait = Math.min(30, 2 ** attempt * 2);
          for (let t = wait; t > 0 && !cancelled; t--) {
            setSub(it, `Connexion perdue, nouvel essai dans ${t} s… (garde cette page ouverte)`, 'warn');
            await sleep(1000);
          }
          if (cancelled) throw new Error('cancel');
        }
      }
    }

    while (!cancelled) {
      await sleep(2000);
      const j = await (await fetch(`/api/jobs/${id}`, { cache: 'no-store' })).json();
      if (j.state === 'error') throw new Error(j.error || 'échec sur le serveur');
      if (j.state === 'queued') setSub(it, j.position > 1 ? `En attente sur le serveur (${j.position}e)…` : 'Bientôt traitée sur le serveur…');
      if (j.state === 'running') {
        bar.value = j.progress;
        setSub(it, `Floutage sur le serveur… ${Math.round(j.progress * 100)} %`);
      }
      if (j.state === 'done') break;
      if (!j.state) throw new Error(j.error || 'tâche perdue');
    }
    if (cancelled) return;

    setSub(it, 'Récupération…');
    const r = await fetch(`/api/jobs/${id}/result`, { cache: 'no-store' });
    if (!r.ok) throw new Error('résultat indisponible');
    const blob = await r.blob();
    it.url = URL.createObjectURL(blob);
    it.export = async () => blob;
    it.dispose = () => URL.revokeObjectURL(it.url);
    it.server = true;
    it.doneText = `Floutée sur le serveur${s.keepAudio ? '' : ' (sans son)'} puis effacée de celui-ci. Regarde-la en entier avant de la publier : un visage peut avoir été raté.`;
    showActions(it);
    setSub(it, 'Prête (serveur) — à vérifier', 'ok');
    setReady(it);
  } catch (e) {
    // Après une annulation, les réponses encore en route (tâche effacée…) ne comptent plus
    if (!cancelled && e.message !== 'cancel') {
      const d = it.diag || {};
      it.diag = { ...d, step: 'serveur', error: e.message, local: d.step ? `${d.step} : ${d.error || ''}` : '' };
      setError(it, 'Serveur : ' + e.message);
    }
  }
}
