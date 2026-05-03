/**
 * StreamSafe Engine v7 - Production Hardened
 * Fixes: sendBeacon auth, offline DELETE routing, origin check,
 *        render-during-playback, time-based debounce, cold-start retry,
 *        BroadcastChannel cross-tab sync, watchdog waiting-state gap,
 *        progress clamping, search dismiss, flushQueue routing.
 */

const CONFIG = {
    TMDB_KEY: '797f74f09af514f1d6f9ecdbf70e8597',
    API_URL: 'https://safestream-ulch.onrender.com/api',
    SYNC_DEBOUNCE_S: 5,       // Sync every 5 seconds of MEDIA time (not wall clock)
    SYNC_DEBOUNCE_MS: 3000,   // Network write debounce (wall clock)
    RETRY_LIMIT: 3,
    RETRY_BASE_MS: 3000
};

// --- CROSS-TAB SYNC ---
let syncChannel = null;
try { syncChannel = new BroadcastChannel('streamsafe_sync'); } catch(e) { /* not supported */ }

// --- ORCHESTRATOR: PROVIDERS ---
const PROVIDERS = [
    {
        name: 'Vidlink',
        getUrl: (type, id, s, e, start) =>
            `https://vidlink.pro/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}?primaryColor=3b82f6&autoplay=true&startAt=${start || 0}`,
        supportsEvents: true
    },
    {
        name: 'VidSrc',
        getUrl: (type, id, s, e) =>
            `https://vidsrc.to/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}`,
        supportsEvents: false
    }
];

// --- STATE MANAGEMENT ---
const AppState = {
    activeMedia: null,
    providerIndex: 0,
    lastKnownTime: 0,
    lastSyncTime: 0,       // tracks MEDIA time of last sync (not wall clock)
    frozenTicks: 0,
    isPlaying: false,
    isBuffering: false,
    historyCache: new Map(),
    offlineQueue: [],
    retryCount: 0,
    pendingTv: null
};

// --- DOM UTILITIES ---
const DOM = {
    get: id => document.getElementById(id),
    show: id => { const el = DOM.get(id); if (el) el.classList.remove('hidden'); },
    hide: id => { const el = DOM.get(id); if (el) el.classList.add('hidden'); },
    toast: (msg, duration = 3000) => {
        const t = DOM.get('status-toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.remove('hidden');
        if (duration > 0) setTimeout(() => t.classList.add('hidden'), duration);
    }
};

// ============================================================
// --- SYNC ENGINE ---
// ============================================================
const SyncEngine = {
    init() {
        // Load local cache into Map
        try {
            const local = JSON.parse(localStorage.getItem('streamsafe_cache') || '[]');
            local.forEach(item => {
                if (item && item.tmdbId) AppState.historyCache.set(this.makeKey(item), item);
            });
        } catch(e) { localStorage.removeItem('streamsafe_cache'); }

        // Load offline queue
        try {
            AppState.offlineQueue = JSON.parse(localStorage.getItem('ss_queue') || '[]');
        } catch(e) { AppState.offlineQueue = []; }

        // Listen for cross-tab sync events
        if (syncChannel) {
            syncChannel.onmessage = (e) => {
                try {
                    const { type, payload } = e.data;
                    const key = this.makeKey(payload);
                    if (type === 'UPDATE') {
                        const local = AppState.historyCache.get(key);
                        if (!local || payload.last_updated > local.last_updated) {
                            AppState.historyCache.set(key, payload);
                            this.persistLocal();
                            if (!AppState.activeMedia) Renderer.renderHistory();
                        }
                    } else if (type === 'DELETE') {
                        AppState.historyCache.delete(key);
                        this.persistLocal();
                        if (!AppState.activeMedia) Renderer.renderHistory();
                    }
                } catch(e) {}
            };
        }

        // Flush any pending offline writes immediately
        this.flushQueue();
        window.addEventListener('online', () => { DOM.toast('Back online. Syncing...', 2000); this.flushQueue(); });

        // Kick off non-blocking backend sync
        this.fetchRemote();
    },

    makeKey: (item) => `${item.tmdbId}_${item.type}_${item.season || 1}_${item.episode || 1}`,

    async fetchRemote() {
        if (!navigator.onLine) return;
        try {
            // Partial sync: only fetch items newer than our newest local record
            let maxLastUpdated = 0;
            AppState.historyCache.forEach(item => {
                if (item.last_updated > maxLastUpdated) maxLastUpdated = item.last_updated;
            });

            const res = await fetch(`${CONFIG.API_URL}/continue-watching?since=${maxLastUpdated}`, {
                headers: { 'x-api-key': 'streamsafe-secret' },
                cache: 'no-store'
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const { history } = await res.json();
            let changed = false;

            if (history && history.length > 0) {
                history.forEach(serverItem => {
                    const key = this.makeKey(serverItem);
                    const local = AppState.historyCache.get(key);
                    if (!local || serverItem.last_updated > local.last_updated) {
                        AppState.historyCache.set(key, serverItem);
                        changed = true;
                    }
                });
            }

            if (changed) {
                this.persistLocal();
                // Only re-render if no video is playing (avoid repaints during playback)
                if (!AppState.activeMedia) Renderer.renderHistory();
            }

            AppState.retryCount = 0;
        } catch(e) {
            if (AppState.retryCount < CONFIG.RETRY_LIMIT) {
                AppState.retryCount++;
                const delay = CONFIG.RETRY_BASE_MS * AppState.retryCount;
                console.warn(`Backend fetch failed. Retrying in ${delay}ms... (${AppState.retryCount}/${CONFIG.RETRY_LIMIT})`);
                if (AppState.retryCount === 1) DOM.toast('Waking server, please wait...', delay + 500);
                setTimeout(() => this.fetchRemote(), delay);
            } else {
                console.warn('All backend retries exhausted. Running on local cache.');
            }
        }
    },

    saveProgress(currentTime, duration = 0, isComplete = false) {
        if (!AppState.activeMedia) return;
        if (!currentTime && currentTime !== 0) return;

        const key = this.makeKey(AppState.activeMedia);
        const payload = {
            ...AppState.activeMedia,
            timestamp: currentTime,
            duration: duration || AppState.activeMedia.duration || 5000,
            last_updated: Date.now()
        };

        if (isComplete || (duration > 0 && currentTime >= duration - 10)) {
            // Video completed — remove from cache + backend
            AppState.historyCache.delete(key);
            this._networkDelete(payload);
            if (syncChannel) syncChannel.postMessage({ type: 'DELETE', payload });
        } else {
            // Active progress — update cache + backend
            AppState.historyCache.set(key, payload);
            this._networkUpload(payload);
            if (syncChannel) syncChannel.postMessage({ type: 'UPDATE', payload });
        }

        this.persistLocal();
        // NOTE: Do NOT call Renderer.renderHistory() here during playback
        // History will refresh when the player is closed
    },

    persistLocal() {
        try {
            localStorage.setItem('streamsafe_cache',
                JSON.stringify(Array.from(AppState.historyCache.values()))
            );
        } catch(e) { console.warn('localStorage write failed (storage full?)'); }
    },

    // *** FIX: keepalive fetch replaces sendBeacon (can carry auth headers) ***
    uploadTimeout: null,
    _networkUpload(payload) {
        if (this.uploadTimeout) clearTimeout(this.uploadTimeout);
        this.uploadTimeout = setTimeout(() => {
            if (!navigator.onLine) {
                this._queueOffline('POST', payload);
                return;
            }
            fetch(`${CONFIG.API_URL}/sync`, {
                method: 'POST',
                keepalive: true,
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
                body: JSON.stringify(payload)
            }).catch(() => this._queueOffline('POST', payload));
        }, CONFIG.SYNC_DEBOUNCE_MS);
    },

    // *** FIX: DELETE goes to correct /history endpoint ***
    _networkDelete(payload) {
        if (!navigator.onLine) {
            this._queueOffline('DELETE', payload);
            return;
        }
        fetch(`${CONFIG.API_URL}/history`, {
            method: 'DELETE',
            keepalive: true,
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
            body: JSON.stringify(payload)
        }).catch(() => this._queueOffline('DELETE', payload));
    },

    _queueOffline(method, payload) {
        // Avoid duplicates — update existing entry if same key
        const key = this.makeKey(payload);
        const idx = AppState.offlineQueue.findIndex(t => this.makeKey(t.payload) === key && t.method === method);
        if (idx >= 0) AppState.offlineQueue[idx] = { method, payload };
        else AppState.offlineQueue.push({ method, payload });
        try { localStorage.setItem('ss_queue', JSON.stringify(AppState.offlineQueue)); } catch(e) {}
    },

    // *** FIX: flushQueue now routes correctly to /sync or /history ***
    flushQueue() {
        if (!AppState.offlineQueue.length || !navigator.onLine) return;
        const tasks = [...AppState.offlineQueue];
        AppState.offlineQueue = [];
        localStorage.removeItem('ss_queue');

        tasks.forEach(task => {
            const endpoint = task.method === 'DELETE'
                ? `${CONFIG.API_URL}/history`
                : `${CONFIG.API_URL}/sync`;
            fetch(endpoint, {
                method: task.method,
                keepalive: true,
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
                body: JSON.stringify(task.payload)
            }).catch(() => this._queueOffline(task.method, task.payload));
        });
    },

    deleteEntry(payload) {
        const key = this.makeKey(payload);
        AppState.historyCache.delete(key);
        this._networkDelete(payload);
        this.persistLocal();
        if (syncChannel) syncChannel.postMessage({ type: 'DELETE', payload });
        Renderer.renderHistory();
    }
};

// ============================================================
// --- PLAYER ORCHESTRATOR ---
// ============================================================
const PlayerManager = {
    watchdogInterval: null,

    launch(item, startAt = 0) {
        // Guard: if item is nearly complete, restart from beginning
        const resumeAt = (item.duration && startAt >= item.duration - 10) ? 0 : startAt;

        AppState.activeMedia = { ...item }; // clone to avoid mutation
        AppState.lastKnownTime = resumeAt;
        AppState.lastSyncTime = resumeAt;
        AppState.providerIndex = 0;
        AppState.isPlaying = false;
        AppState.isBuffering = false;
        AppState.frozenTicks = 0;

        DOM.show('player-section');
        setTimeout(() => DOM.get('player-section').scrollIntoView({ behavior: 'smooth' }), 50);
        this.injectIframe();
    },

    injectIframe() {
        const provider = PROVIDERS[AppState.providerIndex];
        const m = AppState.activeMedia;
        const url = provider.getUrl(m.type, m.tmdbId, m.season, m.episode, Math.floor(AppState.lastKnownTime));

        DOM.get('provider-badge').textContent = provider.name;
        // Nuke previous iframe cleanly
        const wrapper = DOM.get('iframe-wrapper');
        wrapper.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.setAttribute('allowfullscreen', '');
        iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
        wrapper.appendChild(iframe);

        this.startWatchdog(provider);
    },

    switchProvider() {
        AppState.providerIndex++;
        if (AppState.providerIndex >= PROVIDERS.length) {
            DOM.toast('All providers failed. Please try again later.');
            this.close();
            return;
        }
        DOM.toast(`Switching to ${PROVIDERS[AppState.providerIndex].name}...`);
        this.injectIframe();
    },

    startWatchdog(provider) {
        this.stopWatchdog();
        AppState.frozenTicks = 0;
        let lastCheckedTime = -1;

        if (provider.supportsEvents) {
            this.watchdogInterval = setInterval(() => {
                // *** FIX: Skip if hidden, paused, OR buffering (not stuck, just loading) ***
                if (document.hidden || !AppState.isPlaying || AppState.isBuffering) return;

                if (AppState.lastKnownTime === lastCheckedTime && AppState.lastKnownTime > 0) {
                    AppState.frozenTicks++;
                    if (AppState.frozenTicks >= 4) { // 12 seconds frozen while playing and not buffering
                        console.warn('Freeze confirmed. Switching provider.');
                        this.switchProvider();
                    }
                } else {
                    AppState.frozenTicks = 0;
                    lastCheckedTime = AppState.lastKnownTime;
                }
            }, 3000);
        } else {
            // Heuristic tracking for providers without postMessage
            this.watchdogInterval = setInterval(() => {
                if (!document.hidden && AppState.activeMedia) {
                    AppState.lastKnownTime += 3;
                    SyncEngine.saveProgress(AppState.lastKnownTime);
                }
            }, 3000);
        }
    },

    stopWatchdog() {
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
    },

    close() {
        this.stopWatchdog();
        // Save final position before nuking
        SyncEngine.saveProgress(AppState.lastKnownTime);
        // Nuke iframe to release RAM + stop audio
        const wrapper = DOM.get('iframe-wrapper');
        if (wrapper) wrapper.innerHTML = '';
        DOM.hide('player-section');
        AppState.activeMedia = null;
        AppState.isPlaying = false;
        AppState.isBuffering = false;
        // Now safe to re-render history
        Renderer.renderHistory();
    },

    // *** FIX: Added origin check to prevent malicious postMessage injection ***
    handleMessage(e) {
        if (!e.origin || !e.origin.includes('vidlink.pro')) return;
        if (!e.data || e.data.type !== 'PLAYER_EVENT') return;

        const { event, currentTime, duration } = e.data.data || {};
        if (currentTime === undefined) return;

        if (event === 'play' || event === 'playing') {
            AppState.isPlaying = true;
            AppState.isBuffering = false;
        }
        // *** FIX: Track buffering state separately so watchdog doesn't misfire ***
        if (event === 'waiting') {
            AppState.isBuffering = true;
            AppState.isPlaying = false;
        }
        if (event === 'pause') {
            AppState.isPlaying = false;
            AppState.isBuffering = false;
        }

        if (event === 'timeupdate') {
            AppState.lastKnownTime = currentTime;
            AppState.isBuffering = false;

            // *** FIX: Time-based debounce using MEDIA time, not wall clock ***
            // Avoids the Math.floor(x) % 5 double-trigger problem
            if (currentTime - AppState.lastSyncTime >= CONFIG.SYNC_DEBOUNCE_S) {
                AppState.lastSyncTime = currentTime;
                SyncEngine.saveProgress(currentTime, duration);
            }
        }

        if (event === 'ended') {
            AppState.isPlaying = false;
            SyncEngine.saveProgress(currentTime, duration, true);
        }
    }
};

// ============================================================
// --- RENDERER ---
// ============================================================
const Renderer = {
    renderHistory() {
        const grid = DOM.get('history-grid');
        if (!grid) return;

        const items = Array.from(AppState.historyCache.values())
            .filter(i => i.timestamp < i.duration - 10) // client-side completed filter
            .sort((a, b) => b.last_updated - a.last_updated)
            .slice(0, 15);

        if (!items.length) {
            grid.innerHTML = '<p style="color:var(--muted)">No watch history. Start exploring!</p>';
            return;
        }

        const fragment = document.createDocumentFragment();
        const tpl = DOM.get('tpl-history-item');
        if (!tpl) return;

        items.forEach(item => {
            const clone = document.importNode(tpl.content, true);
            const el = clone.querySelector('.history-item');
            el.dataset.payload = JSON.stringify(item);
            clone.querySelector('.item-title').textContent = item.title || 'Unknown';
            clone.querySelector('.item-meta').textContent =
                item.type === 'tv' ? `S${item.season || 1} E${item.episode || 1}` : 'Movie';

            // *** FIX: Always clamp progress to [0, 100] regardless of source ***
            const rawProgress = item.progress !== undefined
                ? item.progress
                : (item.timestamp / item.duration) * 100;
            const progress = Math.min(Math.max(rawProgress, 0), 100);
            clone.querySelector('.progress-fill').style.width = `${progress}%`;

            fragment.appendChild(clone);
        });

        grid.replaceChildren(fragment);
    },

    async renderSearch(query, type) {
        const container = DOM.get('search-results');
        container.innerHTML = '<div style="padding:10px;color:var(--muted)">Searching...</div>';
        DOM.show('search-results');

        try {
            const url = `https://api.themoviedb.org/3/search/${type}?api_key=${CONFIG.TMDB_KEY}&query=${encodeURIComponent(query)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('TMDB error');
            const { results } = await res.json();

            if (!results || !results.length) {
                container.innerHTML = '<div style="padding:10px;">No results found.</div>';
                return;
            }

            const fragment = document.createDocumentFragment();
            const tpl = DOM.get('tpl-search-item');

            results.slice(0, 8).forEach(item => {
                const clone = document.importNode(tpl.content, true);
                const el = clone.querySelector('.search-item');
                const release = type === 'movie' ? item.release_date : item.first_air_date;
                el.dataset.id = item.id;
                el.dataset.title = type === 'movie' ? item.title : item.name;
                clone.querySelector('.search-title').textContent = el.dataset.title;
                clone.querySelector('.search-year').textContent = `(${release ? release.split('-')[0] : 'N/A'})`;
                fragment.appendChild(clone);
            });

            container.replaceChildren(fragment);
        } catch(e) {
            container.innerHTML = '<div style="padding:10px;color:var(--danger)">Search failed. Check connection.</div>';
        }
    }
};

// ============================================================
// --- GLOBAL EVENT DELEGATOR ---
// ============================================================
document.body.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'close-player') {
        PlayerManager.close();
    }
    else if (action === 'delete-history') {
        e.stopPropagation();
        const historyItem = actionEl.closest('.history-item');
        if (!historyItem) return;
        try {
            const payload = JSON.parse(historyItem.dataset.payload);
            SyncEngine.deleteEntry(payload);
        } catch(e) {}
    }
    else if (action === 'resume-play') {
        const historyItem = actionEl.closest('.history-item');
        if (!historyItem) return;
        try {
            const payload = JSON.parse(historyItem.dataset.payload);
            PlayerManager.launch(payload, payload.timestamp || 0);
        } catch(e) {}
    }
    else if (action === 'select-search') {
        const type = DOM.get('media-type').value;
        const id = actionEl.dataset.id;
        const title = actionEl.dataset.title;
        DOM.hide('search-results');
        if (type === 'movie') {
            PlayerManager.launch({ tmdbId: id, type, title });
        } else {
            AppState.pendingTv = { tmdbId: id, type, title };
            DOM.get('tv-title-display').textContent = `Selected: ${title}`;
            DOM.show('tv-selector');
        }
    }
});

// *** FIX: Dismiss search results when clicking outside ***
document.addEventListener('click', (e) => {
    const searchResults = DOM.get('search-results');
    const searchSection = DOM.get('search-query');
    if (searchResults && !searchResults.classList.contains('hidden')) {
        if (!searchResults.contains(e.target) && e.target !== searchSection) {
            DOM.hide('search-results');
        }
    }
}, true);

// --- Input Listeners ---
DOM.get('btn-search')?.addEventListener('click', () => {
    const q = DOM.get('search-query').value.trim();
    if (q) Renderer.renderSearch(q, DOM.get('media-type').value);
});

DOM.get('search-query')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') DOM.get('btn-search').click();
});

DOM.get('btn-play-tv')?.addEventListener('click', () => {
    if (!AppState.pendingTv) return;
    const s = parseInt(DOM.get('season-input').value) || 1;
    const ep = parseInt(DOM.get('episode-input').value) || 1;
    PlayerManager.launch({ ...AppState.pendingTv, season: s, episode: ep });
});

// --- Core Lifecycle Listeners ---
// *** FIX: Bind handleMessage with proper context preservation ***
window.addEventListener('message', (e) => PlayerManager.handleMessage(e));

document.addEventListener('visibilitychange', () => {
    if (document.hidden && AppState.activeMedia) {
        SyncEngine.saveProgress(AppState.lastKnownTime);
    } else if (!document.hidden && !AppState.activeMedia) {
        // Refresh history when user returns to tab without a video open
        SyncEngine.fetchRemote();
    }
});

// --- Boot ---
window.addEventListener('DOMContentLoaded', () => {
    // Render from cache instantly (< 16ms)
    Renderer.renderHistory();
    // Then sync from backend non-blocking
    SyncEngine.init();
    // Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
});
