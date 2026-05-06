/**
 * StreamSafe Engine v10 - Fixed Provider System
 * Fixes: handleMessage missing, playDetected never set, infinite provider loop.
 * New: Manual provider dropdown, smarter heartbeat, Enter-to-search.
 */

const CONFIG = {
    TMDB_KEY: '797f74f09af514f1d6f9ecdbf70e8597',
    API_URL: 'https://safestream-ulch.onrender.com/api',
    SYNC_DELTA_S: 5,
    DEBOUNCE_MS: 3000,
    HEARTBEAT_TIMEOUT: 15000, // 15s — give slow providers time to load
    MAX_QUEUE_SIZE: 50
};

const syncChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('streamsafe_sync') : null;

const PROVIDERS = [
    { name: 'Vidlink', supportsEvents: true, buildUrl: ({ type, id, s, e, time }) => `https://vidlink.pro/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}?primaryColor=3b82f6&autoplay=true&startAt=${time || 0}` },
    { name: 'VidSrc.to', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://vidsrc.to/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}` },
    { name: 'SuperEmbed', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://multiembed.mov/?video_id=${id}&tmdb=1${type === 'tv' ? `&s=${s}&e=${e}` : ''}` },
    { name: 'AutoEmbed', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://player.autoembed.cc/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}` },
    { name: 'NontonGo', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://www.NontonGo.win/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}` },
    { name: '2embed', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://www.2embed.cc/embed/${id}${type === 'tv' ? `&s=${s}&e=${e}` : ''}` }
];

const AppState = {
    activeMedia: null, providerIndex: 0, lastKnownTime: 0, lastSyncTime: 0,
    isPlaying: false, playDetected: false, historyCache: new Map(), pendingTv: null
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
//  SYNC ENGINE
// ═══════════════════════════════════════════
const SyncEngine = {
    init() {
        let local = [];
        try { local = JSON.parse(localStorage.getItem('streamsafe_cache') || '[]'); } catch (e) { local = []; }
        local.forEach(item => AppState.historyCache.set(this.makeKey(item), item));
        this.fetchRemote();
        if (syncChannel) {
            syncChannel.onmessage = (e) => {
                const { type, payload } = e.data;
                if (type === 'UPDATE') AppState.historyCache.set(this.makeKey(payload), payload);
                else if (type === 'DELETE') AppState.historyCache.delete(this.makeKey(payload));
                this.persistLocal(); Renderer.renderHistory();
            };
        }
    },
    makeKey: (i) => `${i.tmdbId}_${i.type}_${i.season || 1}_${i.episode || 1}`,
    async fetchRemote() {
        if (!navigator.onLine) return;
        try {
            const res = await fetch(`${CONFIG.API_URL}/continue-watching`, { headers: { 'x-api-key': 'streamsafe-secret' } });
            if (!res.ok) return;
            const { history } = await res.json();
            if (history) {
                history.forEach(item => AppState.historyCache.set(this.makeKey(item), item));
                this.persistLocal(); Renderer.renderHistory();
            }
        } catch (e) { console.warn('Remote sync skipped:', e.message); }
    },
    saveProgress(time, duration = 0, isComplete = false) {
        if (!AppState.activeMedia) return;
        const key = this.makeKey(AppState.activeMedia);
        const payload = { ...AppState.activeMedia, timestamp: time, duration: duration || 1, last_updated: Date.now() };
        if (isComplete || (duration > 0 && time > duration - 10)) {
            AppState.historyCache.delete(key);
            this.queueNetworkAction('DELETE', payload);
        } else {
            AppState.historyCache.set(key, payload);
            this.queueNetworkAction('POST', payload);
        }
        this.persistLocal(); Renderer.renderHistory();
        if (syncChannel) syncChannel.postMessage({ type: isComplete ? 'DELETE' : 'UPDATE', payload });
    },
    persistLocal() { localStorage.setItem('streamsafe_cache', JSON.stringify(Array.from(AppState.historyCache.values()))); },
    queueNetworkAction(method, payload) {
        if (!navigator.onLine) return;
        fetch(method === 'DELETE' ? `${CONFIG.API_URL}/history` : `${CONFIG.API_URL}/sync`, {
            method, headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
            body: JSON.stringify(payload), keepalive: true
        }).catch(() => {});
    }
};

// ═══════════════════════════════════════════
//  PLAYER MANAGER (FIXED)
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

        // Update dropdown selection
        const select = DOM.get('provider-select');
        if (select) select.value = AppState.providerIndex;

        DOM.get('provider-status').textContent = `Loading ${provider.name}...`;
        DOM.get('provider-status').style.color = '#fbbf24'; // yellow

        const wrapper = DOM.get('iframe-wrapper');
        // Show loading overlay
        wrapper.innerHTML = `<div class="player-loader">⏳ Connecting to ${provider.name}...</div>`;

        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.allowFullscreen = true;
        iframe.allow = "autoplay; fullscreen; picture-in-picture; encrypted-media";
        iframe.style.cssText = "position:absolute;width:100%;height:100%;border:none;";

        // Reset play detection for this provider
        AppState.playDetected = false;

        iframe.onload = () => {
            // Remove loader, show iframe
            const loader = wrapper.querySelector('.player-loader');
            if (loader) loader.remove();
            wrapper.appendChild(iframe);

            DOM.get('provider-status').textContent = `${provider.name} (loaded)`;
            DOM.get('provider-status').style.color = '#34d399'; // green

            // Start heuristic timer for non-event providers
            this.stopHeuristic();
            if (!provider.supportsEvents) {
                // For providers without postMessage, estimate time passing
                this.heuristicTimer = setInterval(() => {
                    if (!document.hidden && AppState.activeMedia) {
                        AppState.lastKnownTime += 3;
                        if (Math.floor(AppState.lastKnownTime) % 15 === 0) {
                            SyncEngine.saveProgress(AppState.lastKnownTime);
                        }
                    }
                }, 3000);
            }
        };

        iframe.onerror = () => {
            DOM.get('provider-status').textContent = `${provider.name} failed`;
            DOM.get('provider-status').style.color = '#ef4444';
        };

        // Heartbeat: if no play event detected within timeout, mark as potentially dead
        // But do NOT auto-switch — let the user decide
        this.stopHeartbeat();
        this.heartbeatTimer = setTimeout(() => {
            if (!AppState.playDetected && PROVIDERS[AppState.providerIndex].supportsEvents) {
                DOM.get('provider-status').textContent = `${provider.name} — no signal (try switching ↓)`;
                DOM.get('provider-status').style.color = '#fbbf24';
                DOM.toast(`${provider.name} may be down. Use the dropdown to switch.`, 5000);
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

    stopHeartbeat() {
        if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    },
    stopHeuristic() {
        if (this.heuristicTimer) { clearInterval(this.heuristicTimer); this.heuristicTimer = null; }
    },

    // THIS IS THE CRITICAL MISSING FUNCTION
    handleMessage(event) {
        if (!event.data || !event.data.type) return;

        // Handle Vidlink PLAYER_EVENT messages
        if (event.data.type === 'PLAYER_EVENT' && event.data.data) {
            const { event: eventType, currentTime, duration } = event.data.data;

            if (eventType === 'play' || eventType === 'playing') {
                AppState.isPlaying = true;
                AppState.playDetected = true; // THIS is what stops the heartbeat warning
                PlayerManager.stopHeartbeat();
                DOM.get('provider-status').textContent = `${PROVIDERS[AppState.providerIndex].name} ▶ Playing`;
                DOM.get('provider-status').style.color = '#34d399';
            }
            if (eventType === 'pause') {
                AppState.isPlaying = false;
                SyncEngine.saveProgress(currentTime, duration);
            }
            if (eventType === 'waiting' || eventType === 'buffering') {
                AppState.isPlaying = false;
            }
            if (eventType === 'timeupdate' && currentTime !== undefined) {
                AppState.lastKnownTime = currentTime;
                AppState.playDetected = true;
                // Debounced sync every 5 seconds
                if (Date.now() - AppState.lastSyncTime > 5000) {
                    AppState.lastSyncTime = Date.now();
                    SyncEngine.saveProgress(currentTime, duration);
                }
            }
            if (eventType === 'ended') {
                SyncEngine.saveProgress(currentTime, duration, true);
            }
        }

        // Handle Vidlink MEDIA_DATA fallback
        if (event.data.type === 'MEDIA_DATA') {
            localStorage.setItem('vidLinkProgress', JSON.stringify(event.data.data));
        }
    }
};

// ═══════════════════════════════════════════
//  METADATA MANAGER (TV Show Seasons/Episodes)
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
        } catch (e) { DOM.toast("Failed to load show metadata."); }
    },
    async loadEpisodes(id, season) {
        DOM.get('btn-play-tv').disabled = true;
        try {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${id}/season/${season}?api_key=${CONFIG.TMDB_KEY}`);
            const data = await res.json();
            const epSelect = DOM.get('episode-select');
            epSelect.innerHTML = data.episodes
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
        const grid = DOM.get('history-grid'); if (!grid) return;
        const items = Array.from(AppState.historyCache.values())
            .sort((a, b) => b.last_updated - a.last_updated)
            .slice(0, 15);
        if (!items.length) {
            grid.innerHTML = '<p style="color:var(--muted)">No watch history yet. Search and play something!</p>';
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
            clone.querySelector('.item-meta').textContent = i.type === 'tv' ? `S${i.season} E${i.episode}` : 'Movie';
            const pct = Math.min((i.timestamp / (i.duration || 1)) * 100, 100);
            clone.querySelector('.progress-fill').style.width = `${pct}%`;
            frag.appendChild(clone);
        });
        grid.replaceChildren(frag);
    },
    async renderSearch(q, type) {
        const container = DOM.get('search-results');
        container.innerHTML = '<div style="padding:10px;text-align:center;color:var(--muted)">⏳ Searching...</div>';
        DOM.show('search-results');
        try {
            const res = await fetch(`https://api.themoviedb.org/3/search/${type}?api_key=${CONFIG.TMDB_KEY}&query=${encodeURIComponent(q)}`);
            const { results } = await res.json();
            if (!results || !results.length) {
                container.innerHTML = '<div style="padding:10px">No results found.</div>';
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
                clone.querySelector('.search-year').textContent = `(${year})`;
                frag.appendChild(clone);
            });
            container.replaceChildren(frag);
        } catch (e) { container.innerHTML = '<div style="padding:10px">Search failed. Check your connection.</div>'; }
    }
};

// ═══════════════════════════════════════════
//  EVENT SYSTEM
// ═══════════════════════════════════════════

// Vidlink postMessage listener
window.addEventListener('message', (e) => {
    if (e.origin && e.origin.includes('vidlink.pro')) {
        PlayerManager.handleMessage(e);
    }
});

// Delegated click handler
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
    }
    else if (action === 'close-player') {
        PlayerManager.close();
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
            MetadataManager.loadTVShow(id, title);
        }
    }
});

// Provider dropdown change
document.addEventListener('change', (e) => {
    if (e.target.id === 'provider-select') {
        PlayerManager.switchToProvider(parseInt(e.target.value));
    }
    if (e.target.id === 'season-select' && AppState.pendingTv) {
        MetadataManager.loadEpisodes(AppState.pendingTv.tmdbId, e.target.value);
    }
});

// Search on Enter key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'search-query') {
        const q = e.target.value.trim();
        if (q) Renderer.renderSearch(q, DOM.get('media-type').value);
    }
});

// Search button
DOM.get('btn-search')?.addEventListener('click', () => {
    const q = DOM.get('search-query')?.value.trim();
    if (q) Renderer.renderSearch(q, DOM.get('media-type').value);
});

// Play TV button
DOM.get('btn-play-tv')?.addEventListener('click', () => {
    if (!AppState.pendingTv) return;
    PlayerManager.launch({
        ...AppState.pendingTv,
        season: DOM.get('season-select')?.value || 1,
        episode: DOM.get('episode-select')?.value || 1
    });
});

// Visibility change — save progress when tab hidden, refresh history when returning
document.addEventListener('visibilitychange', () => {
    if (document.hidden && AppState.activeMedia) {
        SyncEngine.saveProgress(AppState.lastKnownTime);
    }
    if (!document.hidden && !AppState.activeMedia) {
        SyncEngine.fetchRemote();
    }
});

// Boot
window.addEventListener('DOMContentLoaded', () => {
    SyncEngine.init();
    Renderer.renderHistory();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});