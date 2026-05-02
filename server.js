const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();

// Explicit CORS to allow Vercel frontend to talk to Render backend
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json());

// Protect the backend since it will be public
app.use('/api', (req, res, next) => {
    if (req.headers["x-api-key"] !== "streamsafe-secret") {
        return res.status(403).json({ error: "Unauthorized access" });
    }
    next();
});

// Serve the frontend static files
app.use(express.static(path.join(__dirname)));

// Initialize SQLite database (Single-User Schema)
const db = new sqlite3.Database('./history.db', (err) => {
    if (err) console.error("Database error:", err);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS history (
            tmdbId TEXT,
            type TEXT,
            title TEXT,
            season INTEGER,
            episode INTEGER,
            timestamp REAL,
            duration REAL,
            last_updated INTEGER,
            PRIMARY KEY (tmdbId, type, season, episode)
        )`);
    }
});

// Sync playback progress (Single User)
app.post('/api/sync', (req, res) => {
    const { tmdbId, type, title, season, episode, timestamp, duration } = req.body;
    
    if (!tmdbId || !type) return res.status(400).json({ error: "Missing parameters" });

    const now = Date.now();
    db.run(
        `INSERT INTO history (tmdbId, type, title, season, episode, timestamp, duration, last_updated) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tmdbId, type, season, episode) DO UPDATE SET 
            title=excluded.title,
            timestamp=excluded.timestamp,
            duration=excluded.duration,
            last_updated=excluded.last_updated
         WHERE excluded.last_updated > history.last_updated`,
        [tmdbId, type, title || "Unknown", season || 1, episode || 1, timestamp, duration, now],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, syncedAt: now });
        }
    );
});

// Retrieve global watch history
app.get('/api/history', (req, res) => {
    db.all(`SELECT * FROM history ORDER BY last_updated DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ history: rows });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StreamSafe Backend running on port ${PORT}`));
