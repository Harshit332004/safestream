const CACHE_NAME = 'streamsafe-core-v12';
const STATIC_ASSETS = ['/', '/index.html', '/style.css', '/script.js'];

self.addEventListener('install', e => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)));
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    if (e.request.url.includes('/api/') || e.request.url.includes('vidlink') || e.request.url.includes('tmdb')) return;
    
    e.respondWith(
        caches.match(e.request).then(res => res || fetch(e.request))
    );
});
