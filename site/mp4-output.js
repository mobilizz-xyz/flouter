// Écriture du fichier MP4 produit.
import { Muxer, StreamTarget } from './vendor/mp4-muxer.mjs';

// Sortie MP4 classique écrite par morceaux (pas de copie géante en mémoire) ;
// seul l'en-tête du bloc de données est réécrit à la fin.
export function makeOutput(W, H, fps, audio) {
  let blob = new Blob([]);
  let parts = [], partsSize = 0, pos = 0;
  const patches = [];
  const target = new StreamTarget({
    chunked: true,
    chunkSize: 4 << 20,
    onData: (data, position) => {
      if (position < pos) { patches.push([position, data.slice()]); return; }
      if (position > pos) throw new Error('écriture non séquentielle');
      parts.push(data.slice());
      pos += data.byteLength;
      partsSize += data.byteLength;
      if (partsSize > 32 << 20) { blob = new Blob([blob, ...parts]); parts = []; partsSize = 0; }
    },
  });
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    ...(audio ? { audio: { codec: 'aac', numberOfChannels: audio.channels, sampleRate: audio.sampleRate } } : {}),
    fastStart: false,
    firstTimestampBehavior: 'offset',
  });
  return {
    muxer,
    finish: () => {
      muxer.finalize();
      let out = new Blob([blob, ...parts]);
      for (const [p, d] of patches) out = new Blob([out.slice(0, p), d, out.slice(p + d.byteLength)]);
      return new Blob([out], { type: 'video/mp4' });
    },
  };
}
