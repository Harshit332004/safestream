const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json());

// Auth middleware (skip health check)
app.use('/api', (req, res, next) => {
    // Allow health check without auth
    if (req.path === '/health') {
        return next();
    }

    if (req.headers["x-api-key"] !== "streamsafe-secret") {
        return res.status(403).json({ error: "Unauthorized access" });
    }
    next();
});

// ═══════════════════════════════════════════
// HISTORY DATABASE
// ═══════════════════════════════════════════
const db = new sqlite3.Database('./history.db', (err) => {
    if (err) return console.error('DB open error:', err.message);

    db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='history'`, (err, row) => {
        if (err) return console.error('Schema check error:', err.message);

        if (row && row.sql && row.sql.includes('season, episode)')) {
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

// ═══════════════════════════════════════════
// HISTORY API ENDPOINTS (EXISTING)
// ═══════════════════════════════════════════

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
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, changes: this.changes });
        }
    );
});

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

app.get('/api/continue-watching', (req, res) => {
    db.all(`SELECT * FROM history ORDER BY last_updated DESC LIMIT 20`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ history: rows || [] });
    });
});

app.delete('/api/history', (req, res) => {
    const { tmdbId, type } = req.body;
    if (!tmdbId || !type) return res.status(400).json({ error: "Missing parameters" });
    db.run(`DELETE FROM history WHERE tmdbId = ? AND type = ?`,
        [tmdbId, type],
        (err) => err ? res.status(500).json({ error: err.message }) : res.json({ success: true })
    );
});

app.delete('/api/history/all', (req, res) => {
    db.run(`DELETE FROM history`, (err) => {
        err ? res.status(500).json({ error: err.message }) : res.json({ success: true });
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ═══════════════════════════════════════════
// CINEPRO CORE INTEGRATION (PROXY)
// ═══════════════════════════════════════════

/**
 * CINEPRO_CORE_URL — internal endpoint to your CinePro backend
 * In development: http://localhost:4000 (via your laptop)
 * In production (Render): Run CinePro Core in same container
 * 
 * For now, we'll assume it's running locally during dev
 * Later, we'll set up CinePro Core as a separate service on Render
 */
const CINEPRO_CORE_URL = process.env.CINEPRO_CORE_URL || 'http://localhost:4000';

/**
 * Health check for CinePro backend
 */
app.get('/cinepro/health', async (req, res) => {
    try {
        const response = await fetch(`${CINEPRO_CORE_URL}/health`, { timeout: 3000 });
        const data = await response.json();
        res.json({
            status: data.status === 'operational' ? 'ok' : 'degraded',
            core: data
        });
    } catch (e) {
        res.status(503).json({
            status: 'unreachable',
            error: e.message,
            hint: 'Make sure CinePro Core is running'
        });
    }
});

/**
 * Proxy: GET /cinepro/movie/:tmdbId
 * Forwards request to CinePro Core and returns sources
 */
app.get('/cinepro/movie/:tmdbId', async (req, res) => {
    const { tmdbId } = req.params;

    try {
        const response = await fetch(`${CINEPRO_CORE_URL}/movie/${tmdbId}`, {
            timeout: 15000  // CinePro may take time scraping
        });

        if (!response.ok) {
            return res.status(response.status).json({
                error: `CinePro returned ${response.status}`,
                sources: [],
                subtitles: []
            });
        }

        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error(`CinePro movie fetch failed for ${tmdbId}:`, e.message);
        res.status(503).json({
            error: 'CinePro Core unavailable',
            sources: [],
            subtitles: [],
            hint: e.message
        });
    }
});

/**
 * Proxy: GET /cinepro/tv/:tmdbId/:season/:episode
 * Forwards request to CinePro Core and returns sources
 */
app.get('/cinepro/tv/:tmdbId/:season/:episode', async (req, res) => {
    const { tmdbId, season, episode } = req.params;

    try {
        const response = await fetch(
            `${CINEPRO_CORE_URL}/tv/${tmdbId}/${season}/${episode}`,
            { timeout: 15000 }
        );

        if (!response.ok) {
            return res.status(response.status).json({
                error: `CinePro returned ${response.status}`,
                sources: [],
                subtitles: []
            });
        }

        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error(`CinePro TV fetch failed for ${tmdbId}/${season}/${episode}:`, e.message);
        res.status(503).json({
            error: 'CinePro Core unavailable',
            sources: [],
            subtitles: [],
            hint: e.message
        });
    }
});

// ═══════════════════════════════════════════
// SERVER START
// ═══════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 StreamSafe API running on port ${PORT}`);
    console.log(`📍 History API: http://localhost:${PORT}/api`);
    console.log(`🎬 CinePro proxy: http://localhost:${PORT}/cinepro`);
    console.log(`🔗 CinePro Core backend: ${CINEPRO_CORE_URL}`);
});