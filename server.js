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

// --- THE MISSING SETUP ROUTE ---
app.get('/setup-db', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS location_logs (
          id SERIAL PRIMARY KEY,
          guide_id TEXT NOT NULL,
          lat DOUBLE PRECISION NOT NULL,
          lng DOUBLE PRECISION NOT NULL,
          timestamp TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS waypoints (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          lat DOUBLE PRECISION NOT NULL,
          lng DOUBLE PRECISION NOT NULL,
          waypoint_type TEXT DEFAULT 'stop'
      );
      CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          waypoint_id INTEGER REFERENCES waypoints(id) ON DELETE CASCADE,
          task_name TEXT NOT NULL,
          scheduled_time TIMESTAMPTZ,
          is_completed BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS tracks (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          color TEXT DEFAULT '#FF0000',
          geojson_data JSONB NOT NULL
      );
    `);
    res.send("Database tables created successfully!");
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// --- TRACKS ---
app.post('/tracks', async (req, res) => {
  const { title, geojson_data, color } = req.body;
  try {
    await pool.query('INSERT INTO tracks (title, geojson_data, color) VALUES ($1, $2, $3)', [title, geojson_data, color]);
    res.status(200).send({ message: "Track uploaded" });
  } catch (err) { res.status(500).send(err); }
});

// --- LIVE GPS ---
app.post('/log-location', async (req, res) => {
  const { guide_id, lat, lng } = req.body;
  try {
    await pool.query('INSERT INTO location_logs (guide_id, lat, lng) VALUES ($1, $2, $3)', [guide_id, lat, lng]);
    res.status(200).send({ status: "ok" });
  } catch (err) { res.status(500).send(err); }
});

app.get('/live-locations', async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT ON (guide_id) * FROM location_logs ORDER BY guide_id, timestamp DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).send(err); }
});

// ROOT ROUTE (To check if API is alive)
app.get('/', (req, res) => {
  res.send("Expedition API is running!");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API online on port ${PORT}`));