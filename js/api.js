let activeCategoryIdForEdit = null;
const API_URL = 'https://mapbox-api-uz9a.onrender.com';
let AUTH_TOKEN = sessionStorage.getItem('expedition_token');

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; bottom: 25px; right: 25px; z-index: 10000;
        padding: 14px 24px; border-radius: 12px; color: white;
        background: ${type === 'success' ? 'var(--success)' : (type === 'info' ? 'var(--accent)' : 'var(--danger)')};
        backdrop-filter: var(--glass-blur); box-shadow: var(--card-shadow);
        font-weight: 600; font-size: 0.95em; pointer-events: none;
        transition: opacity 0.4s ease, transform 0.4s ease;
        transform: translateY(20px); opacity: 0;
    `;
    toast.innerText = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.transform = 'translateY(0)';
        toast.style.opacity = '1';
    });
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

async function authFetch(url, options = {}) {
    if (!AUTH_TOKEN) {
        const pass = prompt("Session expired or missing. Enter Admin Password:");
        if (!pass) return new Response(null, { status: 401 }); // Safely abort if user cancels
        const res = await fetch(`${API_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pass })
        });
        const data = await res.json();
        if (data.token) {
            AUTH_TOKEN = data.token;
            sessionStorage.setItem('expedition_token', AUTH_TOKEN);
        } else {
            alert("Unauthorized: Incorrect Password");
            return new Response(null, { status: 401 });
        }
    }

    options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${AUTH_TOKEN}`
    };

    const response = await fetch(url, options);

    // --- NEW: Auto-Recovery for Expired Tokens (403) ---
    if (response.status === 403) {
        console.warn("Token expired. Requesting re-authentication...");
        AUTH_TOKEN = null;
        sessionStorage.removeItem('expedition_token');
        // Recursively call authFetch to prompt password and retry the exact same request
        return authFetch(url, options);
    }

    return response;
}

        async function refreshData() {
            // 1. Capture the currently open section before refreshing
            const openSection = document.querySelector('.asana-section:not(.collapsed)');
            const openSectionId = openSection ? openSection.dataset.sectionId : null;
            const previousActiveId = AppStore.get('activeTaskId');

            try {
                const [itRes, secRes, catRes, typeRes] = await Promise.all([
                    fetch(`${API_URL}/itinerary`),
                    fetch(`${API_URL}/sections`),
                    fetch(`${API_URL}/categories`),
                    fetch(`${API_URL}/task_types`)
                ]);

                const data = await itRes.json();
                console.log("📡 Itinerary Refreshed. Items found:", data.length);
                AppStore.set('itinerary', data); // This triggers the map re-render
                AppStore.set('sections', await secRes.json());
                allCategories = await catRes.json();
                allTaskTypes = await typeRes.json();

                // 2. Re-render the UI
                renderSectionPills();
                updateCategoryDropdowns();
                updateSectionDropdowns();
                updateTaskTypeDropdowns();

                updateResponsibleDropdown();

                renderCategoryList();
                renderTaskTypeList();
                renderProjectView();
                renderMapGeometries();

        // 3. FORCE the previously open section to expand again
        if (openSectionId) {
            const strId = String(openSectionId);
            const targetSection = document.querySelector(`.asana-section[data-section-id="${strId}"]`);
            if (targetSection) {
                const content = targetSection.querySelector('.section-content');
                const icon = targetSection.querySelector('.section-toggle-icon');
                if (content) content.classList.remove('collapsed');
                if (icon) icon.classList.remove('collapsed');
            }
        }

        if (previousActiveId) AppStore.set('activeTaskId', previousActiveId);

        // --- STATE RECOVERY BREADCRUMB ---
        const returnTaskId = sessionStorage.getItem('return_to_task');
        if (returnTaskId) {
            sessionStorage.removeItem('return_to_task');
            setTimeout(() => {
                const tId = parseInt(returnTaskId);
                focusTaskInSidebar(tId);
                const task = AppStore.get('itinerary').find(t => t.task_id === tId);
                if (task) {
                    openTaskDetailPanel(task);
                    const features = [];
                    task.geometries.forEach(g => {
                        if (g.kind === 'point' && g.lat) features.push(turf.point([g.lng, g.lat]));
                        else if (g.geojson) features.push(...g.geojson.features);
                    });
                    if (features.length > 0) {
                        const bbox = turf.bbox(turf.featureCollection(features));
                        map.fitBounds(bbox, { padding: 80, maxZoom: 16, duration: 1200 });
                    }
                }
            }, 600); // Slight delay allows map and UI to finish rendering first
        }
    } catch (err) {
        console.error("Critical Sync Failure:", err);
    }
}
