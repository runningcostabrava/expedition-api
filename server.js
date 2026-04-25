const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken'); // 1. Import JWT
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios'); // Added for Traccar proxy
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET 
});
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true })); // <--- 🚨 ADD THIS CRITICAL LINE 🚨
app.use(express.static(path.join(__dirname)));

const JWT_SECRET = process.env.JWT_SECRET || 'emergency_fallback_secret'; // 2. Set secret

// REPLACED: adminAuth now verifies tokens, not a static key
const adminAuth = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1]; // Expecting "Bearer <token>"

  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decoded; // Token is valid
    next();
  });
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
      "DO $$ BEGIN ALTER TABLE tracks ADD CONSTRAINT fk_parent_track_self FOREIGN KEY (parent_track_id) REFERENCES tracks(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN null; END $$;"
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

    if (existing_task_id) {
      await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [existing_task_id, anchorId]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        const taskRes = await pool.query('INSERT INTO tasks (task_name, responsible, characteristics, target_group, day_label, starts_at, ends_at, is_completed, section_id, category_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
          [t.name, t.responsible, t.characteristics, t.target_group, t.day_label, t.starts_at, t.ends_at, t.is_completed || false, t.section_id, t.category_id]);
        const newTaskId = taskRes.rows[0].id;
        await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2)', [newTaskId, anchorId]);
      }
    }

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

    if (existing_task_id) {
      await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [existing_task_id, anchorId]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        const taskRes = await pool.query('INSERT INTO tasks (task_name, responsible, characteristics, target_group, day_label, starts_at, ends_at, is_completed, section_id, category_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
          [t.name, t.responsible, t.characteristics, t.target_group, t.day_label, t.starts_at, t.ends_at, t.is_completed || false, t.section_id, t.category_id]);
        const newTaskId = taskRes.rows[0].id;
        await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2)', [newTaskId, anchorId]);
      }
    }
    res.status(200).send({ message: "Waypoint created and linked!" });
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
      [name, color || '#3498db', icon || '📍', line_type || 'solid', marker_size || 28]);
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
    const result = await pool.query('INSERT INTO task_types (name, color, icon) VALUES ($1, $2, $3) RETURNING *', [name, color || '#95a5a6', icon || '🏷️']);
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
        const id = req.query.id || req.body.id;
        const lat = req.query.lat || req.body.lat;
        const lon = req.query.lon || req.body.lon;

        if (!id || !lat || !lon) return res.status(400).send("Missing GPS parameters");

        // Save EXACTLY what Traccar sends (e.g. "pablo")
        await pool.query(
            'INSERT INTO location_logs (guide_id, lat, lng) VALUES ($1, $2, $3)',
            [id.toString().trim(), lat, lon]
        );

        console.log(`[Fleet Radar] 📍 Saved Traccar location for: ${id}`);
        res.status(200).send("OK");
    } catch (err) {
        console.error("Traccar Webhook Error:", err);
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

// 5. Fetch the Telemetry History (The Magic Translation)
app.get('/api/fleet/telemetry', async (req, res) => {
    const minutes = parseInt(req.query.minutes) || 60; 
    try {
        // THE FIX: Notice the first selected item is "d.id AS guide_id"
        // This forces the database to output the numeric ID for the UI, regardless of whether Traccar saved "pablo" or "cris".
        const query = `
            SELECT d.id AS guide_id, l.lat, l.lng, l.timestamp, d.display_name, d.color, d.icon, d.icon_size 
            FROM location_logs l
            JOIN live_devices d ON LOWER(l.guide_id) = LOWER(d.device_identifier) OR l.guide_id = d.id::text
            WHERE l.timestamp >= NOW() - INTERVAL '1 minute' * $1
            AND d.is_visible = true
            ORDER BY l.timestamp ASC
        `;
        const result = await pool.query(query, [minutes]);
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

// UPDATED: Remove ADMIN_KEY from the public config broadcast
app.get('/api/config', (req, res) => {
  res.json({
    MAPBOX_TOKEN: process.env.MAPBOX_TOKEN,
    GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY
    // ADMIN_KEY IS GONE from here!
  });
});

app.get('/icons/:name', (req, res) => {
  res.sendFile(path.join(__dirname, req.params.name));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`API online on port ${PORT}`));
