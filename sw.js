// Sanctum of Neurology — offline service worker. Cache name changes with every build.
const CACHE = 'sanctum-c1f3cd30a5';
const SHELL = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png", "data/version.json", "data/signs.json", "data/diseases.json", "data/meta.json", "data/index.json", "data/similar.json"];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('sanctum-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const url = new URL(r.url); if (url.origin !== location.origin) return;
  const fresh = r.mode === 'navigate' || url.pathname.endsWith('/version.json') || r.cache === 'no-store';
  if (fresh) {   // network first, cached copy offline
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(r.mode === 'navigate' ? 'index.html' : r, c)); return res; })
      .catch(() => caches.match(r.mode === 'navigate' ? 'index.html' : r, {ignoreSearch: true})));
    return;
  }
  e.respondWith(caches.match(r, {ignoreSearch: true}).then(hit => hit || fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); return res; })));
});
