// Caches the app shell and every book opened, so reading works without wifi.
// Progress is cached separately by app.js in localStorage and sent when there is signal.
const CACHE = 'polka-v5';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'mock.js', 'catalog.js', 'manifest.webmanifest', 'icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first (so updates arrive), cache as fallback; don't wait more than 3 s on weak wifi.
  const net = fetch(e.request, { cache: 'no-cache' })
    .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; });
  const saved = caches.match(e.request, { ignoreSearch: true });
  e.respondWith(new Promise(resolve => {
    let done = false;
    const give = r => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => saved.then(give), 3000);
    net.then(r => { clearTimeout(timer); give(r); })
      .catch(() => saved.then(r => give(r || Response.error())));
  }));
});
