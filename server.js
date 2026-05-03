const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());

// Protect API access with secret key[cite: 3]
app.use('/api', (req, res, next) => {
    if (req.headers["x-api-key"] !== "streamsafe-secret") {
        return res.status(403).json({ error: "Unauthorized access" });
    }
    next();
});

// Initialize SQLite database schema[cite: 13]
const db = new sqlite3.Database('./history.db', (err) => {
    if (!err) {
        db.run(`CREATE TABLE IF NOT EXISTS history (
            tmdbId TEXT, type TEXT, title TEXT, 
            season INTEGER, episode INTEGER, 
            timestamp REAL, duration REAL, last_updated INTEGER,
            PRIMARY KEY (tmdbId, type, season, episode)
        )`);
    }
});

// API: Sync watch progress with atomic conflict resolution[cite: 3, 13]
app.post('/api/sync', (req, res) => {
    const { tmdbId, type, title, season, episode, timestamp, duration, last_updated } = req.body;
    db.run(
        `INSERT INTO history (tmdbId, type, title, season, episode, timestamp, duration, last_updated) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tmdbId, type, season, episode) DO UPDATE SET 
            title=excluded.title, 
            timestamp=excluded.timestamp, 
            duration=excluded.duration, 
            last_updated=excluded.last_updated
         WHERE excluded.last_updated > history.last_updated`,
        [tmdbId, type, title || "Unknown", season || 1, episode || 1, timestamp, duration, last_updated || Date.now()],
        (err) => err ? res.status(500).json({ error: err.message }) : res.json({ success: true })
    );
});

// API: Retrieve recent continue-watching list[cite: 3]
app.get('/api/continue-watching', (req, res) => {
    db.all(`SELECT * FROM history ORDER BY last_updated DESC LIMIT 20`, [], (err, rows) => {
        err ? res.status(500).json({ error: err.message }) : res.json({ history: rows });
    });
});

// API: Remove a specific entry[cite: 13]
app.delete('/api/history', (req, res) => {
    const { tmdbId, type, season, episode } = req.body;
    db.run(`DELETE FROM history WHERE tmdbId = ? AND type = ? AND season = ? AND episode = ?`,
        [tmdbId, type, season || 1, episode || 1],
        (err) => err ? res.status(500).json({ error: err.message }) : res.json({ success: true })
    );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StreamSafe API Hardened Core running on port ${PORT}`));