const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 1. SETUP: Run once at /setup-db
app.get('/setup-db', async (req, res) => {
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

app.post('/tracks', async (req, res) => {
  const { title, geojson_data, color, target_group } = req.body;
  try {
    await pool.query('INSERT INTO tracks (title, geojson_data, color, target_group) VALUES ($1, $2, $3, $4)', 
      [title, geojson_data, color || '#3498db', target_group]);
    res.status(200).send({ message: "Track uploaded" });
  } catch (err) { res.status(500).send({ error: err.message }); }
});

app.put('/tracks/:id', async (req, res) => {
  const { id } = req.params;
  const { geojson_data, title, color, target_group } = req.body;
  try {
    await pool.query(
      'UPDATE tracks SET geojson_data = $1, title = COALESCE($2, title), color = COALESCE($3, color), target_group = COALESCE($4, target_group) WHERE id = $5',
      [geojson_data, title, color, target_group, id]
    );
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

app.post('/waypoints', async (req, res) => {
  const { title, lat, lng, description, category, tasks } = req.body;
  try {
    const wp = await pool.query('INSERT INTO waypoints (title, lat, lng, description, category) VALUES ($1, $2, $3, $4, $5) RETURNING id', 
      [title, lat, lng, description, category]);
    const wpId = wp.rows[0].id;
    if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        await pool.query('INSERT INTO tasks (waypoint_id, task_name, responsible, characteristics, target_group, day_label) VALUES ($1, $2, $3, $4, $5, $6)', 
        [wpId, t.name, t.responsible, t.characteristics, t.target_group, t.day_label]);
      }
    }
    res.status(200).send({ message: "Project link saved!" });
  } catch (err) { res.status(500).send({ error: err.message }); }
});

// 4. ITINERARY: View Project Plan
app.get('/itinerary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        w.title as waypoint, 
        w.category as waypoint_category,
        w.lat,
        w.lng,
        t.task_name as task, 
        t.responsible,
        t.target_group,
        t.day_label
      FROM waypoints w 
      INNER JOIN tasks t ON w.id = t.waypoint_id
      ORDER BY t.day_label, w.title
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).send({ error: err.message }); }
});

app.get('/api/config', (req, res) => {
  res.json({ MAPBOX_TOKEN: process.env.MAPBOX_TOKEN });
});

app.get('/', (req, res) => res.send("Expedition API is Online"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`API online on port ${PORT}`));
