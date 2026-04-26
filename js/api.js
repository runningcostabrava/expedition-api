let activeCategoryIdForEdit = null;
const API_URL = 'https://mapbox-api-uz9a.onrender.com';
let AUTH_TOKEN = sessionStorage.getItem('expedition_token');

let aiConversationMemory = [];

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

// Function to ensure Mapbox recalculates its canvas size smoothly during CSS transitions
function smoothMapResize() {
    if (typeof map === 'undefined' || !map.resize) return;
    const interval = setInterval(() => map.resize(), 30);
    setTimeout(() => clearInterval(interval), 350); // Stop after CSS transition ends
}

window.closeAiChat = function() {
    const modal = document.getElementById('ai-multimodal-assistant');
    if (modal) {
        modal.classList.add('ai-chat-hidden');
        document.body.classList.remove('ai-chat-open'); // Restore map width
        smoothMapResize();
        
        setTimeout(() => { modal.style.display = 'none'; }, 300);
    }
};

window.openAiChat = function() {
    const modalId = 'ai-multimodal-assistant';
    
    // 1. STATE PRESERVATION: If chat exists, slide it back in
    const existingModal = document.getElementById(modalId);
    if (existingModal) {
        existingModal.style.display = 'flex';
        document.body.classList.add('ai-chat-open'); // Shrink map width
        smoothMapResize();
        
        setTimeout(() => {
            existingModal.classList.remove('ai-chat-hidden');
            document.getElementById('ai-prompt-text').focus();
        }, 10);
        return;
    }

    // 2. INJECT DOCKED & RESPONSIVE STYLES
    if (!document.getElementById('ai-chat-styles')) {
        const style = document.createElement('style');
        style.id = 'ai-chat-styles';
        style.innerHTML = `
            /* Smooth transitions for the UI elements being pushed */
            #map-wrapper, #mobile-fab-container, #right-panel, #fleet-panel {
                transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
            }

            #ai-multimodal-assistant {
                position: fixed;
                z-index: 1000000;
                display: flex;
                transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s;
            }
            #ai-multimodal-assistant.ai-chat-hidden {
                opacity: 0;
            }
            .ai-chat-box {
                background: #f8fafc;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                pointer-events: auto; /* Chat is always clickable */
            }
            
            /* DESKTOP: True Docked Panel */
            @media (min-width: 769px) {
                #ai-multimodal-assistant {
                    top: 85px; 
                    right: 15px;
                    bottom: 15px; /* Matches left-panel height */
                    width: 400px;
                    pointer-events: none; /* Let clicks pass through background */
                }
                #ai-multimodal-assistant.ai-chat-hidden {
                    transform: translateX(450px);
                }
                .ai-chat-box {
                    width: 100%;
                    height: 100%;
                    border-radius: 16px;
                    border: 1px solid rgba(0,0,0,0.1);
                    box-shadow: 0 20px 40px rgba(0,0,0,0.4);
                }

                /* --- THE MAGIC: Shrink map and push UI when chat is open --- */
                body.ai-chat-open #map-wrapper {
                    right: 430px !important; /* Physically shrinks the map canvas */
                }
                body.ai-chat-open #mobile-fab-container,
                body.ai-chat-open #right-panel,
                body.ai-chat-open #fleet-panel {
                    right: 430px !important; /* Pushes floating buttons/panels left */
                }
            }
            
            /* MOBILE: Centered Modal */
            @media (max-width: 768px) {
                #ai-multimodal-assistant {
                    inset: 0;
                    background: rgba(0,0,0,0.5);
                    backdrop-filter: blur(4px);
                    align-items: center;
                    justify-content: center;
                    padding: 15px;
                    pointer-events: auto;
                }
                #ai-multimodal-assistant.ai-chat-hidden {
                    transform: translateY(100%);
                }
                .ai-chat-box {
                    width: 100%;
                    max-width: 450px;
                    height: 85vh;
                    max-height: 800px;
                    border-radius: 20px;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.4);
                }
            }
        `;
        document.head.appendChild(style);
    }

    // 3. BUILD THE UI
    const modal = document.createElement('div');
    modal.id = modalId;
    
    modal.innerHTML = `
        <div class="ai-chat-box">
            <div style="background: #0f172a; color: white; padding: 15px 20px; font-weight: bold; font-size: 1.1em; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <div style="width:34px; height:34px; background:#8b5cf6; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:1.2em;"><i class="ph ph-robot"></i></div>
                    <div style="display:flex; flex-direction:column;">
                        <span style="line-height:1.1;">DeepSeek Guide</span>
                        <span style="font-size:0.7em; color:#94a3b8; font-weight:normal;">Online</span>
                    </div>
                </div>
                <span onclick="window.closeAiChat()" style="cursor: pointer; font-size: 1.8em; line-height: 1; padding: 0 5px;"><i class="ph ph-x"></i></span>
            </div>

            <div id="ai-chat-history" style="flex: 1; overflow-y: auto; padding: 20px 15px; display: flex; flex-direction: column; gap: 15px; background: #e2e8f0; background-image: radial-gradient(#cbd5e0 1px, transparent 0); background-size: 20px 20px;">
                <div style="text-align: center; color: #64748b; font-size: 0.85em; margin-bottom: 10px; background: rgba(255,255,255,0.8); padding: 6px 12px; border-radius: 12px; align-self: center; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                    Chat started. I can update your itinerary, read receipts via OCR, or analyze map data! Try asking me to move a task.
                </div>
            </div>

            <div style="background: white; padding: 12px 15px; border-top: 1px solid #cbd5e0; display: flex; flex-direction: column; gap: 10px; flex-shrink: 0;">
                <div id="ai-attachment-preview" style="display:none; align-items:center; justify-content:space-between; background:#f1f5f9; padding:8px 12px; border-radius:8px; border:1px solid #e2e8f0; font-size:0.85em;">
                    <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
                        <span style="font-size:1.2em;"><i class="ph ph-paperclip"></i></span>
                        <span id="ai-image-name" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#475569; font-weight:bold;">No image</span>
                    </div>
                    <button onclick="window.clearAiAttachment()" style="background:none; border:none; color:#ef4444; cursor:pointer; font-weight:bold; font-size:1.2em; padding:0 5px;"><i class="ph ph-x"></i></button>
                </div>
                <div style="display: flex; gap: 8px; align-items: flex-end;">
                    <input type="file" id="ai-image-upload" accept="image/*" style="display: none;">
                    <button onclick="document.getElementById('ai-image-upload').click()" style="background: #f8fafc; color: #475569; border: 1px solid #cbd5e0; border-radius: 50%; width: 42px; height: 42px; display:flex; align-items:center; justify-content:center; cursor: pointer; flex-shrink: 0; font-size:1.2em; transition:0.2s;"><i class="ph ph-plus"></i></button>
                    <textarea id="ai-prompt-text" rows="1" placeholder="Message..." style="flex: 1; padding: 12px 15px; border: 1px solid #cbd5e0; border-radius: 20px; font-family: inherit; resize: none; overflow-y:hidden; box-sizing: border-box; font-size:0.95em; outline:none; max-height:120px;" oninput="this.style.height = ''; this.style.height = Math.min(this.scrollHeight, 120) + 'px';"></textarea>
                    <button id="ai-submit-btn" style="background: #27ae60; color: white; border: none; border-radius: 50%; width: 42px; height: 42px; display:flex; align-items:center; justify-content:center; cursor: pointer; flex-shrink: 0; font-size:1.2em; box-shadow: 0 4px 10px rgba(39, 174, 96, 0.3); transition:transform 0.1s;"><i class="ph ph-paper-plane-right"></i></button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    document.body.classList.add('ai-chat-open'); // Trigger layout shift
    smoothMapResize(); // Ensure map scales cleanly

    const textarea = document.getElementById('ai-prompt-text');
    const history = document.getElementById('ai-chat-history');

    // Auto-send on Enter (Shift+Enter for new line)
    textarea.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('ai-submit-btn').click();
        }
    });

    // Attachment Handlers
    let attachedFile = null;
    window.clearAiAttachment = function() {
        attachedFile = null;
        document.getElementById('ai-image-upload').value = '';
        document.getElementById('ai-attachment-preview').style.display = 'none';
    };

    document.getElementById('ai-image-upload').addEventListener('change', function(e) {
        if (e.target.files.length > 0) {
            attachedFile = e.target.files[0];
            document.getElementById('ai-image-name').innerText = attachedFile.name;
            document.getElementById('ai-attachment-preview').style.display = 'flex';
            textarea.focus();
        }
    });

    // Chat Bubble Generator
    function appendMessage(role, text, imageUrl = null) {
        const msgDiv = document.createElement('div');
        msgDiv.style.cssText = `max-width: 85%; padding: 10px 14px; font-size: 0.95em; line-height: 1.4; word-wrap: break-word; box-shadow: 0 1px 2px rgba(0,0,0,0.1); display:flex; flex-direction:column; gap:5px;`;

        if (role === 'user') {
            msgDiv.style.alignSelf = 'flex-end';
            msgDiv.style.background = '#dcf8c6'; // WhatsApp light green
            msgDiv.style.color = '#0f172a';
            msgDiv.style.borderRadius = '16px 16px 4px 16px';
        } else {
            msgDiv.style.alignSelf = 'flex-start';
            msgDiv.style.background = 'white';
            msgDiv.style.color = '#1e293b';
            msgDiv.style.borderRadius = '16px 16px 16px 4px';
        }

        let contentHtml = '';
        
        if (imageUrl) {
            contentHtml += `<img src="${imageUrl}" style="max-width:100%; border-radius:8px; border:1px solid rgba(0,0,0,0.1); cursor:pointer;" onclick="if(window.openLightbox) window.openLightbox('${imageUrl}')">`;
        }
        
        if (role === 'ai') {
            contentHtml += typeof marked !== 'undefined' ? marked.parse(text) : text.replace(/\n/g, '<br>');
        } else {
            contentHtml += text.replace(/</g, '<').replace(/>/g, '>').replace(/\n/g, '<br>');
        }

        msgDiv.innerHTML = contentHtml;
        
        // Fix markdown margins
        const paras = msgDiv.querySelectorAll('p');
        paras.forEach(p => p.style.margin = '0 0 8px 0');
        if (paras.length > 0) paras[paras.length-1].style.margin = '0';

        history.appendChild(msgDiv);
        setTimeout(() => { history.scrollTo({ top: history.scrollHeight, behavior: 'smooth' }); }, 50);
        return msgDiv;
    }

    // Submit Handler
    document.getElementById('ai-submit-btn').addEventListener('click', async function() {
        const promptText = textarea.value.trim();
        if (!promptText && !attachedFile) return;

        const btn = this;
        btn.disabled = true;
        btn.style.transform = 'scale(0.9)';

        // Render User Message instantly
        let previewUrl = null;
        if (attachedFile) previewUrl = URL.createObjectURL(attachedFile);
        appendMessage('user', promptText, previewUrl);

        textarea.value = '';
        textarea.style.height = 'auto';
        textarea.focus();

        const typingIndicator = appendMessage('ai', '<span style="color:#94a3b8; font-style:italic;">thinking...</span>');

        try {
            let uploadedImageUrl = null;

            if (attachedFile) {
                const formData = new FormData();
                formData.append('file', attachedFile);
                const uploadRes = await authFetch(`${API_URL}/api/upload`, { method: 'POST', body: formData });
                if (!uploadRes.ok) throw new Error("Failed to upload image");
                const uploadData = await uploadRes.json();
                uploadedImageUrl = uploadData.secure_url;
            }

            const res = await authFetch(`${API_URL}/api/ai/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    prompt: promptText, 
                    imageUrl: uploadedImageUrl,
                    history: aiConversationMemory // Inject memory here!
                })
            });
            
            if (!res || res.status === 401) throw new Error("Unauthorized"); 
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            // Save the exchange to short-term memory
            aiConversationMemory.push({ role: 'user', content: promptText });
            aiConversationMemory.push({ role: 'assistant', content: data.message });

            typingIndicator.remove();
            appendMessage('ai', data.message);
            window.clearAiAttachment();

            // Quietly refresh the UI so the user can watch the map/sidebar update instantly behind the chat!
            if (typeof refreshData === 'function') refreshData();
            if (typeof loadData === 'function') loadData(); 
            
        } catch (err) {
            typingIndicator.remove();
            appendMessage('ai', `<strong style="color:#ef4444;">Error:</strong> ${err.message}`);
        } finally {
            btn.disabled = false;
            btn.style.transform = 'scale(1)';
        }
    });

    // Make sure input is focused when first opened
    setTimeout(() => document.getElementById('ai-prompt-text').focus(), 100);
};

// Map the old global function to the new persistent chat UI
window.processAiCommand = window.openAiChat;
