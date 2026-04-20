const KomootEngine = {
    // Added editMeta to state
    state: { intersections: [], segments: [], markers: [], currentFileName: '', isListenerAdded: false, editMeta: null },

    // --- UPDATE in js/route-editor.js ---
    handleGpxUpload: function (file) {
        const reader = new FileReader();
        const currentTask = AppStore.get('activeTaskId');

        reader.onload = async (event) => {
            try {
                const gpxXml = new DOMParser().parseFromString(event.target.result, "text/xml");
                const geojson = toGeoJSON.gpx(gpxXml);
                if (geojson && geojson.features.length > 0) {
                    showToast("Packaging GPX for Editor...", "info");

                    // 1. Package it as a brand new track
                    const editContext = {
                        taskId: currentTask,
                        trackId: null, // Signals it is a new track
                        title: file.name.replace('.gpx', ''),
                        color: '#8e44ad', // Distinct color for uploaded tracks
                        geojson: geojson,
                        parentTrackId: null
                    };

                    // 2. Put in short-term memory
                    sessionStorage.setItem('expedition_edit_context', JSON.stringify(editContext));

                    // 3. Redirect to the editor to process and save it
                    window.location.href = 'editor.html';
                } else {
                    alert("No valid route data found in GPX file.");
                }
            } catch (err) {
                console.error(err);
                alert("Failed to parse GPX file.");
            }
        };
        reader.readAsText(file);
    },

    initFromGpx: async function (feature, fileName, editMeta = null) {
        if (typeof draw !== 'undefined' && draw && typeof draw.deleteAll === 'function') {
            draw.deleteAll();
        }
        this.cleanup();
        this.state.currentFileName = fileName || 'Edited Route';
        this.state.editMeta = editMeta; 

        // Simplify to get control points for the editor
        const simplified = turf.simplify(feature, { tolerance: 0.0005, highQuality: true });
        let simpCoords = simplified.geometry.coordinates;
        if (feature.geometry.type === 'Polygon') simpCoords = simpCoords[0];
        
        this.state.intersections = simpCoords.map((c, i) => ({ id: Date.now() + i, lngLat: [c[0], c[1]], z: c[2] || 0 }));
        
        const origCoords = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates;
        
        // FIX: Switchback Corruption Bug. 
        // turf.lineSlice snaps to the geometrically closest point, which scrambles switchback trails.
        // Instead, we find the exact array indices of the simplified points to slice chronologically.
        let origIdx = 0;
        const intersectionIndices = [];
        
        for (let pt of this.state.intersections) {
            let found = -1;
            let minDist = Infinity;
            
            // Search forward to maintain strict chronological order
            for (let i = origIdx; i < origCoords.length; i++) {
                const dist = Math.pow(origCoords[i][0] - pt.lngLat[0], 2) + Math.pow(origCoords[i][1] - pt.lngLat[1], 2);
                if (dist < 1e-10) { // Practically identical
                    found = i;
                    break;
                }
                if (dist < minDist) {
                    minDist = dist;
                    found = i;
                }
            }
            
            // Fallback search if exact sequence was broken
            if (found === -1 || minDist > 1e-8) {
                minDist = Infinity;
                for (let i = 0; i < origCoords.length; i++) {
                    const dist = Math.pow(origCoords[i][0] - pt.lngLat[0], 2) + Math.pow(origCoords[i][1] - pt.lngLat[1], 2);
                    if (dist < minDist) {
                        minDist = dist;
                        found = i;
                    }
                }
            }
            
            intersectionIndices.push(found);
            if (found !== -1 && found >= origIdx) origIdx = found; 
        }

        this.state.segments = [];
        for (let i = 0; i < this.state.intersections.length - 1; i++) {
            let sliceStart = intersectionIndices[i];
            let sliceEnd = intersectionIndices[i + 1];
            
            let slicedCoords = [];
            // Slice the array directly to guarantee 100% preservation of 3D Z-coordinates and chronological order
            if (sliceStart !== -1 && sliceEnd !== -1 && sliceEnd >= sliceStart) {
                slicedCoords = origCoords.slice(sliceStart, sliceEnd + 1);
            } else {
                // Failsafe
                slicedCoords = [this.state.intersections[i].lngLat, this.state.intersections[i+1].lngLat];
            }

            this.state.segments.push({ 
                id: Date.now() + i + 100, 
                type: 'imported', // Locks the exact GPX shape
                startIdx: i, 
                endIdx: i + 1, 
                geometry: { type: 'LineString', coordinates: slicedCoords }
            });
        }
        
        await this.refreshAllSegments();
        
        const bbox = turf.bbox(feature);
        map.fitBounds(bbox, { padding: 50 });
        
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
        return 'smart';
    },

    refreshAllSegments: async function () {
        let totalGain = 0; let totalLoss = 0;
        for (let sIdx = 0; sIdx < this.state.segments.length; sIdx++) {
            const seg = this.state.segments[sIdx];
            const startNode = this.state.intersections[seg.startIdx];
            const endNode = this.state.intersections[seg.endIdx];
            const startLngLat = startNode.lngLat;
            const endLngLat = endNode.lngLat;

            if (seg.type === 'imported' && seg.geometry) {
                // Keep exact GPX geometry, no Mapbox API call needed
            } else if (seg.type === 'smart') {
                try {
                    const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${startLngLat.join(',')};${endLngLat.join(',')}?geometries=geojson&access_token=${mapboxgl.accessToken}`;
                    const res = await fetch(url);
                    const data = await res.json();
                    seg.geometry = data.routes[0].geometry;
                } catch (e) { seg.geometry = turf.lineString([startLngLat, endLngLat]).geometry; }
            } else {
                seg.geometry = turf.lineString([startLngLat, endLngLat]).geometry;
            }

            if (seg.geometry && seg.geometry.coordinates) {
                const coords = seg.geometry.coordinates;
                
                // Pre-calculate start and end Z for interpolation fallback
                const startZ = startNode.z || (sIdx > 0 ? (this.state.segments[sIdx-1].geometry?.coordinates.slice(-1)[0][2] || 0) : 0);
                const endZ = endNode.z || startZ;

                for (let i = 0; i < coords.length; i++) {
                    // Ensure Z coordinate exists. If Mapbox DEM fails (zoomed out/off-screen), interpolate!
                    if (coords[i].length < 3 || coords[i][2] === undefined || coords[i][2] === null) {
                        let z = map.queryTerrainElevation(coords[i]);
                        if (z === null) {
                            // Interpolate based on index ratio to prevent 0-meter cliffs
                            const ratio = coords.length > 1 ? (i / (coords.length - 1)) : 0;
                            z = startZ + (endZ - startZ) * ratio;
                        }
                        coords[i] = [coords[i][0], coords[i][1], z];
                    }
                    if (i > 0) {
                        const diff = coords[i][2] - coords[i - 1][2];
                        if (diff > 0) totalGain += diff; else totalLoss += Math.abs(diff);
                    }
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
                    'line-color': ['match', ['get', 'type'], 'smart', '#38bdf8', 'imported', '#8e44ad', '#94a3b8'],
                    'line-width': 5,
                    'line-dasharray': ['match', ['get', 'type'], 'smart', ['literal', [1, 2]], 'imported', ['literal', [1, 0]], ['literal', [1, 0]]]
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
                    <button onclick="KomootEngine.toggleSegmentMode(${i})" style="margin-bottom:5px; background:#3498db; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; width:100%;">Toggle Mode</button>
                    <button onclick="KomootEngine.deleteStop(${i})" style="margin-bottom:5px; background:#e74c3c; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; width:100%;">🗑️ Delete Stop</button>
                </div>
            `);

            const m = new mapboxgl.Marker({ element: el, draggable: true })
                .setLngLat(point.lngLat)
                .setPopup(popup)
                .addTo(map);

            m.on('dragend', async () => {
                const pos = m.getLngLat();
                this.state.intersections[i].lngLat = [pos.lng, pos.lat];
                
                // Break lock on adjacent segments if user drags a pin
                this.state.segments.forEach(seg => {
                    if (seg.startIdx === i || seg.endIdx === i) {
                        if (seg.type === 'imported') seg.type = 'smart'; // Auto-switch to smart if dragged
                    }
                });

                await this.refreshAllSegments();
                this.updateSavePopup();
            });
            this.state.markers.push(m);
        });
    },

    toggleSegmentMode: function (index) {
        if (this.state.segments[index]) {
            const seg = this.state.segments[index];
            if (seg.type === 'imported') {
                seg.type = 'smart'; // Unlocking imported segment
            } else {
                seg.type = seg.type === 'smart' ? 'manual' : 'smart';
            }
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