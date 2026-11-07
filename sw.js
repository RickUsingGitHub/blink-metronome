/* Offline shell. Bump CACHE when any file below changes. */

const CACHE = 'blink-v1.1.0';
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/audio.js',
  './js/flash.js',
  './js/mic.js',
  './js/ui.js',
  './js/ui-metronome.js',
  './js/ui-setlist.js',
  './js/ui-tuner.js',
  './js/ui-levels.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(FILES.map(f => c.add(new Request(f, { cache:'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;   // let the font CDN fall back to the network

  ev.respondWith(
    caches.match(req, { ignoreSearch:true }).then(hit => {
      if(hit){
        // refresh in the background so the next load is current
        fetch(req).then(res => {
          if(res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req)
        .then(res => {
          if(res && res.ok && res.type === 'basic'){
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
