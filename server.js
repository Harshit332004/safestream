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

// Initialize SQLite database
const db = new sqlite3.Database('./history.db', (err) => {
    if (err) console.error("Database error:", err);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS history (
            userId TEXT,
            tmdbId TEXT,
            type TEXT,
            title TEXT,
            season INTEGER,
            episode INTEGER,
            timestamp REAL,
            duration REAL,
            last_updated INTEGER,
            PRIMARY KEY (userId, tmdbId, type)
        )`);
    }
});

// Sync playback progress (receives exact seconds)
app.post('/api/sync', (req, res) => {
    const { userId, tmdbId, type, title, season, episode, timestamp, duration } = req.body;
    
    if (!userId || !tmdbId || !type) return res.status(400).json({ error: "Missing parameters" });

    const now = Date.now();
    db.run(
        `INSERT INTO history (userId, tmdbId, type, title, season, episode, timestamp, duration, last_updated) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(userId, tmdbId, type) DO UPDATE SET 
            title=excluded.title,
            season=excluded.season,
            episode=excluded.episode,
            timestamp=excluded.timestamp,
            duration=excluded.duration,
            last_updated=excluded.last_updated`,
        [userId, tmdbId, type, title || "Unknown", season || 1, episode || 1, timestamp, duration, now],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, syncedAt: now });
        }
    );
});

// Retrieve cross-device watch history
app.get('/api/history/:userId', (req, res) => {
    const { userId } = req.params;
    db.all(`SELECT * FROM history WHERE userId = ? ORDER BY last_updated DESC`, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ history: rows });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Production server running on http://localhost:${PORT}`));
