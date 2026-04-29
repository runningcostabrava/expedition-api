let activeCategoryIdForEdit = null;
const API_URL = 'https://mapbox-api-uz9a.onrender.com';
let AUTH_TOKEN = localStorage.getItem('expedition_token');

let aiConversationMemory = [];
let totalSessionCost = 0;

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
            localStorage.setItem('expedition_token', AUTH_TOKEN);
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
        localStorage.removeItem('expedition_token');
        // Recursively call authFetch to prompt password and retry the exact same request
        return authFetch(url, options);
    }

    return response;
}

window.handleBatchPhotoImport = async function (input) {
    const files = input.files;
    const taskId = typeof AppStore !== 'undefined' ? AppStore.get('activeTaskId') : null;
    if (!files || files.length === 0 || !taskId) return;

    let successCount = 0;
    let noGpsCount = 0;

    const btn = document.querySelector('button[onclick*="batch-photo-input"]');
    const origText = btn ? btn.innerText : '📸 Batch Import GPS Photos';
    if (btn) btn.disabled = true;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
            if (btn) btn.innerText = `⏳ Extracting GPS ${i + 1}/${files.length}...`;

            // 1. Extract GPS natively
            const gps = await exifr.gps(file);
            if (!gps || !gps.latitude || !gps.longitude) {
                noGpsCount++;
                continue; // Skip photos without location data
            }

            if (btn) btn.innerText = `⏳ Uploading ${i + 1}/${files.length}...`;

            // 2. Upload to Cloudinary
            const formData = new FormData();
            formData.append('file', file);
            const upRes = await authFetch(`${API_URL}/api/upload`, { method: 'POST', body: formData });
            const upData = await upRes.json();
            if (!upData.secure_url) throw new Error("Cloudinary upload failed");

            // 3. Create and Link Waypoint
            const wpPayload = {
                title: file.name.split('.')[0] || "Imported Photo",
                lat: gps.latitude,
                lng: gps.longitude,
                photo_url: upData.secure_url,
                icon: 'ph-camera',
                color: '#e67e22',
                existing_task_id: taskId
            };
            await authFetch(`${API_URL}/waypoints`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(wpPayload)
            });
            successCount++;
        } catch (e) {
            console.error("Failed to import photo:", file.name, e);
        }
    }

    input.value = ''; // Reset input
    if (btn) { btn.innerText = origText; btn.disabled = false; }

    alert(`Batch Import Complete!\n✅ ${successCount} Photos mapped and linked.\n⚠️ ${noGpsCount} Photos skipped (No GPS data found).`);

    // Force a hard refresh of the data and re-open the panel
    if (typeof refreshData === 'function') await refreshData();
    if (typeof AppStore !== 'undefined' && typeof openTaskDetailPanel === 'function') {
        const task = AppStore.get('itinerary').find(t => t.task_id === taskId);
        if (task) openTaskDetailPanel(task);
    }
};

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

window.closeAiChat = function () {
    const modal = document.getElementById('ai-multimodal-assistant');
    if (modal) {
        modal.classList.add('ai-chat-hidden');
        document.body.classList.remove('ai-chat-open'); // Restore map width
        smoothMapResize();

        setTimeout(() => { modal.style.display = 'none'; }, 300);
    }
};

window.openAiChat = function () {
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
                font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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

            /* Segmented Control Model Toggle */
            .ai-model-toggle {
                display: flex;
                background: #1e293b;
                border-radius: 20px;
                padding: 2px;
                font-size: 0.75em;
                font-weight: bold;
                border: 1px solid rgba(255,255,255,0.1);
            }
            .ai-model-btn {
                padding: 4px 10px;
                border-radius: 18px;
                cursor: pointer;
                transition: 0.2s;
                color: #94a3b8;
            }
            .ai-model-btn.active {
                background: #8b5cf6;
                color: white;
                box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            }
            .ai-model-btn:not(.active):hover {
                color: white;
                background: rgba(255,255,255,0.05);
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
                        <span style="line-height:1.1;">AI Co-Pilot</span>
                        <div style="display:flex; align-items:center;">
                            <span style="font-size:0.7em; color:#94a3b8; font-weight:normal;">Online</span>
                            <span id="ai-session-cost" style="color:#10b981; font-weight:bold; margin-left:5px; font-size:0.7em;">$0.000</span>
                        </div>
                    </div>
                </div>
                <div style="display:flex; gap:12px; align-items:center;">
                    <div class="ai-model-toggle">
                        <div id="model-deepseek" class="ai-model-btn active" onclick="window.setAiModel('deepseek')">🧠 DeepSeek</div>
                        <div id="model-gemini" class="ai-model-btn" onclick="window.setAiModel('gemini')">✨ Gemini</div>
                    </div>
                    <span id="ai-voice-toggle" style="cursor:pointer; font-size:1.2em; opacity:0.5; transition:0.2s;" title="Read aloud (Off)">🔇</span>
                    <span onclick="window.clearAiSession()" style="cursor:pointer; font-size:1.2em; color:#94a3b8; transition:0.2s;" title="Clear Session"><i class="ph ph-trash"></i></span>
                    <span onclick="window.closeAiChat()" style="cursor: pointer; font-size: 1.8em; line-height: 1; padding: 0 5px;"><i class="ph ph-x"></i></span>
                </div>
            </div>

            <div id="ai-chat-history" style="flex: 1; overflow-y: auto; padding: 20px 15px; display: flex; flex-direction: column; gap: 15px; background: #e2e8f0; background-image: radial-gradient(#cbd5e0 1px, transparent 0); background-size: 20px 20px;">
                <div style="text-align: center; color: #64748b; font-size: 0.85em; margin-bottom: 10px; background: rgba(255,255,255,0.8); padding: 6px 12px; border-radius: 12px; align-self: center; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                    Chat started. I can update your itinerary, read receipts via OCR, or analyze map data! Try asking me to move a task.
                </div>
            </div>

            <div style="background: white; padding: 12px 15px; border-top: 1px solid #cbd5e0; display: flex; flex-direction: column; gap: 10px; flex-shrink: 0;">
                <div id="ai-attachment-preview" style="display:none; flex-wrap:wrap; gap:8px; background:#f1f5f9; padding:8px 12px; border-radius:8px; border:1px solid #e2e8f0; font-size:0.85em;">
                </div>
                <div style="display: flex; gap: 8px; align-items: flex-end;">
                    <input type="file" id="ai-image-upload" multiple accept="image/*,application/pdf,text/plain,audio/*" style="display: none;">
                    <button onclick="document.getElementById('ai-image-upload').click()" style="background: #f8fafc; color: #475569; border: 1px solid #cbd5e0; border-radius: 50%; width: 42px; height: 42px; display:flex; align-items:center; justify-content:center; cursor: pointer; flex-shrink: 0; font-size:1.2em; transition:0.2s;"><i class="ph ph-plus"></i></button>
                    
                    <textarea id="ai-prompt-text" rows="1" placeholder="Message..." style="flex: 1; padding: 12px 15px; border: 1px solid #cbd5e0; border-radius: 20px; font-family: inherit; resize: none; overflow-y:hidden; box-sizing: border-box; font-size:0.95em; outline:none; max-height:120px;" oninput="this.style.height = ''; this.style.height = Math.min(this.scrollHeight, 120) + 'px';"></textarea>
                    
                    <button id="ai-mic-btn" style="background: #3498db; color: white; border: none; border-radius: 50%; width: 42px; height: 42px; display:flex; align-items:center; justify-content:center; cursor: pointer; flex-shrink: 0; font-size:1.2em; box-shadow: 0 4px 10px rgba(52, 152, 219, 0.3); transition:0.2s;"><i class="ph ph-microphone"></i></button>
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

    // --- SESSION MANAGEMENT ---
    window.clearAiSession = function() {
        if (!confirm("Clear this conversation and reset session? (Database items are safe!)")) return;
        aiConversationMemory = [];
        const historyContainer = document.getElementById('ai-chat-history');
        historyContainer.innerHTML = `
            <div style="text-align: center; color: #64748b; font-size: 0.85em; margin-bottom: 10px; background: rgba(255,255,255,0.8); padding: 6px 12px; border-radius: 12px; align-self: center; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                Session cleared to save money. Permanent memory and database items are still safe!
            </div>
        `;
        showToast("AI Session Reset", "info");
    };

    // --- MODEL SELECTION ---
    let selectedAiModel = 'deepseek';
    window.setAiModel = function(model) {
        selectedAiModel = model;
        document.querySelectorAll('.ai-model-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById(`model-${model}`).classList.add('active');
        showToast(`AI brain switched to ${model === 'deepseek' ? 'DeepSeek' : 'Gemini 1.5 Pro'}`, 'info');
    };

    // --- GEMINI MULTIMODAL LIVE AUDIO ENGINE ---
    let liveAudioSocket = null;
    let audioContext = null;
    let micStream = null;
    let processorNode = null;
    let isConversing = false;
    let lastAiChunkTime = Date.now();
    let thinkingToastActive = false;

    const micBtn = document.getElementById('ai-mic-btn');

    // Add pulse animation CSS dynamically
    if (!document.getElementById('mic-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'mic-pulse-style';
        style.innerHTML = `
            @keyframes micPulse { 0% { box-shadow: 0 0 0 0 rgba(52, 152, 219, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(52, 152, 219, 0); } 100% { box-shadow: 0 0 0 0 rgba(52, 152, 219, 0); } }
            .conversing-pulse { animation: micPulse 1.5s infinite !important; background: #8b5cf6 !important; }
        `;
        document.head.appendChild(style);
    }

    async function startLiveConversation() {
        try {
            let serverIsReady = false;
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            micStream = stream;

            liveAudioSocket = new WebSocket(API_URL.replace('https:', 'wss:') + '/api/live-stream');
            
            liveAudioSocket.onopen = () => {
                console.log('[Live AI] Socket Connected. Waiting for Google...');
                showToast("Connecting brain...", "info");
            };

            liveAudioSocket.onmessage = async (event) => {
                if (typeof event.data === 'string') {
                    const msg = JSON.parse(event.data);
                    if (msg.status === "ready") {
                        serverIsReady = true;
                        console.log('[Live AI] Google is READY 🚀');
                        showToast("Live conversation active", "success");
                        startMicProcessing();
                    }
                    if (msg.status === "error") {
                        showToast(`AI Error: ${msg.reason}`, "error");
                        stopLiveConversation();
                    }
                    return;
                }

                lastAiChunkTime = Date.now();
                thinkingToastActive = false;

                try {
                    const pcmBuffer = new Int16Array(await event.data.arrayBuffer());
                    const floatBuffer = new Float32Array(pcmBuffer.length);
                    for (let i = 0; i < pcmBuffer.length; i++) {
                        floatBuffer[i] = pcmBuffer[i] / (pcmBuffer[i] < 0 ? 0x8000 : 0x7FFF);
                    }
                    const audioBuffer = audioContext.createBuffer(1, floatBuffer.length, 16000);
                    audioBuffer.getChannelData(0).set(floatBuffer);
                    const playSource = audioContext.createBufferSource();
                    playSource.buffer = audioBuffer;
                    playSource.connect(audioContext.destination);
                    playSource.start(0);
                } catch (e) { console.error("Playback error:", e); }
            };

            function startMicProcessing() {
                const source = audioContext.createMediaStreamSource(micStream);
                processorNode = audioContext.createScriptProcessor(4096, 1, 1);
                source.connect(processorNode);
                processorNode.connect(audioContext.destination);

                processorNode.onaudioprocess = (e) => {
                    // CRITICAL GUARD: Only send data if server handshake is complete
                    if (!isConversing || !serverIsReady) return;
                    
                    const inputData = e.inputBuffer.getChannelData(0);
                    const pcmData = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        const s = Math.max(-1, Math.min(1, inputData[i]));
                        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    if (liveAudioSocket.readyState === WebSocket.OPEN) {
                        liveAudioSocket.send(pcmData.buffer);
                    }
                };
            }

            liveAudioSocket.onclose = () => stopLiveConversation();
            liveAudioSocket.onerror = (err) => console.error("[Live AI] WebSocket Error:", err);

            isConversing = true;
            micBtn.innerHTML = '<i class="ph ph-waveform"></i>';
            micBtn.classList.add('conversing-pulse');

        } catch (err) {
            console.error("[Live AI] Startup Error:", err);
            alert("Could not start live conversation. Please check mic permissions.");
        }
    }

    function stopLiveConversation() {
        isConversing = false;
        if (processorNode) processorNode.disconnect();
        if (micStream) micStream.getTracks().forEach(t => t.stop());
        if (liveAudioSocket) liveAudioSocket.close();
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().catch(e => console.warn("[Live AI] Cierre de audio omitido: ", e));
        }

        micBtn.innerHTML = '<i class="ph ph-microphone"></i>';
        micBtn.classList.remove('conversing-pulse');
        showToast("Live conversation ended", "info");
    }

    micBtn.addEventListener('click', () => {
        if (!isConversing) startLiveConversation();
        else stopLiveConversation();
    });

    // Auto-send on Enter (Shift+Enter for new line)
    textarea.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('ai-submit-btn').click();
        }
    });

    // Attachment Handlers
    let attachedFiles = [];
    window.clearAiAttachment = function (index = null) {
        if (index === null) {
            attachedFiles = [];
        } else {
            attachedFiles.splice(index, 1);
        }
        renderAiAttachmentPreview();
    };

    function renderAiAttachmentPreview() {
        const container = document.getElementById('ai-attachment-preview');
        if (attachedFiles.length === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
            document.getElementById('ai-image-upload').value = '';
            return;
        }

        container.style.display = 'flex';
        container.innerHTML = attachedFiles.map((file, idx) => {
            const isImage = file.type.startsWith('image/');
            const icon = isImage ? 'ph-image' : (file.type.startsWith('audio/') ? 'ph-microphone' : 'ph-file-text');
            return `
                <div style="display:flex; align-items:center; gap:6px; background:white; padding:4px 8px; border-radius:16px; border:1px solid #cbd5e0; max-width:180px;">
                    <i class="ph ${icon}" style="font-size:1.2em; color:#64748b;"></i>
                    <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#475569; font-size:0.9em; font-weight:bold;">${file.name}</span>
                    <i class="ph ph-x-circle" style="cursor:pointer; color:#ef4444; font-size:1.2em;" onclick="window.clearAiAttachment(${idx})"></i>
                </div>
            `;
        }).join('') + `<button onclick="window.clearAiAttachment()" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:0.8em; font-weight:bold; text-decoration:underline; margin-left:auto;">Clear All</button>`;
    }

    document.getElementById('ai-image-upload').addEventListener('change', function (e) {
        if (e.target.files.length > 0) {
            attachedFiles = [...attachedFiles, ...Array.from(e.target.files)];
            renderAiAttachmentPreview();
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
        if (paras.length > 0) paras[paras.length - 1].style.margin = '0';

        history.appendChild(msgDiv);
        setTimeout(() => { history.scrollTo({ top: history.scrollHeight, behavior: 'smooth' }); }, 50);
        return msgDiv;
    }

    // Submit Handler
    document.getElementById('ai-submit-btn').addEventListener('click', async function () {
        const promptText = textarea.value.trim();
        if (!promptText && attachedFiles.length === 0) return;

        const btn = this;
        btn.disabled = true;
        btn.style.transform = 'scale(0.9)';

        // Render User Message instantly with first image preview if any
        let firstImageUrl = null;
        const firstImage = attachedFiles.find(f => f.type.startsWith('image/'));
        if (firstImage) firstImageUrl = URL.createObjectURL(firstImage);
        appendMessage('user', promptText, firstImageUrl);

        const currentFiles = [...attachedFiles];
        attachedFiles = [];
        renderAiAttachmentPreview();

        textarea.value = '';
        textarea.style.height = 'auto';
        textarea.focus();

        const typingIndicator = appendMessage('ai', '<span style="color:#94a3b8; font-style:italic;">thinking...</span>');

        try {
            let imageUrls = [];
            let documentContext = "";

            if (currentFiles.length > 0) {
                typingIndicator.innerHTML = `<span style="color:#94a3b8; font-style:italic;">processing ${currentFiles.length} files...</span>`;
                
                await Promise.all(currentFiles.map(async (file) => {
                    const formData = new FormData();
                    formData.append('file', file);

                    if (file.type.startsWith('image/')) {
                        const uploadRes = await authFetch(`${API_URL}/api/upload`, { method: 'POST', body: formData });
                        if (!uploadRes.ok) throw new Error(`Failed to upload ${file.name}`);
                        const uploadData = await uploadRes.json();
                        imageUrls.push(uploadData.secure_url);
                    } else {
                        const parseRes = await authFetch(`${API_URL}/api/parse-media`, { method: 'POST', body: formData });
                        if (!parseRes.ok) throw new Error(`Failed to read ${file.name}`);
                        const parseData = await parseRes.json();
                        documentContext += `\n\n[CONTENTS OF ATTACHED FILE "${file.name}"]:\n${parseData.text}\n\n`;
                    }
                }));
            }

            const finalPrompt = documentContext ? (promptText + documentContext) : promptText;

            const activeTaskId = typeof AppStore !== 'undefined' ? AppStore.get('activeTaskId') : null;
            const res = await authFetch(`${API_URL}/api/ai/command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: finalPrompt,
                    imageUrls: imageUrls,
                    history: aiConversationMemory, // Inject memory here!
                    model: selectedAiModel,
                    activeTaskId: activeTaskId
                })
            });

            if (!res || res.status === 401) throw new Error("Unauthorized");
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            if (data.cost) {
                totalSessionCost += data.cost;
                const costDisplay = document.getElementById('ai-session-cost');
                if (costDisplay) costDisplay.innerText = `$${totalSessionCost.toFixed(3)}`;
            }

            // Save the exchange to short-term memory
            aiConversationMemory.push({ role: 'user', content: promptText });
            aiConversationMemory.push({ role: 'assistant', content: data.message });

            typingIndicator.remove();
            appendMessage('ai', data.message);

            if (data.uiAction) {
                if (data.uiAction.type === 'focus_task') {
                    if (typeof window.focusTaskInSidebar === 'function') {
                        setTimeout(() => window.focusTaskInSidebar(data.uiAction.taskId), 500);
                    }
                } else if (data.uiAction.type === 'ui_search') {
                    if (typeof window.triggerDiscoverySearch === 'function') {
                        window.triggerDiscoverySearch(data.uiAction.query);
                    }
                } else if (data.uiAction.type === 'preview_route') {
                    // Logic to preview the GeoJSON on the map
                    if (typeof window.previewAiRoute === 'function') {
                        window.previewAiRoute(data.uiAction.geojson);
                    }
                }
            }

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

window.downloadVCard = function (name, phone, email, notes) {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name || ''}\nTEL:${phone || ''}\nEMAIL:${email || ''}\nNOTE:${notes || ''}\nEND:VCARD`;
    const blob = new Blob([vcard], { type: 'text/vcard' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(name || 'contact').replace(/\s+/g, '_')}.vcf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};
