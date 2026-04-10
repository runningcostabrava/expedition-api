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

    // Phase 3: Task-Centric model & many-to-many
    await pool.query(`
      -- Add styling to waypoints
      ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#e74c3c';
      ALTER TABLE waypoints ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT 'marker';
      
      -- Create Junction Table for Many-to-Many relationship
      CREATE TABLE IF NOT EXISTS task_anchors (
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        anchor_id INTEGER REFERENCES spatial_anchors(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, anchor_id)
      );
    `);

    res.send("Database tables created and updated successfully with v3.0 Task-Centric model!");
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
      await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [existing_task_id, anchorId]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        const taskRes = await pool.query('INSERT INTO tasks (task_name, responsible, characteristics, target_group, day_label, starts_at, ends_at, is_completed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id', 
          [t.name, t.responsible, t.characteristics, t.target_group, t.day_label, t.starts_at, t.ends_at, t.is_completed || false]);
        const newTaskId = taskRes.rows[0].id;
        await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2)', [newTaskId, anchorId]);
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
      await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [existing_task_id, anchorId]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        const task = t;
        // In the many-to-many world, we update the tasks linked to this anchor
        await pool.query(`
          UPDATE tasks SET 
              task_name = COALESCE($1, task_name), 
              responsible = COALESCE($2, responsible), 
              target_group = COALESCE($3, target_group), 
              day_label = COALESCE($4, day_label), 
              starts_at = $5, 
              ends_at = $6, 
              is_completed = COALESCE($7, is_completed)
          WHERE id IN (SELECT task_id FROM task_anchors WHERE anchor_id = $8)`,
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
  const { title, lat, lng, description, category, tasks, existing_task_id, color, icon } = req.body;
  try {
    const wp = await pool.query('INSERT INTO waypoints (title, lat, lng, description, category, color, icon) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', 
      [title, lat, lng, description, category, color || '#e74c3c', icon || 'marker']);
    const wpId = wp.rows[0].id;

    const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, waypoint_id) VALUES ($1, $2) RETURNING id', ['point', wpId]);
    const anchorId = anchorRes.rows[0].id;

    if (existing_task_id) {
      await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [existing_task_id, anchorId]);
    } else if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        const taskRes = await pool.query('INSERT INTO tasks (task_name, responsible, characteristics, target_group, day_label, starts_at, ends_at, is_completed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id', 
        [t.name, t.responsible, t.characteristics, t.target_group, t.day_label, t.starts_at, t.ends_at, t.is_completed || false]);
        const newTaskId = taskRes.rows[0].id;
        await pool.query('INSERT INTO task_anchors (task_id, anchor_id) VALUES ($1, $2)', [newTaskId, anchorId]);
      }
    }
    res.status(200).send({ message: "Waypoint created and linked!" });
  } catch (err) { res.status(500).send({ error: err.message }); }
});

app.put('/waypoints/:id', adminAuth, async (req, res) => {
    const { id } = req.params;
    const { title, lat, lng, description, category, tasks, color, icon } = req.body;
    try {
      await pool.query(
        'UPDATE waypoints SET title = COALESCE($1, title), lat = COALESCE($2, lat), lng = COALESCE($3, lng), description = COALESCE($4, description), category = COALESCE($5, category), color = COALESCE($6, color), icon = COALESCE($7, icon) WHERE id = $8',
        [title, lat, lng, description, category, color, icon, id]
      );

      let anchorId;
      const existingAnchor = await pool.query('SELECT id FROM spatial_anchors WHERE waypoint_id = $1', [id]);
      if (existingAnchor.rows.length > 0) {
        anchorId = existingAnchor.rows[0].id;
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
                  is_completed = COALESCE($7, is_completed)
              WHERE id IN (SELECT task_id FROM task_anchors WHERE anchor_id = $8)`,
              [task.name, task.responsible, task.target_group, task.day_label, task.starts_at, task.ends_at, task.is_completed, anchorId]);
          }
      }
  
      res.status(200).send({ message: "Waypoint updated successfully" });
    } catch (err) { res.status(500).send({ error: err.message }); }
});

// 4. ITINERARY: View Project Plan
app.get('/itinerary', async (req, res) => {
  try {
    // Note: Due to many-to-many, a task can appear multiple times if it has multiple anchors.
    // For the UI, we'll join via task_anchors.
    const result = await pool.query(`
      SELECT 
        t.id as task_id,
        COALESCE(w.title, tr.title) as waypoint,
        w.category as waypoint_category,
        w.lat, w.lng,
        w.id as waypoint_id,
        tr.id as linked_track_id,
        sa.id as anchor_id,
        sa.kind as anchor_kind,
        t.task_name as task, t.responsible, t.target_group, t.day_label,
        t.starts_at, t.ends_at, t.is_completed
      FROM tasks t
      LEFT JOIN task_anchors ta ON t.id = ta.task_id
      LEFT JOIN spatial_anchors sa ON ta.anchor_id = sa.id
      LEFT JOIN waypoints w ON sa.waypoint_id = w.id
      LEFT JOIN tracks tr ON sa.track_id = tr.id
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
