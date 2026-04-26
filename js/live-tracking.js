let fleetRefreshTimer = null;
let liveFleetMarkers = {}; // Stores the Emoji HTML markers

// 1. Toggle the UI Panel
window.toggleFleetPanel = function () {
    const panel = document.getElementById('fleet-panel');
    const isHidden = panel.classList.contains('hidden');

    if (isHidden) {
        panel.classList.remove('hidden');
        fetchFleetDirectory();
        startFleetTelemetry(); // Start pinging map data
    } else {
        panel.classList.add('hidden');
        if (fleetRefreshTimer) clearInterval(fleetRefreshTimer);
    }
};

window.zoomToGuide = function (guideId) {
    const marker = liveFleetMarkers[guideId];
    if (marker) {
        const coords = marker.getLngLat();
        map.flyTo({ center: coords, zoom: 16, duration: 1500 });

        // Close mobile panel if we are on field.html
        const mobilePanel = document.getElementById('fleet-panel-mobile');
        if (mobilePanel) mobilePanel.style.display = 'none';
    } else {
        alert("Location not found yet. Wait for the next GPS ping.");
    }
};

window.fetchFleetDirectory = async function () {
    try {
        const res = await fetch(`${API_URL}/api/fleet/devices`);
        const devices = await res.json();

        // Target either the desktop list or the mobile list depending on the app
        const list = document.getElementById('fleet-device-list') || document.getElementById('field-fleet-list');
        if (!list) return;

        list.innerHTML = '';

        devices.forEach(d => {
            const card = document.createElement('div');
            card.style.cssText = `background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); transition: opacity 0.2s; cursor: pointer;`;
            if (!d.is_visible) card.style.opacity = '0.6';

            // Add the click-to-fly handler to the main card area
            card.onclick = () => window.zoomToGuide(d.id);

            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: bold; color: #1e293b; font-size: 1.05em;">
                        ${d.icon || '🏃‍♂️'} ${d.display_name}
                    </div>
                    <button onclick="event.stopPropagation(); toggleDeviceVisibility(${d.id}, ${!d.is_visible})" style="background: none; border: none; cursor: pointer; font-size: 1.2em;" title="Toggle Map Visibility">
                        ${d.is_visible ? '👁️' : '🙈'}
                    </button>
                </div>

                <div style="font-size: 0.85em; color: #3498db; font-weight: bold;">📍 Tap to Zoom to Location</div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 5px;" onclick="event.stopPropagation()">
                    <div>
                        <label style="font-size: 0.75em; font-weight:bold; color:#94a3b8;">Name</label>
                        <input type="text" value="${d.display_name}" onblur="updateDevice(${d.id}, 'display_name', this.value)" style="width:100%; padding:4px 8px; border:1px solid #ddd; border-radius:4px; font-size:0.9em;">
                    </div>
                    <div>
                        <label style="font-size: 0.75em; font-weight:bold; color:#94a3b8;">Color Trail</label>
                        <input type="color" value="${d.color}" onchange="updateDevice(${d.id}, 'color', this.value)" style="width:100%; height:26px; border:none; padding:0; border-radius:4px; cursor:pointer;">
                    </div>
                </div>
            `;
            list.appendChild(card);
        });
    } catch (err) {
        console.error("Failed to load fleet:", err);
    }
};

window.updateDevice = async function (id, field, value) {
    let payload = {};
    payload[field] = value;
    try {
        await authFetch(`${API_URL}/api/fleet/devices/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        fetchFleetDirectory();
        forceFleetUpdate(); // Instantly update map
    } catch (err) { alert("Update failed: " + err.message); }
};

window.toggleDeviceVisibility = function (id, isVisible) {
    updateDevice(id, 'is_visible', isVisible);
};

// 3. The Map Rendering Engine
window.forceFleetUpdate = function () {
    fetchAndDrawTelemetry();
};

function startFleetTelemetry() {
    if (fleetRefreshTimer) clearInterval(fleetRefreshTimer);
    fetchAndDrawTelemetry();
    // Poll every 10 seconds
    fleetRefreshTimer = setInterval(fetchAndDrawTelemetry, 10000);
}

async function fetchAndDrawTelemetry() {
    const minutes = document.getElementById('fleet-time-filter')?.value || 60;

    try {
        const res = await fetch(`${API_URL}/api/fleet/telemetry?minutes=${minutes}`);
        const data = await res.json();

        // Group data by guide_id
        const paths = {};
        data.forEach(point => {
            if (!paths[point.guide_id]) {
                paths[point.guide_id] = {
                    coords: [],
                    color: point.color,
                    icon: point.icon || '📍',
                    icon_size: point.icon_size || 28,
                    name: point.display_name
                };
            }
            paths[point.guide_id].coords.push([point.lng, point.lat]);
        });

        const lineFeatures = [];
        const activeIds = Object.keys(paths);

        activeIds.forEach(id => {
            const track = paths[id];

            // 1. Draw the Tail (LineString)
            if (track.coords.length > 1) {
                lineFeatures.push({
                    type: 'Feature',
                    properties: { color: track.color, name: track.name },
                    geometry: { type: 'LineString', coordinates: track.coords }
                });
            }

            // 2. Draw the Live Avatar (Mapbox HTML Marker)
            const latestCoord = track.coords[track.coords.length - 1];

            if (!liveFleetMarkers[id]) {
                const el = document.createElement('div');
                el.className = 'fleet-avatar-pin';

                // Creates a circular pulsing pin with the Emoji inside
                el.innerHTML = `
                    <div style="
                        background-color: ${track.color};
                        width: ${track.icon_size}px;
                        height: ${track.icon_size}px;
                        border-radius: 50%;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        border: 2px solid white;
                        box-shadow: 0 0 15px ${track.color}80;
                        font-size: ${Math.max(12, track.icon_size - 10)}px;
                        animation: pulse-ring 2s infinite;
                    ">
                        ${track.icon}
                    </div>
                    <div style="
                        position: absolute;
                        top: -22px;
                        left: 50%;
                        transform: translateX(-50%);
                        background: rgba(15, 23, 42, 0.85);
                        color: white;
                        padding: 2px 8px;
                        border-radius: 4px;
                        font-size: 11px;
                        font-weight: bold;
                        white-space: nowrap;
                    ">${track.name}</div>
                `;

                liveFleetMarkers[id] = new mapboxgl.Marker({ element: el })
                    .setLngLat(latestCoord)
                    .addTo(map);
            } else {
                liveFleetMarkers[id].setLngLat(latestCoord);
            }
        });

        // Remove markers for devices that went offline or were hidden
        Object.keys(liveFleetMarkers).forEach(id => {
            if (!activeIds.includes(id)) {
                liveFleetMarkers[id].remove();
                delete liveFleetMarkers[id];
            }
        });

        // 3. Update Mapbox Native Line Source
        const geojson = { type: 'FeatureCollection', features: lineFeatures };

        if (map.getSource('fleet-tails')) {
            map.getSource('fleet-tails').setData(geojson);
        } else {
            map.addSource('fleet-tails', { type: 'geojson', data: geojson });
            map.addLayer({
                id: 'fleet-tails-layer',
                type: 'line',
                source: 'fleet-tails',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': 4,
                    'line-opacity': 0.7
                }
            });
        }

    } catch (err) { console.error("Telemetry Error:", err); }
}