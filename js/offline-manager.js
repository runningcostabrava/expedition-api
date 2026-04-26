/**
 * offline-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles three things:
 *   1. OSM basemap layer toggle (replaces Mapbox tiles when switched on)
 *   2. Smart tile pre-download for the current viewport (z10→z15)
 *   3. Offline write queue — saves failed POSTs/PUTs to IndexedDB,
 *      auto-syncs them the moment connectivity returns
 *
 * Usage (add to your map.on('load') callback in index.html and field.html):
 *   OfflineManager.init(map);
 */

const OfflineManager = (() => {

    // ─────────────────────────────────────────────────────────────────────────
    // Config
    // ─────────────────────────────────────────────────────────────────────────
    const DB_NAME = 'expedition-offline-queue';
    const DB_VERSION = 1;
    const STORE_NAME = 'queue';
    const MIN_ZOOM = 10;
    const MAX_ZOOM = 15; // z15 = good hiking detail, manageable tile count

    let db = null;
    let mapInstance = null;
    let osmVisible = false;


    // =========================================================================
    // 1. IndexedDB — Offline Write Queue
    // =========================================================================

    async function openDB() {
        if (db) return db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = e => {
                const database = e.target.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    const store = database.createObjectStore(STORE_NAME, {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    store.createIndex('timestamp', 'timestamp');
                }
            };
            req.onsuccess = e => { db = e.target.result; resolve(db); };
            req.onerror = () => reject(req.error);
        });
    }

    async function enqueue(url, options) {
        const database = await openDB();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).add({
                url,
                method: options.method || 'POST',
                headers: options.headers || {},
                body: options.body || null,
                timestamp: new Date().toISOString(),
                retries: 0
            });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    async function removeFromQueue(id) {
        const database = await openDB();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(id);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    async function getAllQueued() {
        const database = await openDB();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function getQueueCount() {
        const database = await openDB();
        return new Promise((resolve, reject) => {
            const tx = database.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    // ── Sync all queued writes to the server ──────────────────────────────────
    async function syncQueue() {
        if (!navigator.onLine) return;

        const items = await getAllQueued();
        if (items.length === 0) return;

        console.log(`[OfflineManager] Syncing ${items.length} queued requests...`);
        if (typeof showToast === 'function') {
            showToast(`🔄 Syncing ${items.length} offline change${items.length > 1 ? 's' : ''}...`, 'info');
        }

        let synced = 0;
        let failed = 0;

        for (const item of items) {
            try {
                const response = await fetch(item.url, {
                    method: item.method,
                    headers: item.headers,
                    body: item.body
                });

                if (response.ok || response.status === 409) {
                    // 409 Conflict = already exists on server — safe to discard
                    await removeFromQueue(item.id);
                    synced++;
                } else {
                    failed++;
                    console.warn(`[OfflineManager] Server rejected item ${item.id}:`, response.status);
                }
            } catch (e) {
                failed++;
                console.warn(`[OfflineManager] Network error syncing item ${item.id}:`, e);
            }
        }

        updateQueueBadge();

        if (synced > 0) {
            if (typeof showToast === 'function') {
                showToast(`✅ ${synced} change${synced > 1 ? 's' : ''} synced!`, 'success');
            }
            // Refresh the UI to show the newly-synced data
            if (typeof refreshData === 'function') {
                setTimeout(refreshData, 800);
            }
        }

        if (failed > 0 && typeof showToast === 'function') {
            showToast(`⚠️ ${failed} change${failed > 1 ? 's' : ''} still pending`, 'error');
        }
    }


    // =========================================================================
    // 2. Patch authFetch — intercept writes when offline
    // =========================================================================

    function patchAuthFetch() {
        // Wait for authFetch to be available (it may load after this script)
        const tryPatch = () => {
            if (typeof window.authFetch !== 'function') {
                setTimeout(tryPatch, 200);
                return;
            }

            const original = window.authFetch;

            window.authFetch = async function (url, options = {}) {
                const method = (options.method || 'GET').toUpperCase();
                const isWrite = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);

                if (!navigator.onLine && isWrite) {
                    console.log(`[OfflineManager] Queuing offline: ${method} ${url}`);
                    await enqueue(url, options);
                    updateQueueBadge();

                    if (typeof showToast === 'function') {
                        showToast('📦 Saved offline — will sync when connected', 'info');
                    }

                    // Return a fake success so the calling code doesn't break
                    return new Response(JSON.stringify({ offline_queued: true }), {
                        status: 202,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                return original.call(this, url, options);
            };

            console.log('[OfflineManager] authFetch patched for offline writes');
        };

        tryPatch();
    }


    // =========================================================================
    // 3. OSM Layer
    // =========================================================================

    function addOSMLayer(map) {
        if (map.getSource('osm-tiles')) return; // Already added

        map.addSource('osm-tiles', {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 19,
            attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
        });

        // Insert below ALL other layers so your routes/pins stay on top
        const firstLayerId = map.getStyle()?.layers?.[0]?.id;
        map.addLayer({
            id: 'osm-basemap',
            type: 'raster',
            source: 'osm-tiles',
            layout: { visibility: 'none' },
            paint: { 'raster-opacity': 1.0 }
        }, firstLayerId);
    }

    function setOSMVisible(visible) {
        osmVisible = visible;
        if (!mapInstance) return;

        mapInstance.setLayoutProperty('osm-basemap', 'visibility', visible ? 'visible' : 'none');

        const btn = document.getElementById('om-osm-btn');
        if (btn) {
            btn.style.background = visible ? '#27ae60' : 'rgba(15,23,42,0.85)';
            btn.style.borderColor = visible ? '#27ae60' : 'rgba(255,255,255,0.15)';
            btn.title = visible ? 'Switch back to Mapbox' : 'Switch to OpenStreetMap (offline)';
        }
    }

    function toggleOSM() {
        const next = !osmVisible;
        setOSMVisible(next);
        // When switching TO osm — immediately cache what's visible
        if (next) downloadVisibleTiles();
    }


    // =========================================================================
    // 4. Tile Download Engine
    // =========================================================================

    function lon2tile(lon, z) {
        return Math.floor((lon + 180) / 360 * Math.pow(2, z));
    }

    function lat2tile(lat, z) {
        return Math.floor(
            (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI)
            / 2 * Math.pow(2, z)
        );
    }

    function buildTileUrls(map, minZoom, maxZoom) {
        const bounds = map.getBounds();
        const west = bounds.getWest();
        const east = bounds.getEast();
        const north = bounds.getNorth();
        const south = bounds.getSouth();

        // Expand slightly beyond viewport so edges don't blank out on pan
        const pad = 0.05;
        const urls = new Set();

        for (let z = minZoom; z <= maxZoom; z++) {
            const xMin = lon2tile(west - pad, z);
            const xMax = lon2tile(east + pad, z);
            const yMin = lat2tile(north + pad, z); // Note: y-axis inverted
            const yMax = lat2tile(south - pad, z);

            for (let x = xMin; x <= xMax; x++) {
                for (let y = yMin; y <= yMax; y++) {
                    urls.add(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
                }
            }
        }

        return [...urls];
    }

    async function downloadVisibleTiles() {
        if (!navigator.serviceWorker?.controller) {
            console.warn('[OfflineManager] SW not active, cannot cache tiles');
            if (typeof showToast === 'function') {
                showToast('⚠️ Reload the app first to activate offline support', 'error');
            }
            return;
        }

        const urls = buildTileUrls(mapInstance, MIN_ZOOM, MAX_ZOOM);

        setDownloadState('downloading', urls.length);
        if (typeof showToast === 'function') {
            showToast(`⬇️ Downloading ${urls.length} map tiles for offline use...`, 'info');
        }

        navigator.serviceWorker.controller.postMessage({ type: 'CACHE_TILES', urls });
    }


    // =========================================================================
    // 5. UI
    // =========================================================================

    function setDownloadState(state, total = 0, done = 0) {
        const bar = document.getElementById('om-progress-bar');
        const label = document.getElementById('om-progress-label');
        const wrap = document.getElementById('om-progress-wrap');
        if (!wrap) return;

        if (state === 'idle') {
            wrap.style.opacity = '0';
            setTimeout(() => { wrap.style.display = 'none'; }, 400);
        } else {
            wrap.style.display = 'flex';
            requestAnimationFrame(() => { wrap.style.opacity = '1'; });
        }

        if (state === 'downloading' && bar && label) {
            const pct = total > 0 ? Math.round(done / total * 100) : 0;
            bar.style.width = pct + '%';
            label.textContent = total > 0
                ? `⬇️ ${pct}% · ${done}/${total} tiles`
                : `⬇️ Calculating tiles...`;
        }

        if (state === 'done' && bar && label) {
            bar.style.width = '100%';
            label.textContent = `✅ ${total} tiles cached`;
            setTimeout(() => setDownloadState('idle'), 3000);
        }
    }

    async function updateQueueBadge() {
        const badge = document.getElementById('om-queue-badge');
        if (!badge) return;
        const count = await getQueueCount();
        badge.textContent = count;
        badge.style.display = count > 0 ? 'flex' : 'none';
    }

    function buildUI() {
        const style = document.createElement('style');
        style.textContent = `
            #om-container {
                position: fixed;
                bottom: 80px;
                right: 15px;
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 8px;
                z-index: 500;
                font-family: sans-serif;
            }

            .om-btn {
                width: 44px;
                height: 44px;
                border-radius: 50%;
                border: 1px solid rgba(255,255,255,0.15);
                background: rgba(15,23,42,0.85);
                backdrop-filter: blur(8px);
                color: white;
                font-size: 19px;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(0,0,0,0.35);
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.2s, transform 0.1s;
                position: relative;
            }
            .om-btn:hover { transform: scale(1.08); }
            .om-btn:active { transform: scale(0.95); }

            #om-queue-badge {
                position: absolute;
                top: -4px;
                right: -4px;
                background: #e74c3c;
                color: white;
                border-radius: 10px;
                font-size: 10px;
                font-weight: bold;
                padding: 2px 5px;
                display: none;
                align-items: center;
                justify-content: center;
                min-width: 16px;
                height: 16px;
            }

            #om-progress-wrap {
                display: none;
                opacity: 0;
                flex-direction: column;
                gap: 4px;
                background: rgba(15,23,42,0.9);
                backdrop-filter: blur(8px);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 10px;
                padding: 10px 12px;
                min-width: 180px;
                transition: opacity 0.3s;
            }

            #om-progress-label {
                font-size: 11px;
                font-weight: 600;
                color: #e2e8f0;
                white-space: nowrap;
            }

            #om-progress-track {
                width: 100%;
                height: 4px;
                background: rgba(255,255,255,0.1);
                border-radius: 2px;
                overflow: hidden;
            }

            #om-progress-bar {
                height: 100%;
                width: 0%;
                background: linear-gradient(90deg, #3498db, #27ae60);
                border-radius: 2px;
                transition: width 0.3s ease;
            }

            #om-offline-banner {
                display: none;
                position: fixed;
                top: 0; left: 0; right: 0;
                background: linear-gradient(90deg, #e67e22, #d35400);
                color: white;
                text-align: center;
                padding: 7px 16px;
                font-size: 13px;
                font-weight: 700;
                letter-spacing: 0.02em;
                z-index: 9999;
                box-shadow: 0 2px 12px rgba(0,0,0,0.3);
            }
        `;
        document.head.appendChild(style);

        // Offline banner
        const banner = document.createElement('div');
        banner.id = 'om-offline-banner';
        banner.innerHTML = '📵 &nbsp;Offline mode &mdash; edits will auto-sync when connected';
        document.body.appendChild(banner);

        // Main container
        const container = document.createElement('div');
        container.id = 'om-container';

        // OSM toggle button
        const osmBtn = document.createElement('button');
        osmBtn.id = 'om-osm-btn';
        osmBtn.className = 'om-btn';
        osmBtn.title = 'Switch to OpenStreetMap (offline)';
        osmBtn.innerHTML = '🗺️';
        osmBtn.onclick = toggleOSM;

        // Download area button
        const dlBtn = document.createElement('button');
        dlBtn.id = 'om-dl-btn';
        dlBtn.className = 'om-btn';
        dlBtn.title = 'Download this area for offline use';
        dlBtn.innerHTML = '⬇️';
        dlBtn.onclick = downloadVisibleTiles;

        // Sync button (shows pending count)
        const syncBtn = document.createElement('button');
        syncBtn.id = 'om-sync-btn';
        syncBtn.className = 'om-btn';
        syncBtn.title = 'Sync offline changes now';
        syncBtn.innerHTML = '🔄';
        syncBtn.onclick = syncQueue;

        const badge = document.createElement('span');
        badge.id = 'om-queue-badge';
        syncBtn.appendChild(badge);

        // Progress panel
        const progressWrap = document.createElement('div');
        progressWrap.id = 'om-progress-wrap';
        progressWrap.innerHTML = `
            <div id="om-progress-label">Ready</div>
            <div id="om-progress-track"><div id="om-progress-bar"></div></div>
        `;

        container.appendChild(progressWrap);
        container.appendChild(osmBtn);
        container.appendChild(dlBtn);
        container.appendChild(syncBtn);
        document.body.appendChild(container);
    }

    function updateOnlineStatus() {
        const banner = document.getElementById('om-offline-banner');
        if (banner) banner.style.display = navigator.onLine ? 'none' : 'block';

        if (navigator.onLine) {
            console.log('[OfflineManager] Back online — starting sync');
            syncQueue();
        } else {
            console.log('[OfflineManager] Gone offline');
        }
    }


    // =========================================================================
    // 6. Service Worker message listener (progress callbacks)
    // =========================================================================

    function listenToSW() {
        if (!navigator.serviceWorker) return;

        navigator.serviceWorker.addEventListener('message', event => {
            const { type, cached, skipped, total } = event.data || {};

            if (type === 'CACHE_PROGRESS') {
                setDownloadState('downloading', total, cached);
            }

            if (type === 'CACHE_COMPLETE') {
                setDownloadState('done', cached);
                if (typeof showToast === 'function') {
                    const fresh = cached - (skipped || 0);
                    showToast(
                        fresh > 0
                            ? `✅ ${fresh} new tiles cached (${skipped || 0} already stored)`
                            : `✅ Area already fully cached`,
                        'success'
                    );
                }
            }
        });
    }


    // =========================================================================
    // Public API
    // =========================================================================
    return {
        /**
         * Call this inside your map.on('load') callback:
         *   OfflineManager.init(map);
         */
        init(map) {
            mapInstance = map;

            buildUI();
            addOSMLayer(map);
            patchAuthFetch();
            listenToSW();
            updateOnlineStatus();
            updateQueueBadge();

            window.addEventListener('online', updateOnlineStatus);
            window.addEventListener('offline', updateOnlineStatus);

            console.log('[OfflineManager] Initialised ✅');
        },

        /** Manually trigger a tile download for the current viewport */
        downloadArea: downloadVisibleTiles,

        /** Manually trigger a sync of the offline queue */
        syncNow: syncQueue,

        /** Check how many writes are pending */
        getPendingCount: getQueueCount,

        /** Toggle the OSM layer on/off */
        toggleOSM
    };

})();