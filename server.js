const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(cors());
app.use(express.json());

// --- Auth Middleware ---
app.use('/api', (req, res, next) => {
    if (req.method !== 'OPTIONS' && req.headers['x-api-key'] !== 'streamsafe-secret') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
});

// --- Database Setup ---
const db = new sqlite3.Database('./history.db', (err) => {
    if (err) { console.error('DB open error:', err); return; }

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS history (
            tmdbId TEXT, type TEXT, title TEXT,
            season INTEGER, episode INTEGER,
            timestamp REAL, duration REAL, last_updated INTEGER,
            PRIMARY KEY (tmdbId, type, season, episode)
        )`);

        db.run(`CREATE INDEX IF NOT EXISTS idx_last_updated ON history(last_updated)`);

        db.run(`DELETE FROM history WHERE duration > 0 AND timestamp >= duration - 30`, (err) => {
            if (!err) console.log('Boot cleanup: removed completed videos.');
        });
    });
});

let writeCount = 0;

app.post('/api/sync', (req, res) => {
    const { tmdbId, type, title, season, episode, timestamp, duration, last_updated } = req.body;

    if (!tmdbId || !type || timestamp === undefined) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    writeCount++;
    if (writeCount % 50 === 0) {
        db.run(`DELETE FROM history WHERE duration > 0 AND timestamp >= duration - 30`);
    }

    db.run(
        `INSERT INTO history (tmdbId, type, title, season, episode, timestamp, duration, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tmdbId, type, season, episode) DO UPDATE SET
            title       = excluded.title,
            timestamp   = excluded.timestamp,
            duration    = excluded.duration,
            last_updated = excluded.last_updated
         WHERE excluded.last_updated > history.last_updated
           AND abs(excluded.timestamp - history.timestamp) >= 2`,
        [tmdbId, type, title || 'Unknown', season || 1, episode || 1,
         timestamp, duration, last_updated || Date.now()],
        (err) => err ? res.status(500).json({ error: err.message }) : res.json({ success: true })
    );
});

app.get('/api/continue-watching', (req, res) => {
    const since = parseInt(req.query.since) || 0;

    db.all(`
        SELECT
            tmdbId, type, title, season, episode,
            timestamp, duration, last_updated,
            CAST(MIN((timestamp * 100.0 / duration), 100) AS REAL) AS progress
        FROM history
        WHERE duration > 0
          AND timestamp < duration - 10
          AND last_updated > ?
        ORDER BY last_updated DESC
        LIMIT 15
    `, [since], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ history: rows });
    });
});

app.delete('/api/history', (req, res) => {
    const { tmdbId, type, season, episode } = req.body;
    if (!tmdbId || !type) return res.status(400).json({ error: 'Missing fields' });

    db.run(
        `DELETE FROM history WHERE tmdbId = ? AND type = ? AND season = ? AND episode = ?`,
        [tmdbId, type, season || 1, episode || 1],
        (err) => err ? res.status(500).json({ error: err.message }) : res.json({ success: true })
    );
});

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StreamSafe Backend v2 running on port ${PORT}`));
