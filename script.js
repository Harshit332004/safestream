/**
 * StreamSafe Engine v11 — Consolidated History + UI Polish
 * 
 * Changes:
 * - TV shows: one entry per show (last played episode overwrites previous)
 * - Added 111movies provider
 * - Relative timestamps ("2h ago"), clear-all history, better empty states
 * - Smoother search/history UX
 */

const CONFIG = {
    TMDB_KEY: '797f74f09af514f1d6f9ecdbf70e8597',
    API_URL: 'https://safestream-ulch.onrender.com/api',
    DEBOUNCE_MS: 3000,
    HEARTBEAT_TIMEOUT: 15000,
};

const syncChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('streamsafe_sync') : null;

// ═══════════════════════════════════════════
//  PROVIDERS (All verified 2026-05-09)
// ═══════════════════════════════════════════
const PROVIDERS = [
    {
        name: 'Vidlink',
        supportsEvents: true,
        buildUrl: ({ type, id, s, e, time }) =>
            `https://vidlink.pro/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}?primaryColor=3b82f6&autoplay=true&startAt=${time || 0}`
    },
    {
        name: '111movies',
        supportsEvents: false,
        buildUrl: ({ type, id, s, e }) =>
            `https://111movies.com/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}`
    },
    {
        name: 'VidSrc.cc',
        supportsEvents: false,
        buildUrl: ({ type, id, s, e }) =>
            `https://vidsrc.cc/v2/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}`
    },
    {
        name: 'VidSrc.xyz',
        supportsEvents: false,
        buildUrl: ({ type, id, s, e }) =>
            `https://vidsrc.xyz/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}`
    },
    {
        name: 'NontonGo',
        supportsEvents: false,
        buildUrl: ({ type, id, s, e }) =>
            `https://www.NontonGo.win/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}`
    },
    {
        name: 'MoviesAPI',
        supportsEvents: false,
        buildUrl: ({ type, id, s, e }) =>
            type === 'tv' ? `https://moviesapi.club/tv/${id}-${s}-${e}` : `https://moviesapi.club/movie/${id}`
    },
    {
        name: '2embed',
        supportsEvents: false,
        buildUrl: ({ type, id, s, e }) =>
            type === 'tv' ? `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}` : `https://www.2embed.cc/embed/${id}`
    },
    {
        name: 'VidSrc.to',
        supportsEvents: false,
        buildUrl: ({ type, id, s, e }) =>
            `https://vidsrc.to/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}`
    }
];

const AppState = {
    activeMedia: null, providerIndex: 0, lastKnownTime: 0, lastSyncTime: 0,
    lastDuration: 0, isPlaying: false, playDetected: false,
    historyCache: new Map(), pendingTv: null
};

const DOM = {
    get: id => document.getElementById(id),
    show: id => { const el = DOM.get(id); if (el) el.classList.remove('hidden'); },
    hide: id => { const el = DOM.get(id); if (el) el.classList.add('hidden'); },
    toast: (msg, duration = 3000) => {
        const t = DOM.get('status-toast');
        if (!t) return;
        t.textContent = msg; t.classList.remove('hidden');
        if (duration > 0) setTimeout(() => t.classList.add('hidden'), duration);
    }
};

// ═══════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════
function timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
}

function formatTime(secs) {
    if (!secs || secs < 0) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════
//  SYNC ENGINE
// ═══════════════════════════════════════════
const SyncEngine = {
    init() {
        let local = [];
        try { local = JSON.parse(localStorage.getItem('streamsafe_cache') || '[]'); } catch (e) { local = []; }
        local.forEach(item => AppState.historyCache.set(this.makeKey(item), item));
        Renderer.renderHistory();
        this.fullSync();
        if (syncChannel) {
            syncChannel.onmessage = (e) => {
                const { type, payload } = e.data;
                if (type === 'UPDATE') AppState.historyCache.set(this.makeKey(payload), payload);
                else if (type === 'DELETE') AppState.historyCache.delete(this.makeKey(payload));
                this.persistLocal(); Renderer.renderHistory();
            };
        }
    },

    // KEY CHANGE: TV shows now keyed by (tmdbId, type) only — one entry per show
    makeKey: (i) => `${i.tmdbId}_${i.type}`,

    async fullSync() {
        if (!navigator.onLine) return;
        try {
            // Step 1: Bulk-upload all local items in ONE request
            const localItems = Array.from(AppState.historyCache.values());
            if (localItems.length > 0) {
                await fetch(`${CONFIG.API_URL}/sync/bulk`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
                    body: JSON.stringify({ items: localItems }),
                    keepalive: true
                }).catch(() => {});
            }

            // Step 2: Pull server truth
            const res = await fetch(`${CONFIG.API_URL}/continue-watching`, {
                headers: { 'x-api-key': 'streamsafe-secret' }
            });
            if (!res.ok) return;
            const { history } = await res.json();
            if (history) {
                AppState.historyCache.clear();
                history.forEach(item => AppState.historyCache.set(this.makeKey(item), item));
                this.persistLocal();
                Renderer.renderHistory();
            }
        } catch (e) {
            console.warn('Sync failed, local cache active:', e.message);
        }
    },

    // Debounced network write — sends to server at most every 3 seconds
    _pendingSync: null,
    saveProgress(time, duration = 0, isComplete = false) {
        if (!AppState.activeMedia) return;
        const key = this.makeKey(AppState.activeMedia);
        const payload = { ...AppState.activeMedia, timestamp: time, duration: duration || 1, last_updated: Date.now() };
        if (isComplete || (duration > 0 && time > duration - 10)) {
            AppState.historyCache.delete(key);
            this.queueNetworkAction('DELETE', payload);
        } else {
            AppState.historyCache.set(key, payload);
            // Debounce network writes to 3s max
            if (this._pendingSync) clearTimeout(this._pendingSync);
            this._pendingSync = setTimeout(() => {
                this.queueNetworkAction('POST', payload);
                this._pendingSync = null;
            }, 3000);
        }
        this.persistLocal(); Renderer.renderHistory();
        if (syncChannel) syncChannel.postMessage({ type: isComplete ? 'DELETE' : 'UPDATE', payload });
    },

    persistLocal() {
        localStorage.setItem('streamsafe_cache', JSON.stringify(Array.from(AppState.historyCache.values())));
    },

    queueNetworkAction(method, payload) {
        if (!navigator.onLine) return;
        fetch(method === 'DELETE' ? `${CONFIG.API_URL}/history` : `${CONFIG.API_URL}/sync`, {
            method, headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
            body: JSON.stringify(payload), keepalive: true
        }).catch(() => {});
    },

    async clearAll() {
        AppState.historyCache.clear();
        this.persistLocal();
        Renderer.renderHistory();
        try {
            await fetch(`${CONFIG.API_URL}/history/all`, {
                method: 'DELETE',
                headers: { 'x-api-key': 'streamsafe-secret' }
            });
        } catch (e) {}
    }
};

// ═══════════════════════════════════════════
//  PLAYER MANAGER
// ═══════════════════════════════════════════
const PlayerManager = {
    heartbeatTimer: null,
    heuristicTimer: null,

    launch(item, startAt = 0) {
        let resumeTime = (item.duration && startAt > item.duration - 10) ? 0 : startAt;
        AppState.activeMedia = item;
        AppState.lastKnownTime = resumeTime;
        AppState.lastSyncTime = resumeTime;
        AppState.providerIndex = 0;
        AppState.playDetected = false;
        AppState.isPlaying = false;

        DOM.show('player-section');
        this.buildProviderDropdown();
        this.injectIframe();
        setTimeout(() => DOM.get('player-section')?.scrollIntoView({ behavior: 'smooth' }), 100);
    },

    buildProviderDropdown() {
        const select = DOM.get('provider-select');
        if (!select) return;
        select.innerHTML = PROVIDERS.map((p, i) =>
            `<option value="${i}"${i === AppState.providerIndex ? ' selected' : ''}>${p.name}</option>`
        ).join('');
    },

    injectIframe() {
        const provider = PROVIDERS[AppState.providerIndex];
        const m = AppState.activeMedia;
        if (!m) return;

        const url = provider.buildUrl({
            type: m.type, id: m.tmdbId,
            s: m.season || 1, e: m.episode || 1,
            time: Math.floor(AppState.lastKnownTime)
        });

        const select = DOM.get('provider-select');
        if (select) select.value = AppState.providerIndex;

        const status = DOM.get('provider-status');
        if (status) { status.textContent = `Loading ${provider.name}...`; status.style.color = '#fbbf24'; }

        AppState.playDetected = false;
        this.stopHeartbeat();
        this.stopHeuristic();

        const wrapper = DOM.get('iframe-wrapper');
        wrapper.innerHTML = '';

        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.allowFullscreen = true;
        iframe.allow = "autoplay; fullscreen; picture-in-picture; encrypted-media";
        iframe.style.cssText = "position:absolute;width:100%;height:100%;border:none;z-index:1;";

        const loader = document.createElement('div');
        loader.className = 'player-loader';
        loader.textContent = `⏳ Loading ${provider.name}...`;
        loader.style.zIndex = '2';

        wrapper.appendChild(iframe);
        wrapper.appendChild(loader);

        iframe.onload = () => {
            loader.remove();
            if (status) { status.textContent = `${provider.name} (ready)`; status.style.color = '#34d399'; }

            // For ALL providers: start a periodic sync timer (every 10 seconds)
            this.stopHeuristic();
            this.heuristicTimer = setInterval(() => {
                if (!document.hidden && AppState.activeMedia) {
                    // For non-event providers, estimate time passing
                    if (!provider.supportsEvents) {
                        AppState.lastKnownTime += 3;
                    }
                    // Update time display
                    this.updateTimeDisplay();
                    // Sync to backend every 10s
                    SyncEngine.saveProgress(AppState.lastKnownTime, AppState.lastDuration);
                }
            }, provider.supportsEvents ? 10000 : 3000);
        };

        this.heartbeatTimer = setTimeout(() => {
            if (!AppState.playDetected && provider.supportsEvents) {
                if (status) { status.textContent = `${provider.name} — no signal. Try another ↓`; status.style.color = '#fbbf24'; }
                DOM.toast(`${provider.name} may be down. Switch from the dropdown.`, 5000);
            }
        }, CONFIG.HEARTBEAT_TIMEOUT);
    },

    switchToProvider(index) {
        if (index < 0 || index >= PROVIDERS.length) return;
        AppState.providerIndex = index;
        AppState.playDetected = false;
        AppState.isPlaying = false;
        DOM.toast(`Switching to ${PROVIDERS[index].name}...`);
        this.injectIframe();
    },

    close() {
        this.stopHeartbeat();
        this.stopHeuristic();
        const wrapper = DOM.get('iframe-wrapper');
        const iframe = wrapper?.querySelector('iframe');
        if (iframe) iframe.removeAttribute('src');
        if (wrapper) wrapper.innerHTML = '';
        DOM.hide('player-section');
        if (AppState.activeMedia) SyncEngine.saveProgress(AppState.lastKnownTime);
        AppState.activeMedia = null;
        AppState.playDetected = false;
        AppState.isPlaying = false;
        Renderer.renderHistory();
    },

    stopHeartbeat() { if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; } },
    stopHeuristic() { if (this.heuristicTimer) { clearInterval(this.heuristicTimer); this.heuristicTimer = null; } },

    updateTimeDisplay() {
        const el = DOM.get('player-time-display');
        if (el) el.textContent = formatTime(AppState.lastKnownTime);
    },

    /**
     * SKIP via postMessage — does NOT destroy/reload the iframe.
     * Sends a seek command to the embedded player via postMessage.
     * If the player supports it (Vidlink does), it seeks instantly.
     * If not, nothing breaks — the iframe stays untouched.
     */
    skip(seconds) {
        if (!AppState.activeMedia) return;
        const newTime = Math.max(0, AppState.lastKnownTime + seconds);
        const iframe = DOM.get('iframe-wrapper')?.querySelector('iframe');
        if (!iframe || !iframe.contentWindow) {
            DOM.toast('Player not ready');
            return;
        }

        // Try multiple postMessage formats that embedded players commonly accept
        const seekMessages = [
            { type: 'SEEK', time: newTime },
            { type: 'seek', currentTime: newTime },
            { type: 'command', command: 'seek', value: newTime },
            { event: 'seek', currentTime: newTime },
        ];
        seekMessages.forEach(msg => {
            try { iframe.contentWindow.postMessage(msg, '*'); } catch(e) {}
        });

        // Optimistically update our local state
        AppState.lastKnownTime = newTime;
        this.updateTimeDisplay();
    },

    handleMessage(event) {
        if (!event.data || !event.data.type) return;
        if (event.data.type === 'PLAYER_EVENT' && event.data.data) {
            const { event: eventType, currentTime, duration } = event.data.data;
            if (eventType === 'play' || eventType === 'playing') {
                AppState.isPlaying = true;
                AppState.playDetected = true;
                PlayerManager.stopHeartbeat();
                const status = DOM.get('provider-status');
                if (status) { status.textContent = `${PROVIDERS[AppState.providerIndex].name} ▶ Playing`; status.style.color = '#34d399'; }
            }
            if (eventType === 'pause') { AppState.isPlaying = false; SyncEngine.saveProgress(currentTime, duration); }
            if (eventType === 'waiting' || eventType === 'buffering') { AppState.isPlaying = false; }
            if (eventType === 'timeupdate' && currentTime !== undefined) {
                AppState.lastKnownTime = currentTime;
                if (duration) AppState.lastDuration = duration;
                AppState.playDetected = true;
                PlayerManager.updateTimeDisplay();
                if (Date.now() - AppState.lastSyncTime > 5000) {
                    AppState.lastSyncTime = Date.now();
                    SyncEngine.saveProgress(currentTime, duration);
                }
            }
            if (eventType === 'ended') { SyncEngine.saveProgress(currentTime, duration, true); }
        }
        if (event.data.type === 'MEDIA_DATA') {
            localStorage.setItem('vidLinkProgress', JSON.stringify(event.data.data));
        }
    }
};

// ═══════════════════════════════════════════
//  METADATA MANAGER
// ═══════════════════════════════════════════
const MetadataManager = {
    async loadTVShow(id, title) {
        DOM.show('tv-selector');
        DOM.get('btn-play-tv').disabled = true;
        try {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${id}?api_key=${CONFIG.TMDB_KEY}`);
            const data = await res.json();
            const seasonSelect = DOM.get('season-select');
            seasonSelect.innerHTML = data.seasons
                .filter(s => s.season_number > 0)
                .map(s => `<option value="${s.season_number}">Season ${s.season_number}</option>`)
                .join('');
            this.loadEpisodes(id, seasonSelect.value);
            DOM.get('tv-title-display').textContent = title;
        } catch (e) { DOM.toast("Failed to load show info."); }
    },
    async loadEpisodes(id, season) {
        DOM.get('btn-play-tv').disabled = true;
        try {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${id}/season/${season}?api_key=${CONFIG.TMDB_KEY}`);
            const data = await res.json();
            DOM.get('episode-select').innerHTML = data.episodes
                .map(e => `<option value="${e.episode_number}">Ep ${e.episode_number}: ${e.name}</option>`)
                .join('');
            DOM.get('btn-play-tv').disabled = false;
        } catch (e) { DOM.toast("Failed to load episodes."); }
    }
};

// ═══════════════════════════════════════════
//  RENDERER
// ═══════════════════════════════════════════
const Renderer = {
    renderHistory() {
        const grid = DOM.get('history-grid');
        const clearBtn = DOM.get('btn-clear-all');
        if (!grid) return;

        const items = Array.from(AppState.historyCache.values())
            .sort((a, b) => b.last_updated - a.last_updated)
            .slice(0, 20);

        // Show/hide clear all button
        if (clearBtn) clearBtn.style.display = items.length > 0 ? 'inline-block' : 'none';

        if (!items.length) {
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🎬</div>
                    <p>No watch history yet</p>
                    <span>Search for a movie or TV show above to get started</span>
                </div>`;
            return;
        }
        const frag = document.createDocumentFragment();
        const tpl = DOM.get('tpl-history-item')?.content;
        if (!tpl) return;

        items.forEach(i => {
            const clone = document.importNode(tpl, true);
            const el = clone.querySelector('.history-item');
            el.dataset.payload = JSON.stringify(i);

            clone.querySelector('.item-title').textContent = i.title || `ID: ${i.tmdbId}`;

            // Build rich meta line
            let metaParts = [];
            if (i.type === 'tv') metaParts.push(`S${i.season} E${i.episode}`);
            else metaParts.push('Movie');
            if (i.timestamp > 0) metaParts.push(formatTime(i.timestamp));
            clone.querySelector('.item-meta').textContent = metaParts.join(' · ');

            // Time ago
            clone.querySelector('.item-time').textContent = timeAgo(i.last_updated);

            // Progress bar
            const pct = Math.min((i.timestamp / (i.duration || 1)) * 100, 100);
            clone.querySelector('.progress-fill').style.width = `${pct}%`;

            frag.appendChild(clone);
        });
        grid.replaceChildren(frag);
    },

    async renderSearch(q, type) {
        const container = DOM.get('search-results');
        container.innerHTML = '<div class="search-loading">⏳ Searching...</div>';
        DOM.show('search-results');
        try {
            const res = await fetch(`https://api.themoviedb.org/3/search/${type}?api_key=${CONFIG.TMDB_KEY}&query=${encodeURIComponent(q)}`);
            const { results } = await res.json();
            if (!results || !results.length) {
                container.innerHTML = '<div class="search-loading">No results found</div>';
                return;
            }
            const frag = document.createDocumentFragment();
            const tpl = DOM.get('tpl-search-item')?.content;
            if (!tpl) return;
            results.slice(0, 8).forEach(i => {
                const clone = document.importNode(tpl, true);
                const el = clone.querySelector('.search-item');
                el.dataset.id = i.id;
                el.dataset.title = type === 'movie' ? i.title : i.name;
                clone.querySelector('.search-title').textContent = el.dataset.title;
                const year = (type === 'movie' ? i.release_date : i.first_air_date)?.split('-')[0] || 'N/A';
                clone.querySelector('.search-year').textContent = year;
                const rating = i.vote_average ? `★ ${i.vote_average.toFixed(1)}` : '';
                clone.querySelector('.search-rating').textContent = rating;
                frag.appendChild(clone);
            });
            container.replaceChildren(frag);
        } catch (e) { container.innerHTML = '<div class="search-loading">Search failed</div>'; }
    }
};

// ═══════════════════════════════════════════
//  EVENT SYSTEM
// ═══════════════════════════════════════════

window.addEventListener('message', (e) => {
    if (e.origin && e.origin.includes('vidlink.pro')) PlayerManager.handleMessage(e);
});

document.body.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'resume-play') {
        const payload = JSON.parse(actionEl.closest('.history-item').dataset.payload);
        PlayerManager.launch(payload, payload.timestamp);
    }
    else if (action === 'delete-history') {
        e.stopPropagation();
        const payload = JSON.parse(actionEl.closest('.history-item').dataset.payload);
        AppState.historyCache.delete(SyncEngine.makeKey(payload));
        SyncEngine.queueNetworkAction('DELETE', payload);
        SyncEngine.persistLocal();
        Renderer.renderHistory();
        DOM.toast('Removed from history');
    }
    else if (action === 'close-player') {
        PlayerManager.close();
    }
    else if (action === 'skip-back') {
        PlayerManager.skip(-10);
    }
    else if (action === 'skip-forward') {
        PlayerManager.skip(10);
    }
    else if (action === 'clear-all') {
        if (confirm('Clear all watch history? This cannot be undone.')) {
            SyncEngine.clearAll();
            DOM.toast('History cleared');
        }
    }
    else if (action === 'select-search') {
        const type = DOM.get('media-type').value;
        const id = actionEl.dataset.id;
        const title = actionEl.dataset.title;
        DOM.hide('search-results');
        DOM.get('search-query').value = '';
        if (type === 'movie') {
            PlayerManager.launch({ tmdbId: id, type, title });
        } else {
            AppState.pendingTv = { tmdbId: id, type, title };
            MetadataManager.loadTVShow(id, title);
        }
    }
});

document.addEventListener('change', (e) => {
    if (e.target.id === 'provider-select') PlayerManager.switchToProvider(parseInt(e.target.value));
    if (e.target.id === 'season-select' && AppState.pendingTv) MetadataManager.loadEpisodes(AppState.pendingTv.tmdbId, e.target.value);
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'search-query') {
        e.preventDefault();
        const q = e.target.value.trim();
        if (q) Renderer.renderSearch(q, DOM.get('media-type').value);
    }
    // Escape closes player
    if (e.key === 'Escape' && AppState.activeMedia) PlayerManager.close();
});

DOM.get('btn-search')?.addEventListener('click', () => {
    const q = DOM.get('search-query')?.value.trim();
    if (q) Renderer.renderSearch(q, DOM.get('media-type').value);
});

DOM.get('btn-play-tv')?.addEventListener('click', () => {
    if (!AppState.pendingTv) return;
    PlayerManager.launch({
        ...AppState.pendingTv,
        season: DOM.get('season-select')?.value || 1,
        episode: DOM.get('episode-select')?.value || 1
    });
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && AppState.activeMedia) SyncEngine.saveProgress(AppState.lastKnownTime);
    if (!document.hidden && !AppState.activeMedia) SyncEngine.fullSync();
});

// Close search dropdown when clicking outside
document.addEventListener('click', (e) => {
    const searchResults = DOM.get('search-results');
    const searchQuery = DOM.get('search-query');
    if (searchResults && !searchResults.contains(e.target) && e.target !== searchQuery && !e.target.closest('.btn-primary')) {
        DOM.hide('search-results');
    }
});

window.addEventListener('DOMContentLoaded', () => {
    SyncEngine.init();
    Renderer.renderHistory();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});