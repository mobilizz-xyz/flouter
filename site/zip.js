// Archive .zip sans compression (photos et vidéos sont déjà compressées) pour tout enregistrer d'un coup.
// Format : https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Écriture séquentielle de champs little-endian
function record(size, fill) {
  const view = new DataView(new ArrayBuffer(size));
  let pos = 0;
  fill({
    u16: (v) => { view.setUint16(pos, v, true); pos += 2; },
    u32: (v) => { view.setUint32(pos, v, true); pos += 4; },
  });
  return new Uint8Array(view.buffer);
}

const VERSION = 20;       // zip 2.0
const UTF8_NAMES = 0x0800;
const DOS_DATE = 0x21;    // 1er janvier 1980 : aucune date réelle n'est enregistrée

// files : objets File (nom + contenu). Renvoie un Blob .zip.
export async function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    const name = new TextEncoder().encode(file.name);
    const crc = crc32(data);
    const common = (w) => {
      w.u16(UTF8_NAMES); w.u16(0); // pas de compression
      w.u16(0); w.u16(DOS_DATE);   // heure, date
      w.u32(crc); w.u32(data.length); w.u32(data.length);
      w.u16(name.length); w.u16(0);
    };
    const local = record(30, (w) => { w.u32(0x04034b50); w.u16(VERSION); common(w); });
    central.push(record(46, (w) => {
      w.u32(0x02014b50); w.u16(VERSION); w.u16(VERSION); common(w);
      w.u16(0); w.u16(0); w.u16(0); w.u32(0); // commentaire, disque, attributs
      w.u32(offset);
    }), name);
    parts.push(local, name, data);
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = record(22, (w) => {
    w.u32(0x06054b50); w.u16(0); w.u16(0);
    w.u16(files.length); w.u16(files.length);
    w.u32(centralSize); w.u32(offset); w.u16(0);
  });
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
