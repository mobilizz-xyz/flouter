// Vidéos : lecture image par image, détection, floutage et ré-encodage, entièrement sur l'appareil.
// Voie rapide : démultiplexage mp4box + décodage/encodage matériel (WebCodecs).
// Voie compatible : lecture par le lecteur vidéo du navigateur, image par image (plus lent, sans son).
import { createFile, MP4BoxBuffer, DataStream, Endianness } from './vendor/mp4box/mp4box.all.mjs';
import { el, fmtTime, sleep } from './dom.js';
import { modelReady, detectFaces } from './engine.js';
import { MASK_SCALE, anonymize } from './anonymize.js';
import { settings } from './settings.js';
import { addItem, setCancelled, setReady, setSub, setThumb, updateBulk } from './list.js';
import { closeViewer, openViewer } from './viewer.js';
import { makeOutput } from './mp4-output.js';
import { pcmTrack, makePcmPump } from './pcm-audio.js';
import { openZoneEditor } from './zones.js';
import { manualAt } from './zone-path.js';
import { offerServer } from './fallback.js';

// Détection 1 image sur STRIDE ; chaque image reçoit l'union des zones détectées
// juste avant et juste après elle, pour ne pas laisser passer un visage en mouvement.
const STRIDE = 3;
const OUT_MAX = 1280; // côté max de la vidéo produite (720p : rapide et léger à partager)

// Pauses de la page : quand on passe à une autre appli ou qu'on verrouille l'écran, le téléphone met la
// page en pause (parfois sans prévenir) et peut couper l'encodeur vidéo. On note chaque départ et chaque
// retour, et une horloge détecte les gels non annoncés.
let lastPause = 0, lastBeat = Date.now();
const notePause = () => { lastPause = Date.now(); };
document.addEventListener('visibilitychange', notePause);
for (const name of ['pagehide', 'freeze', 'resume', 'pageshow']) addEventListener(name, notePause);
setInterval(() => {
  const now = Date.now();
  if (now - lastBeat > 3000) lastPause = now;
  lastBeat = now;
}, 1000);
// La page a-t-elle été mise en pause depuis `since`, ou vient-elle de revenir ?
const pausedSince = (since) => lastPause >= since || Date.now() - lastPause < 5000;

async function pickVideoCodec(W, H, fps) {
  const bitrate = Math.round(Math.min(6e6, Math.max(1e6, W * H * fps * 0.08)));
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f']) {
    const cfg = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* suivant */ }
  }
  return null;
}

async function keepAwake() {
  try { return await navigator.wakeLock?.request('screen'); } catch { return null; }
}

// Reçoit les images dans l'ordre, détecte, floute et encode.
function makeProcessor(job, W, H, rotation, venc, fps) {
  job.started = true;
  const view = job.view;
  view.width = W; view.height = H;
  const ctx = view.getContext('2d');
  const detSide = job.s.high ? 960 : 640;
  let prev = [], pending = [], n = 0, k = 0, encoded = 0, firstTs = null;
  const manual = job.manual || [];

  function draw(src) {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    const sw = rotation % 180 ? H : W, sh = rotation % 180 ? W : H;
    ctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
  }
  async function emit(f, boxes) {
    draw(f.src);
    f.src.close();
    if (firstTs === null) firstTs = f.ts;
    job.cache?.set(f.ts, boxes);
    anonymize(ctx, boxes, job.s.mode, MASK_SCALE, job.s.oval);
    if (manual.length) anonymize(ctx, manualAt(manual, (f.ts - firstTs) / 1e6, W, H), job.s.mode, 1, job.s.oval);
    const vf = new VideoFrame(view, { timestamp: f.ts, duration: f.dur });
    venc.encode(vf, { keyFrame: encoded % (fps * 2) === 0 });
    vf.close();
    encoded++;
    while (venc.encodeQueueSize > 6) await sleep(2);
  }
  async function detectAndFlush(f) {
    draw(f.src);
    const boxes = await detectFaces(view, W, H, detSide, job.s.threshold, job.s.high);
    const zones = prev.concat(boxes);
    for (const p of pending) await emit(p, zones);
    pending = [];
    await emit(f, zones);
    prev = boxes;
  }
  return {
    async push(f) {
      if (job.cancelled) { f.src.close(); throw new Error('cancel'); }
      n++;
      // Nouveau passage ou reprise : les visages déjà détectés sont réutilisés
      const known = !pending.length && job.reuse?.get(f.ts);
      if (known) {
        prev = known; // couvre aussi les images qui suivent, jusqu'à la prochaine détection
        return emit(f, known);
      }
      if (k++ % STRIDE === 0) await detectAndFlush(f);
      else pending.push(f);
    },
    async finish() {
      if (pending.length) await detectAndFlush(pending.pop());
    },
    get count() { return n; },
  };
}

function rotationOf(m) {
  if (!m) return 0;
  const deg = Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI);
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

function outSize(w, h) {
  const r = Math.min(1, OUT_MAX / Math.max(w, h));
  return [Math.round((w * r) / 2) * 2, Math.round((h * r) / 2) * 2];
}

function aacConfig(mp4, track) {
  try {
    const entry = mp4.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
    const dsi = entry.esds.esd.descs[0].descs[0].data;
    return { codec: track.codec, sampleRate: track.audio.sample_rate, numberOfChannels: track.audio.channel_count, description: new Uint8Array(dsi) };
  } catch { return null; }
}

// Voie rapide : MP4/MOV démultiplexé et décodé par la puce vidéo (WebCodecs).
// Renvoie false si le format n'est pas pris en charge (on bascule alors sur la voie lente).
async function runWebCodecs(job) {
  if (typeof VideoDecoder === 'undefined') return false;
  const { file } = job;
  const mp4 = createFile();
  let info = null, demuxError = null;
  const vSamples = [];
  let decoder, proc, venc, out, vt, at, audioCfg = null, pcm = null, total = 1, firstAudio = true;

  mp4.onError = (e) => { demuxError = e; };
  mp4.onReady = (i) => { info = i; };
  mp4.onSamples = (id, _u, samples) => {
    if (vt && id === vt.id) { for (const s of samples) vSamples.push(s); return; }
    if (at && id === at.id && audioCfg) {
      for (const s of samples) {
        out.muxer.addAudioChunkRaw(s.data, s.is_sync ? 'key' : 'delta',
          (s.cts * 1e6) / s.timescale, (s.duration * 1e6) / s.timescale,
          firstAudio ? { decoderConfig: audioCfg } : undefined);
        firstAudio = false;
      }
      mp4.releaseUsedSamples(id, samples[samples.length - 1].number);
    }
  };

  let offset = 0;
  const CH = 4 << 20;
  const feed = async () => {
    const ab = await file.slice(offset, offset + CH).arrayBuffer();
    const start = offset;
    const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, start), start + ab.byteLength >= file.size);
    // mp4box indique où lire ensuite (il peut demander de revenir en arrière)
    offset = typeof next === 'number' && next !== start ? next : start + ab.byteLength;
  };

  // 1. Lire jusqu'à trouver la description du fichier
  while (!info && offset < file.size && !demuxError) await feed();
  if (!info || !info.videoTracks.length) return false;
  vt = info.videoTracks[0];
  job.codec = vt.codec;

  // 2. Décodeur matériel
  const entry = mp4.getTrackById(vt.id).mdia.minf.stbl.stsd.entries[0];
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  let description;
  if (box) {
    const ds = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(ds);
    description = new Uint8Array(ds.buffer, 8);
  }
  const dcfg = { codec: vt.codec.startsWith('vp08') ? 'vp8' : vt.codec, codedWidth: vt.video.width, codedHeight: vt.video.height, description };
  try { if (!(await VideoDecoder.isConfigSupported(dcfg)).supported) return false; } catch { return false; }

  const rotation = rotationOf(vt.matrix);
  const dispW = rotation % 180 ? vt.video.height : vt.video.width;
  const dispH = rotation % 180 ? vt.video.width : vt.video.height;
  const [W, H] = outSize(dispW, dispH);
  const seconds = vt.samples_duration / vt.timescale || info.duration / info.timescale;
  const fps = Math.max(1, Math.min(60, Math.round(vt.nb_samples / seconds) || 30));
  total = vt.nb_samples;

  const vcfg = await pickVideoCodec(W, H, fps);
  if (!vcfg) throw new Error("ce navigateur ne sait pas encoder en H.264 (essaie Chrome ou Safari)");

  if (job.s.keepAudio) {
    at = info.audioTracks.find((t) => t.codec.startsWith('mp4a'));
    audioCfg = at ? aacConfig(mp4, at) : null;
    if (!audioCfg) {
      try { pcm = await pcmTrack(mp4, file); } catch { pcm = null; }
      const acfg = pcm && { codec: 'mp4a.40.2', sampleRate: pcm.rate, numberOfChannels: Math.min(2, pcm.ch), bitrate: 128000 };
      try { if (!acfg || typeof AudioEncoder === 'undefined' || !(await AudioEncoder.isConfigSupported(acfg)).supported) pcm = null; } catch { pcm = null; }
      if (pcm) pcm.cfg = acfg;
      else job.noAudio = true;
    }
  }

  const aout = audioCfg || pcm?.cfg;
  out = makeOutput(W, H, fps, aout ? { channels: aout.numberOfChannels, sampleRate: aout.sampleRate } : null);
  let encErr = null, decErr = null, aenc = null, pump = null;
  if (pcm) {
    // Une erreur sur le son n'arrête pas le floutage : la vidéo sort, signalée « sans son »
    const stop = () => { pump = null; job.noAudio = true; };
    aenc = new AudioEncoder({ output: (c, m) => { try { out.muxer.addAudioChunk(c, m); } catch { stop(); } }, error: stop });
    aenc.configure(pcm.cfg);
    const run = makePcmPump(file, pcm, aenc);
    pump = async (until) => { try { await run(until); } catch { stop(); } };
  }
  venc = new VideoEncoder({ output: (c, m) => out.muxer.addVideoChunk(c, m), error: (e) => { encErr = e; } });
  venc.configure(vcfg);
  proc = makeProcessor(job, W, H, rotation, venc, fps);

  const decoded = [];
  decoder = new VideoDecoder({ output: (f) => decoded.push(f), error: (e) => { decErr = e; } });
  decoder.configure(dcfg);

  const drain = async (limit) => {
    while (decoded.length || decoder.decodeQueueSize > limit) {
      if (encErr || decErr) throw encErr || decErr;
      if (!decoded.length) { await sleep(1); continue; }
      const f = decoded.shift();
      await proc.push({ src: f, ts: f.timestamp, dur: f.duration || Math.round(1e6 / fps) });
      job.progress(proc.count / total);
    }
  };

  mp4.setExtractionOptions(vt.id, null, { nbSamples: 30 });
  if (audioCfg) mp4.setExtractionOptions(at.id, null, { nbSamples: 100 });
  mp4.start();
  // Repartir du début des images (la description peut être en fin de fichier)
  offset = mp4.seek(0, true).offset;

  try {
    let last = -1, stalls = 0;
    while (last < total - 1) {
      while (vSamples.length) {
        const s = vSamples.shift();
        decoder.decode(new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round((s.cts * 1e6) / s.timescale),
          duration: Math.round((s.duration * 1e6) / s.timescale),
          data: s.data,
        }));
        mp4.releaseUsedSamples(vt.id, s.number);
        last = s.number;
        await drain(3);
        await pump?.((s.cts + s.duration) / s.timescale + 1);
      }
      if (demuxError) throw new Error('fichier vidéo illisible');
      if (last >= total - 1) break;
      if (offset >= file.size) {
        mp4.flush();
        if (vSamples.length) continue;
        if (++stalls > 2) break;
        offset = mp4.seek(0, true).offset; // relire si mp4box a besoin de revenir en arrière
        continue;
      }
      await feed();
    }
    await decoder.flush();
    await drain(0);
    await proc.finish();
    await venc.flush();
    await pump?.(Infinity);
    if (pump) { try { await aenc.flush(); } catch { job.noAudio = true; } }
    if (encErr) throw encErr;
    if (proc.count < total * 0.9) throw new Error(`seulement ${proc.count} images lues sur ${total}`);
  } finally {
    try { decoder.close(); } catch { /* déjà fermé */ }
    try { venc.close(); } catch { /* déjà fermé */ }
    try { aenc?.close(); } catch { /* déjà fermé */ }
    for (const f of decoded) f.close();
  }
  return out.finish();
}

// Voie lente (WebM, formats rares) : lecture image par image avec le lecteur du navigateur.
async function runElement(job) {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  video.className = 'offscreen';
  const url = URL.createObjectURL(job.file);
  video.src = url;
  document.body.appendChild(video);
  try {
    await Promise.race([waitEvent(video, 'loadedmetadata'), sleep(15000).then(() => { throw new Error('lecture impossible'); })]);
    // iOS ne décode rien tant que la lecture n'a pas démarré
    try { await video.play(); video.pause(); } catch { /* lecture auto refusée : on tente quand même */ }
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) throw new Error('durée illisible');
    const fps = 30;
    const total = Math.max(1, Math.floor(duration * fps));
    const [W, H] = outSize(video.videoWidth, video.videoHeight);
    const vcfg = await pickVideoCodec(W, H, fps);
    if (!vcfg) throw new Error("ce navigateur ne sait pas encoder en H.264 (essaie Chrome ou Safari)");
    if (job.s.keepAudio) job.noAudio = true;
    const out = makeOutput(W, H, fps, null);
    let encErr = null;
    const venc = new VideoEncoder({ output: (c, m) => out.muxer.addVideoChunk(c, m), error: (e) => { encErr = e; } });
    venc.configure(vcfg);
    const proc = makeProcessor(job, W, H, 0, venc, fps);
    try {
      for (let i = 0; i < total; i++) {
        if (encErr) throw encErr;
        video.currentTime = Math.min(duration - 0.001, (i + 0.5) / fps);
        await waitEvent(video, 'seeked');
        const src = await createImageBitmap(video);
        await proc.push({ src, ts: Math.round((i * 1e6) / fps), dur: Math.round(1e6 / fps) });
        job.progress((i + 1) / total);
      }
      await proc.finish();
      await venc.flush();
      if (encErr) throw encErr;
      if (!proc.count) throw new Error('aucune image lue');
    } finally {
      try { venc.close(); } catch { /* déjà fermé */ }
    }
    return out.finish();
  } finally {
    URL.revokeObjectURL(url);
    video.remove();
  }
}

function waitEvent(target, name) {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); };
    const ko = () => { cleanup(); rej(new Error('lecture impossible')); };
    const cleanup = () => { target.removeEventListener(name, ok); target.removeEventListener('error', ko); };
    target.addEventListener(name, ok, { once: true });
    target.addEventListener('error', ko, { once: true });
  });
}

export async function processVideo(file, turn) {
  const it = addItem('video');
  it.file = file;
  it.manual = [];
  if (typeof VideoEncoder === 'undefined') {
    await turn;
    return offerServer(it, file, settings(), 'Ton téléphone ne sait pas traiter les vidéos (navigateur trop ancien).');
  }
  setSub(it, 'En attente…');
  it.preview = document.createElement('canvas');
  setThumb(it, it.preview);
  it.s = settings();
  it.li.querySelector('[data-a=view]').disabled = false; // aperçu en direct pendant le traitement
  it.open = (media, status, hint, actions) => openVideo(it, media, status, hint, actions);
  await turn; // une vidéo à la fois
  await encodeLocal(it);
}

// Passe de floutage sur le téléphone. Au second passage (zones manuelles ajoutées) ou après une
// interruption, les visages déjà détectés sont réutilisés : seul le ré-encodage est refait pour eux.
async function encodeLocal(it) {
  const bar = it.li.querySelector('progress');
  const reuse = it.cache || it.partial || null;
  const label = it.partial ? 'Reprise… ' : it.cache ? 'Zones manuelles… ' : '';
  const job = { file: it.file, s: it.s, view: it.preview, cancelled: false, noAudio: false, manual: it.manual, reuse, cache: new Map() };
  it.cancel = () => { job.cancelled = true; };
  it.state = 'work';
  updateBulk();
  const t0 = performance.now();
  let lastUi = 0;
  bar.hidden = false; bar.value = 0;
  job.progress = (done) => {
    const now = performance.now();
    if (now - lastUi < 250 && done < 1) return;
    lastUi = now;
    bar.value = done;
    const elapsed = (now - t0) / 1000;
    setSub(it, `${label}${Math.round(done * 100)} % — reste ~${fmtTime((elapsed / Math.max(done, 0.001)) * (1 - done))}`);
  };
  setSub(it, 'Ouverture…');
  const since = Date.now();
  let lock = await keepAwake();
  const relock = async () => { if (document.visibilityState === 'visible' && !job.done) lock = await keepAwake(); };
  document.addEventListener('visibilitychange', relock);
  let interrupted = false;

  try {
    await modelReady;
    let blob = await runWebCodecs(job).catch((e) => { if (e.message === 'cancel') throw e; console.warn(e); return e; });
    if (blob instanceof Error && !job.started) blob = false; // échec avant tout traitement : voie compatible
    if (blob instanceof Error) throw blob;
    if (blob === false) { setSub(it, 'Mode compatible (plus lent)…'); blob = await runElement(job); }
    it.cache = job.cache;
    it.partial = null;
    it.resumes = 0;
    if (it.url) URL.revokeObjectURL(it.url);
    it.url = URL.createObjectURL(blob);
    it.export = async () => blob;
    it.dispose = () => URL.revokeObjectURL(it.url);
    const sound = job.s.keepAudio && !job.noAudio ? '' : ' · sans son';
    const extra = it.manual.length ? ` · ${it.manual.length} zone${it.manual.length > 1 ? 's' : ''} manuelle${it.manual.length > 1 ? 's' : ''}` : '';
    it.doneText = `Terminé en ${fmtTime((performance.now() - t0) / 1000)}${sound}${extra}. Regarde-la en entier avant de la publier : un visage peut avoir été raté.`;
    setSub(it, `Prête${sound}${extra} — à vérifier`, 'ok');
    setReady(it);
  } catch (e) {
    if (e.message === 'cancel') setCancelled(it);
    // Interruption par une pause de la page : on reprend au retour. Au-delà de 3 reprises d'affilée
    // sans aucun progrès, c'est un vrai échec.
    else if (pausedSince(since) && (job.cache.size > (it.partial?.size || 0) || (it.resumes || 0) < 3)) {
      interrupted = true;
      it.resumes = job.cache.size > (it.partial?.size || 0) ? 0 : (it.resumes || 0) + 1;
      if (!it.cache && job.cache.size > (it.partial?.size || 0)) it.partial = job.cache;
    } else {
      it.diag = { step: job.started ? 'traitement' : 'ouverture', error: String(e?.message || e), codec: job.codec || '' };
      offerServer(it, it.file, job.s, "Ton téléphone n'a pas réussi à traiter cette vidéo.");
    }
  } finally {
    job.done = true;
    document.removeEventListener('visibilitychange', relock);
    try { await lock?.release(); } catch { /* déjà libéré */ }
  }
  if (interrupted) await resume(it);
}

// Reprise dès que la page est de nouveau affichée (on laisse une seconde au téléphone pour
// rendre la puce vidéo)
async function resume(it) {
  setSub(it, 'En pause : reprend dès que tu reviens sur la page.', 'warn');
  let cancelled = false;
  it.cancel = () => { cancelled = true; };
  do await sleep(1000); while (document.visibilityState !== 'visible' && !cancelled);
  if (cancelled) return setCancelled(it);
  await encodeLocal(it);
}

function openVideo(it, media, status, hint, actions) {
  if (it.state !== 'done') {
    // Aperçu en direct du traitement
    const c = document.createElement('canvas');
    media.appendChild(c);
    status.className = 'card-status';
    hint.textContent = "Reste sur cette page jusqu'à la fin, idéalement téléphone branché. Si tu la quittes, le floutage se met en pause et reprend à ton retour.";
    actions.innerHTML = '<button class="btn danger" data-a="cancel">Annuler cette vidéo</button>';
    actions.querySelector('[data-a=cancel]').onclick = () => { it.cancel?.(); closeViewer(); };
    let alive = true;
    const loop = () => {
      if (!alive) return;
      const p = it.preview;
      if (p && p.width > 1) { if (c.width !== p.width) { c.width = p.width; c.height = p.height; } c.getContext('2d').drawImage(p, 0, 0); }
      status.textContent = it.li.querySelector('.sub').textContent;
      if (it.state === 'done') { alive = false; closeViewer(); openViewer(it); return; }
      requestAnimationFrame(loop);
    };
    loop();
    return () => { alive = false; };
  }
  const v = document.createElement('video');
  v.controls = true; v.playsInline = true; v.src = it.url;
  media.appendChild(v);
  status.textContent = it.doneText;
  status.className = 'card-status ok';
  if (it.file && !it.server) {
    const b = el('<button class="btn">✋ Masquer un élément (tatouage, banderole…)</button>');
    b.onclick = () => { v.pause(); openZoneEditor(it, () => encodeLocal(it)); };
    actions.appendChild(b);
  }
  return () => v.pause();
}
