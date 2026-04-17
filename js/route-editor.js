const KomootEngine = {
    // Added editMeta to state
    state: { intersections: [], segments: [], markers: [], currentFileName: '', isListenerAdded: false, editMeta: null },

    // --- UPDATE in js/route-editor.js ---
    handleGpxUpload: function (file) {
        const reader = new FileReader();
        // 🔒 GRAB THE ID RIGHT NOW before any panels close
        const currentTask = AppStore.get('activeTaskId');

        reader.onload = async (event) => {
            try {
                const gpxXml = new DOMParser().parseFromString(event.target.result, "text/xml");
                const geojson = toGeoJSON.gpx(gpxXml);
                if (geojson && geojson.features.length > 0) {
                    showToast("Analyzing GPX (Komoot Engine)...", "info");

                    // Pass the locked Task ID into initFromGpx
                    await this.initFromGpx(geojson.features[0], file.name, {
                        lockedTaskId: currentTask
                    });
                }
                // ... rest of error handling ...
            } catch (err) { console.error(err); }
        };
        reader.readAsText(file);
    },

    // Now accepts editMeta
    initFromGpx: async function (feature, fileName, editMeta = null) {
        draw.deleteAll();
        this.cleanup();
        this.state.currentFileName = fileName || 'Edited Route';
        this.state.editMeta = editMeta; // Save the ID for the update!
        const simplified = turf.simplify(feature, { tolerance: 0.005, highQuality: true });
        const coords = simplified.geometry.coordinates;
        this.state.intersections = coords.map((c, i) => ({ id: Date.now() + i, lngLat: [c[0], c[1]] }));
        this.state.segments = [];

        for (let i = 0; i < this.state.intersections.length - 1; i++) {
            const type = await this.autoDetectType(this.state.intersections[i].lngLat, this.state.intersections[i + 1].lngLat);
            this.state.segments.push({ id: Date.now() + i + 100, type, startIdx: i, endIdx: i + 1, geometry: null });
        }
        await this.refreshAllSegments();

        // const bbox = turf.bbox(feature);
        //map.fitBounds(bbox, { padding: 50 });

        this.updateSavePopup();
        this.setupMapListeners();
    },

    setupMapListeners: function () {
        if (this.state.isListenerAdded) return;

        map.on('click', 'komoot-edit-line', (e) => {
            const coords = [e.lngLat.lng, e.lngLat.lat];
            let clickedSegIdx = -1;

            this.state.segments.forEach((seg, index) => {
                if (!seg.geometry) return;
                const line = turf.feature(seg.geometry);
                const dist = turf.pointToLineDistance(turf.point(coords), line);
                if (dist < 0.05) clickedSegIdx = index;
            });

            if (clickedSegIdx !== -1) {
                this.insertStop(clickedSegIdx, coords);
            }
        });

        map.on('mouseenter', 'komoot-edit-line', () => map.getCanvas().style.cursor = 'copy');
        map.on('mouseleave', 'komoot-edit-line', () => map.getCanvas().style.cursor = '');

        this.state.isListenerAdded = true;
    },

    insertStop: async function (segIdx, coords) {
        showToast("Adding new stop...", "info");
        const newStop = { id: Date.now(), lngLat: coords };
        const oldSeg = this.state.segments[segIdx];

        this.state.intersections.splice(oldSeg.endIdx, 0, newStop);

        for (let i = segIdx + 1; i < this.state.segments.length; i++) {
            this.state.segments[i].startIdx++;
            this.state.segments[i].endIdx++;
        }

        const newSeg1 = { id: Date.now() + 1, type: oldSeg.type, startIdx: oldSeg.startIdx, endIdx: oldSeg.startIdx + 1, geometry: null };
        const newSeg2 = { id: Date.now() + 2, type: oldSeg.type, startIdx: oldSeg.startIdx + 1, endIdx: oldSeg.endIdx + 1, geometry: null };

        this.state.segments.splice(segIdx, 1, newSeg1, newSeg2);
        await this.refreshAllSegments();
        this.updateSavePopup();
    },

    deleteStop: async function (idx) {
        if (this.state.intersections.length <= 2) {
            alert("A route must have at least 2 stops.");
            return;
        }
        showToast("Deleting stop...", "info");

        this.state.intersections.splice(idx, 1);
        this.state.segments = [];
        for (let i = 0; i < this.state.intersections.length - 1; i++) {
            this.state.segments.push({ id: Date.now() + i, type: 'smart', startIdx: i, endIdx: i + 1, geometry: null });
        }

        await this.refreshAllSegments();
        this.updateSavePopup();
    },

    autoDetectType: async function (start, end) {
        // Optimization: Default to manual to prevent Mapbox API rate-limiting during initialization.
        // Users can toggle segments to 'smart' individually in the UI.
        return 'manual';
    },

    refreshAllSegments: async function () {
        let totalGain = 0; let totalLoss = 0;
        for (const seg of this.state.segments) {
            const start = this.state.intersections[seg.startIdx].lngLat;
            const end = this.state.intersections[seg.endIdx].lngLat;

            if (seg.type === 'smart') {
                try {
                    const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${start.join(',')};${end.join(',')}?geometries=geojson&access_token=${mapboxgl.accessToken}`;
                    const res = await fetch(url);
                    const data = await res.json();
                    seg.geometry = data.routes[0].geometry;
                } catch (e) { seg.geometry = turf.lineString([start, end]).geometry; }
            } else {
                seg.geometry = turf.lineString([start, end]).geometry;
            }

            const coords = seg.geometry.coordinates;
            for (let i = 0; i < coords.length; i++) {
                const z = map.queryTerrainElevation(coords[i]) || 0;
                coords[i] = [coords[i][0], coords[i][1], z];

                if (i > 0) {
                    const diff = coords[i][2] - coords[i - 1][2];
                    if (diff > 0) totalGain += diff; else totalLoss += Math.abs(diff);
                }
            }
        }
        this.renderToMap();
    },

    renderToMap: function () {
        this.state.markers.forEach(m => m.remove());
        this.state.markers = [];

        const features = this.state.segments.map(s => {
            const feat = turf.feature(s.geometry);
            feat.properties = { type: s.type };
            return feat;
        });
        const data = turf.featureCollection(features);

        if (map.getSource('komoot-edit-route')) {
            map.getSource('komoot-edit-route').setData(data);
        } else {
            map.addSource('komoot-edit-route', { type: 'geojson', data });
            map.addLayer({
                id: 'komoot-edit-line', type: 'line', source: 'komoot-edit-route',
                paint: {
                    'line-color': ['case', ['==', ['get', 'type'], 'smart'], '#38bdf8', '#94a3b8'],
                    'line-width': 5,
                    'line-dasharray': ['case', ['==', ['get', 'type'], 'smart'], ['literal', [1, 2]], ['literal', [1, 0]]]
                }
            });
        }

        this.state.intersections.forEach((point, i) => {
            const el = document.createElement('div');
            el.style.cssText = 'background:#1e293b; width:24px; height:24px; border-radius:50%; color:white; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold; cursor:move; border:2px solid white; box-shadow:0 2px 4px rgba(0,0,0,0.3);';
            el.innerText = i + 1;

            const popup = new mapboxgl.Popup({ offset: 10 }).setHTML(`
                <div style="text-align:center; padding:5px;">
                    <strong style="display:block; margin-bottom:8px;">Stop ${i + 1}</strong>
                    <button onclick="KomootEngine.toggleSegmentMode(${i})" style="margin-bottom:5px; background:#3498db; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; width:100%;">Toggle Smart/Manual</button>
                    <button onclick="KomootEngine.deleteStop(${i})" style="margin-bottom:5px; background:#e74c3c; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; width:100%;">🗑️ Delete Stop</button>
                    <button onclick="openStreetView(${point.lngLat[1]}, ${point.lngLat[0]})" style="background:#e67e22; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; width:100%;">🚶‍♂️ Street View</button>
                </div>
            `);

            const m = new mapboxgl.Marker({ element: el, draggable: true })
                .setLngLat(point.lngLat)
                .setPopup(popup)
                .addTo(map);

            m.on('dragend', async () => {
                const pos = m.getLngLat();
                this.state.intersections[i].lngLat = [pos.lng, pos.lat];
                await this.refreshAllSegments();
                this.updateSavePopup();
            });
            this.state.markers.push(m);
        });
    },

    toggleSegmentMode: function (index) {
        if (this.state.segments[index]) {
            this.state.segments[index].type = this.state.segments[index].type === 'smart' ? 'manual' : 'smart';
            this.refreshAllSegments();
            this.updateSavePopup();
        }
    },

    updateSavePopup: function () {
        if (isEditingGeometry || this.state.currentFileName) {
            const fullGeom = this.getUnifiedGeometry();
            const centerPt = this.state.intersections[Math.floor(this.state.intersections.length / 2)].lngLat;

            // Extract existing metadata if we are updating a track
            let editConfig = null, color = '#3498db', link = '';
            if (this.state.editMeta) {
                editConfig = this.state.editMeta.config;
                color = this.state.editMeta.color;
                link = this.state.editMeta.link;
            }

            // Pass the metadata so the popup knows to run a PUT (update) instead of a POST (create)
            showGeometryContextPopup(centerPt, fullGeom, this.state.currentFileName.replace('.gpx', ''), `Komoot Segmented Route`, editConfig, '📈', color, link);
        }
    },

    getUnifiedGeometry: function () {
        let allCoords = [];
        this.state.segments.forEach(seg => {
            if (seg.geometry && seg.geometry.coordinates) {
                const coords = seg.geometry.coordinates;
                allCoords = allCoords.concat(coords.slice(0, -1));
            }
        });
        const lastSeg = this.state.segments[this.state.segments.length - 1];
        if (lastSeg && lastSeg.geometry) {
            allCoords.push(lastSeg.geometry.coordinates[lastSeg.geometry.coordinates.length - 1]);
        }
        return { type: 'LineString', coordinates: allCoords };
    },

    cleanup: function () {
        this.state.markers.forEach(m => m.remove());
        this.state.markers = [];
        this.state.editMeta = null; // Clear metadata on exit
        if (map.getLayer('komoot-edit-line')) map.removeLayer('komoot-edit-line');
        if (map.getSource('komoot-edit-route')) map.removeSource('komoot-edit-route');
    }
};