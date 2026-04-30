const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const { OpenAI } = require('openai');
const turf = require('@turf/turf');
const { search, SafeSearchType } = require('duck-duck-scrape');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY 
});
const jwt = require('jsonwebtoken'); // 1. Import JWT
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios'); // Added for Traccar proxy
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const pdfParse = require('pdf-parse');
const FormData = require('form-data');
const { WebSocketServer } = require('ws');

cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET 
});
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());

let sseClients = [];
let isAiProcessing = false;

app.get('/api/live-sync', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

// Heartbeat to keep connections alive on Render (prevents 100s timeout)
setInterval(() => {
    sseClients.forEach(res => res.write(': heartbeat\n\n'));
}, 25000);

function triggerMapRefresh() {
    if (isAiProcessing === false) {
        sseClients.forEach(res => res.write('data: refresh\n\n'));
    }
}

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true })); // <--- 🚨 ADD THIS CRITICAL LINE 🚨

app.get('/api/config', (req, res) => {
  res.json({
    MAPBOX_TOKEN: process.env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN,
    GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY
  });
});

app.use(express.static(path.join(__dirname)));

const JWT_SECRET = process.env.JWT_SECRET || 'emergency_fallback_secret'; // 2. Set secret

// REPLACED: adminAuth now verifies tokens, not a static key
const adminAuth = (req, res, next) => {
  // BYPASS: Autenticación desactivada temporalmente para desarrollo
  req.user = { admin: true }; 
  next();
};

// NEW: Add a Login endpoint
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  // We use your existing ADMIN_KEY from environment variables as the "password"
  if (password === process.env.ADMIN_KEY) {
    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 1. SETUP: Run once at /setup-db
app.get('/setup-db', adminAuth, async (req, res) => {
  try {
    const queries = [
      // Core Tables
      "CREATE TABLE IF NOT EXISTS location_logs (id SERIAL PRIMARY KEY, guide_id TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, timestamp TIMESTAMPTZ DEFAULT NOW())",
      "CREATE TABLE IF NOT EXISTS live_devices (id SERIAL PRIMARY KEY, device_identifier TEXT UNIQUE, display_name TEXT, assigned_user TEXT, color TEXT DEFAULT '#ef4444', is_visible BOOLEAN DEFAULT true)",
      "ALTER TABLE live_devices ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT '🏃‍♂️'",
      "ALTER TABLE live_devices ADD COLUMN IF NOT EXISTS icon_size INTEGER DEFAULT 28",
      "CREATE TABLE IF NOT EXISTS sections (id SERIAL PRIMARY KEY, section_date DATE, title TEXT, description TEXT)",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL",
      "CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE, color TEXT, icon TEXT)",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL",
      "CREATE TABLE IF NOT EXISTS waypoints (id SERIAL PRIMARY KEY, title TEXT, description TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION)",
      "CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, waypoint_id INTEGER REFERENCES waypoints(id) ON DELETE CASCADE, task_name TEXT, responsible TEXT, characteristics TEXT, scheduled_time TIMESTAMPTZ, is_completed BOOLEAN DEFAULT false)",
      "CREATE TABLE IF NOT EXISTS tracks (id SERIAL PRIMARY KEY, title TEXT, color TEXT DEFAULT '#FF0000', geojson_data JSONB NOT NULL)",

      // Additional Columns
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS category TEXT",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS description TEXT",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS responsible TEXT",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS characteristics TEXT",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_group TEXT",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type TEXT",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS day_label TEXT",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_completed BOOLEAN DEFAULT false",
      "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS target_group TEXT",

      // Spatial Anchors
      "CREATE TABLE IF NOT EXISTS spatial_anchors (id SERIAL PRIMARY KEY, kind VARCHAR(20) CHECK (kind IN ('point', 'line', 'polygon')), waypoint_id INTEGER REFERENCES waypoints(id) ON DELETE CASCADE, track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE)",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS anchor_id INTEGER REFERENCES spatial_anchors(id) ON DELETE CASCADE",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ",

      // Task-Centric Model
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#e74c3c'",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT 'marker'",
      "CREATE TABLE IF NOT EXISTS task_anchors (task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, anchor_id INTEGER REFERENCES spatial_anchors(id) ON DELETE CASCADE, PRIMARY KEY (task_id, anchor_id))",

      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comments TEXT",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE",

      // Routing & Meta
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS link TEXT",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS comments TEXT",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS distance NUMERIC",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS gain NUMERIC",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS loss NUMERIC",

      "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS link TEXT",
      "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS comments TEXT",
      "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS distance NUMERIC",
      "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS duration NUMERIC",
      "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS gain NUMERIC",
      "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS loss NUMERIC",
      "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS parent_track_id INTEGER",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS parent_track_id INTEGER",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS photo_url TEXT",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS phone TEXT",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS address TEXT",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS google_maps_url TEXT",
      "ALTER TABLE categories ADD COLUMN IF NOT EXISTS line_type TEXT DEFAULT 'solid'",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_milestone BOOLEAN DEFAULT false",
      "ALTER TABLE categories ADD COLUMN IF NOT EXISTS marker_size INTEGER DEFAULT 28",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0",
      "CREATE TABLE IF NOT EXISTS team_members (id SERIAL PRIMARY KEY, name TEXT UNIQUE)",
      "CREATE TABLE IF NOT EXISTS task_types (id SERIAL PRIMARY KEY, name TEXT UNIQUE, color TEXT, icon TEXT)",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type_id INTEGER REFERENCES task_types(id) ON DELETE SET NULL",
      "ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL",
      "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL",
      "DO $$ BEGIN ALTER TABLE waypoints ADD CONSTRAINT fk_parent_track FOREIGN KEY (parent_track_id) REFERENCES tracks(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN null; END $$;",
      "DO $$ BEGIN ALTER TABLE tracks ADD CONSTRAINT fk_parent_track_self FOREIGN KEY (parent_track_id) REFERENCES tracks(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN null; END $$;",
      `CREATE TABLE IF NOT EXISTS ai_memory (
        id SERIAL PRIMARY KEY,
        memory_text TEXT
      );`,
      "INSERT INTO ai_memory (id, memory_text) VALUES (1, '') ON CONFLICT DO NOTHING;",
      "CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, name TEXT NOT NULL, contact_type TEXT, phone TEXT, email TEXT, notes TEXT)",
      "CREATE TABLE IF NOT EXISTS waypoint_contacts (waypoint_id INTEGER REFERENCES waypoints(id) ON DELETE CASCADE, contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE, PRIMARY KEY (waypoint_id, contact_id))",
      "CREATE TABLE IF NOT EXISTS database_backups (id SERIAL PRIMARY KEY, backup_date TIMESTAMPTZ DEFAULT NOW(), table_name TEXT, data_json JSONB, metadata TEXT)"
    ];

    // Execute safely one by one
    for (let q of queries) {
      await pool.query(q);
    }

    // Auto-migrate existing text labels into real Sections
    await pool.query(`
      INSERT INTO sections (title, section_date)
      SELECT DISTINCT day_label, CURRENT_DATE
      FROM tasks
      WHERE day_label IS NOT NULL AND day_label NOT IN (SELECT title FROM sections)
      ON CONFLICT DO NOTHING;
    `);

    // Link existing tasks to their new sections
    await pool.query(`
      UPDATE tasks t SET section_id = s.id FROM sections s WHERE t.day_label = s.title AND t.section_id IS NULL;
    `);

    res.send("Database tables updated successfully with real Sections!");
  } catch (err) {
    console.error("Setup Error:", err);
    res.status(500).send("Setup Error: " + err.message);
  }
});

// Endpoint de emergencia para auditar backups
app.get('/api/export-backups', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, backup_date, table_name, metadata, data_json FROM database_backups ORDER BY id DESC');
        res.setHeader('Content-disposition', 'attachment; filename=expedition_backups.json');
        res.setHeader('Content-type', 'application/json');
        res.send(JSON.stringify(result.rows, null, 2));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- MEDIA UPLOAD (CLOUDINARY) ---
app.post('/api/upload', adminAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // If it's an image, let Cloudinary process it ('auto'). If it's a document/PDF, store it exactly as-is ('raw').
    const isImage = req.file.mimetype.startsWith('image/');
    const resType = isImage ? 'auto' : 'raw';

    // Create a direct upload stream to Cloudinary
    const uploadOptions = { folder: "expedition_media", resource_type: resType };
    if (resType === 'raw') {
        uploadOptions.format = req.file.originalname.split('.').pop();
        uploadOptions.use_filename = true;
    }
    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
        if (error) {
          console.error("Cloudinary Stream Error:", error);
          return res.status(500).json({ error: 'Upload failed', details: error.message });
        }
        res.json({ secure_url: result.secure_url });
      }
    );

    // Pipe the raw memory buffer byte-by-byte to prevent payload crashes
    const { Readable } = require('stream');
    const readableStream = new Readable({
      read() {
        this.push(req.file.buffer);
        this.push(null);
      }
    });

    readableStream.pipe(stream);
  } catch (error) {
    console.error("Server Upload Error:", error);
    res.status(500).json({ error: 'Server crash', details: error.message });
  }
});

async function getOrCreateFallbackTask() {
    let secRes = await pool.query("SELECT id FROM sections WHERE title = '🛟 Recovered Items'");
    let secId;
    if (secRes.rows.length === 0) {
        const today = new Date().toISOString().split('T')[0];
        const newSec = await pool.query("INSERT INTO sections (title, section_date) VALUES ($1, $2) RETURNING id", ['🛟 Recovered Items', today]);
        secId = newSec.rows[0].id;
    } else {
        secId = secRes.rows[0].id;
    }

    let taskRes = await pool.query("SELECT id FROM tasks WHERE task_name = 'Unassigned task' AND section_id = $1", [secId]);
    if (taskRes.rows.length === 0) {
        const newTask = await pool.query("INSERT INTO tasks (task_name, section_id, characteristics) VALUES ($1, $2, $3) RETURNING id", ['Unassigned task', secId, 'Auto-generated task for unlinked field data.']);
        return newTask.rows[0].id;
    }
    return taskRes.rows[0].id;
}

app.post('/api/waypoints/photo', adminAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        const { lat, lng, title, category, color, icon, parent_track_id, phone, address, google_maps_url, section_id, existing_task_id } = req.body;

        // 1. Upload to Cloudinary
        const isImage = req.file.mimetype.startsWith('image/');
        const resType = isImage ? 'auto' : 'raw';
        const uploadOptions = { folder: "expedition_media", resource_type: resType };
        
        if (resType === 'raw') {
            uploadOptions.format = req.file.originalname.split('.').pop();
            uploadOptions.use_filename = true;
        }

        const cloudinaryRes = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            });
            const { Readable } = require('stream');
            const readableStream = new Readable({
                read() {
                    this.push(req.file.buffer);
                    this.push(null);
                }
            });
            readableStream.pipe(stream);
        });

        // 2. Create Waypoint
        const wp = await pool.query(
            'INSERT INTO waypoints (title, lat, lng, photo_url, category, color, icon, parent_track_id, phone, address, google_maps_url, section_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id',
            [title || 'Photo Waypoint', lat, lng, cloudinaryRes.secure_url, category, color || '#e67e22', icon || 'ph-camera', parent_track_id, phone, address, google_maps_url, section_id]
        );
        const wpId = wp.rows[0].id;
        const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, waypoint_id) VALUES ($1, $2) RETURNING id', ['point', wpId]);
        const anchorId = anchorRes.rows[0].id;
        const finalTaskId = existing_task_id || await getOrCreateFallbackTask();
        await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [finalTaskId, anchorId]);

        triggerMapRefresh();
        res.json({ success: true, waypoint_id: wpId, photo_url: cloudinaryRes.secure_url });
    } catch (error) {
        console.error("Photo Waypoint Error:", error);
        res.status(500).json({ error: 'Failed to create photo waypoint', details: error.message });
    }
});

app.post('/api/waypoints/audio', adminAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const { lat, lng, title, category, color, icon, parent_track_id, section_id, existing_task_id } = req.body;

        // --- NEW ROBUST TRANSCRIPTION LOGIC ---
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

        const result = await model.generateContent([
            "You are a professional transcriber. Transcribe this audio exactly. Return ONLY text.",
            {
                inlineData: {
                    mimeType: req.file.mimetype,
                    data: req.file.buffer.toString("base64")
                }
            }
        ]);
        const transcript = result.response.text();

        // 2. Create Waypoint
        const wp = await pool.query(
            'INSERT INTO waypoints (title, lat, lng, description, category, color, icon, parent_track_id, section_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
            [title || 'Audio Field Note', lat, lng, "Audio Field Note: " + transcript, category, color || '#9b59b6', icon || 'ph-microphone', parent_track_id, section_id]
        );
        const wpId = wp.rows[0].id;
        const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, waypoint_id) VALUES ($1, $2) RETURNING id', ['point', wpId]);
        const anchorId = anchorRes.rows[0].id;
        const finalTaskId = existing_task_id || await getOrCreateFallbackTask();
        await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [finalTaskId, anchorId]);

        triggerMapRefresh();
        res.json({ success: true, waypoint_id: wpId, transcript });
    } catch (err) {
        console.error("Audio Waypoint error:", err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/parse-media', adminAuth, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        const mime = req.file.mimetype;
        
        // 1. Handle PDFs
        if (mime === 'application/pdf') {
            const data = await pdfParse(req.file.buffer);
            return res.json({ text: data.text });
        }
        
        // 2. Handle Text files (WhatsApp exports, etc.)
        if (mime === 'text/plain') {
            return res.json({ text: req.file.buffer.toString('utf-8') });
        }
        
        // 3. Handle Audio & Video (Gemini)
        const isAudio = mime.startsWith('audio/') || 
                        mime.startsWith('video/mp4') || 
                        req.file.originalname.toLowerCase().endsWith('.opus') || 
                        req.file.originalname.toLowerCase().endsWith('.ogg') || 
                        req.file.originalname.toLowerCase().endsWith('.m4a') || 
                        req.file.originalname.toLowerCase().endsWith('.wav');

        if (isAudio) {
            // --- NEW ROBUST TRANSCRIPTION LOGIC ---
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

            const result = await model.generateContent([
                "You are a professional transcriber. Transcribe this audio exactly. Return ONLY text.",
                {
                    inlineData: {
                        mimeType: req.file.mimetype,
                        data: req.file.buffer.toString("base64")
                    }
                }
            ]);
            return res.json({ text: result.response.text() });
        }
        
        return res.status(400).json({ error: 'Unsupported file type for text extraction.' });
    } catch (err) {
        console.error("Media parsing error:", err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/upload', adminAuth, async (req, res) => {
  const { fileUrl } = req.body;
  if (!fileUrl) return res.status(400).json({ error: 'No URL provided' });
  try {
    const urlParts = fileUrl.split('/');
    const uploadIndex = urlParts.indexOf('upload');
    if (uploadIndex === -1) return res.status(400).json({ error: 'Invalid URL' });
    
    let public_id = urlParts.slice(uploadIndex + 2).join('/');
    const resourceType = urlParts[uploadIndex - 1]; // usually 'image' or 'raw'
    
    if (resourceType !== 'raw') {
      public_id = public_id.substring(0, public_id.lastIndexOf('.'));
    }
    await cloudinary.uploader.destroy(public_id, { resource_type: resourceType });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. TRACKS: GPX Upload & Management
app.post('/tasks', adminAuth, async (req, res) => {
  const { task_name, responsible, target_group, task_type_id, starts_at, ends_at, is_completed, comments, parent_id, is_milestone, section_id, category_id, characteristics } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO tasks (task_name, responsible, target_group, task_type_id, starts_at, ends_at, is_completed, comments, parent_id, is_milestone, section_id, category_id, characteristics) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *',
      [task_name, responsible, target_group, task_type_id, starts_at, ends_at, is_completed || false, comments, parent_id, is_milestone || false, section_id, category_id, characteristics]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/tasks/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { task_name, responsible, target_group, task_type_id, starts_at, ends_at, is_completed, comments, parent_id, category_id, is_milestone, section_id, characteristics } = req.body;
  try {
    const result = await pool.query(
      'UPDATE tasks SET task_name=$1, responsible=$2, target_group=$3, task_type_id=$4, starts_at=$5, ends_at=$6, is_completed=$7, comments=$8, parent_id=$9, category_id=$10, is_milestone=$11, section_id=$13, characteristics=$14 WHERE id=$12 RETURNING *',
      [task_name, responsible, target_group, task_type_id, starts_at, ends_at, is_completed, comments, parent_id, category_id, is_milestone, id, section_id, characteristics]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- AI LOGISTICS ASSISTANT ---
const aiTools = [
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Use this tool to create a brand new task or milestone in the itinerary.",
      parameters: {
        type: "object",
        properties: {
          task_name: { type: "string" },
          section_id: { type: "number", nullable: true },
          starts_at: { type: "string", nullable: true, description: "ISO string format" },
          responsible: { type: "string", nullable: true },
          is_milestone: { type: "boolean", description: "Set to true if this is a Fite/Milestone" },
          characteristics: { type: "string", nullable: true, description: "Description or notes for the task" }
        },
        required: ["task_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Modify an existing task's details.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "The database ID of the task to update" },
          updates: {
            type: "object",
            description: "The fields to update. Allowed fields: task_name, section_id, starts_at, responsible, is_completed, is_milestone, characteristics, comments.",
            properties: {
              task_name: { type: "string" },
              section_id: { type: "integer", nullable: true },
              starts_at: { type: "string", nullable: true },
              responsible: { type: "string", nullable: true },
              is_completed: { type: "boolean" },
              is_milestone: { type: "boolean" },
              characteristics: { type: "string", description: "The description or main notes of the task." },
              comments: { type: "string", description: "Internal comments or attachments." }
            }
          }
        },
        required: ["id", "updates"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_internet",
      description: "Search the internet for real-time information, history, weather, facts, or news.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The exact search engine query (e.g., 'History of Erice Sicily' or 'Current weather in Palermo')" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_core_memory",
      description: "Save or summarize important user preferences, rules, or context to your permanent long-term memory. Use this when the user explicitly asks you to remember something for the future. You should rewrite the existing memory to include the new facts seamlessly.",
      parameters: {
        type: "object",
        properties: {
          new_memory_text: { type: "string", description: "The comprehensive, updated summary of everything you need to remember. Incorporate the new information into the existing memory string." }
        },
        required: ["new_memory_text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_section",
      description: "Create a new section/day for the itinerary.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Name of the day/section" },
          section_date: { type: "string", description: "Date in YYYY-MM-DD format" },
          description: { type: "string", description: "General notes for the day" }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_category",
      description: "Create a new visual category for tasks (e.g., Hiking, Transport).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          color: { type: "string", description: "Hex color code, e.g., #3498db" },
          icon: { type: "string", description: "Phosphor icon class, e.g., ph-car" },
          line_type: { type: "string", enum: ["solid", "dashed", "dotted"] }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_task_type",
      description: "Create a new task type (e.g., Logistics, Briefing).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          color: { type: "string" },
          icon: { type: "string" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_nearby_places",
      description: "Search for points of interest (restaurants, hotels, gas stations, etc.) near a specific location or city name.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for (e.g., 'Coffee', 'Pharmacy')" },
          location_context: { type: "string", description: "The city or area name to search in" }
        },
        required: ["query", "location_context"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "highlight_task_in_ui",
      description: "Use this tool to visually open, highlight, and focus on a specific task in the user's sidebar UI.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "integer", description: "The database ID of the task to highlight" }
        },
        required: ["task_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_directory",
      description: "Search for contacts by name or role.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_contact",
      description: "Save new person/organization to the database.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          contact_type: { type: "string", enum: ["Staff", "Collaborator", "PlacesContact", "Emergency"] },
          phone: { type: "string" },
          email: { type: "string" },
          notes: { type: "string" }
        },
        required: ["name", "contact_type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "link_contact_to_waypoint",
      description: "Attach a contact to a map location.",
      parameters: {
        type: "object",
        properties: {
          waypoint_id: { type: "integer" },
          contact_id: { type: "integer" }
        },
        required: ["waypoint_id", "contact_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_waypoint",
      description: "Drop a pin/waypoint on the map at the user's current GPS location. Use this when the user's audio note describes a physical location or hazard.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          lat: { type: "number", description: "Extract this from the [GPS: lat, lng] tag in the prompt." },
          lng: { type: "number", description: "Extract this from the [GPS: lat, lng] tag in the prompt." },
          description: { type: "string", description: "The transcribed audio note" },
          icon: { type: "string", description: "Phosphor icon class, e.g., ph-warning, ph-map-pin" },
          color: { type: "string", description: "Hex color code" },
          existing_task_id: { type: "integer", nullable: true, description: "Link to a task if requested" },
          parent_track_id: { type: "integer", description: "ID del track al que pertenece este punto para que aparezca en el perfil de elevación" }
        },
        required: ["title", "lat", "lng"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_waypoint",
      description: "Modify an existing waypoint's details.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          updates: {
            type: "object",
            properties: {
              title: { type: "string" },
              lat: { type: "number" },
              lng: { type: "number" },
              description: { type: "string" },
              icon: { type: "string" },
              color: { type: "string" }
            }
          }
        },
        required: ["id", "updates"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_track",
      description: "Modify an existing track's details.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          updates: {
            type: "object",
            properties: {
              title: { type: "string" },
              color: { type: "string" },
              distance: { type: "number" },
              gain: { type: "number" },
              loss: { type: "number" }
            }
          }
        },
        required: ["id", "updates"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reassign_geometry",
      description: "Move a waypoint or track to a different task.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["waypoint", "track"] },
          id: { type: "integer", description: "The ID of the waypoint or track" },
          new_task_id: { type: "integer" }
        },
        required: ["kind", "id", "new_task_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_contact",
      description: "Modify an existing contact's details.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer" },
          updates: {
            type: "object",
            properties: {
              name: { type: "string" },
              phone: { type: "string" },
              email: { type: "string" },
              notes: { type: "string" }
            }
          }
        },
        required: ["id", "updates"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_contact",
      description: "Remove a contact from the database.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Remove a task from the itinerary.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_waypoint",
      description: "Remove a waypoint from the map.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_track",
      description: "Remove a track from the map.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_section",
      description: "Remove a section (and potentially its tasks) from the itinerary.",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_fleet_status",
      description: "Get the real-time location and status of all fleet devices.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "calculate_eta",
      description: "Estimate arrival time based on current device position and track length.",
      parameters: {
        type: "object",
        properties: {
          track_id: { type: "integer" },
          device_id: { type: "integer" }
        },
        required: ["track_id", "device_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "trigger_ui_discovery",
      description: "Force the dashboard to open the discovery/search sidebar for a specific place or category.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term like 'Gas Stations' or 'Pizza'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_all_waypoints",
      description: "Fetch all waypoints from the database. Use this if you need to check for duplicates or perform global cleanup across all sections.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "calculate_smart_route",
      description: "Generate a road-snapped GPS track between two points using Mapbox Directions.",
      parameters: {
        type: "object",
        properties: {
          start_coords: { type: "string", description: "Format: 'lng,lat'" },
          end_coords: { type: "string", description: "Format: 'lng,lat'" },
          profile: { type: "string", enum: ["walking", "cycling", "driving"], default: "walking" }
        },
        required: ["start_coords", "end_coords"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_backups",
      description: "View available database backups to recover deleted information.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "restore_from_backup",
      description: "Overwrite a table with data from a backup JSONB snapshot.",
      parameters: {
        type: "object",
        properties: {
          backup_id: { type: "integer" },
          table_name: { type: "string", enum: ["waypoints", "tasks", "sections"] }
        },
        required: ["backup_id", "table_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "inspect_backup",
      description: "Read the contents of a specific database backup without restoring it. Use this to find deleted tasks, waypoints, or tracks so you can answer user questions or manually recreate the missing items.",
      parameters: {
        type: "object",
        properties: {
          backup_id: { type: "integer" },
          table_name: { type: "string", enum: ["waypoints", "tasks", "sections", "tracks"] },
          search_term: { type: "string", description: "Filter results by name/title to avoid massive data responses." }
        },
        required: ["backup_id", "table_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_track_point",
      description: "Calcula el KM exacto, la altitud y el contexto de giro de una coordenada respecto a un track. Si no se proporcionan lat/lng, el sistema elegirá automáticamente puntos clave del track para analizarlos.",
      parameters: {
        type: "object",
        properties: {
          track_id: { type: "integer" },
          lat: { type: "number", nullable: true },
          lng: { type: "number", nullable: true }
        },
        required: ["track_id"]
      }
    }
  }
];

async function runAiAgent(finalPrompt, history = [], modelChoice = 'deepseek', activeTaskId = null, imageUrls = []) {
    isAiProcessing = true;
    try {
    // --- AUTO-SNAPSHOT BEFORE AI ACTIONS ---
    try {
        const wpSnap = await pool.query('SELECT * FROM waypoints');
        const tkSnap = await pool.query('SELECT * FROM tasks');
        const scSnap = await pool.query('SELECT * FROM sections');
        const fullSnap = { waypoints: wpSnap.rows, tasks: tkSnap.rows, sections: scSnap.rows };
        await pool.query('INSERT INTO database_backups (table_name, data_json, metadata) VALUES ($1, $2, $3)', 
            ['full_snapshot', JSON.stringify(fullSnap), 'Backup antes de: ' + finalPrompt.substring(0, 50)]);
    } catch (snapErr) { console.error("Auto-snapshot failed:", snapErr); }

    // Fetch AI's permanent memory
    const memoryRes = await pool.query('SELECT memory_text FROM ai_memory WHERE id = 1');
    const longTermMemory = memoryRes.rows[0]?.memory_text || "No specific memories or guidelines saved yet.";

    // 1. Fetch Expedition Days
    const sectionsRes = await pool.query('SELECT id, title, section_date FROM sections ORDER BY section_date ASC');
    const sectionsContext = JSON.stringify(sectionsRes.rows);

    // 2. Fetch Tasks AND their attached Map Geometries
    const currentTasksQuery = `
      SELECT t.id, t.task_name, t.starts_at, t.responsible, t.section_id, t.characteristics,
             COALESCE(
               (
                 SELECT json_agg(
                   json_build_object(
                     'kind', sa.kind,
                     'title', COALESCE(w.title, tr.title),
                     'distance_km', COALESCE(w.distance, tr.distance),
                     'elevation_gain_m', COALESCE(w.gain, tr.gain),
                     'elevation_loss_m', COALESCE(w.loss, tr.loss),
                     'comments_attachments', COALESCE(w.comments, tr.comments),
                     'url_link', COALESCE(w.link, tr.link),
                     'lat', w.lat, 'lng', w.lng,
                     'geojson', tr.geojson_data
                   )
                 )
                 FROM task_anchors ta
                 JOIN spatial_anchors sa ON ta.anchor_id = sa.id
                 LEFT JOIN waypoints w ON sa.waypoint_id = w.id
                 LEFT JOIN tracks tr ON sa.track_id = tr.id
                 WHERE ta.task_id = t.id
               ), '[]'
             ) as map_data
      FROM tasks t
      WHERE t.is_completed = false
      ORDER BY t.starts_at ASC
      LIMIT 200
    `;
    const currentTasks = await pool.query(currentTasksQuery);
    const contextString = JSON.stringify(currentTasks.rows);

    // --- DEEPSEEK AGENT LOOP ---
    const messages = [
        { 
          role: "system", 
          content: `You are the JARVIS of this expedition. You have borderless CRUD permissions.
          
          [YOUR PERMANENT LONG-TERM MEMORY]:
          ${longTermMemory}
          -----------------------------------

          Expedition Days (Sections): ${sectionsContext}.
          Current Active Tasks (with Map Data): ${contextString}.
          
          RULES:
          0. MULTIMODAL: You may receive multiple OCR results or images. Integrate all provided information into your response.
          1. SECRECY: Keep all database IDs strictly internal. Do not EVER write "Task ID", "Section ID", or numbers like "341" in your text replies.
          2. FORMATTING: When referring to tasks, use bullet points and bold text like this: **[Day/Section] - [Task Name]**.
          3. TONE: Speak like a human assistant on WhatsApp. Be concise, clear, and avoid robotic robotic database jargon.
          4. CONTEXT: Maintain conversational context based on the user's history.
          5. GEOMETRY: Answer questions about the route, distances, or locations using the 'map_data'.
          6. SEARCH: If asked to find information you don't know, use the 'search_internet' tool first, read the results, and then fulfill the user's request.
          7. TIME: When creating or moving a task for a specific day, combine the section_date with the requested time to form the correct ISO timestamp (YYYY-MM-DDTHH:mm:ss.000Z), and include the section_id.
          8. VOCAB: 'Fite' means milestone (set is_milestone true).
          9. SEARCH DECISIVENESS: After using 'search_internet' once, if you have received reasonable information, you MUST stop calling tools and provide your final answer immediately. Do not keep searching for 'perfect' details.
          10. MEMORY: If the user asks you to remember a rule or preference, use the 'update_core_memory' tool to rewrite your permanent memory.
          11. STRICT TOOL EXECUTION: NEVER claim to have created, updated, or deleted a task unless you have EXPLICITLY called the appropriate tool (e.g., create_task) in this exact turn. Do not hallucinate actions or pretend to do things.
          12. CONTACTS: Tasks can only be assigned to official 'Staff'. If asked to assign a task, use 'search_directory' to find the ID first, then pass it as 'responsible_contact_id'. Save new phone numbers using 'create_contact'.
          13. UI CONTROL: You CAN control the user's interface. If the user asks to 'show', 'find', 'open', or 'highlight' a task, use the 'highlight_task_in_ui' tool.
          14. OMNIPOTENCE: You can re-assign locations to different tasks, change map icons/colors, and manage the directory.
          15. FLEET: When asked where someone is, always use get_fleet_status.
          16. REFRESH: Always trigger database changes immediately. The system will auto-refresh the UI.
          17. SELECTION AWARENESS: When the user refers to 'this' or 'the current' item, check the [UI CONTEXT] first before asking for clarification.
          18. NAVIGATION: When calculating a route, always tell the user the total distance in kilometers and the estimated travel time in your response.
          19. PROJECT MANAGEMENT: You have full vision of the expedition database via [Expedition Days] and [Current Active Tasks]. If the user asks for a review or optimization, analyze every task, its responsible person, its location in 'map_data', and its 'starts_at' time to provide professional project management advice.
          20. Every task provided in [Current Active Tasks] contains a 'map_data' array. This array includes the database IDs (waypoint_id or track_id) for every location on the map. You DO NOT need a separate tool to scan waypoints; you must read the IDs directly from the 'map_data' provided in this context to perform updates or deletions.
          21. RECUPERACIÓN DE DATOS. Si el usuario indica que has borrado información o cometido un error masivo, utiliza 'list_backups' para encontrar el snapshot anterior a tu acción y 'restore_from_backup' para revertir los cambios en la tabla afectada inmediatamente. NUNCA utilices 'list_backups' ante fallos de herramientas geográficas o de red.
          23. CONFIRMATION REQUIRED: Before calling any 'delete' tool (task, waypoint, track, or section), you MUST ask the user for explicit permission in the chat. Never delete data silently.
          24. GEOMETRY LINKING: You have full permission to use 'reassign_geometry' to organize the map. If a user asks to 'move' or 'assign' a pin/track, do it immediately and confirm the action.
          25. PERFIL DE ELEVACIÓN: Cuando el usuario te pida crear un punto en una ruta o perfil, identifica el track_id de la tarea activa y asígnalo como 'parent_track_id'. Esto es vital para que el punto sea visible en el gráfico técnico.
          26. INTELIGENCIA DE TERRENO: Antes de crear cualquier waypoint en una ruta, DEBES llamar a 'analyze_track_point'. Usa los datos recibidos para escribir un título inteligente. Ej: 'KM 4.2 - Cima' o 'KM 1.5 - Giro a la derecha'.
          27. BÚSQUEDA DE ACCIDENTES: Solo busca accidentes geográficos (Rule 27) si el análisis de track tiene éxito. Si falla, genera el waypoint solo con el KM y la altitud básica para evitar bucles. Si el punto está en un valle o cerca de altitud 0, usa 'search_internet' con las coordenadas para ver si hay un río, puente o playa conocida cerca y menciónalo en la descripción.

          RECOVERY PROTOCOL: If the user asks to fix or recreate items from a backup:
          1. Use \`inspect_backup\` to read the data.
          2. NEVER rely on old 'id', 'section_id', or 'parent_track_id' numbers. They have changed.
          3. Use NAMES/TITLES as the source of truth. 
          4. To relink a Task to a Day: Find the Section in the current database whose 'title' matches the one in the backup, and use its NEW id.
          5. To recover Waypoints after the user uploads tracks: Find the new Track in the database with the same title as the 'parent_track_id' referenced in the backup, and link them.
          6. If an ID cannot be matched by name, move the item to 'Unscheduled' or notify the user.

          [UI CONTEXT]: The user currently has Task ID ${activeTaskId} open and selected in their dashboard. If they say "this task" or "this waypoint," they are likely referring to this ID or its attached geometries.` 
        }
    ];

    // Inject history
    const recentHistory = history.slice(-8);
    recentHistory.forEach(msg => messages.push({ role: msg.role, content: msg.content }));
    messages.push({ role: "user", content: finalPrompt });

    let finalResponseText = "";
    let pendingUiAction = null;

    const RATES = { 
        gemini: { input: 1.25 / 1000000, output: 5.00 / 1000000 },
        deepseek: { input: 0.14 / 1000000, output: 0.28 / 1000000 }
    };
    let totalCost = 0;

    if (modelChoice === 'gemini') {
        // --- GEMINI 1.5 PRO AGENT ---
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.1-pro-preview",
            tools: [{ functionDeclarations: aiTools.map(t => t.function) }]
        });

        const chat = model.startChat({
            history: messages.slice(1, -1).map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }))
        });

        const promptParts = [{ text: finalPrompt }];
        if (imageUrls.length > 0) {
            for (const url of imageUrls) {
                const response = await axios.get(url, { responseType: 'arraybuffer' });
                const mimeType = response.headers['content-type'];
                promptParts.push({
                    inlineData: {
                        data: Buffer.from(response.data).toString('base64'),
                        mimeType: mimeType
                    }
                });
            }
        }

        let result = await chat.sendMessage(promptParts);
        let response = result.response;
        
        for (let step = 0; step < 10; step++) {
            const calls = response.functionCalls();
            if (!calls || calls.length === 0) {
                finalResponseText = response.text();
                break;
            }

            const toolResults = [];
            for (const call of calls) {
                const { name, args } = call;
                console.log(`[Gemini Step ${step}] Calling Tool: ${name}`);
                const toolResult = await executeTool(name, args);
                if (name === "highlight_task_in_ui") pendingUiAction = { type: 'focus_task', taskId: args.task_id };
                if (name === "trigger_ui_discovery") pendingUiAction = { type: 'ui_search', query: args.query };
                if (name === "calculate_smart_route" && typeof toolResult === 'object') pendingUiAction = { type: 'preview_route', geojson: toolResult.geometry };
                toolResults.push({ functionResponse: { name, response: { result: (typeof toolResult === 'string' ? toolResult : toolResult.text) } } });
            }

            result = await chat.sendMessage(toolResults);
            response = result.response;
        }

        const usage = response.usageMetadata;
        if (usage) {
            totalCost = (usage.promptTokenCount * RATES.gemini.input) + (usage.candidatesTokenCount * RATES.gemini.output);
        }
    } else {
        // --- DEEPSEEK AGENT LOOP ---
        let lastDeepseekResponse = null;
        for (let step = 0; step < 10; step++) {
            lastDeepseekResponse = await deepseek.chat.completions.create({
                model: "deepseek-chat",
                messages: messages,
                tools: aiTools,
                tool_choice: "auto"
            });

            const message = lastDeepseekResponse.choices[0].message;
            console.log(`[AI Step ${step}]`, message.tool_calls ? "Calling Tool: " + message.tool_calls[0].function.name : "Giving Text Answer");
            messages.push(message);

            if (!message.tool_calls || message.tool_calls.length === 0) {
                finalResponseText = message.content || "I searched for that but couldn't formulate an answer. Please try again.";
                break;
            }

            for (const toolCall of message.tool_calls) {
                const name = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);
                const toolResult = await executeTool(name, args);
                if (name === "highlight_task_in_ui") pendingUiAction = { type: 'focus_task', taskId: args.task_id };
                if (name === "trigger_ui_discovery") pendingUiAction = { type: 'ui_search', query: args.query };
                if (name === "calculate_smart_route" && typeof toolResult === 'object') pendingUiAction = { type: 'preview_route', geojson: toolResult.geometry };
                messages.push({ role: "tool", tool_call_id: toolCall.id, content: (typeof toolResult === 'string' ? toolResult : toolResult.text) });
            }
        }

        if (lastDeepseekResponse && lastDeepseekResponse.usage) {
            const usage = lastDeepseekResponse.usage;
            totalCost = (usage.prompt_tokens * RATES.deepseek.input) + (usage.completion_tokens * RATES.deepseek.output);
        }
    }

    return { success: true, message: finalResponseText, uiAction: pendingUiAction, cost: totalCost };
    } catch (err) {
        throw err;
    } finally {
        isAiProcessing = false;
        triggerMapRefresh();
    }
}

async function executeTool(name, args) {
    let toolResult = "";
    try {
        if (name === "create_task") {
            const result = await pool.query(
                'INSERT INTO tasks (task_name, section_id, starts_at, responsible, characteristics, is_milestone) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                [args.task_name, args.section_id || null, args.starts_at || null, args.responsible || null, args.characteristics || null, args.is_milestone || false]
            );
            toolResult = `SUCCESS: Task created with ID ${result.rows[0].id}`;
        }
        else if (name === "update_task") {
            const fields = Object.keys(args.updates).map((key, i) => `${key} = $${i + 2}`).join(', ');
            const values = Object.values(args.updates);
            await pool.query(`UPDATE tasks SET ${fields} WHERE id = $1`, [args.id, ...values]);
            toolResult = `SUCCESS: Task ${args.id} updated.`;
        }
        else if (name === "search_internet") {
            const searchResults = await search(args.query, { safeSearch: SafeSearchType.OFF });
            const snippets = searchResults.results.slice(0, 5).map(r => r.description).join('\n\n');
            toolResult = snippets ? `WEB RESULTS FOUND:\n${snippets}` : "No results found on the web.";
        }
        else if (name === "update_core_memory") {
            await pool.query('UPDATE ai_memory SET memory_text = $1 WHERE id = 1', [args.new_memory_text]);
            toolResult = `SUCCESS: Permanent memory updated.`;
        }
        else if (name === "create_section") {
            const res = await pool.query(
                'INSERT INTO sections (title, section_date, description) VALUES ($1, $2, $3) RETURNING id',
                [args.title, args.section_date || null, args.description || null]
            );
            toolResult = `SUCCESS: Section created with ID ${res.rows[0].id}`;
        }
        else if (name === "create_category") {
            const res = await pool.query(
                'INSERT INTO categories (name, color, icon, line_type) VALUES ($1, $2, $3, $4) RETURNING id',
                [args.name, args.color || '#3498db', args.icon || 'ph-map-pin', args.line_type || 'solid']
            );
            toolResult = `SUCCESS: Category created with ID ${res.rows[0].id}`;
        }
        else if (name === "create_task_type") {
            const res = await pool.query(
                'INSERT INTO task_types (name, color, icon) VALUES ($1, $2, $3) RETURNING id',
                [args.name, args.color || '#95a5a6', args.icon || 'ph-tag']
            );
            toolResult = `SUCCESS: Task type created with ID ${res.rows[0].id}`;
        }
        else if (name === "search_nearby_places") {
            const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN;
            const searchUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(args.query + ' ' + args.location_context)}.json?access_token=${mapboxToken}&limit=5`;
            const response = await axios.get(searchUrl);
            const results = response.data.features.map(f => ({ name: f.text, address: f.place_name, coordinates: f.center }));
            toolResult = JSON.stringify(results);
        }
        else if (name === "create_contact") {
            const res = await pool.query(
                'INSERT INTO contacts (name, contact_type, phone, email, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [args.name, args.contact_type || 'Staff', args.phone, args.email, args.notes]
            );
            toolResult = `SUCCESS: Contact created with ID ${res.rows[0].id}.`;
        }
        else if (name === "search_directory") {
            const searchQuery = `%${args.query}%`;
            const res = await pool.query(
                'SELECT id, name, contact_type, phone FROM contacts WHERE name ILIKE $1 OR contact_type ILIKE $1 LIMIT 5',
                [searchQuery]
            );
            toolResult = res.rows.length > 0 ? `FOUND CONTACTS:\n${JSON.stringify(res.rows)}` : `No contacts found.`;
        }
        else if (name === "link_contact_to_waypoint") {
            await pool.query(
                'INSERT INTO waypoint_contacts (waypoint_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [args.waypoint_id, args.contact_id]
            );
            toolResult = `SUCCESS: Linked contact to waypoint.`;
        }
        else if (name === "highlight_task_in_ui") {
            toolResult = `SUCCESS: UI told to highlight task.`;
        }
        else if (name === "create_waypoint") {
            const wpRes = await pool.query(
                'INSERT INTO waypoints (title, lat, lng, description, icon, color) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                [args.title, args.lat, args.lng, args.description || '', args.icon || 'ph-map-pin', args.color || '#3498db']
            );
            const newWpId = wpRes.rows[0].id;
            const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, waypoint_id) VALUES ($1, $2) RETURNING id', ['point', newWpId]);
            if (args.existing_task_id) {
                await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [args.existing_task_id, anchorRes.rows[0].id]);
            }
            toolResult = `SUCCESS: Waypoint created with ID ${newWpId}.`;
        }
        else if (name === "update_waypoint") {
            const fields = Object.keys(args.updates).map((key, i) => `${key} = $${i + 2}`).join(', ');
            const values = Object.values(args.updates);
            await pool.query(`UPDATE waypoints SET ${fields} WHERE id = $1`, [args.id, ...values]);
            toolResult = `SUCCESS: Waypoint ${args.id} updated.`;
        }
        else if (name === "update_track") {
            const fields = Object.keys(args.updates).map((key, i) => `${key} = $${i + 2}`).join(', ');
            const values = Object.values(args.updates);
            await pool.query(`UPDATE tracks SET ${fields} WHERE id = $1`, [args.id, ...values]);
            toolResult = `SUCCESS: Track ${args.id} updated.`;
        }
        else if (name === "reassign_geometry") {
            // Logic must DELETE from task_anchors where waypoint_id or track_id matches, then INSERT a new row for the new_task_id.
            const anchorQuery = args.kind === 'waypoint' ? 
                'SELECT id FROM spatial_anchors WHERE waypoint_id = $1' : 
                'SELECT id FROM spatial_anchors WHERE track_id = $1';
            const anchorRes = await pool.query(anchorQuery, [args.id]);
            if (anchorRes.rows.length > 0) {
                const anchorId = anchorRes.rows[0].id;
                await pool.query('DELETE FROM task_anchors WHERE anchor_id = $1', [anchorId]);
                await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2)', [args.new_task_id, anchorId]);
                toolResult = `SUCCESS: Reassigned ${args.kind} ${args.id} to task ${args.new_task_id}.`;
            } else {
                toolResult = `ERROR: No spatial anchor found for ${args.kind} ${args.id}.`;
            }
        }
        else if (name === "update_contact") {
            const fields = Object.keys(args.updates).map((key, i) => `${key} = $${i + 2}`).join(', ');
            const values = Object.values(args.updates);
            await pool.query(`UPDATE contacts SET ${fields} WHERE id = $1`, [args.id, ...values]);
            toolResult = `SUCCESS: Contact ${args.id} updated.`;
        }
        else if (name === "delete_contact") {
            await pool.query('DELETE FROM contacts WHERE id = $1', [args.id]);
            toolResult = `SUCCESS: Contact ${args.id} deleted.`;
        }
        else if (name === "delete_task") {
            await pool.query('DELETE FROM tasks WHERE id = $1', [args.id]);
            toolResult = `SUCCESS: Task ${args.id} deleted.`;
        }
        else if (name === "delete_waypoint") {
            await pool.query('DELETE FROM waypoints WHERE id = $1', [args.id]);
            toolResult = `SUCCESS: Waypoint ${args.id} deleted.`;
        }
        else if (name === "delete_track") {
            await pool.query('DELETE FROM tracks WHERE id = $1', [args.id]);
            toolResult = `SUCCESS: Track ${args.id} deleted.`;
        }
        else if (name === "delete_section") {
            await pool.query('DELETE FROM tasks WHERE section_id = $1', [args.id]);
            await pool.query('DELETE FROM sections WHERE id = $1', [args.id]);
            toolResult = `SUCCESS: Section ${args.id} deleted.`;
        }
        else if (name === "get_fleet_status") {
            // Join live_devices with the latest pings from location_logs.
            const query = `
                SELECT DISTINCT ON (d.id) 
                    d.display_name, d.icon, d.color, l.lat, l.lng, l.timestamp,
                    EXTRACT(EPOCH FROM (NOW() - l.timestamp))/60 AS minutes_ago
                FROM live_devices d
                LEFT JOIN location_logs l ON LOWER(l.guide_id) = LOWER(d.device_identifier) OR LOWER(l.guide_id) = LOWER(d.display_name) OR l.guide_id = d.id::text
                WHERE d.is_visible = true
                ORDER BY d.id, l.timestamp DESC
            `;
            const res = await pool.query(query);
            toolResult = res.rows.length > 0 ? `FLEET STATUS:\n${JSON.stringify(res.rows)}` : "No fleet devices found or no pings recorded.";
        }
        else if (name === "calculate_eta") {
            // Use speed vs remaining distance (Dummy logic for now based on distance)
            const trackRes = await pool.query('SELECT distance FROM tracks WHERE id = $1', [args.track_id]);
            if (trackRes.rows.length > 0) {
                const distance = trackRes.rows[0].distance || 0;
                const avgSpeed = 4; // km/h
                const hours = distance / avgSpeed;
                toolResult = `ETA: Approximately ${hours.toFixed(2)} hours based on ${distance}km track at ${avgSpeed}km/h.`;
            } else {
                toolResult = "ERROR: Track not found.";
            }
        }
        else if (name === "get_all_waypoints") {
            const res = await pool.query('SELECT id, title, lat, lng, section_id FROM waypoints');
            toolResult = res.rows.length > 0 ? `ALL WAYPOINTS:\n${JSON.stringify(res.rows)}` : "No waypoints found in database.";
        }
        else if (name === "trigger_ui_discovery") {
            toolResult = `SUCCESS: User discovery search triggered for "${args.query}"`;
        }
        else if (name === "calculate_smart_route") {
            try {
                const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN;
                const profile = args.profile || 'walking';
                const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${args.start_coords};${args.end_coords}?geometries=geojson&access_token=${mapboxToken}`;
                const response = await axios.get(url);
                const route = response.data.routes[0];
                if (route) {
                    const distance = (route.distance / 1000).toFixed(2);
                    const duration = Math.round(route.duration / 60);
                    const geometry = route.geometry;
                    // Return an object that we can use both for the AI response and for the UI action
                    return {
                        text: `ROUTE FOUND: ${distance}km, ${duration} mins. Geometry: ${JSON.stringify(geometry)}`,
                        geometry: geometry
                    };
                } else {
                    toolResult = "ERROR: No route found between these points.";
                }
            } catch (err) {
                toolResult = "ERROR calling Mapbox Directions: " + err.message;
            }
        }
        else if (name === "list_backups") {
            const res = await pool.query('SELECT id, backup_date, metadata FROM database_backups ORDER BY backup_date DESC LIMIT 10');
            toolResult = res.rows.length > 0 ? `BACKUPS FOUND:\n${JSON.stringify(res.rows)}` : "No backups found.";
        }
        else if (name === "restore_from_backup") {
            const res = await pool.query('SELECT data_json FROM database_backups WHERE id = $1', [args.backup_id]);
            if (res.rows.length > 0) {
                const snapshot = res.rows[0].data_json;
                const tableData = snapshot[args.table_name];
                if (tableData) {
                    await pool.query('BEGIN');
                    await pool.query(`TRUNCATE TABLE ${args.table_name} CASCADE`);
                    for (const row of tableData) {
                        // 🛟 BYPASS DE EMERGENCIA: Desconectar relaciones huérfanas
                        if (args.table_name === 'waypoints') {
                            row.parent_track_id = null;
                        }
                        if (args.table_name === 'tasks') {
                            row.section_id = null;
                            row.parent_id = null;
                        }

                        const fields = Object.keys(row).join(', ');
                        const placeholders = Object.keys(row).map((_, i) => `$${i + 1}`).join(', ');
                        const values = Object.values(row);
                        await pool.query(`INSERT INTO ${args.table_name} (${fields}) VALUES (${placeholders})`, values);
                    }
                    await pool.query('COMMIT');
                    toolResult = `SUCCESS: Table ${args.table_name} restored from backup ${args.backup_id}.`;
                } else { toolResult = `ERROR: No data for table ${args.table_name} in this backup.`; }
            } else { toolResult = "ERROR: Backup not found."; }
        }
        else if (name === "inspect_backup") {
            const res = await pool.query('SELECT data_json FROM database_backups WHERE id = $1', [args.backup_id]);
            if (res.rows.length > 0) {
                const snapshot = res.rows[0].data_json;
                let tableData = snapshot[args.table_name];
                if (tableData) {
                    if (args.search_term) {
                        const term = args.search_term.toLowerCase();
                        tableData = tableData.filter(row => JSON.stringify(row).toLowerCase().includes(term));
                    }
                    // Limit output size to prevent blowing up the AI's context window
                    const output = tableData.slice(0, 15);
                    toolResult = `BACKUP DATA (Matches: ${tableData.length}, Showing first 15):\n${JSON.stringify(output)}`;
                } else { 
                    toolResult = `ERROR: No data for table ${args.table_name} in this backup.`; 
                }
            } else { 
                toolResult = "ERROR: Backup not found."; 
            }
        }
        else if (name === "analyze_track_point") {
            let kmCalculated = 0;
            try {
                const res = await pool.query('SELECT geojson_data FROM tracks WHERE id = $1', [args.track_id]);
                if (res.rows.length === 0) return JSON.stringify({ error: "Track not found" });

                const geojson = res.rows[0].geojson_data;
                const line = geojson.features[0];
                
                // Si no hay lat/lng, tomamos el punto de inicio del track como fallback o puntos automáticos
                let targetLat = args.lat;
                let targetLng = args.lng;
                
                if (targetLat === undefined || targetLng === undefined) {
                    // Si no se proporcionan, tomamos el primer punto del track por ahora (IA lo mejorará)
                    targetLng = line.geometry.coordinates[0][0];
                    targetLat = line.geometry.coordinates[0][1];
                }

                const point = turf.point([targetLng, targetLat]);
                const snapped = turf.nearestPointOnLine(line, point);
                const coords = line.geometry.coordinates;
                const index = snapped.properties.index;

                // 1. KM Exacto
                const startPoint = turf.point(coords[0]);
                const sliced = turf.lineSlice(startPoint, snapped, line);
                kmCalculated = parseFloat(turf.length(sliced, { units: 'kilometers' }).toFixed(3));
                const km = kmCalculated;

                // 2. Altitud
                const altitude = snapped.geometry.coordinates[2] || 0;

                // 3. Análisis de Pendiente (Cimas)
                let terrainType = "plano";
                const checkDistance = 0.1; // 100m
                let isSummit = true;
                let higherPointFound = false;
                let lowerPointFound = false;

                // Simple check around 100m
                for (let i = Math.max(0, index - 10); i <= Math.min(coords.length - 1, index + 10); i++) {
                    const dist = turf.distance(snapped, turf.point(coords[i]), { units: 'kilometers' });
                    if (dist <= checkDistance && i !== index) {
                        const otherAlt = coords[i][2] || 0;
                        if (otherAlt > altitude) isSummit = false;
                        if (otherAlt > altitude + 0.5) higherPointFound = true;
                        if (otherAlt < altitude - 0.5) lowerPointFound = true;
                    }
                }

                if (isSummit && altitude > 0) terrainType = "cima/summit";
                else if (higherPointFound && !lowerPointFound) terrainType = "bajada";
                else if (!higherPointFound && lowerPointFound) terrainType = "subida";
                else terrainType = "plano";

                // 4. Análisis de Dirección (Giros)
                let detectedTurn = null;
                if (index >= 2 && index <= coords.length - 3) {
                    const prevPt = coords[index - 2];
                    const currPt = coords[index];
                    const nextPt = coords[index + 2];
                    const b1 = turf.bearing(turf.point(prevPt), turf.point(currPt));
                    const b2 = turf.bearing(turf.point(currPt), turf.point(nextPt));
                    let diff = b2 - b1;
                    if (diff > 180) diff -= 360;
                    if (diff < -180) diff += 360;

                    if (Math.abs(diff) > 35) {
                        detectedTurn = {
                            direction: diff > 0 ? "derecha" : "izquierda",
                            angle: Math.abs(parseFloat(diff.toFixed(1)))
                        };
                    }
                }

                toolResult = JSON.stringify({
                    track_id: args.track_id,
                    km: km,
                    altitude: altitude,
                    terrain: terrainType,
                    turn: detectedTurn,
                    coordinates: snapped.geometry.coordinates
                });
            } catch (err) {
                console.error("Error en analyze_track_point:", err);
                toolResult = JSON.stringify({ 
                    error: "Info de entorno no disponible", 
                    km: kmCalculated 
                });
            }
        }
    } catch (err) {
        console.error(`[AI Tool Error] ${name}:`, err);
        toolResult = `ERROR executing ${name}: ${err.message}`;
    }
    return toolResult;
}

app.post('/api/ai/command', adminAuth, async (req, res) => {
    const { prompt, imageUrl, imageUrls = [], history = [], model = 'deepseek', activeTaskId = null } = req.body;
    if (!prompt && !imageUrl && imageUrls.length === 0) return res.status(400).json({ error: "Prompt or Image is required" });

    try {
        let finalPrompt = prompt || "Please process the extracted text from the attached image(s).";
        const allImageUrls = [...imageUrls];
        if (imageUrl) allImageUrls.push(imageUrl);

        if (allImageUrls.length > 0 && model === 'deepseek') {
            const Tesseract = require('tesseract.js');
            for (const url of allImageUrls) {
                try {
                    const { data: { text } } = await Tesseract.recognize(url, 'eng+spa+ita');
                    finalPrompt += `\n\n[RAW TEXT EXTRACTED FROM IMAGE VIA OCR (${url})]:\n${text}`;
                } catch (ocrErr) {
                    finalPrompt += `\n\n[SYSTEM NOTE: OCR extraction failed for image ${url}]`;
                }
            }
        }

        const result = await runAiAgent(finalPrompt, history, model, activeTaskId, allImageUrls);
        res.json(result);
    } catch (err) {
        console.error("AI Error:", err);
        res.status(500).json({ error: "AI processing failed: " + err.message });
    }
});

app.post('/api/ai/audio-command', adminAuth, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
    const { lat, lng, existing_task_id } = req.body;
    try {
        // --- NEW ROBUST TRANSCRIPTION LOGIC ---
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

        const result = await model.generateContent([
            "You are a professional transcriber. Transcribe this audio exactly. Return ONLY text.",
            {
                inlineData: {
                    mimeType: req.file.mimetype,
                    data: req.file.buffer.toString("base64")
                }
            }
        ]);
        const transcript = result.response.text();

        const finalPrompt = `[GPS: ${lat}, ${lng}] I just recorded an audio note here. Transcript: ${transcript}`;
        const agentResult = await runAiAgent(finalPrompt, [], 'deepseek', existing_task_id, []);
        res.json(agentResult);
    } catch (err) {
        console.error("Audio AI Error:", err.response?.data || err.message);
        res.status(500).json({ error: "Audio AI processing failed: " + err.message });
    }
});

app.get('/tracks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tracks');
    res.json(result.rows);
  } catch (err) { res.status(500).send({ error: err.message }); }
});

// Get all child waypoints associated with a specific parent track
app.get('/tracks/:id/waypoints', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM waypoints WHERE parent_track_id = $1 ORDER BY id ASC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/tracks', adminAuth, async (req, res) => {
  console.log("DEBUG POST /tracks payload:", req.body);
  const { title, geojson_data, color, target_group, tasks, existing_task_id, distance, duration, comments, link, parent_track_id, section_id, gain, loss } = req.body;

  try {
    const result = await pool.query('INSERT INTO tracks (title, geojson_data, color, target_group, distance, duration, comments, link, parent_track_id, section_id, gain, loss) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id',
      [title, geojson_data, color || '#3498db', target_group, distance, duration, comments, link, parent_track_id, section_id, gain, loss]);
    const trackId = result.rows[0].id;

    const geometryType = geojson_data.features[0].geometry.type;
    const kind = geometryType === 'Polygon' ? 'polygon' : 'line';
    const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, track_id) VALUES ($1, $2) RETURNING id', [kind, trackId]);
    const anchorId = anchorRes.rows[0].id;

    let targetTaskId = existing_task_id;
    if (!targetTaskId && (!tasks || tasks.length === 0)) {
        targetTaskId = await getOrCreateFallbackTask();
    }

    if (targetTaskId) {
      await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [targetTaskId, anchorId]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        const taskRes = await pool.query('INSERT INTO tasks (task_name, responsible, characteristics, target_group, day_label, starts_at, ends_at, is_completed, section_id, category_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
          [t.name, t.responsible, t.characteristics, t.target_group, t.day_label, t.starts_at, t.ends_at, t.is_completed || false, t.section_id, t.category_id]);
        const newTaskId = taskRes.rows[0].id;
        await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2)', [newTaskId, anchorId]);
      }
    }

    triggerMapRefresh();
    res.status(200).send({ message: "Track uploaded" });
  } catch (err) {
    console.error("DEBUG POST /tracks error:", err);
    res.status(500).send({ error: err.message });
  }
});

app.put('/tracks/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { geojson_data, title, color, target_group, tasks, existing_task_id, link, comments, distance, duration, gain, loss, parent_track_id, section_id } = req.body;

  // Extract gain/loss from geojson_data if provided by modern frontend
  let finalGain = gain;
  let finalLoss = loss;
  if (geojson_data && geojson_data.features && geojson_data.features[0].properties) {
      const props = geojson_data.features[0].properties;
      if (props.gain !== undefined) finalGain = props.gain;
      if (props.loss !== undefined) finalLoss = props.loss;
  }
  try {
    await pool.query(
      'UPDATE tracks SET geojson_data = COALESCE($1, geojson_data), title = COALESCE($2, title), color = COALESCE($3, color), target_group = COALESCE($4, target_group), link = COALESCE($6, link), comments = COALESCE($7, comments), distance = COALESCE($8, distance), gain = COALESCE($9, gain), loss = COALESCE($10, loss), parent_track_id = COALESCE($11, parent_track_id), duration = COALESCE($12, duration), section_id = COALESCE($13, section_id) WHERE id = $5',
      [geojson_data, title, color, target_group, id, link, comments, distance, finalGain, finalLoss, parent_track_id, duration, section_id]
    );

    let anchorId;
    const existingAnchor = await pool.query('SELECT id FROM spatial_anchors WHERE track_id = $1', [id]);
    if (existingAnchor.rows.length > 0) {
      anchorId = existingAnchor.rows[0].id;
    } else if (geojson_data && geojson_data.features && geojson_data.features.length > 0) {
      const geometryType = geojson_data.features[0].geometry.type;
      const kind = geometryType === 'Polygon' ? 'polygon' : 'line';
      const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, track_id) VALUES ($1, $2) RETURNING id', [kind, id]);
      anchorId = anchorRes.rows[0].id;
    }

    if (existing_task_id && anchorId) {
      await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [existing_task_id, anchorId]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        const task = t;
        await pool.query(`
          UPDATE tasks SET
              task_name = COALESCE($1, task_name),
              responsible = COALESCE($2, responsible),
              target_group = COALESCE($3, target_group),
              day_label = COALESCE($4, day_label),
              starts_at = $5,
              ends_at = $6,
              is_completed = COALESCE($7, is_completed),
              section_id = COALESCE($9, section_id),
              category_id = COALESCE($10, category_id)
          WHERE id IN (SELECT task_id FROM task_anchors WHERE anchor_id = $8)`,
          [task.name, task.responsible, task.target_group, task.day_label, task.starts_at, task.ends_at, task.is_completed, anchorId, task.section_id, task.category_id]);
      }
    }
    triggerMapRefresh();
    res.status(200).send({ message: "Track updated successfully" });
  } catch (err) { res.status(500).send({ error: err.message }); }
});

// 3. PROJECT MANAGEMENT: Link Waypoint to Task
app.get('/waypoints', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM waypoints');
    res.json(result.rows);
  } catch (err) { res.status(500).send({ error: err.message }); }
});

app.post('/waypoints', adminAuth, async (req, res) => {
  const { title, lat, lng, description, category, tasks, existing_task_id, color, icon, parent_track_id, photo_url, phone, address, google_maps_url, section_id } = req.body;
  try {
    const wp = await pool.query(
      'INSERT INTO waypoints (title, lat, lng, description, category, color, icon, parent_track_id, photo_url, phone, address, google_maps_url, section_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id',
      [title, lat, lng, description, category, color || '#e74c3c', icon || 'marker', parent_track_id, photo_url, phone, address, google_maps_url, section_id]
    );
    const wpId = wp.rows[0].id;

    const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, waypoint_id) VALUES ($1, $2) RETURNING id', ['point', wpId]);
    const anchorId = anchorRes.rows[0].id;

    let targetTaskId = existing_task_id;
    if (!targetTaskId && (!tasks || tasks.length === 0)) {
        targetTaskId = await getOrCreateFallbackTask();
    }

    if (targetTaskId) {
      await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [targetTaskId, anchorId]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        const taskRes = await pool.query('INSERT INTO tasks (task_name, responsible, characteristics, target_group, day_label, starts_at, ends_at, is_completed, section_id, category_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
          [t.name, t.responsible, t.characteristics, t.target_group, t.day_label, t.starts_at, t.ends_at, t.is_completed || false, t.section_id, t.category_id]);
        const newTaskId = taskRes.rows[0].id;
        await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2)', [newTaskId, anchorId]);
      }
    }
    triggerMapRefresh();
    const wpComplete = await pool.query('SELECT * FROM waypoints WHERE id = $1', [wpId]);
    res.status(200).json(wpComplete.rows[0]);
  } catch (err) {
    console.error("DEBUG POST /waypoints error:", err);
    res.status(500).send({ error: err.message });
  }
});

app.put('/waypoints/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { title, lat, lng, description, category, tasks, color, icon, existing_task_id, link, comments, distance, gain, loss, parent_track_id, photo_url, phone, address, google_maps_url, section_id } = req.body;
  try {
    await pool.query(
      'UPDATE waypoints SET title = COALESCE($1, title), lat = COALESCE($2, lat), lng = COALESCE($3, lng), description = COALESCE($4, description), category = COALESCE($5, category), color = COALESCE($6, color), icon = COALESCE($7, icon), link = COALESCE($9, link), comments = COALESCE($10, comments), distance = COALESCE($11, distance), gain = COALESCE($12, gain), loss = COALESCE($13, loss), parent_track_id = COALESCE($14, parent_track_id), photo_url = COALESCE($15, photo_url), phone = COALESCE($16, phone), address = COALESCE($17, address), google_maps_url = COALESCE($18, google_maps_url), section_id = COALESCE($19, section_id) WHERE id = $8',
      [title, lat, lng, description, category, color, icon, id, link, comments, distance, gain, loss, parent_track_id, photo_url, phone, address, google_maps_url, section_id]
    );

    let anchorId;
    const existingAnchor = await pool.query('SELECT id FROM spatial_anchors WHERE waypoint_id = $1', [id]);
    if (existingAnchor.rows.length > 0) {
      anchorId = existingAnchor.rows[0].id;
    }

    if (existing_task_id && anchorId) {
      await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [existing_task_id, anchorId]);
    }

    if (anchorId && tasks && tasks.length > 0) {
      for (let t of tasks) {
        const task = t;
        await pool.query(`
              UPDATE tasks SET
                  task_name = COALESCE($1, task_name),
                  responsible = COALESCE($2, responsible),
                  target_group = COALESCE($3, target_group),
                  day_label = COALESCE($4, day_label),
                  starts_at = $5,
                  ends_at = $6,
                  is_completed = COALESCE($7, is_completed),
                  section_id = COALESCE($9, section_id),
                  category_id = COALESCE($10, category_id)
              WHERE id IN (SELECT task_id FROM task_anchors WHERE anchor_id = $8)`,
          [task.name, task.responsible, task.target_group, task.day_label, task.starts_at, task.ends_at, task.is_completed, anchorId, task.section_id, task.category_id]);
      }
    }
    triggerMapRefresh();
    res.status(200).send({ message: "Waypoint updated successfully" });
  } catch (err) { res.status(500).send({ error: err.message }); }
});



// Bulk update sort_order for drag-and-drop
app.patch('/tasks/reorder', adminAuth, async (req, res) => {
  const { tasks } = req.body; // Expects an array of { id, sort_order }
  if (!tasks || !Array.isArray(tasks)) return res.status(400).json({ error: "Invalid payload" });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of tasks) {
      await client.query('UPDATE tasks SET sort_order = $1 WHERE id = $2', [t.sort_order, t.id]);
    }
    await client.query('COMMIT');
    res.json({ message: "Order updated successfully" });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete a specific task
app.delete('/tasks/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ message: "Task deleted" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Rename a section (bulk update day_label)
app.put('/tasks/section/:old_label', adminAuth, async (req, res) => {
  try {
    const oldLabel = req.params.old_label === 'Unscheduled' ? null : req.params.old_label;
    const { new_label } = req.body;
    if (oldLabel === null) {
      await pool.query('UPDATE tasks SET day_label = $1 WHERE day_label IS NULL', [new_label]);
    } else {
      await pool.query('UPDATE tasks SET day_label = $1 WHERE day_label = $2', [new_label, oldLabel]);
    }
    res.json({ message: "Section renamed" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete geometries
app.delete('/waypoints/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM waypoints WHERE id = $1', [req.params.id]);
    res.json({ message: "Waypoint deleted" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/tracks/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM tracks WHERE id = $1', [req.params.id]);
    res.json({ message: "Track deleted" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CONTACTS DIRECTORY ---
app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contacts ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts', adminAuth, async (req, res) => {
  const { name, contact_type, phone, email, notes } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO contacts (name, contact_type, phone, email, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, contact_type || 'Staff', phone, email, notes]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/contacts/:id', adminAuth, async (req, res) => {
  const { name, contact_type, phone, email, notes } = req.body;
  try {
    const result = await pool.query(
      'UPDATE contacts SET name=$1, contact_type=$2, phone=$3, email=$4, notes=$5 WHERE id=$6 RETURNING *',
      [name, contact_type, phone, email, notes, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/contacts/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM contacts WHERE id=$1', [req.params.id]);
    res.json({ message: 'Contact deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SECTION MANAGEMENT ---
app.get('/sections', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sections ORDER BY section_date ASC, id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NEW: Create a new Section (Day)
app.post('/sections', adminAuth, async (req, res) => {
  const { section_date, title } = req.body;
  try {
    const result = await pool.query('INSERT INTO sections (section_date, title) VALUES ($1, $2) RETURNING *', [section_date, title || `Day: ${section_date}`]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// NEW: Delete a Section AND all tasks within it
app.delete('/sections/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE section_id = $1', [req.params.id]);
    await pool.query('DELETE FROM sections WHERE id = $1', [req.params.id]);
    res.json({ message: "Section and tasks deleted" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update Section Metadata
app.put('/sections/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { title, section_date, description } = req.body;
  try {
    const result = await pool.query(
      'UPDATE sections SET title = COALESCE($1, title), section_date = COALESCE($2, section_date), description = COALESCE($3, description) WHERE id = $4 RETURNING *',
      [title, section_date, description, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CATEGORY MANAGEMENT ---
app.get('/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/categories', adminAuth, async (req, res) => {
  const { name, color, icon, line_type, marker_size } = req.body;
  try {
    const result = await pool.query('INSERT INTO categories (name, color, icon, line_type, marker_size) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, color || '#3498db', icon || 'ph-map-pin', line_type || 'solid', marker_size || 28]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/categories/:id', adminAuth, async (req, res) => {
  const { name, color, icon, line_type, marker_size } = req.body; // Added marker_size
  try {
    const result = await pool.query('UPDATE categories SET name=$1, color=$2, icon=$3, line_type=$4, marker_size=$5 WHERE id=$6 RETURNING *', [name, color, icon, line_type, marker_size, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/categories/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
    res.json({ message: 'Category deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- TASK TYPES MANAGEMENT ---
app.get('/task_types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM task_types ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/task_types', adminAuth, async (req, res) => {
  const { name, color, icon } = req.body;
  try {
    const result = await pool.query('INSERT INTO task_types (name, color, icon) VALUES ($1, $2, $3) RETURNING *', [name, color || '#95a5a6', icon || 'ph-tag']);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/task_types/:id', adminAuth, async (req, res) => {
  const { name, color, icon } = req.body;
  try {
    const result = await pool.query('UPDATE task_types SET name=$1, color=$2, icon=$3 WHERE id=$4 RETURNING *', [name, color, icon, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/task_types/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM task_types WHERE id=$1', [req.params.id]);
    res.json({ message: 'Task type deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- TEAM MANAGEMENT ---
app.get('/team_members', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM team_members ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/team_members', adminAuth, async (req, res) => {
  const { name } = req.body;
  try {
    const result = await pool.query('INSERT INTO team_members (name) VALUES ($1) RETURNING *', [name]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/team_members/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM team_members WHERE id=$1', [req.params.id]);
    res.json({ message: 'Team member deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. ITINERARY: View Project Plan
app.get('/itinerary', async (req, res) => {
  const { section_id } = req.query; // Step 4: Pagination support
  let filterClause = "";
  let params = [];

  if (section_id && section_id !== 'null') {
    filterClause = "WHERE t.section_id = $1";
    params.push(section_id);
  }

  try {
    const query = `
      SELECT t.*, t.id AS task_id, s.section_date,
             c.color AS category_color, c.icon AS category_icon, c.line_type AS category_line_type,
             tt.name AS task_type_name, tt.icon AS task_type_icon,
             COALESCE(
               (
                 SELECT json_agg(geom_data)
                 FROM (
                   SELECT DISTINCT ON (sa.id) -- Step 4: Fix deduplication bug
                     json_build_object(
                       'anchor_id', sa.id,
                       'waypoint_id', w.id,
                       'track_id', tr.id,
                       'kind', sa.kind,
                       'title', COALESCE(w.title, tr.title),
                       'color', COALESCE(w.color, tr.color),
                       'icon', w.icon,
                       'lat', w.lat, 'lng', w.lng,
                       'geojson', tr.geojson_data,
                       'link', COALESCE(w.link, tr.link),
                       'comments', COALESCE(w.comments, tr.comments),
                       'distance', COALESCE(w.distance, tr.distance),
                       'gain', COALESCE(w.gain, tr.gain),
                       'loss', COALESCE(w.loss, tr.loss),
                       'parent_track_id', COALESCE(w.parent_track_id, tr.parent_track_id),
                       'photo_url', w.photo_url,
                       'phone', w.phone,
                       'address', w.address,
                       'google_maps_url', w.google_maps_url
                     ) AS geom_data
                   FROM task_anchors ta
                   JOIN spatial_anchors sa ON ta.anchor_id = sa.id
                   LEFT JOIN waypoints w ON sa.waypoint_id = w.id
                   LEFT JOIN tracks tr ON sa.track_id = tr.id
                   WHERE ta.task_id = t.id
                 ) sub
               ), '[]'
             ) as geometries
      FROM tasks t
      LEFT JOIN sections s ON t.section_id = s.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN task_types tt ON t.task_type_id = tt.id
      ${filterClause}
      GROUP BY t.id, s.section_date, c.color, c.icon, c.line_type, tt.name, tt.icon
      ORDER BY s.section_date ASC NULLS FIRST, t.sort_order ASC, t.starts_at ASC;
    `;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Query failed", details: err.message });
  }
});

// --- UNLINK ANCHOR FROM TASK ---
app.delete('/tasks/:task_id/anchors/:anchor_id', adminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM task_anchors WHERE task_id = $1 AND anchor_id = $2', [req.params.task_id, req.params.anchor_id]);
        res.json({ message: "Unlinked successfully" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 📡 FLEET TRACKING & TELEMETRY ---

// 1. TRACCAR LOCATION WEBHOOK (From the native mobile app)
app.all('/api/location', async (req, res) => {
    try {
        console.log('[Traccar DEBUG] query:', req.query, '| body:', req.body);

        // Support BOTH Background Geolocation plugin (nested) AND OsmAnd-style (flat)
        const id  = req.body.device_id      || req.query.id  || req.body.id;
        const lat = req.body.location?.coords?.latitude  || req.query.lat || req.body.lat;
        const lon = req.body.location?.coords?.longitude || req.query.lon || req.body.lon;

        if (!id || !lat || !lon) return res.status(400).send("Missing GPS parameters");

        await pool.query(
            'INSERT INTO location_logs (guide_id, lat, lng) VALUES ($1, $2, $3)',
            [id.toString().trim(), lat, lon]
        );

        console.log(`[Fleet Radar] 📍 Saved location for: ${id} @ ${lat}, ${lon}`);
        res.status(200).send("OK");
    } catch (err) {
        console.error("Location Webhook Error:", err);
        res.status(500).send("Server Error");
    }
});

// 2. WEB BROADCASTER (From field.html)
app.post('/api/fleet/telemetry', adminAuth, async (req, res) => {
    const { device_id, lat, lng } = req.body;
    if (!device_id || !lat || !lng) return res.status(400).json({error: "Missing data"});
    
    try {
        await pool.query(
            'INSERT INTO location_logs (guide_id, lat, lng) VALUES ($1, $2, $3)',
            [device_id.toString().trim(), lat, lng]
        );
        res.json({success: true});
    } catch (e) { 
        res.status(500).json({error: e.message}); 
    }
});

// 3. Fetch Fleet Directory (For the UI Panel)
app.get('/api/fleet/devices', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM live_devices ORDER BY display_name ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Update Device Settings (Toggle Visibility)
app.put('/api/fleet/devices/:id', adminAuth, async (req, res) => {
    const { display_name, assigned_user, color, is_visible, icon, icon_size } = req.body;
    try {
        await pool.query(
            'UPDATE live_devices SET display_name = COALESCE($1, display_name), assigned_user = COALESCE($2, assigned_user), color = COALESCE($3, color), is_visible = COALESCE($4, is_visible), icon = COALESCE($5, icon), icon_size = COALESCE($6, icon_size) WHERE id = $7',
            [display_name, assigned_user, color, is_visible, icon, icon_size, req.params.id]
        );
        res.json({ message: "Device updated" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Crear un nuevo dispositivo
app.post('/api/fleet/devices', adminAuth, async (req, res) => {
    const { device_identifier, display_name, color, icon } = req.body;
    try {
        const result = await pool.query(
            "INSERT INTO live_devices (device_identifier, display_name, color, icon) VALUES ($1, $2, $3, $4) RETURNING *",
            [device_identifier, display_name, color || '#3498db', icon || 'ph-user']
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Borrar un dispositivo
app.delete('/api/fleet/devices/:id', adminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM live_devices WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Fetch the Telemetry History (The Magic Translation)
app.get('/api/fleet/telemetry', async (req, res) => {
    const minutes = parseInt(req.query.minutes) || 60; 
    try {
        // THE FIX: Notice the first selected item is "d.id AS guide_id"
        // This forces the database to output the numeric ID for the UI, regardless of whether Traccar saved "pablo" or "cris".
        const query = `
            SELECT d.id AS guide_id, l.lat, l.lng, l.timestamp, d.display_name, d.color, d.icon, d.icon_size 
            FROM location_logs l
            JOIN live_devices d ON LOWER(l.guide_id) = LOWER(d.device_identifier) OR LOWER(l.guide_id) = LOWER(d.display_name) OR l.guide_id = d.id::text
            WHERE l.timestamp >= NOW() - INTERVAL '1 minute' * $1
            AND d.is_visible = true
            ORDER BY l.timestamp ASC
        `;
        const result = await pool.query(query, [minutes]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. RAW TELEMETRY LOGS (For the Data Inspector)
app.get('/api/fleet/logs', async (req, res) => {
    try {
        // Fetches the last 200 GPS pings, matching them to guide names
        const query = `
            SELECT l.id, l.guide_id, l.lat, l.lng, l.timestamp, d.display_name 
            FROM location_logs l
            LEFT JOIN live_devices d ON LOWER(l.guide_id) = LOWER(d.device_identifier) OR LOWER(l.guide_id) = LOWER(d.display_name) OR l.guide_id = d.id::text
            ORDER BY l.timestamp DESC
            LIMIT 200
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- TRACCAR PROXY ENDPOINTS ---
app.get('/api/traccar/positions', async (req, res) => {
  try {
    const response = await axios.get(`${process.env.TRACCAR_URL}/api/positions`, {
      auth: {
        username: process.env.TRACCAR_USER,
        password: process.env.TRACCAR_PASSWORD
      }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Traccar Sync Failed", details: err.message });
  }
});

app.get('/api/traccar/devices', async (req, res) => {
  try {
    const response = await axios.get(`${process.env.TRACCAR_URL}/api/devices`, {
      auth: {
        username: process.env.TRACCAR_USER,
        password: process.env.TRACCAR_PASSWORD
      }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Traccar Device Fetch Failed", details: err.message });
  }
});

// Quick-Link an existing geometry to a new task without overwriting old links
app.post('/link_anchor', adminAuth, async (req, res) => {
  const { task_id, anchor_id } = req.body;
  if (!task_id || !anchor_id) return res.status(400).json({ error: "Missing IDs" });
  try {
    await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [task_id, anchor_id]);
    res.json({ message: 'Linked successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/icons/:name', (req, res) => {
  res.sendFile(path.join(__dirname, req.params.name));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Auto-setup DB on startup to prevent 'relation missing' errors
pool.query(`
    CREATE TABLE IF NOT EXISTS ai_memory (
      id SERIAL PRIMARY KEY,
      memory_text TEXT
    );
    INSERT INTO ai_memory (id, memory_text) VALUES (1, '') ON CONFLICT DO NOTHING;
`).catch(err => console.error("Auto DB setup failed:", err));

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, '0.0.0.0', () => console.log(`API online on port ${PORT}`));

// --- GEMINI MULTIMODAL LIVE WEBSOCKET SERVER ---
const wss = new WebSocketServer({ server, path: '/api/live-stream' });

wss.on('connection', async (ws) => {
    console.log('[Live AI] Iniciando sesión con Gemini 3.1 Pro...');
    let setupConfirmed = false;

    try {
        const WebSocket = require('ws');
        // Usamos la URL bidiGenerateContent con la versión v1alpha
        const googleWs = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`);

        googleWs.on('open', () => {
            googleWs.send(JSON.stringify({
                setup: {
                    model: "models/gemini-2.5-flash",
                    generation_config: { 
                        response_modalities: ["AUDIO"],
                        speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } }
                    }
                }
            }));
        });

        googleWs.on('message', (data) => {
            const resp = JSON.parse(data);
            
            if (resp.setupComplete) {
                setupConfirmed = true;
                console.log('[Live AI] Gemini 3.1 Pro Listo. Escuchando...');
                if (ws.readyState === 1) ws.send(JSON.stringify({ status: "ready" }));
                return;
            }

            if (resp.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
                const audioB64 = resp.serverContent.modelTurn.parts[0].inlineData.data;
                if (ws.readyState === 1) ws.send(Buffer.from(audioB64, 'base64'));
            }
        });

        googleWs.on('close', (code, reason) => {
            console.error(`[Live AI] Google cerró conexión. Código: ${code}, Razón: ${reason}`);
            if (ws.readyState === 1) ws.send(JSON.stringify({ status: "error", code, reason }));
            ws.close();
        });

        ws.on('message', (data) => {
            // CRITICAL: No enviamos audio hasta que setupConfirmed sea true
            if (googleWs.readyState === 1 && setupConfirmed) {
                const b64 = Buffer.isBuffer(data) ? data.toString("base64") : Buffer.from(data).toString("base64");
                googleWs.send(JSON.stringify({ 
                    realtime_input: { 
                        media_chunks: [{ mime_type: "audio/pcm;rate=16000", data: b64 }] 
                    } 
                }));
            }
        });
    } catch (e) { ws.close(); }
});
