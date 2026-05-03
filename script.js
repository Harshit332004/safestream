/**
 * StreamSafe Engine v8 - Production Hardened
 * Powerhouse Tier Providers + TMDB Dropdowns
 */

const CONFIG = {
    TMDB_KEY: '797f74f09af514f1d6f9ecdbf70e8597',
    API_URL: 'https://safestream-ulch.onrender.com/api',
    SYNC_DEBOUNCE_S: 5,
    SYNC_DEBOUNCE_MS: 3000,
    RETRY_LIMIT: 3,
    RETRY_BASE_MS: 3000,
    PROVIDER_COOLDOWN_MS: 2 * 60 * 1000, // 2 minutes
    TMDB_CACHE_EXPIRY: 60 * 60 * 1000    // 1 hour
};

// --- CROSS-TAB SYNC ---
let syncChannel = null;
try { syncChannel = new BroadcastChannel('streamsafe_sync'); } catch (e) { /* not supported */ }

const PROVIDERS = [
    {
        name: 'Vidlink',
        priority: 1,
        supportsTimestamp: true,
        buildUrl: ({ type, tmdbId, season, episode, time }) =>
            `https://vidlink.pro/${type}/${tmdbId}${type === 'tv' ? `/${season}/${episode}` : ''}?primaryColor=3b82f6&autoplay=true&startAt=${time || 0}`
    },
    {
        name: 'VidSrc.to',
        priority: 2,
        supportsTimestamp: false,
        buildUrl: ({ type, tmdbId, season, episode }) =>
            `https://vidsrc.to/embed/${type}/${tmdbId}${type === 'tv' ? `/${season}/${episode}` : ''}`
    },
    {
        name: 'SuperFlix',
        priority: 3,
        supportsTimestamp: false,
        buildUrl: ({ type, tmdbId, season, episode }) =>
            `https://superflix.icu/api/${type}/${tmdbId}${type === 'tv' ? `/${season}/${episode}` : ''}`
    },
    {
        name: 'AutoEmbed',
        priority: 4,
        supportsTimestamp: false,
        buildUrl: ({ type, tmdbId, season, episode }) =>
            `https://autoembed.cc/embed/${type}/${tmdbId}${type === 'tv' ? `/${season}/${episode}` : ''}`
    },
    {
        name: 'WarezCDN',
        priority: 5,
        supportsTimestamp: false,
        buildUrl: ({ type, tmdbId, season, episode }) =>
            `https://embed.warezcdn.com/v2/${type}/${tmdbId}${type === 'tv' ? `/${season}/${episode}` : ''}`
    },
    {
        name: 'VidSrc.me',
        priority: 6,
        supportsTimestamp: false,
        buildUrl: ({ type, tmdbId, season, episode }) =>
            `https://vidsrc.me/embed/${tmdbId}${type === 'tv' ? `/${season}/${episode}` : ''}`
    }
];

// --- PROVIDER ENGINE ---
const ProviderEngine = {
    currentIndex: 0,
    activeProviders: [],
    attempts: 0,

    init(tmdbId) {
        const isLowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 2);
        const savedProvider = localStorage.getItem(`provider_${tmdbId}`);
        const cooldowns = JSON.parse(localStorage.getItem('provider_cooldowns') || '{}');

        this.activeProviders = [...PROVIDERS].filter(p => {
            const expiry = cooldowns[p.name];
            return !expiry || Date.now() > expiry;
        }).sort((a, b) => {
            if (a.name === savedProvider) return -1;
            if (b.name === savedProvider) return 1;
            if (isLowEnd) {
                if (a.supportsTimestamp && !b.supportsTimestamp) return -1;
                if (!a.supportsTimestamp && b.supportsTimestamp) return 1;
            }
            return a.priority - b.priority;
        });

        if (this.activeProviders.length === 0) {
            this.activeProviders = [...PROVIDERS].sort((a, b) => a.priority - b.priority);
        }

        this.currentIndex = 0;
        this.attempts = 0;
    },

    getCurrent() { return this.activeProviders[this.currentIndex]; },

    getNext() {
        this.attempts++;
        if (this.attempts >= this.activeProviders.length) return null;
        this.currentIndex++;
        return this.getCurrent();
    },

    markSuccess(tmdbId) {
        const p = this.getCurrent();
        if (p) {
            localStorage.setItem(`provider_${tmdbId}`, p.name);
            const cooldowns = JSON.parse(localStorage.getItem('provider_cooldowns') || '{}');
            delete cooldowns[p.name];
            localStorage.setItem('provider_cooldowns', JSON.stringify(cooldowns));
        }
    },

    markFailure() {
        const p = this.getCurrent();
        if (p) {
            const cooldowns = JSON.parse(localStorage.getItem('provider_cooldowns') || '{}');
            cooldowns[p.name] = Date.now() + CONFIG.PROVIDER_COOLDOWN_MS;
            localStorage.setItem('provider_cooldowns', JSON.stringify(cooldowns));
        }
    }
};

const AppState = {
    activeMedia: null,
    lastKnownTime: 0,
    lastSyncTime: 0,
    frozenTicks: 0,
    isPlaying: false,
    isBuffering: false,
    historyCache: new Map(),
    offlineQueue: [],
    retryCount: 0,
    pendingTv: null,
    currentTMDBRequestId: 0,
    tmdbAbortCtrl: null
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

// --- SYNC & DATA ENGINE ---
const SyncEngine = {
    init() {
        try {
            const local = JSON.parse(localStorage.getItem('streamsafe_cache') || '[]');
            local.forEach(item => {
                if (item && item.tmdbId) AppState.historyCache.set(this.makeKey(item), item);
            });
        } catch (e) { localStorage.removeItem('streamsafe_cache'); }

        try { AppState.offlineQueue = JSON.parse(localStorage.getItem('ss_queue') || '[]'); } catch (e) { AppState.offlineQueue = []; }

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
                } catch (e) { }
            };
        }
        this.flushQueue();
        window.addEventListener('online', () => { DOM.toast('Back online. Syncing...', 2000); this.flushQueue(); });
        this.fetchRemote();
    },

    makeKey: (item) => `${item.tmdbId}_${item.type}_${item.season || 1}_${item.episode || 1}`,

    async fetchRemote() {
        if (!navigator.onLine) return;
        try {
            let maxLastUpdated = 0;
            AppState.historyCache.forEach(item => {
                if (item.last_updated > maxLastUpdated) maxLastUpdated = item.last_updated;
            });
            const res = await fetch(`${CONFIG.API_URL}/continue-watching?since=${maxLastUpdated}`, {
                headers: { 'x-api-key': 'streamsafe-secret' },
                cache: 'no-store'
            });
            if (!res.ok) throw new Error();
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
                if (!AppState.activeMedia) Renderer.renderHistory();
            }
            AppState.retryCount = 0;
        } catch (e) {
            if (AppState.retryCount < CONFIG.RETRY_LIMIT) {
                AppState.retryCount++;
                setTimeout(() => this.fetchRemote(), CONFIG.RETRY_BASE_MS * AppState.retryCount);
            }
        }
    },

    saveProgress(currentTime, duration = 0, isComplete = false) {
        if (!AppState.activeMedia) return;
        const key = this.makeKey(AppState.activeMedia);
        const payload = {
            ...AppState.activeMedia,
            timestamp: currentTime,
            duration: duration || AppState.activeMedia.duration || 0,
            last_updated: Date.now()
        };
        if (isComplete || (duration > 0 && currentTime >= duration - 10)) {
            AppState.historyCache.delete(key);
            this._networkDelete(payload);
            if (syncChannel) syncChannel.postMessage({ type: 'DELETE', payload });
        } else {
            AppState.historyCache.set(key, payload);
            this._networkUpload(payload);
            if (syncChannel) syncChannel.postMessage({ type: 'UPDATE', payload });
        }
        this.persistLocal();
    },

    persistLocal() {
        try { localStorage.setItem('streamsafe_cache', JSON.stringify(Array.from(AppState.historyCache.values()))); } catch (e) { }
    },

    uploadTimeout: null,
    _networkUpload(payload) {
        if (this.uploadTimeout) clearTimeout(this.uploadTimeout);
        this.uploadTimeout = setTimeout(() => {
            if (!navigator.onLine) { this._queueOffline('POST', payload); return; }
            fetch(`${CONFIG.API_URL}/sync`, {
                method: 'POST', keepalive: true,
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
                body: JSON.stringify(payload)
            }).catch(() => this._queueOffline('POST', payload));
        }, CONFIG.SYNC_DEBOUNCE_MS);
    },

    _networkDelete(payload) {
        if (!navigator.onLine) { this._queueOffline('DELETE', payload); return; }
        fetch(`${CONFIG.API_URL}/history`, {
            method: 'DELETE', keepalive: true,
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
            body: JSON.stringify(payload)
        }).catch(() => this._queueOffline('DELETE', payload));
    },

    _queueOffline(method, payload) {
        const key = this.makeKey(payload);
        const idx = AppState.offlineQueue.findIndex(t => SyncEngine.makeKey(t.payload) === key && t.method === method);
        if (idx >= 0) AppState.offlineQueue[idx] = { method, payload };
        else AppState.offlineQueue.push({ method, payload });
        try { localStorage.setItem('ss_queue', JSON.stringify(AppState.offlineQueue)); } catch (e) { }
    },

    flushQueue() {
        if (!AppState.offlineQueue.length || !navigator.onLine) return;
        const tasks = [...AppState.offlineQueue];
        AppState.offlineQueue = [];
        localStorage.removeItem('ss_queue');
        tasks.forEach(task => {
            const endpoint = task.method === 'DELETE' ? `${CONFIG.API_URL}/history` : `${CONFIG.API_URL}/sync`;
            fetch(endpoint, {
                method: task.method, keepalive: true,
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
                body: JSON.stringify(task.payload)
            }).catch(() => this._queueOffline(task.method, task.payload));
        });
    },

    deleteEntry(payload) {
        AppState.historyCache.delete(this.makeKey(payload));
        this._networkDelete(payload);
        this.persistLocal();
        if (syncChannel) syncChannel.postMessage({ type: 'DELETE', payload });
        Renderer.renderHistory();
    }
};

// --- PLAYER ORCHESTRATOR ---
const PlayerManager = {
    watchdogInterval: null,
    playGuard: null,
    hasPlayed: false,

    launch(item, startAt = 0) {
        AppState.activeMedia = { ...item };
        AppState.lastKnownTime = startAt;
        AppState.lastSyncTime = startAt;
        AppState.isPlaying = false;
        AppState.isBuffering = false;
        this.hasPlayed = false;
        ProviderEngine.init(item.tmdbId);
        DOM.show('player-section');
        setTimeout(() => DOM.get('player-section').scrollIntoView({ behavior: 'smooth' }), 50);
        this.injectIframe();
    },

    injectIframe() {
        const provider = ProviderEngine.getCurrent();
        if (!provider) { DOM.toast("No working providers available."); this.close(); return; }
        const m = AppState.activeMedia;
        const start = (provider.supportsTimestamp && AppState.lastKnownTime > 5 && (m.duration ? AppState.lastKnownTime < m.duration - 10 : true))
            ? Math.floor(AppState.lastKnownTime) : 0;
        const url = provider.buildUrl({ type: m.type, tmdbId: m.tmdbId, season: m.season, episode: m.episode, time: start });
        DOM.get('provider-badge').textContent = provider.name;
        const wrapper = DOM.get('iframe-wrapper');
        wrapper.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.allowFullscreen = true;
        iframe.allow = "autoplay; fullscreen; picture-in-picture";
        wrapper.appendChild(iframe);
        this.startWatchdog(provider);

        // 8s Watchdog: ONLY for providers that send playback events
        if (this.playGuard) clearTimeout(this.playGuard);
        if (provider.supportsTimestamp) {
            this.playGuard = setTimeout(() => {
                if (!this.hasPlayed) {
                    console.warn("8s timeout: No playback detected. Switching provider.");
                    ProviderEngine.markFailure();
                    this.switchProvider();
                }
            }, 8000);
        }
    },

    switchProvider() {
        if (this.playGuard) clearTimeout(this.playGuard);
        const next = ProviderEngine.getNext();
        if (!next) { DOM.toast("All providers failed."); this.close(); return; }
        DOM.toast(`Switching to ${next.name}...`);
        this.injectIframe();
    },

    startWatchdog(provider) {
        this.stopWatchdog();
        AppState.frozenTicks = 0;
        let lastCheckedTime = -1;
        if (provider.supportsTimestamp) {
            this.watchdogInterval = setInterval(() => {
                if (document.hidden || !AppState.isPlaying || AppState.isBuffering) return;
                if (AppState.lastKnownTime === lastCheckedTime && AppState.lastKnownTime > 0) {
                    AppState.frozenTicks++;
                    if (AppState.frozenTicks >= 4) { ProviderEngine.markFailure(); this.switchProvider(); }
                } else { AppState.frozenTicks = 0; lastCheckedTime = AppState.lastKnownTime; }
            }, 3000);
        } else {
            this.watchdogInterval = setInterval(() => {
                if (!document.hidden && AppState.activeMedia) {
                    AppState.lastKnownTime += 3;
                    SyncEngine.saveProgress(AppState.lastKnownTime);
                }
            }, 3000);
        }
    },

    stopWatchdog() { if (this.watchdogInterval) clearInterval(this.watchdogInterval); if (this.playGuard) clearTimeout(this.playGuard); },

    close() {
        this.stopWatchdog();
        SyncEngine.saveProgress(AppState.lastKnownTime);
        DOM.get('iframe-wrapper').innerHTML = '';
        DOM.hide('player-section');
        AppState.activeMedia = null;
        AppState.isPlaying = false;
        AppState.isBuffering = false;
        Renderer.renderHistory();
    },

    handleMessage(e) {
        if (!e.origin || (!e.origin.includes('vidlink.pro') && !e.origin.includes('vidsrc'))) return;
        if (!e.data || e.data.type !== 'PLAYER_EVENT') return;
        const { event, currentTime, duration } = e.data.data || {};
        if (event === 'play' || event === 'playing') {
            AppState.isPlaying = true;
            AppState.isBuffering = false;
            if (!this.hasPlayed) { this.hasPlayed = true; ProviderEngine.markSuccess(AppState.activeMedia.tmdbId); if (this.playGuard) clearTimeout(this.playGuard); }
        }
        if (event === 'waiting') { AppState.isBuffering = true; AppState.isPlaying = false; }
        if (event === 'pause') { AppState.isPlaying = false; AppState.isBuffering = false; }
        if (event === 'timeupdate' && currentTime !== undefined) {
            AppState.lastKnownTime = currentTime;
            AppState.isBuffering = false;
            if (currentTime - AppState.lastSyncTime >= CONFIG.SYNC_DEBOUNCE_S) { AppState.lastSyncTime = currentTime; SyncEngine.saveProgress(currentTime, duration); }
        }
        if (event === 'ended') { AppState.isPlaying = false; SyncEngine.saveProgress(currentTime, duration, true); }
    }
};

// --- METADATA MANAGER ---
const MetadataManager = {
    async fetchTVDetails(id) {
        const cacheKey = `tv_details_${id}`;
        const cached = this.getCache(cacheKey);
        if (cached) return cached;
        AppState.tmdbAbortCtrl?.abort();
        AppState.tmdbAbortCtrl = new AbortController();
        const requestId = ++AppState.currentTMDBRequestId;
        try {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${id}?api_key=${CONFIG.TMDB_KEY}`, { signal: AppState.tmdbAbortCtrl.signal });
            if (!res.ok) throw new Error();
            const data = await res.json();
            if (requestId === AppState.currentTMDBRequestId) { this.setCache(cacheKey, data); return data; }
        } catch (e) { if (e.name !== 'AbortError') console.error("TMDB Fetch Failed", e); }
        return null;
    },

    async fetchSeasonEpisodes(id, seasonNumber) {
        const cacheKey = `tv_episodes_${id}_${seasonNumber}`;
        const cached = this.getCache(cacheKey);
        if (cached) return cached;
        AppState.tmdbAbortCtrl?.abort();
        AppState.tmdbAbortCtrl = new AbortController();
        const requestId = ++AppState.currentTMDBRequestId;
        try {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${id}/season/${seasonNumber}?api_key=${CONFIG.TMDB_KEY}`, { signal: AppState.tmdbAbortCtrl.signal });
            if (!res.ok) throw new Error();
            const data = await res.json();
            if (requestId === AppState.currentTMDBRequestId) { this.setCache(cacheKey, data); return data; }
        } catch (e) { if (e.name !== 'AbortError') console.error("TMDB Season Fetch Failed", e); }
        return null;
    },

    getCache(key) {
        try {
            const raw = sessionStorage.getItem(key);
            if (!raw) return null;
            const { data, cachedAt } = JSON.parse(raw);
            if (Date.now() - cachedAt > CONFIG.TMDB_CACHE_EXPIRY) { sessionStorage.removeItem(key); return null; }
            return data;
        } catch (e) { return null; }
    },

    setCache(key, data) { try { sessionStorage.setItem(key, JSON.stringify({ data, cachedAt: Date.now() })); } catch (e) { } },

    async loadTVShow(item) {
        DOM.show('tv-selector');
        DOM.get('tv-title-display').textContent = `Loading: ${item.title}`;
        DOM.get('btn-play-tv').disabled = true;
        const details = await this.fetchTVDetails(item.tmdbId);
        if (!details) { DOM.toast("Failed to load show details."); return; }
        const seasonSelect = DOM.get('season-select');
        seasonSelect.innerHTML = details.seasons.filter(s => s.season_number > 0).map(s => `<option value="${s.season_number}">${s.name}</option>`).join('');
        const historyItem = Array.from(AppState.historyCache.values()).find(h => h.tmdbId == item.tmdbId && h.type === 'tv');
        const targetSeason = historyItem ? historyItem.season : details.seasons.find(s => s.season_number > 0).season_number;
        seasonSelect.value = targetSeason;
        await this.loadSeason(item.tmdbId, targetSeason, historyItem ? historyItem.episode : 1);
    },

    async loadSeason(id, seasonNumber, targetEpisode = 1) {
        DOM.get('btn-play-tv').disabled = true;
        const data = await this.fetchSeasonEpisodes(id, seasonNumber);
        if (!data) return;
        const epSelect = DOM.get('episode-select');
        epSelect.innerHTML = data.episodes.map(e => `<option value="${e.episode_number}">E${e.episode_number}: ${e.name}</option>`).join('');
        epSelect.value = targetEpisode;
        DOM.get('btn-play-tv').disabled = false;
        DOM.get('tv-title-display').textContent = `Ready: ${AppState.pendingTv.title}`;
    }
};

// --- RENDERER ---
const Renderer = {
    renderHistory() {
        const grid = DOM.get('history-grid');
        if (!grid) return;
        const items = Array.from(AppState.historyCache.values()).filter(i => i.timestamp < i.duration - 10).sort((a, b) => b.last_updated - a.last_updated).slice(0, 15);
        if (!items.length) { grid.innerHTML = '<p style="color:var(--muted)">No watch history. Start exploring!</p>'; return; }
        const fragment = document.createDocumentFragment();
        const tpl = DOM.get('tpl-history-item');
        if (!tpl) return;
        items.forEach(item => {
            const clone = document.importNode(tpl.content, true);
            const el = clone.querySelector('.history-item');
            el.dataset.payload = JSON.stringify(item);
            clone.querySelector('.item-title').textContent = item.title || 'Unknown';
            clone.querySelector('.item-meta').textContent = item.type === 'tv' ? `S${item.season || 1} E${item.episode || 1}` : 'Movie';
            const rawProgress = item.progress !== undefined ? item.progress : (item.timestamp / item.duration) * 100;
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
            if (!results || !results.length) { container.innerHTML = '<div style="padding:10px;">No results found.</div>'; return; }
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
        } catch (e) { container.innerHTML = '<div style="padding:10px;color:var(--danger)">Search failed. Check connection.</div>'; }
    }
};

// --- GLOBAL EVENT DELEGATOR ---
document.body.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'close-player') { PlayerManager.close(); }
    else if (action === 'delete-history') {
        e.stopPropagation();
        const historyItem = actionEl.closest('.history-item');
        if (historyItem) { try { SyncEngine.deleteEntry(JSON.parse(historyItem.dataset.payload)); } catch (e) { } }
    }
    else if (action === 'resume-play') {
        const historyItem = actionEl.closest('.history-item');
        if (historyItem) { try { const p = JSON.parse(historyItem.dataset.payload); PlayerManager.launch(p, p.timestamp || 0); } catch (e) { } }
    }
    else if (action === 'select-search') {
        const type = DOM.get('media-type').value;
        const id = actionEl.dataset.id;
        const title = actionEl.dataset.title;
        DOM.hide('search-results');
        if (type === 'movie') { PlayerManager.launch({ tmdbId: id, type, title }); }
        else { AppState.pendingTv = { tmdbId: id, type, title }; MetadataManager.loadTVShow(AppState.pendingTv); }
    }
});

document.addEventListener('click', (e) => {
    const searchResults = DOM.get('search-results');
    if (searchResults && !searchResults.classList.contains('hidden')) {
        if (!searchResults.contains(e.target) && e.target !== DOM.get('search-query')) DOM.hide('search-results');
    }
}, true);

DOM.get('season-select')?.addEventListener('change', (e) => { if (AppState.pendingTv) MetadataManager.loadSeason(AppState.pendingTv.tmdbId, e.target.value); });
DOM.get('btn-search')?.addEventListener('click', () => { const q = DOM.get('search-query').value.trim(); if (q) Renderer.renderSearch(q, DOM.get('media-type').value); });
DOM.get('search-query')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') DOM.get('btn-search').click(); });
DOM.get('btn-play-tv')?.addEventListener('click', () => { if (AppState.pendingTv) PlayerManager.launch({ ...AppState.pendingTv, season: DOM.get('season-select').value, episode: DOM.get('episode-select').value }); });

window.addEventListener('message', (e) => PlayerManager.handleMessage(e));
document.addEventListener('visibilitychange', () => {
    if (document.hidden && AppState.activeMedia) SyncEngine.saveProgress(AppState.lastKnownTime);
    else if (!document.hidden && !AppState.activeMedia) SyncEngine.fetchRemote();
});

window.addEventListener('DOMContentLoaded', () => { Renderer.renderHistory(); SyncEngine.init(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { }); });
