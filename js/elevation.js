let elevationHoverMarker = null;
let currentElevationTrackId = null;

function createIconCanvas(iconClass, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    
    // Draw background circle
    ctx.beginPath();
    ctx.arc(16, 16, 15, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Get the character from Phosphor icon class
    const temp = document.createElement('i');
    temp.className = `ph ${iconClass}`;
    temp.style.position = 'absolute';
    temp.style.visibility = 'hidden';
    document.body.appendChild(temp);
    const char = window.getComputedStyle(temp, ':before').content.replace(/['"]/g, '');
    document.body.removeChild(temp);

    ctx.fillStyle = '#ffffff';
    ctx.font = '18px "Phosphor"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(char, 16, 16);
    
    return canvas;
}

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

    const waypointData = new Array(coords.length).fill(null);
    const waypointMeta = new Array(coords.length).fill(null);
    const customPointStyles = new Array(coords.length).fill('circle');
    const pointRadii = new Array(coords.length).fill(0);
    const pointBgColors = new Array(coords.length).fill('transparent');
    const pointBorderColors = new Array(coords.length).fill('transparent');
    const waypointSequence = new Array(coords.length).fill(null);

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

    const task = AppStore.get('itinerary').find(t => t.task_id === AppStore.get('activeTaskId'));

    if (task && task.geometries && geojson.features[0].geometry.type !== 'Polygon') {
        let seq = 1;
        task.geometries.forEach(g => {
            if (g.kind === 'point' && g.lng && g.lat) {
                let minDist = Infinity;
                let nearestIdx = 0;
                const pt = turf.point([g.lng, g.lat]);
                coords.forEach((c, idx) => {
                    const d = turf.distance(pt, turf.point(c));
                    if (d < minDist) { minDist = d; nearestIdx = idx; }
                });

                // Use increased minDist threshold or rely on title for identification
                if (minDist < 5) {
                    const match = g.title.match(/^(\d+)/);
                    const seqNum = match ? match[1] : seq++;
                    
                    waypointData[nearestIdx] = elevations[nearestIdx];
                    waypointMeta[nearestIdx] = {
                        title: g.title,
                        icon: g.icon || 'ph-map-pin',
                        lng: g.lng,
                        lat: g.lat,
                        x: distances[nearestIdx],
                        color: g.color || '#e74c3c'
                    };
                    waypointSequence[nearestIdx] = seqNum;
                    customPointStyles[nearestIdx] = createIconCanvas(g.icon || 'ph-map-pin', g.color || '#e74c3c');
                    pointRadii[nearestIdx] = 15;
                    pointBgColors[nearestIdx] = g.color || '#e74c3c';
                    pointBorderColors[nearestIdx] = '#ffffff';
                }
            }
        });
    }

    const existingChart = Chart.getChart('elevation-chart');
    if (existingChart) existingChart.destroy();

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
                    pointRadius: pointRadii,
                    pointHoverRadius: 10,
                    pointBackgroundColor: pointBgColors,
                    pointBorderColor: pointBorderColors,
                    pointBorderWidth: 2,
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
                    backgroundColor: 'rgba(52, 152, 219, 0.2)',
                    segment: { backgroundColor: ctx => (Math.floor(distances[ctx.p1DataIndex]) % 2 === 0 ? 'rgba(52, 152, 219, 0.3)' : 'rgba(41, 128, 185, 0.5)') }
                }
            ]
        },
        plugins: [{
            id: 'waypointLabels',
            afterDatasetsDraw: (chart) => {
                const { ctx, data } = chart;
                ctx.save();
                // Find the waypoint dataset
                const waypointDatasetIndex = data.datasets.findIndex(d => d.label === 'Waypoints');
                if (waypointDatasetIndex === -1) return;
                
                data.datasets[waypointDatasetIndex].data.forEach((value, i) => {
                    if (value !== null && waypointSequence[i] !== null) {
                        const meta = chart.getDatasetMeta(waypointDatasetIndex);
                        const point = meta.data[i];
                                if (point) {
                                    ctx.font = 'bold 12px DM Sans';
                                    ctx.textAlign = 'center';
                                    
                                    // White Halo for legibility
                                    ctx.strokeStyle = '#ffffff';
                                    ctx.lineWidth = 3;
                                    ctx.strokeText(waypointSequence[i], point.x, point.y - 32);
                                    
                                    // Dark text (--bg-main)
                                    ctx.fillStyle = '#0f172a';
                                    ctx.fillText(waypointSequence[i], point.x, point.y - 32);
                                }
                    }
                });
                ctx.restore();
            }
        }],
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
                                if (meta) return `${meta.title} (at ${meta.x}km)`;
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
                if (activeElements.length === 0) {
                    // Check if clicked on the chart area (near the line)
                    const points = window.elevationChart.getElementsAtEventForMode(e, 'index', { intersect: false }, true);
                    if (points.length > 0) {
                        const index = points[0].index;
                        const activeCoord = coords[index];
                        const dist = distances[index];
                        const gain = cumulativeGains[index];
                        
                        activeParentTrackId = trackId;
                        showGeometryContextPopup([activeCoord[0], activeCoord[1]], { type: 'Point', coordinates: [activeCoord[0], activeCoord[1]] }, `KM ${dist}`, `<i class="ph ph-ruler"></i> ${dist}km | <i class="ph ph-trend-up"></i> +${gain}m`, null, 'ph-map-pin');
                        return;
                    }
                }

                if (activeElements.length > 0) {
                    const element = activeElements[0];
                    if (element.datasetIndex === 0) {
                        // CLICKED EXISTING WAYPOINT
                        const wp = waypointMeta[element.index];
                        if (wp) {
                            map.flyTo({ center: [wp.lng, wp.lat], zoom: 17 });
                            statsHeader.innerHTML = `<span style="color:#e67e22;"><i class="ph ${wp.icon}"></i> <strong>${wp.title}</strong></span> <span style="margin-left:15px; color:#666;">at ${wp.x}km</span> <button onclick="refreshData()" style="width:auto; padding:2px 8px; margin-left:10px; font-size:10px; background:#95a5a6;">Reset View</button>`;
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

                        // CRITICAL FIX: Ensure exact variable match to index.html's let declaration
                        activeParentTrackId = trackId;

                        showGeometryContextPopup([activeCoord[0], activeCoord[1]], { type: 'Point', coordinates: [activeCoord[0], activeCoord[1]] }, `KM ${dist}`, `<i class="ph ph-ruler"></i> ${dist}km | <i class="ph ph-trend-up"></i> +${gain}m`, null, 'ph-map-pin');
                    }
                }
            },
            scales: {
                y: { beginAtZero: false, ticks: { color: '#000', font: { weight: 'bold' } } },
                x: { 
                    grid: { color: (c) => (parseFloat(distances[c.index]) % 1 === 0 ? 'rgba(56, 189, 248, 0.8)' : 'rgba(0,0,0,0)'), lineWidth: (c) => (parseFloat(distances[c.index]) % 1 === 0 ? 3 : 0) },
                    ticks: { font: { size: 12, weight: 'bold' }, color: '#000' }
                }
            }
        }
    });
}