const CACHE_NAME = 'expedition-v3-offline';
const API_URL = 'https://mapbox-api-uz9a.onrender.com';

const APP_SHELL = [
    '/pm.html',
    '/field.html',
    '/index.html',
    '/styles.css',
    '/js/api.js',
    '/js/elevation.js',
    '/js/live-tracking.js',
    '/js/route-editor.js',
    '/js/store.js',
    '/js/offline-manager.js'
];

// ─── INSTALL: Pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('[SW] Caching App Shell...');
            return cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' })));
        })
    );
});

// ─── ACTIVATE: Clean up old caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => {
                        console.log('[SW] Deleting old cache:', key);
                        return caches.delete(key);
                    })
            )
        ).then(() => self.clients.claim())
    );
});

// ─── MESSAGE: Bulk tile pre-fetch (from offline-manager.js) ──────────────────
self.addEventListener('message', async event => {
    if (event.data?.type !== 'CACHE_TILES') return;

    const urls = event.data.urls || [];
    const cache = await caches.open(CACHE_NAME);
    const client = event.source;

    let cached = 0;
    let skipped = 0;
    const CONCURRENCY = 6; // Parallel tile fetches (OSM allows this)

    console.log(`[SW] Tile download started: ${urls.length} tiles`);

    // Process in concurrent batches
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
        const batch = urls.slice(i, i + CONCURRENCY);

        await Promise.allSettled(batch.map(async url => {
            try {
                // Skip tiles already in cache
                const existing = await cache.match(url);
                if (existing) { skipped++; cached++; return; }

                const response = await fetch(url);
                if (response.ok) {
                    await cache.put(url, response);
                    cached++;
                }
            } catch (e) {
                // Tile fetch failed — skip silently
            }
        }));

        // Report progress back to the page
        client?.postMessage({
            type: 'CACHE_PROGRESS',
            cached,
            skipped,
            total: urls.length
        });
    }

    console.log(`[SW] Tile download complete: ${cached}/${urls.length} cached`);
    client?.postMessage({
        type: 'CACHE_COMPLETE',
        cached,
        skipped,
        total: urls.length
    });
});

// ─── FETCH INTERCEPTOR ───────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    // Solo con existir este listener, Chrome habilita el botón de instalación
    if (!event.request.url.startsWith('http')) return;

    // Never intercept non-GET requests (POST/PUT/DELETE go straight through)
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // ── STRATEGY A: Your API — Network first, fall to cache ──────────────────
    if (url.origin === API_URL) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                })
                .catch(async () => {
                    console.log('[SW] Offline: serving API from cache:', url.pathname);
                    const cached = await caches.match(event.request);
                    return cached || new Response(JSON.stringify({ offline: true, error: 'No cached data' }), {
                        status: 503,
                        headers: { 'Content-Type': 'application/json' }
                    });
                })
        );
        return;
    }

    // ── STRATEGY B: Map tiles + CDN libs — Cache first, refresh in background ─
    const isTileOrLib = (
        url.hostname.includes('tile.openstreetmap.org') ||
        url.hostname.includes('mapbox.com') ||
        url.hostname.includes('jsdelivr.net') ||
        url.hostname.includes('unpkg.com') ||
        url.hostname.includes('cdnjs.cloudflare.com')
    );

    if (isTileOrLib) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                // Return cached immediately; fetch fresh in background
                const networkUpdate = fetch(event.request)
                    .then(response => {
                        if (response.ok) {
                            const clone = response.clone();
                            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                        }
                        return response;
                    })
                    .catch(() => null);

                return cached || networkUpdate;
            })
        );
        return;
    }

    // ── STRATEGY C: Everything else — Network first, fall to cache ────────────
    event.respondWith(
        fetch(event.request)
            .then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});