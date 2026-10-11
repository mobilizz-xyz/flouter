// Son PCM non compressé (fréquent dans les .mov) : mp4box ne le reconnaît pas comme du son.
// On lit la description QuickTime et la table des morceaux, puis on lit les échantillons directement dans le
// fichier pour les compresser en AAC sur l'appareil.
import { sleep } from './dom.js';

export async function pcmTrack(mp4, file) {
  for (const trak of mp4.moov?.traks || []) {
    if (trak.mdia?.hdlr?.handler !== 'soun') continue;
    const e = trak.mdia.minf.stbl.stsd.entries[0];
    if (!e || !['lpcm', 'sowt', 'twos'].includes(e.type)) continue;
    const v = new DataView(await file.slice(e.start, e.start + e.size).arrayBuffer());
    const ver = v.getUint16(16);
    let rate, ch, bits, float = false, little = e.type === 'sowt';
    if (ver === 2) {
      rate = v.getFloat64(40); ch = v.getUint32(48); bits = v.getUint32(56);
      const flags = v.getUint32(60);
      float = !!(flags & 1); little = !(flags & 2);
      if (!float && !(flags & 4) && bits !== 8) return null; // entier non signé : rare, non géré
    } else {
      ch = v.getUint16(24); bits = v.getUint16(26); rate = v.getUint32(32) / 65536;
    }
    if (![16, 24, 32].includes(bits) || ch < 1 || ch > 8 || !rate) return null;
    const st = trak.mdia.minf.stbl, frame = (bits / 8) * ch;
    const offsets = (st.stco || st.co64).chunk_offsets, sc = st.stsc;
    const chunks = [];
    let frames = 0;
    for (let i = 0, k = 0; i < offsets.length; i++) {
      while (k + 1 < sc.first_chunk.length && sc.first_chunk[k + 1] <= i + 1) k++;
      const n = sc.samples_per_chunk[k] * (ver === 2 ? v.getUint32(68) || 1 : 1); // images par morceau
      chunks.push({ pos: offsets[i], n, t: frames });
      frames += n;
    }
    return { rate: Math.round(rate), ch, bits, float, little, frame, chunks };
  }
  return null;
}

// Lit les échantillons PCM jusqu'à `until` secondes et les envoie à l'encodeur AAC (2 canaux au plus)
export function makePcmPump(file, pcm, aenc) {
  const outCh = Math.min(2, pcm.ch);
  let i = 0;
  return async (until) => {
    while (i < pcm.chunks.length && pcm.chunks[i].t / pcm.rate <= until) {
      const { pos, n, t } = pcm.chunks[i++];
      // Morceaux découpés en blocs d'une seconde au plus (mémoire)
      for (let f0 = 0; f0 < n; f0 += pcm.rate) {
        const m = Math.min(pcm.rate, n - f0);
        const v = new DataView(await file.slice(pos + f0 * pcm.frame, pos + (f0 + m) * pcm.frame).arrayBuffer());
        const got = Math.floor(v.byteLength / pcm.frame);
        if (!got) break;
        const out = new Float32Array(got * outCh), B = pcm.bits / 8;
        for (let j = 0; j < got; j++) for (let c = 0; c < outCh; c++) {
          const o = j * pcm.frame + c * B;
          let x;
          if (pcm.float) x = v.getFloat32(o, pcm.little);
          else if (B === 2) x = v.getInt16(o, pcm.little) / 32768;
          else if (B === 4) x = v.getInt32(o, pcm.little) / 2147483648;
          else {
            const b0 = v.getUint8(o), b1 = v.getUint8(o + 1), b2 = v.getUint8(o + 2);
            const u = pcm.little ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
            x = ((u << 8) >> 8) / 8388608;
          }
          out[j * outCh + c] = x;
        }
        const ad = new AudioData({ format: 'f32', sampleRate: pcm.rate, numberOfChannels: outCh, numberOfFrames: got,
          timestamp: Math.round(((t + f0) * 1e6) / pcm.rate), data: out });
        aenc.encode(ad);
        ad.close();
        while (aenc.encodeQueueSize > 8) await sleep(2);
      }
    }
  };
}
