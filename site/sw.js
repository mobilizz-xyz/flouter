// Cache local pour fonctionner hors connexion. Aucune donnée personnelle n'est stockée.
// build.py remplace le nom du cache (lié au contenu publié) et la liste des fichiers.
const CACHE = 'flouter-dev';
const CORE = ['./', 'index.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Cache d'abord pour le moteur et le modèle (lourds, liés à la version), réseau d'abord pour le reste.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const isPage = req.mode === 'navigate';
  const isHeavy = /\/(vendor\/|e\.wasm$|e\.mjs$|m\.bin$)/.test(url.pathname);
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isHeavy) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = (await cache.match(req, { ignoreSearch: true })) || (isPage && (await cache.match('index.html')));
      if (hit) return hit;
      throw err;
    }
  })());
});
