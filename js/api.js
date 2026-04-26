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
            const openContent = document.querySelector('.section-content:not(.collapsed)');
            const openSectionId = openContent ? openContent.closest('.asana-section').dataset.sectionId : null;
            const previousActiveId = AppStore.get('activeTaskId');
            const editingRowId = document.querySelector('.is-editing')?.id;

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
                updateResponsibleDropdown();
                renderProjectView();
                renderMapGeometries();

                // RESTORE INLINE EDIT STATE
                if (window.activeInlineEditId) {
                    const row = document.getElementById(window.activeInlineEditId);
                    if (row) {
                        row.classList.add('is-editing');
                        row.querySelectorAll('.modern-inline-input').forEach(inp => (inp.disabled = false));
                        row.querySelectorAll('.inline-edit').forEach(sp => (sp.contentEditable = true));
                    }
                }

                // Refresh Task Detail Panel if it is currently open
                const detailPanel = document.getElementById('task-detail-panel');
                if (detailPanel && detailPanel.classList.contains('open') && previousActiveId) {
                    const updatedTask = data.find(t => t.task_id === previousActiveId);
                    if (updatedTask) {
                        if (typeof openTaskDetailPanel === 'function') openTaskDetailPanel(updatedTask);
                    } else {
                        if (typeof closeTaskDetailPanel === 'function') closeTaskDetailPanel();
                    }
                }

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

window.processAiCommand = function() {
    // 1. Create the Modal UI Dynamically
    const modalId = 'ai-multimodal-assistant';
    if (document.getElementById(modalId)) document.getElementById(modalId).remove();

    const modal = document.createElement('div');
    modal.id = modalId;
    modal.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000000;
        display: flex; align-items: center; justify-content: center; padding: 20px;
    `;

    modal.innerHTML = `
        <div style="background: white; width: 100%; max-width: 400px; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.3); display: flex; flex-direction: column;">
            <div style="background: #0f172a; color: white; padding: 15px 20px; font-weight: bold; font-size: 1.1em; display: flex; justify-content: space-between; align-items: center;">
                <span>🤖 DeepSeek Logistics</span>
                <span onclick="document.getElementById('${modalId}').remove()" style="cursor: pointer; font-size: 1.2em;">×</span>
            </div>
            <div style="padding: 20px; display: flex; flex-direction: column; gap: 15px;">
                <textarea id="ai-prompt-text" rows="4" placeholder="What would you like to update? (e.g., 'Extract the flights from this image and add them to Day 1')" style="width: 100%; padding: 12px; border: 1px solid #cbd5e0; border-radius: 8px; font-family: inherit; resize: vertical; box-sizing: border-box;"></textarea>
                
                <div style="display: flex; align-items: center; gap: 10px;">
                    <input type="file" id="ai-image-upload" accept="image/*" style="display: none;">
                    <button onclick="document.getElementById('ai-image-upload').click()" style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e0; padding: 10px 15px; border-radius: 8px; cursor: pointer; font-weight: bold; flex-shrink: 0;">📸 Attach Photo</button>
                    <span id="ai-image-name" style="font-size: 0.85em; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">No image selected</span>
                </div>

                <button id="ai-submit-btn" style="background: #8b5cf6; color: white; border: none; padding: 14px; border-radius: 8px; font-weight: bold; font-size: 1.05em; cursor: pointer; box-shadow: 0 4px 10px rgba(139, 92, 246, 0.3);">Send to DeepSeek</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // 2. Handle File Selection
    let attachedFile = null;
    document.getElementById('ai-image-upload').addEventListener('change', function(e) {
        if (e.target.files.length > 0) {
            attachedFile = e.target.files[0];
            document.getElementById('ai-image-name').innerText = attachedFile.name;
        }
    });

    // 3. Handle Submission
    document.getElementById('ai-submit-btn').addEventListener('click', async function() {
        const promptText = document.getElementById('ai-prompt-text').value.trim();
        if (!promptText && !attachedFile) return alert("Please enter text or attach an image.");

        const btn = this;
        btn.innerText = "⏳ Processing...";
        btn.disabled = true;

        try {
            let uploadedImageUrl = null;

            // Upload the image to your existing Cloudinary setup first
            if (attachedFile) {
                if (typeof showToast === 'function') showToast("Uploading image...", "info");
                const formData = new FormData();
                formData.append('file', attachedFile);
                const uploadRes = await authFetch(`${API_URL}/api/upload`, { method: 'POST', body: formData });
                if (!uploadRes.ok) throw new Error("Failed to upload image");
                const uploadData = await uploadRes.json();
                uploadedImageUrl = uploadData.secure_url;
            }

            if (typeof showToast === 'function') showToast("🧠 DeepSeek is analyzing...", "info");

            // Send text and image URL to the backend
            const res = await authFetch(`${API_URL}/api/ai/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: promptText, imageUrl: uploadedImageUrl })
            });
            
            if (!res || res.status === 401) throw new Error("Unauthorized"); 
            const data = await res.json();
            
            if (data.error) throw new Error(data.error);
            
            if (typeof showToast === 'function') showToast(data.message, "success");
            else alert(data.message);
            
            modal.remove();
            if (typeof refreshData === 'function') refreshData();
            if (typeof loadData === 'function') loadData(); 
            
        } catch (err) {
            alert("AI Command Failed: " + err.message);
            btn.innerText = "Send to DeepSeek";
            btn.disabled = false;
        }
    });
};
