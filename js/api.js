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
        const pass = prompt("Enter Admin Password:");
        if (!pass) return;
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
            return;
        }
    }
    options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${AUTH_TOKEN}`
    };
    return fetch(url, options);
}

async function refreshData() {
    const previousActiveId = AppStore.get('activeTaskId');
    try {
        const [itRes, secRes, catRes, typeRes] = await Promise.all([
            fetch(`${API_URL}/itinerary`),
            fetch(`${API_URL}/sections`),
            fetch(`${API_URL}/categories`),
            fetch(`${API_URL}/task_types`)
        ]);
        AppStore.set('itinerary', await itRes.json());
        AppStore.set('sections', await secRes.json());
        allCategories = await catRes.json();
        allTaskTypes = await typeRes.json();

        renderSectionPills();
        updateCategoryDropdowns();
        updateSectionDropdowns();
        updateTaskTypeDropdowns();
        renderCategoryList();
        renderTaskTypeList();

        if (previousActiveId) AppStore.set('activeTaskId', previousActiveId);
        renderProjectView();
        renderMapGeometries();
    } catch (err) {
        console.error("Critical Sync Failure:", err);
    }
}
