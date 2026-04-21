let elevationHoverMarker = null;
let currentElevationTrackId = null;

function showElevationProfile(geojson, title, metadata = null, trackId = null) {
    currentElevationTrackId = trackId;
    document.getElementById('elevation-panel').style.display = 'block';
    const statsHeader = document.getElementById('elevation-stats-header');
    const props = metadata || geojson.features?.[0]?.properties || {};

    const resetHeader = () => {
        statsHeader.innerHTML = `
            <span style="color:#000;">🏁 <strong>${title}</strong></span>
            <span style="color:#000;">📏 <strong>${props.distance || 0} km</strong></span>
            <span style="color:#27ae60;">▲ <strong>${props.gain || 0}m</strong></span>
            <span style="color:#e74c3c;">▼ <strong>${props.loss || 0}m</strong></span>
            ${props.duration ? `<span style="color:#000;">🕒 <strong>${props.duration} min</strong></span>` : ''}
        `;
    };
    resetHeader();

    let distances = [], elevations = [], cumulative = 0;
    let cumulativeGains = [], currentGain = 0;
    const coords = geojson.features[0].geometry.type === 'Polygon' ? geojson.features[0].geometry.coordinates[0] : geojson.features[0].geometry.coordinates;

    // Parallel arrays for Chart.js safe parsing
    const waypointData = new Array(coords.length).fill(null);
    const waypointMeta = new Array(coords.length).fill(null);
    const customPointStyles = new Array(coords.length).fill('circle');
    const pointRadii = new Array(coords.length).fill(0); // Hide non-waypoints safely

    coords.forEach((c, i) => {
        elevations.push(c[2] || 0);
        if (i > 0) {
            cumulative += turf.distance(turf.point(coords[i - 1]), turf.point(c), { units: 'kilometers' });
            const diff = (c[2] || 0) - (coords[i - 1][2] || 0);
            if (diff > 0) currentGain += diff;
        }
        distances.push(cumulative.toFixed(2));
        cumulativeGains.push(currentGain.toFixed(0));
    });

    // FIND WAYPOINTS: Locate all points belonging to the active task
    const task = AppStore.get('itinerary').find(t => t.task_id === AppStore.get('activeTaskId'));

    if (task && task.geometries && geojson.features[0].geometry.type !== 'Polygon') {
        task.geometries.forEach(g => {
            if (g.kind === 'point' && g.lng && g.lat) {
                let minDist = Infinity;
                let nearestIdx = 0;
                const pt = turf.point([g.lng, g.lat]);
                coords.forEach((c, idx) => {
                    const d = turf.distance(pt, turf.point(c));
                    if (d < minDist) { minDist = d; nearestIdx = idx; }
                });

                if (minDist < 5) { // Only snap if within 5km
                    const iconEmoji = (g.icon || '📍').split(' ')[0];
                    const canvas = document.createElement('canvas');
                    canvas.width = 24; canvas.height = 24;
                    const ctx = canvas.getContext('2d');
                    ctx.font = '18px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(iconEmoji, 12, 14);

                    // Strictly separate Chart data (Y-axis) from Metadata
                    waypointData[nearestIdx] = elevations[nearestIdx];
                    waypointMeta[nearestIdx] = {
                        title: g.title,
                        icon: g.icon || '📍',
                        lng: g.lng,
                        lat: g.lat,
                        x: distances[nearestIdx]
                    };
                    customPointStyles[nearestIdx] = canvas;
                    pointRadii[nearestIdx] = 12; // Make the icon visible
                }
            }
        });
    }

    // CRITICAL FIX: Aggressively destroy broken canvas instances via Chart registry
    const existingChart = Chart.getChart('elevation-chart');
    if (existingChart) {
        existingChart.destroy();
    }

    window.elevationChart = new Chart(document.getElementById('elevation-chart'), {
        type: 'line',
        data: {
            labels: distances,
            datasets: [
                {
                    label: 'Waypoints',
                    data: waypointData,
                    type: 'line',
                    showLine: false,
                    pointStyle: customPointStyles,
                    pointRadius: pointRadii, // Uses array to safely size points
                    pointHoverRadius: pointRadii,
                    backgroundColor: 'transparent',
                    borderColor: 'transparent',
                    zIndex: 10
                },
                {
                    label: title,
                    data: elevations,
                    fill: true,
                    tension: 0.4,
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.2)'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            if (context.dataset.label === 'Waypoints') {
                                const meta = waypointMeta[context.dataIndex];
                                if (meta) return `📍 ${meta.title}`;
                                return null;
                            }
                            return `Elev: ${context.parsed.y}m`;
                        }
                    }
                }
            },
            onHover: (event, activeElements) => {
                if (activeElements.length > 0) {
                    const index = activeElements[0].index;
                    const coord = coords[index];
                    if (!elevationHoverMarker) {
                        elevationHoverMarker = new mapboxgl.Marker({ color: '#f1c40f' })
                            .setLngLat([coord[0], coord[1]])
                            .addTo(map);
                    } else {
                        elevationHoverMarker.setLngLat([coord[0], coord[1]]);
                    }
                } else if (elevationHoverMarker) {
                    elevationHoverMarker.remove();
                    elevationHoverMarker = null;
                }
            },
            onClick: (e, activeElements) => {
                if (activeElements.length > 0) {
                    const element = activeElements[0];
                    if (element.datasetIndex === 0) {
                        // CLICKED EXISTING WAYPOINT
                        const wp = waypointMeta[element.index];
                        if (wp) {
                            map.flyTo({ center: [wp.lng, wp.lat], zoom: 17 });
                            statsHeader.innerHTML = `<span style="color:#e67e22;">📍 <strong>${wp.icon} ${wp.title}</strong></span> <span style="margin-left:15px; color:#666;">at ${wp.x}km</span> <button onclick="refreshData()" style="width:auto; padding:2px 8px; margin-left:10px; font-size:10px; background:#95a5a6;">Reset View</button>`;
                        }
                    } else {
                        // CLICKED LINE (CREATE NEW)
                        const index = element.index;
                        const activeCoord = coords[index];
                        if (typeof draw !== 'undefined') {
                            draw.deleteAll();
                            const feat = { type: 'Feature', geometry: { type: 'Point', coordinates: [activeCoord[0], activeCoord[1]] } };
                            draw.add(feat);
                        }
                        map.flyTo({ center: [activeCoord[0], activeCoord[1]], zoom: 15 });
                        const dist = distances[index];
                        const gain = cumulativeGains[index];
                        window.activeParentTrackId = trackId;
                        showGeometryContextPopup([activeCoord[0], activeCoord[1]], { type: 'Point', coordinates: [activeCoord[0], activeCoord[1]] }, `KM ${dist}`, `📏 ${dist}km | 🔺 +${gain}m`, null, '📍');
                    }
                }
            },
            scales: {
                y: { beginAtZero: false, ticks: { color: '#000', font: { weight: 'bold' } } },
                x: { ticks: { color: '#000', font: { weight: 'bold' } } }
            }
        }
    });
}