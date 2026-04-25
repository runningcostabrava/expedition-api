const CACHE_NAME = 'expedition-offline-v1';
const API_URL = 'https://mapbox-api-uz9a.onrender.com';

// Cache the app shell (UI files)
const STATIC_ASSETS = [
    '/pm.html',
    '/field.html',
    '/index.html'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // STRATEGY 1: API GET Requests (Network First, fallback to Cache)
    // This saves your itinerary so pm.html works offline
    if (url.origin === API_URL && event.request.method === 'GET') {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // STRATEGY 2: Mapbox Tiles & Scripts (Stale-While-Revalidate)
    if (url.hostname.includes('mapbox.com') || url.hostname.includes('unpkg.com') || url.hostname.includes('jsdelivr.net')) {
        event.respondWith(
            caches.match(event.request).then(cachedResponse => {
                const networkFetch = fetch(event.request).then(response => {
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
                    return response;
                }).catch(() => null);
                return cachedResponse || networkFetch;
            })
        );
        return;
    }

    // STRATEGY 3: HTML Pages (Network First, fallback to Cache)
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
