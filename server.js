const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(cors());
app.use(express.json());

// Auth middleware
app.use('/api', (req, res, next) => {
    if (req.headers["x-api-key"] !== "streamsafe-secret") {
        return res.status(403).json({ error: "Unauthorized access" });
    }
    next();
});

// Database: PRIMARY KEY is (tmdbId, type) — one entry per show/movie
// Migration: drop old table if schema is wrong (old PK was tmdbId,type,season,episode)
const db = new sqlite3.Database('./history.db', (err) => {
    if (err) return console.error('DB open error:', err.message);
    
    // Check if table exists and has the correct schema
    db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='history'`, (err, row) => {
        if (err) return console.error('Schema check error:', err.message);
        
        if (row && row.sql && row.sql.includes('season, episode)')) {
            // Old schema detected — drop and recreate
            console.log('Migrating database: old PK (tmdbId,type,season,episode) → new PK (tmdbId,type)');
            db.run(`DROP TABLE history`, () => {
                createTable();
            });
        } else {
            createTable();
        }
    });
});

function createTable() {
    db.run(`CREATE TABLE IF NOT EXISTS history (
        tmdbId TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT DEFAULT 'Unknown',
        season INTEGER DEFAULT 1,
        episode INTEGER DEFAULT 1,
        timestamp REAL DEFAULT 0,
        duration REAL DEFAULT 0,
        last_updated INTEGER DEFAULT 0,
        PRIMARY KEY (tmdbId, type)
    )`, (err) => {
        if (err) console.error('Table creation error:', err.message);
        else console.log('Database ready (PK: tmdbId, type)');
    });
}

// Sync: upsert — for TV shows, this overwrites the previous episode entry
app.post('/api/sync', (req, res) => {
    const { tmdbId, type, title, season, episode, timestamp, duration, last_updated } = req.body;
    if (!tmdbId || !type) return res.status(400).json({ error: "Missing tmdbId or type" });

    const ts = last_updated || Date.now();
    
    db.run(
        `INSERT INTO history (tmdbId, type, title, season, episode, timestamp, duration, last_updated) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tmdbId, type) DO UPDATE SET 
            title=excluded.title,
            season=excluded.season,
            episode=excluded.episode,
            timestamp=excluded.timestamp, 
            duration=excluded.duration, 
            last_updated=excluded.last_updated
         WHERE excluded.last_updated > history.last_updated`,
        [tmdbId, type, title || "Unknown", season || 1, episode || 1, timestamp || 0, duration || 0, ts],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, changes: this.changes });
        }
    );
});

// Bulk sync: accept array of items (reduces network round-trips)
app.post('/api/sync/bulk', (req, res) => {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Empty items array" });

    const stmt = db.prepare(
        `INSERT INTO history (tmdbId, type, title, season, episode, timestamp, duration, last_updated) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tmdbId, type) DO UPDATE SET 
            title=excluded.title, season=excluded.season, episode=excluded.episode,
            timestamp=excluded.timestamp, duration=excluded.duration, last_updated=excluded.last_updated
         WHERE excluded.last_updated > history.last_updated`
    );

    let errors = 0;
    db.serialize(() => {
        items.forEach(i => {
            stmt.run(
                [i.tmdbId, i.type, i.title || "Unknown", i.season || 1, i.episode || 1, i.timestamp || 0, i.duration || 0, i.last_updated || Date.now()],
                (err) => { if (err) errors++; }
            );
        });
        stmt.finalize(() => {
            res.json({ success: true, processed: items.length, errors });
        });
    });
});

// Continue Watching list
app.get('/api/continue-watching', (req, res) => {
    db.all(`SELECT * FROM history ORDER BY last_updated DESC LIMIT 20`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ history: rows || [] });
    });
});

// Delete entry
app.delete('/api/history', (req, res) => {
    const { tmdbId, type } = req.body;
    if (!tmdbId || !type) return res.status(400).json({ error: "Missing parameters" });
    db.run(`DELETE FROM history WHERE tmdbId = ? AND type = ?`,
        [tmdbId, type],
        (err) => err ? res.status(500).json({ error: err.message }) : res.json({ success: true })
    );
});

// Clear all history
app.delete('/api/history/all', (req, res) => {
    db.run(`DELETE FROM history`, (err) => {
        err ? res.status(500).json({ error: err.message }) : res.json({ success: true });
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StreamSafe API running on port ${PORT}`));