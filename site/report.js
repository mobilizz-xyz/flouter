// « Ça n'a pas marché ? » : signalement d'un problème.
// Diagnostic technique seulement : jamais le fichier, jamais d'identifiant. Montré avant l'envoi.
import { $ } from './dom.js';
import { IS_IOS } from './device.js';
import { INAPP } from './save.js';

const UA = navigator.userAgent;
// Version publiée (remplacée à la construction par build.py)
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';

function osName() {
  let m;
  if ((m = UA.match(/(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)/))) return `iOS ${m[1]}.${m[2]}`;
  if (IS_IOS) return 'iPadOS';
  if ((m = UA.match(/Android (\d+(?:\.\d+)?)/))) return `Android ${m[1]}`;
  if (/Windows/.test(UA)) return 'Windows';
  if (/Mac OS X/.test(UA)) return 'macOS';
  if (/CrOS/.test(UA)) return 'ChromeOS';
  return /Linux/.test(UA) ? 'Linux' : 'autre';
}

function browserName() {
  const tests = [['Samsung Internet', /SamsungBrowser\/(\d+)/], ['Edge', /EdgA?\/(\d+)/], ['Opera', /OPR\/(\d+)/], ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:CriOS|Chrome)\/(\d+)/], ['Safari', /Version\/(\d+(?:\.\d+)?).*Safari/]];
  for (const [name, r] of tests) {
    const m = UA.match(r);
    if (m) return `${name} ${m[1]}`;
  }
  return 'autre';
}

async function features() {
  const f = [];
  f.push('VideoEncoder:' + (typeof VideoEncoder !== 'undefined'), 'VideoDecoder:' + (typeof VideoDecoder !== 'undefined'));
  const probe = async (name, check) => {
    try { f.push(`${name}:${(await check()).supported}`); } catch { f.push(`${name}:?`); }
  };
  await probe('H264enc', () => VideoEncoder.isConfigSupported({ codec: 'avc1.42e028', width: 1280, height: 720, bitrate: 2e6, framerate: 30 }));
  await probe('HEVCdec', () => VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L93.B0', codedWidth: 1920, codedHeight: 1080 }));
  f.push('isolated:' + self.crossOriginIsolated, 'cores:' + (navigator.hardwareConcurrency || '?'), 'mem:' + (navigator.deviceMemory || '?'));
  return f.join(' ');
}
const sizeBucket = (b) => (b < 50e6 ? '<50 Mo' : b < 200e6 ? '50-200 Mo' : b < 500e6 ? '200-500 Mo' : '>500 Mo');

let pendingReport = null;
export async function openReport(it, message) {
  const ext = it?.file?.name?.split('.').pop()?.toLowerCase() || '';
  pendingReport = {
    version: VERSION, os: osName(), browser: browserName(), inapp: INAPP, features: await features(),
    kind: it?.kind || '', container: it?.file ? `${ext} ${it.file.type || ''}`.trim() : '', size: it?.file ? sizeBucket(it.file.size) : '',
    codec: it?.diag?.codec || '', step: it?.diag?.step || '', error: it?.diag?.error || message || '',
    local: it?.diag?.local || '',
  };
  for (const k of Object.keys(pendingReport)) if (!pendingReport[k]) delete pendingReport[k];
  $('#r-data').textContent = Object.entries(pendingReport).map(([k, v]) => `${k} : ${v}`).join('\n');
  $('#r-comment').value = '';
  $('#r-status').textContent = '';
  $('#r-send').disabled = false;
  $('#report').showModal();
}
$('#report-any').onclick = () => openReport(null, '');
$('#r-cancel').onclick = () => $('#report').close();
$('#r-send').onclick = async () => {
  $('#r-send').disabled = true;
  const comment = $('#r-comment').value.trim();
  try {
    const body = JSON.stringify({ ...pendingReport, ...(comment ? { comment } : {}) });
    const r = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'erreur');
    $('#r-status').textContent = 'Merci, c\'est envoyé !';
    setTimeout(() => $('#report').close(), 1500);
  } catch (e) {
    $('#r-status').textContent = 'Envoi impossible : ' + e.message;
    $('#r-send').disabled = false;
  }
};
