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
        const [devRes, logRes] = await Promise.all([
            fetch(`${API_URL}/api/fleet/devices`),
            fetch(`${API_URL}/api/fleet/logs`)
        ]);
        const devices = await devRes.json();
        const logs = await logRes.json();

        // Target either the desktop list or the mobile list depending on the app
        const list = document.getElementById('fleet-device-list') || document.getElementById('field-fleet-list');
        if (!list) return;

        list.innerHTML = '';

        devices.forEach(d => {
            const lastLog = logs.find(l => 
                l.guide_id.toLowerCase() === d.device_identifier?.toLowerCase() || 
                l.display_name === d.display_name || 
                l.guide_id == d.id
            );

            const card = document.createElement('div');
            card.style.cssText = `background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); transition: opacity 0.2s; cursor: pointer;`;
            if (!d.is_visible) card.style.opacity = '0.6';

            // Add the click-to-fly handler to the main card area
            card.onclick = () => window.zoomToGuide(d.id);

            card.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: bold; color: #1e293b; font-size: 1.05em;">
                        ${(d.icon && d.icon.startsWith('ph-')) ? `<i class="ph ${d.icon}"></i>` : (d.icon || '🏃‍♂️')} ${d.display_name}
                    </div>
                    <div style="display: flex; gap: 5px;">
                        <button onclick="event.stopPropagation(); showDeviceDebug('${d.device_identifier || d.id}')" style="background: #f1f5f9; border: none; cursor: pointer; padding: 4px 8px; border-radius: 4px; font-size: 0.8em; color: #64748b;" title="Debug History">
                            🐞 Debug
                        </button>
                        <button onclick="event.stopPropagation(); toggleDeviceVisibility(${d.id}, ${!d.is_visible})" style="background: none; border: none; cursor: pointer; font-size: 1.2em;" title="Toggle Map Visibility">
                            ${d.is_visible ? '<i class="ph ph-eye"></i>' : '<i class="ph ph-eye-slash"></i>'}
                        </button>
                    </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 0.85em; color: #3498db; font-weight: bold;"><i class="ph ph-map-pin"></i> Tap to Zoom</div>
                    <div style="font-size: 0.75em; color: #94a3b8;">
                        Fuente: <span style="color: ${lastLog?.source === 'traccar' ? '#3498db' : '#e67e22'}; font-weight: bold;">${lastLog?.source || '---'}</span>
                    </div>
                </div>

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
                    icon: point.icon || 'ph-map-pin',
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

            // Calculate minutes since last ping
            const lastPoint = data.filter(p => p.guide_id == id).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
            const lastPing = new Date(lastPoint.timestamp);
            const now = new Date();
            const diffMinutes = Math.floor((now - lastPing) / 60000);
            const timeLabel = diffMinutes < 1 ? 'Just now' : `${diffMinutes}m ago`;

            // Generate the popup HTML
            const popupHtml = `
                <div style="text-align: center; padding: 5px; min-width: 160px; font-family: 'DM Sans', sans-serif;">
                    <strong style="display:block; font-size: 1.1em; color: #0f172a; margin-bottom: 2px;">${track.name}</strong>
                    <span style="display:block; font-size: 0.85em; color: ${diffMinutes > 15 ? '#ef4444' : '#10b981'}; margin-bottom: 5px; font-weight: bold;">
                        ${timeLabel}
                    </span>
                    <div style="font-size: 0.8em; color: #64748b; margin-bottom: 8px; border-top: 1px solid #f1f5f9; padding-top: 5px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                            <span>Fuente:</span>
                            <span style="font-weight: bold; color: ${lastPoint.source === 'traccar' ? '#3498db' : '#e67e22'};">${lastPoint.source || '---'}</span>
                        </div>
                        ${lastPoint.speed > 0 ? `
                        <div style="display: flex; justify-content: space-between;">
                            <span>Velocidad:</span>
                            <span style="font-weight: bold; color: #1e293b;">${Math.round(lastPoint.speed * 1.852)} km/h</span>
                        </div>` : ''}
                        ${lastPoint.altitude ? `
                        <div style="display: flex; justify-content: space-between;">
                            <span>Altitud:</span>
                            <span style="font-weight: bold; color: #1e293b;">${Math.round(lastPoint.altitude)} m</span>
                        </div>` : ''}
                    </div>
                    <button onclick="window.open('https://www.google.com/maps/search/?api=1&query=${latestCoord[1]},${latestCoord[0]}', '_blank')" style="background:#10b981; color:white; border:none; padding:8px 12px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:0.9em; width:100%; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.2);">
                        🗺️ Navigate
                    </button>
                </div>
            `;

            if (!liveFleetMarkers[id]) {
                const el = document.createElement('div');
                el.className = 'fleet-avatar-wrapper'; 
                el.style.transition = 'transform 0.2s ease-out';

                el.innerHTML = `
                    <div class="fleet-avatar-pin" style="
                        background-color: ${track.color};
                        width: ${track.icon_size}px;
                        height: ${track.icon_size}px;
                        border-radius: 50%;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        border: 2px solid white;
                        box-shadow: 0 0 10px ${track.color}80;
                        font-size: ${Math.max(12, track.icon_size - 10)}px;
                    ">
                        ${track.icon && track.icon.startsWith('ph-') ? `<i class="ph ${track.icon}"></i>` : (track.icon || '🏃‍♂️')}
                    </div>
                    <div class="fleet-label-container" style="
                        position: absolute;
                        top: -35px;
                        left: 50%;
                        transform: translateX(-50%);
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                    ">
                        <div style="background: rgba(15, 23, 42, 0.9); color: white; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; white-space: nowrap;">
                            ${track.name}
                        </div>
                        <div class="recency-label" style="background: ${diffMinutes > 15 ? '#ef4444' : '#10b981'}; color: white; padding: 1px 5px; border-radius: 3px; font-size: 8px; margin-top: 2px; white-space: nowrap;">
                            ${timeLabel}
                        </div>
                    </div>
                `;

                liveFleetMarkers[id] = new mapboxgl.Marker({ element: el })
                    .setLngLat(latestCoord)
                    .setPopup(new mapboxgl.Popup({ offset: 35 }).setHTML(popupHtml))
                    .addTo(map);
            } else {
                liveFleetMarkers[id].setLngLat(latestCoord);
                const existingPopup = liveFleetMarkers[id].getPopup();
                if (existingPopup) existingPopup.setHTML(popupHtml);

                const label = liveFleetMarkers[id].getElement().querySelector('.recency-label');
                if (label) {
                    label.innerText = timeLabel;
                    label.style.background = diffMinutes > 15 ? '#ef4444' : '#10b981';
                }
            }
        });

        Object.keys(liveFleetMarkers).forEach(id => {
            if (!activeIds.includes(id)) {
                liveFleetMarkers[id].remove();
                delete liveFleetMarkers[id];
            }
        });

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

window.showDeviceDebug = async function (identifier) {
    try {
        const res = await fetch(`${API_URL}/api/fleet/history/${identifier}`);
        const history = await res.json();

        const modal = document.createElement('div');
        modal.id = 'debug-modal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 9999;
            display: flex; justify-content: center; align-items: center;
        `;
        
        const content = document.createElement('div');
        content.style.cssText = `
            background: white; width: 90%; max-width: 800px; max-height: 80%;
            border-radius: 12px; padding: 20px; overflow-y: auto; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);
        `;
        
        content.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 10px;">
                <h3 style="margin: 0; font-family: 'DM Sans', sans-serif;">🐞 Debug History: ${identifier}</h3>
                <button onclick="document.getElementById('debug-modal').remove()" style="background: #ef4444; color: white; border: none; padding: 5px 10px; border-radius: 6px; cursor: pointer;">Close</button>
            </div>
            <table style="width: 100%; border-collapse: collapse; font-family: 'DM Sans', sans-serif; font-size: 0.9em;">
                <thead>
                    <tr style="background: #f8fafc; text-align: left;">
                        <th style="padding: 10px; border-bottom: 2px solid #e2e8f0;">Timestamp</th>
                        <th style="padding: 10px; border-bottom: 2px solid #e2e8f0;">Fuente</th>
                        <th style="padding: 10px; border-bottom: 2px solid #e2e8f0;">Coords</th>
                        <th style="padding: 10px; border-bottom: 2px solid #e2e8f0;">Vel (km/h)</th>
                        <th style="padding: 10px; border-bottom: 2px solid #e2e8f0;">Alt (m)</th>
                    </tr>
                </thead>
                <tbody>
                    ${history.length > 0 ? history.map(h => `
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px;">${new Date(h.timestamp).toLocaleString()}</td>
                            <td style="padding: 10px;">
                                <span style="padding: 2px 6px; border-radius: 4px; color: white; font-weight: bold; font-size: 0.8em; background: ${h.source === 'traccar' ? '#3498db' : '#e67e22'};">
                                    ${h.source === 'traccar' ? '🟦 Traccar' : '🟧 App'}
                                </span>
                            </td>
                            <td style="padding: 10px; color: #64748b; font-family: monospace;">${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}</td>
                            <td style="padding: 10px;">${h.speed ? Math.round(h.speed * 1.852) : '---'}</td>
                            <td style="padding: 10px;">${h.altitude ? Math.round(h.altitude) : '---'}</td>
                        </tr>
                    `).join('') : '<tr><td colspan="5" style="text-align: center; padding: 20px;">No logs found for this device.</td></tr>'}
                </tbody>
            </table>
        `;
        
        modal.appendChild(content);
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    } catch (err) { alert("Failed to load debug history: " + err.message); }
};
