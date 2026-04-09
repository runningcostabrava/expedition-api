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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS location_logs (id SERIAL PRIMARY KEY, guide_id TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION, timestamp TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS waypoints (id SERIAL PRIMARY KEY, title TEXT, description TEXT, lat DOUBLE PRECISION, lng DOUBLE PRECISION);
      CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, waypoint_id INTEGER REFERENCES waypoints(id) ON DELETE CASCADE, task_name TEXT, responsible TEXT, characteristics TEXT, scheduled_time TIMESTAMPTZ, is_completed BOOLEAN DEFAULT false);
      CREATE TABLE IF NOT EXISTS tracks (id SERIAL PRIMARY KEY, title TEXT, color TEXT DEFAULT '#FF0000', geojson_data JSONB NOT NULL);
    `);
    res.send("Database tables created/verified successfully!");
  } catch (err) { res.status(500).send("Setup Error: " + err.message); }
});

// 2. TRACKS: GPX Upload
app.post('/tracks', async (req, res) => {
  const { title, geojson_data, color } = req.body;
  try {
    await pool.query('INSERT INTO tracks (title, geojson_data, color) VALUES ($1, $2, $3)', [title, geojson_data, color || '#3498db']);
    res.status(200).send({ message: "Track uploaded" });
  } catch (err) { res.status(500).send({ error: err.message }); }
});

// 3. PROJECT MANAGEMENT: Link Waypoint to Task
app.post('/waypoints', async (req, res) => {
  const { title, lat, lng, description, tasks } = req.body;
  try {
    const wp = await pool.query('INSERT INTO waypoints (title, lat, lng, description) VALUES ($1, $2, $3, $4) RETURNING id', [title, lat, lng, description]);
    const wpId = wp.rows[0].id;
    if (tasks && tasks.length > 0) {
      for (let t of tasks) {
        await pool.query('INSERT INTO tasks (waypoint_id, task_name, responsible, characteristics) VALUES ($1, $2, $3, $4)', 
        [wpId, t.name, t.responsible, t.characteristics]);
      }
    }
    res.status(200).send({ message: "Project link saved!" });
  } catch (err) { res.status(500).send({ error: err.message }); }
});

// 4. ITINERARY: View Project Plan
app.get('/itinerary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.title as waypoint, t.task_name as task, t.responsible 
      FROM waypoints w 
      INNER JOIN tasks t ON w.id = t.waypoint_id
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).send({ error: err.message }); }
});

app.get('/', (req, res) => res.send("Expedition API is Online"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API online on port ${PORT}`));