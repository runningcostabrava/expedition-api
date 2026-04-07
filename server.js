const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Connect to your Render PostgreSQL Database
// Render will provide this URL in your database dashboard
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } // Required for Render connections
});

// ==========================================
// ENDPOINT 1: Android Guides send GPS here
// ==========================================
app.post('/log-location', async (req, res) => {
  const { guide_id, lat, lng } = req.body;

  try {
    // Insert the GPS ping into your database
    const query = `
      INSERT INTO location_logs (guide_id, lat, lng, timestamp) 
      VALUES ($1, $2, $3, NOW())
    `;
    await pool.query(query, [guide_id, lat, lng]);
    res.status(200).send({ message: "Location saved successfully" });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).send({ error: "Failed to save location" });
  }
});

// ==========================================
// ENDPOINT 2: Web Dashboard asks for Live Locations
// ==========================================
app.get('/live-locations', async (req, res) => {
  try {
    // Get the most recent location for each guide
    const query = `
      SELECT DISTINCT ON (guide_id) guide_id, lat, lng, timestamp 
      FROM location_logs 
      ORDER BY guide_id, timestamp DESC;
    `;
    const result = await pool.query(query);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).send({ error: "Failed to fetch locations" });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Expedition API running on port ${PORT}`);
});