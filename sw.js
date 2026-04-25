const CACHE_NAME = 'expedition-v2-offline';
// Make sure this matches your Render URL exactly
const API_URL = 'https://mapbox-api-uz9a.onrender.com';

// 1. Files to cache immediately when the app is installed
const APP_SHELL = [
    '/pm.html',
    '/field.html',
    '/index.html',
    '/styles.css'
];

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log("Caching App Shell...");
            return cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' })));
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

// 2. The Interceptor Engine
self.addEventListener('fetch', event => {
    // --- CRITICAL FIX: NEVER attempt to cache POST, PUT, or DELETE requests ---
    if (event.request.method !== 'GET') {
        return; // Let the browser handle it normally and exit the Service Worker
    }

    const url = new URL(event.request.url);

    // --- STRATEGY A: Your Database API (Network First, Fallback to Cache) ---
    if (url.origin === API_URL) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                })
                .catch(() => {
                    console.log("Offline: Loading API from cache.");
                    return caches.match(event.request);
                })
        );
        return;
    }

    // --- STRATEGY B: Mapbox Scripts & External Libraries (Cache First, update in background) ---
    if (url.hostname.includes('mapbox.com') || url.hostname.includes('jsdelivr.net') || url.hostname.includes('unpkg.com')) {
        event.respondWith(
            caches.match(event.request).then(cachedResponse => {
                const networkFetch = fetch(event.request).then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                }).catch(() => null);

                return cachedResponse || networkFetch;
            })
        );
        return;
    }

    // --- STRATEGY C: Everything Else (Network First, Fallback to Cache) ---
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
