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
    const queries = [
      // Core Tables
      "CREATE TABLE IF NOT EXISTS location_logs (id SERIAL PRIMARY KEY, guide_id TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, timestamp TIMESTAMPTZ DEFAULT NOW())",
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
      "ALTER TABLE categories ADD COLUMN IF NOT EXISTS line_type TEXT DEFAULT 'solid'",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_milestone BOOLEAN DEFAULT false",
      "ALTER TABLE categories ADD COLUMN IF NOT EXISTS marker_size INTEGER DEFAULT 28"
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

// 2. TRACKS: GPX Upload & Management
app.post('/tasks', adminAuth, async (req, res) => {
  console.log("DEBUG POST /tasks payload:", req.body); // <-- Debugging added
  const { task_name, responsible, target_group, task_type, day_label, starts_at, ends_at, is_completed, comments, parent_id, is_milestone, section_id, category_id } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO tasks (task_name, responsible, target_group, task_type, day_label, starts_at, ends_at, is_completed, comments, parent_id, is_milestone, section_id, category_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *',
      [task_name, responsible, target_group, task_type, day_label, starts_at, ends_at, is_completed || false, comments, parent_id, is_milestone || false, section_id, category_id]
    );
    res.json(result.rows[0]);
  } catch (err) { 
    console.error("DEBUG POST /tasks error:", err); // <-- Debugging added
    res.status(500).json({ error: err.message }); 
  }
});

app.put('/tasks/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { task_name, responsible, target_group, task_type, day_label, starts_at, ends_at, is_completed, comments, parent_id, category_id, is_milestone, section_id } = req.body;
  try {
    const result = await pool.query(
      'UPDATE tasks SET task_name=$1, responsible=$2, target_group=$3, task_type=$4, day_label=$5, starts_at=$6, ends_at=$7, is_completed=$8, comments=$9, parent_id=$10, category_id=$11, is_milestone=$12, section_id=$14 WHERE id=$13 RETURNING *',
      [task_name, responsible, target_group, task_type, day_label, starts_at, ends_at, is_completed, comments, parent_id, category_id, is_milestone, id, section_id]
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

app.post('/tracks', adminAuth, async (req, res) => {
  console.log("DEBUG POST /tracks payload:", req.body);
  const { title, geojson_data, color, target_group, tasks, existing_task_id, distance, duration, comments, link, parent_track_id } = req.body;
  try {
    const result = await pool.query('INSERT INTO tracks (title, geojson_data, color, target_group, distance, duration, comments, link, parent_track_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [title, geojson_data, color || '#3498db', target_group, distance, duration, comments, link, parent_track_id]);
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
  const { geojson_data, title, color, target_group, tasks, existing_task_id, link, comments, distance, duration, gain, loss, parent_track_id } = req.body;
  try {
    await pool.query(
      'UPDATE tracks SET geojson_data = COALESCE($1, geojson_data), title = COALESCE($2, title), color = COALESCE($3, color), target_group = COALESCE($4, target_group), link = COALESCE($6, link), comments = COALESCE($7, comments), distance = COALESCE($8, distance), gain = COALESCE($9, gain), loss = COALESCE($10, loss), parent_track_id = COALESCE($11, parent_track_id), duration = COALESCE($12, duration) WHERE id = $5',
      [geojson_data, title, color, target_group, id, link, comments, distance, gain, loss, parent_track_id, duration]
    );

    let anchorId;
    const existingAnchor = await pool.query('SELECT id FROM spatial_anchors WHERE track_id = $1', [id]);
    if (existingAnchor.rows.length > 0) {
      anchorId = existingAnchor.rows[0].id;
    } else if (geojson_data && geojson_data.features && geojson_data.features.length > 0) {
      // Safely ensure geojson_data exists before attempting to read its properties
      const geometryType = geojson_data.features[0].geometry.type;
      const kind = geometryType === 'Polygon' ? 'polygon' : 'line';
      const anchorRes = await pool.query('INSERT INTO spatial_anchors (kind, track_id) VALUES ($1, $2) RETURNING id', [kind, id]);
      anchorId = anchorRes.rows[0].id;
    }

    if (existing_task_id && anchorId) {
      await pool.query('DELETE FROM task_anchors WHERE anchor_id = $1', [anchorId]);
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
  console.log("DEBUG POST /waypoints payload:", req.body);
  const { title, lat, lng, description, category, tasks, existing_task_id, color, icon, parent_track_id } = req.body;
  try {
    const wp = await pool.query('INSERT INTO waypoints (title, lat, lng, description, category, color, icon, parent_track_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [title, lat, lng, description, category, color || '#e74c3c', icon || 'marker', parent_track_id]);
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
  const { title, lat, lng, description, category, tasks, color, icon, existing_task_id, link, comments, distance, gain, loss, parent_track_id } = req.body;
  try {
    await pool.query(
      'UPDATE waypoints SET title = COALESCE($1, title), lat = COALESCE($2, lat), lng = COALESCE($3, lng), description = COALESCE($4, description), category = COALESCE($5, category), color = COALESCE($6, color), icon = COALESCE($7, icon), link = COALESCE($9, link), comments = COALESCE($10, comments), distance = COALESCE($11, distance), gain = COALESCE($12, gain), loss = COALESCE($13, loss), parent_track_id = COALESCE($14, parent_track_id) WHERE id = $8',
      [title, lat, lng, description, category, color, icon, id, link, comments, distance, gain, loss, parent_track_id]
    );

    let anchorId;
    const existingAnchor = await pool.query('SELECT id FROM spatial_anchors WHERE waypoint_id = $1', [id]);
    if (existingAnchor.rows.length > 0) {
      anchorId = existingAnchor.rows[0].id;
    }

    if (existing_task_id && anchorId) {
      await pool.query('DELETE FROM task_anchors WHERE anchor_id = $1', [anchorId]);
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



// Delete a specific task
app.delete('/tasks/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ message: "Task deleted" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete an entire section (by day_label)
app.delete('/tasks/section/:day_label', adminAuth, async (req, res) => {
  try {
    const label = req.params.day_label === 'Unscheduled' ? null : req.params.day_label;
    if (label === null) {
      await pool.query('DELETE FROM tasks WHERE day_label IS NULL');
    } else {
      await pool.query('DELETE FROM tasks WHERE day_label = $1', [label]);
    }
    res.json({ message: "Section deleted" });
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

// 4. ITINERARY: View Project Plan
app.get('/itinerary', async (req, res) => {
  try {
    const query = `
  SELECT t.*, t.id AS task_id, s.section_date, -- Include section_date for sorting
         c.color AS category_color,
         c.icon AS category_icon,
         c.line_type AS category_line_type,
         c.marker_size AS category_marker_size, -- Add this line
         COALESCE(
               json_agg(
                 json_build_object(
                   'anchor_id', ta.anchor_id,
                   'waypoint_id', w.id,
                   'track_id', tr.id,
                   'kind', CASE WHEN w.id IS NOT NULL THEN 'point' ELSE 'line' END,
                   'title', COALESCE(w.title, tr.title),
                   'color', COALESCE(w.color, tr.color),
                   'icon', w.icon,
                   'lat', w.lat,
                   'lng', w.lng,
                   'geojson', tr.geojson_data,
                   'link', COALESCE(w.link, tr.link),
                   'comments', COALESCE(w.comments, tr.comments),
                   'distance', tr.distance,
                   'duration', tr.duration,
                   'gain', tr.gain,
                   'loss', tr.loss,
                   'parent_track_id', COALESCE(w.parent_track_id, tr.parent_track_id)
                 )
               ) FILTER (WHERE ta.anchor_id IS NOT NULL), '[]'
             ) as geometries
      FROM tasks t
      LEFT JOIN sections s ON t.section_id = s.id -- Join with sections
      LEFT JOIN categories c ON t.category_id = c.id -- Join the categories table
      LEFT JOIN task_anchors ta ON t.id = ta.task_id
      LEFT JOIN spatial_anchors sa ON ta.anchor_id = sa.id
      LEFT JOIN waypoints w ON sa.waypoint_id = w.id
      LEFT JOIN tracks tr ON sa.track_id = tr.id
      GROUP BY t.id, s.section_date, c.color, c.icon, c.line_type, c.marker_size -- Group by section_date and category fields
      ORDER BY s.section_date ASC, t.starts_at ASC; -- This handles the "Auto Arrange"
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error("ITINERARY ERROR:", err.message);
    res.status(500).json({ error: "Database query failed", details: err.message });
  }
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
