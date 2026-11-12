/* Offline shell. Bump CACHE when any file below changes. */

const CACHE = 'blink-v1.3.0';
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
  './js/pitch.js',
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

/* No skipWaiting here on purpose. A new worker installs and then waits, which
   is the signal the page uses to offer a reload; it takes over only when the
   user accepts, so nothing changes underneath a running bar. */
self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(FILES.map(f => c.add(new Request(f, { cache:'reload' })))))
  );
});

/* Tell the open pages which version is now in charge. They compare it with the
   code they are actually running, so the reload prompt only appears when the
   page really is behind — taking over is not by itself news. */
function announce(){
  return self.clients.matchAll({ includeUncontrolled:true })
    .then(cs => cs.forEach(c => c.postMessage({ type:'sw-version', version: CACHE })))
    .catch(() => {});
}

self.addEventListener('message', ev => {
  const d = ev.data;
  if(!d) return;
  if(d.type === 'skipWaiting') self.skipWaiting();            // the user pressed Reload
  if(d.type === 'version?' && ev.source){
    ev.source.postMessage({ type:'sw-version', version: CACHE });
  }
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(announce)
  );
});

/* The page and its code go network-first, so a new version is live the moment
   it is published — cache-first here served a stale shell for one whole load,
   and an old index.html against new modules is worse than a slow one. Icons
   and other assets stay cache-first; both fall back to the cache offline. */
const CODE = /\.(?:js|css|webmanifest)$/;

function put(req, res){
  if(res && res.ok && res.type === 'basic'){
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;   // let the font CDN go straight to the network

  const fresh = req.mode === 'navigate' || CODE.test(url.pathname);

  if(fresh){
    // Revalidate past the browser's own HTTP cache: GitHub Pages sends
    // max-age=600, which otherwise hands back a module up to ten minutes old
    // and can pair a new page with stale code.
    ev.respondWith(
      fetch(req.url, { cache:'no-cache', credentials:'same-origin' })
        .then(res => put(req, res))
        .catch(() => caches.match(req, { ignoreSearch:true })
          .then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  ev.respondWith(
    caches.match(req, { ignoreSearch:true }).then(hit =>
      hit || fetch(req).then(res => put(req, res)).catch(() => hit)
    )
  );
});
