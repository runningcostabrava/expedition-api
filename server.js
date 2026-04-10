const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const adminAuth = (req, res, next) => {
  if (req.headers['x-api-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 1. SETUP: Run once at /setup-db
app.get('/setup-db', adminAuth, async (req, res) => {
  try {
    // First, ensure tables exist (for new deployments)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS location_logs (id SERIAL PRIMARY KEY, guide_id TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, timestamp TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS waypoints (id SERIAL PRIMARY KEY, title TEXT, description TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION);
      CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, waypoint_id INTEGER REFERENCES waypoints(id) ON DELETE CASCADE, task_name TEXT, responsible TEXT, characteristics TEXT, scheduled_time TIMESTAMPTZ, is_completed BOOLEAN DEFAULT false);
      CREATE TABLE IF NOT EXISTS tracks (id SERIAL PRIMARY KEY, title TEXT, color TEXT DEFAULT '#FF0000', geojson_data JSONB NOT NULL);
    `);

    // Second, alter tables to add ALL potentially missing columns from older versions
    await pool.query(`
      ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS category TEXT;
      ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS description TEXT;
      
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS responsible TEXT;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS characteristics TEXT;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_group TEXT;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS day_label TEXT;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_completed BOOLEAN DEFAULT false;
      
      ALTER TABLE tracks ADD COLUMN IF NOT EXISTS target_group TEXT;
    `);

    // Phase 2: Spatial Anchors and Timelines
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spatial_anchors (
        id SERIAL PRIMARY KEY,
        kind VARCHAR(20) CHECK (kind IN ('point', 'line', 'polygon')),
        waypoint_id INTEGER REFERENCES waypoints(id) ON DELETE CASCADE,
        track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE
      );
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS anchor_id INTEGER REFERENCES spatial_anchors(id) ON DELETE CASCADE;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
    `);

    res.send("Database tables created and updated successfully with v2.0 columns!");
  } catch (err) { 
    res.status(500).send("Setup Error: " + err.message); 
  }
});

// 2. TRACKS: GPX Upload & Management
app.get('/tracks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tracks');
    res.json(result.rows);
  } catch (err) { res.status(500).send({ error: err.message }); }
});

app.post('/tracks', adminAuth, async (req, res) => {
  const { title, geojson_data, color, target_group, tasks, existing_task_id } = req.body;
  try {
    const result = await pool.query('INSERT INTO tracks (title, geojson_data, color, target_group) VALUES ($1, $2, $3, $4) RETURNING id', 
      [title, geojson_data, color || '#3498db', target_group]);
    const trackId = result.rows[0].id;

    const geometryType = geojson_data.features[0].geometry.type;
    const kind = geometryType === 'Polygon' ? 'polygon' : 'line';
    const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, track_id) VALUES ($1, $2) RETURNING id', [kind, trackId]);
    const anchorId = anchorRes.rows[0].id;

    if (existing_task_id) {
        await pool.query('UPDATE tasks SET anchor_id = $1 WHERE id = $2', [anchorId, existing_task_id]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        await pool.query('INSERT INTO tasks (anchor_id, task_name, responsible, characteristics, target_group, day_label, starts_at, ends_at, is_completed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', 
          [anchorId, t.name, t.responsible, t.characteristics, t.target_group, t.day_label, t.starts_at, t.ends_at, t.is_completed || false]);
      }
    }

    res.status(200).send({ message: "Track uploaded" });
  } catch (err) { res.status(500).send({ error: err.message }); }
});

app.put('/tracks/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { geojson_data, title, color, target_group, tasks, existing_task_id } = req.body;
  try {
    await pool.query(
      'UPDATE tracks SET geojson_data = $1, title = COALESCE($2, title), color = COALESCE($3, color), target_group = COALESCE($4, target_group) WHERE id = $5',
      [geojson_data, title, color, target_group, id]
    );

    // Find or create anchor
    let anchorId;
    const existingAnchor = await pool.query('SELECT id FROM spatial_anchors WHERE track_id = $1', [id]);
    if (existingAnchor.rows.length > 0) {
        anchorId = existingAnchor.rows[0].id;
    } else {
        const geometryType = geojson_data.features[0].geometry.type;
        const kind = geometryType === 'Polygon' ? 'polygon' : 'line';
        const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, track_id) VALUES ($1, $2) RETURNING id', [kind, id]);
        anchorId = anchorRes.rows[0].id;
    }

    if (existing_task_id) {
        await pool.query('UPDATE tasks SET anchor_id = $1 WHERE id = $2', [anchorId, existing_task_id]);
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
                is_completed = COALESCE($7, is_completed)
            WHERE anchor_id = $8`,
            [task.name, task.responsible, task.target_group, task.day_label, task.starts_at, task.ends_at, task.is_completed, anchorId]);
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
  const { title, lat, lng, description, category, tasks, existing_task_id } = req.body;
  try {
    const wp = await pool.query('INSERT INTO waypoints (title, lat, lng, description, category) VALUES ($1, $2, $3, $4, $5) RETURNING id', 
      [title, lat, lng, description, category]);
    const wpId = wp.rows[0].id;

    const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, waypoint_id) VALUES ($1, $2) RETURNING id', ['point', wpId]);
    const anchorId = anchorRes.rows[0].id;

    if (existing_task_id) {
        await pool.query('UPDATE tasks SET anchor_id = $1, waypoint_id = $2 WHERE id = $3', [anchorId, wpId, existing_task_id]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        await pool.query('INSERT INTO tasks (waypoint_id, anchor_id, task_name, responsible, characteristics, target_group, day_label, starts_at, ends_at, is_completed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', 
        [wpId, anchorId, t.name, t.responsible, t.characteristics, t.target_group, t.day_label, t.starts_at, t.ends_at, t.is_completed || false]);
      }
    }
    res.status(200).send({ message: "Project link saved!" });
  } catch (err) { res.status(500).send({ error: err.message }); }
});

app.put('/waypoints/:id', adminAuth, async (req, res) => {
    const { id } = req.params;
    const { title, lat, lng, description, category, tasks } = req.body;
    try {
      await pool.query(
        'UPDATE waypoints SET title = COALESCE($1, title), lat = COALESCE($2, lat), lng = COALESCE($3, lng), description = COALESCE($4, description), category = COALESCE($5, category) WHERE id = $6',
        [title, lat, lng, description, category, id]
      );
  
      if (tasks && tasks.length > 0) {
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
                  is_completed = COALESCE($7, is_completed)
              WHERE waypoint_id = $8`,
              [task.name, task.responsible, task.target_group, task.day_label, task.starts_at, task.ends_at, task.is_completed, id]);
          }
      }
  
      res.status(200).send({ message: "Waypoint updated successfully" });
    } catch (err) { res.status(500).send({ error: err.message }); }
});

// 4. ITINERARY: View Project Plan
app.get('/itinerary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.id as task_id,
        COALESCE(w_anchor.title, tr_anchor.title, w_legacy.title) as waypoint,
        COALESCE(w_anchor.category, w_legacy.category) as waypoint_category,
        COALESCE(w_anchor.lat, w_legacy.lat) as lat,
        COALESCE(w_anchor.lng, w_legacy.lng) as lng,
        COALESCE(w_anchor.id, w_legacy.id) as waypoint_id,
        tr_anchor.id as linked_track_id,
        sa.id as anchor_id,
        sa.kind as anchor_kind,
        t.task_name as task, t.responsible, t.target_group, t.day_label,
        t.starts_at, t.ends_at, t.is_completed
      FROM tasks t
      LEFT JOIN spatial_anchors sa ON t.anchor_id = sa.id
      LEFT JOIN waypoints w_anchor ON sa.waypoint_id = w_anchor.id
      LEFT JOIN tracks tr_anchor ON sa.track_id = tr_anchor.id
      LEFT JOIN waypoints w_legacy ON t.waypoint_id = w_legacy.id
      ORDER BY t.starts_at ASC NULLS LAST, t.day_label ASC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).send({ error: err.message }); }
});

app.get('/api/config', (req, res) => {
  res.json({ 
    MAPBOX_TOKEN: process.env.MAPBOX_TOKEN,
    ADMIN_KEY: process.env.ADMIN_KEY
  });
});

app.get('/', (req, res) => res.send("Expedition API is Online"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`API online on port ${PORT}`));
