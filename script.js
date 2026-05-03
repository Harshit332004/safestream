/**
 * StreamSafe Engine v9.2 - Frontend Client
 * Hardened: Delta-Sync, Multi-Tab Sync, Heartbeat Validation, Manual Switching.
 */

const CONFIG = {
    TMDB_KEY: '797f74f09af514f1d6f9ecdbf70e8597',
    API_URL: 'https://safestream-ulch.onrender.com/api',
    SYNC_DELTA_S: 5,
    DEBOUNCE_MS: 3000,
    HEARTBEAT_TIMEOUT: 8000,
    MAX_QUEUE_SIZE: 50
};

const syncChannel = new BroadcastChannel('streamsafe_sync');

const PROVIDERS = [
    { name: 'Vidlink', supportsEvents: true, buildUrl: ({ type, id, s, e, time }) => `https://vidlink.pro/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}?primaryColor=3b82f6&autoplay=true&startAt=${time || 0}` },
    { name: 'VidSrc.to', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://vidsrc.to/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}` },
    { name: 'SuperFlix', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://superflix.icu/api/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}` },
    { name: 'AutoEmbed', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://autoembed.cc/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}` },
    { name: 'WarezCDN', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://embed.warezcdn.com/v2/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}` },
    { name: 'VidSrc.me', supportsEvents: false, buildUrl: ({ type, id, s, e }) => `https://vidsrc.me/embed/${id}${type === 'tv' ? `/${s}/${e}` : ''}` }
];

const AppState = {
    activeMedia: null, providerIndex: 0, lastKnownTime: 0, lastSyncTime: 0,
    isPlaying: false, playDetected: false, historyCache: new Map(), pendingTv: null
};

const DOM = {
    get: id => document.getElementById(id),
    show: id => DOM.get(id)?.classList.remove('hidden'),
    hide: id => DOM.get(id)?.classList.add('hidden'),
    toast: (msg, duration = 3000) => {
        const t = DOM.get('status-toast');
        if (!t) return;
        t.textContent = msg; t.classList.remove('hidden');
        if (duration > 0) setTimeout(() => t.classList.add('hidden'), duration);
    }
};

const SyncEngine = {
    init() {
        let local = [];
        try { local = JSON.parse(localStorage.getItem('streamsafe_cache') || '[]'); } catch (e) { local = []; }
        local.forEach(item => AppState.historyCache.set(this.makeKey(item), item));
        this.fetchRemote();
        syncChannel.onmessage = (e) => {
            const { type, payload } = e.data;
            if (type === 'UPDATE') AppState.historyCache.set(this.makeKey(payload), payload);
            else if (type === 'DELETE') AppState.historyCache.delete(this.makeKey(payload));
            this.persistLocal(); Renderer.renderHistory();
        };
    },
    makeKey: (i) => `${i.tmdbId}_${i.type}_${i.season || 1}_${i.episode || 1}`,
    async fetchRemote() {
        if (!navigator.onLine) return;
        try {
            const res = await fetch(`${CONFIG.API_URL}/continue-watching`, { headers: { 'x-api-key': 'streamsafe-secret' } });
            const { history } = await res.json();
            history.forEach(item => AppState.historyCache.set(this.makeKey(item), item));
            this.persistLocal(); Renderer.renderHistory();
        } catch (e) { }
    },
    saveProgress(time, duration = 0, isComplete = false) {
        if (!AppState.activeMedia || !PROVIDERS[AppState.providerIndex].supportsEvents) return;
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
        syncChannel.postMessage({ type: isComplete ? 'DELETE' : 'UPDATE', payload });
    },
    persistLocal() { localStorage.setItem('streamsafe_cache', JSON.stringify(Array.from(AppState.historyCache.values()))); },
    queueNetworkAction(method, payload) {
        fetch(method === 'DELETE' ? `${CONFIG.API_URL}/history` : `${CONFIG.API_URL}/sync`, {
            method, headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
            body: JSON.stringify(payload), keepalive: true
        });
    }
};

const PlayerManager = {
    heartbeat: null,
    launch(item, startAt = 0) {
        let resumeTime = (item.duration && startAt > item.duration - 10) ? 0 : startAt;
        AppState.activeMedia = item; AppState.lastKnownTime = resumeTime; AppState.lastSyncTime = resumeTime;
        AppState.providerIndex = 0; DOM.show('player-section'); this.injectIframe();
    },
    injectIframe() {
        const provider = PROVIDERS[AppState.providerIndex];
        const m = AppState.activeMedia;
        const url = provider.buildUrl({ type: m.type, id: m.tmdbId, s: m.season, e: m.episode, time: AppState.lastKnownTime });
        DOM.get('provider-badge').textContent = provider.name;
        const wrapper = DOM.get('iframe-wrapper');
        wrapper.innerHTML = `<div class="player-loader">Connecting to ${provider.name}...</div>`;
        const iframe = document.createElement('iframe');
        iframe.src = url; iframe.allowFullscreen = true; iframe.allow = "autoplay; fullscreen";
        clearTimeout(this.heartbeat);
        this.heartbeat = setTimeout(() => { if (!AppState.playDetected) this.switchProvider(); }, CONFIG.HEARTBEAT_TIMEOUT);
        iframe.onload = () => { wrapper.querySelector('.player-loader')?.remove(); wrapper.appendChild(iframe); };
    },
    switchProvider() {
        AppState.providerIndex = (AppState.providerIndex + 1) % PROVIDERS.length;
        DOM.toast(`Server: ${PROVIDERS[AppState.providerIndex].name}`);
        this.injectIframe();
    },
    close() {
        clearTimeout(this.heartbeat); DOM.get('iframe-wrapper').innerHTML = ''; DOM.hide('player-section');
        SyncEngine.saveProgress(AppState.lastKnownTime); AppState.activeMedia = null; Renderer.renderHistory();
    }
};

const MetadataManager = {
    async loadTVShow(id, title) {
        DOM.show('tv-selector'); DOM.get('btn-play-tv').disabled = true;
        try {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${id}?api_key=${CONFIG.TMDB_KEY}`);
            const data = await res.json();
            const seasonSelect = DOM.get('season-select');
            seasonSelect.innerHTML = data.seasons.filter(s => s.season_number > 0).map(s => `<option value="${s.season_number}">Season ${s.season_number}</option>`).join('');
            this.loadEpisodes(id, seasonSelect.value);
            DOM.get('tv-title-display').textContent = title;
        } catch (e) { DOM.toast("Meta error."); }
    },
    async loadEpisodes(id, season) {
        const epSelect = DOM.get('episode-select'); DOM.get('btn-play-tv').disabled = true;
        try {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${id}/season/${season}?api_key=${CONFIG.TMDB_KEY}`);
            const data = await res.json();
            epSelect.innerHTML = data.episodes.map(e => `<option value="${e.episode_number}">Ep ${e.episode_number}: ${e.name}</option>`).join('');
            DOM.get('btn-play-tv').disabled = false;
        } catch (e) { DOM.toast("Episode error."); }
    }
};

const Renderer = {
    renderHistory() {
        const grid = DOM.get('history-grid'); if (!grid) return;
        const items = Array.from(AppState.historyCache.values()).sort((a, b) => b.last_updated - a.last_updated).slice(0, 15);
        if (!items.length) { grid.innerHTML = '<p style="color:var(--muted)">No history.</p>'; return; }
        const frag = document.createDocumentFragment(); const tpl = DOM.get('tpl-history-item').content;
        items.forEach(i => {
            const clone = document.importNode(tpl, true); const el = clone.querySelector('.history-item');
            el.dataset.payload = JSON.stringify(i);
            clone.querySelector('.item-title').textContent = i.title;
            clone.querySelector('.item-meta').textContent = i.type === 'tv' ? `S${i.season} E${i.episode}` : 'Movie';
            clone.querySelector('.progress-fill').style.width = `${(i.timestamp / (i.duration || 1)) * 100}%`;
            frag.appendChild(clone);
        });
        grid.replaceChildren(frag);
    },
    async renderSearch(q, type) {
        const res = await fetch(`https://api.themoviedb.org/3/search/${type}?api_key=${CONFIG.TMDB_KEY}&query=${encodeURIComponent(q)}`);
        const { results } = await res.json();
        const frag = document.createDocumentFragment();
        results.slice(0, 6).forEach(i => {
            const clone = document.importNode(DOM.get('tpl-search-item').content, true);
            const el = clone.querySelector('.search-item');
            el.dataset.id = i.id; el.dataset.title = type === 'movie' ? i.title : i.name;
            clone.querySelector('.search-title').textContent = el.dataset.title;
            const year = (type === 'movie' ? i.release_date : i.first_air_date)?.split('-')[0] || 'N/A';
            clone.querySelector('.search-year').textContent = `(${year})`;
            frag.appendChild(clone);
        });
        DOM.get('search-results').replaceChildren(frag); DOM.show('search-results');
    }
};

// --- EVENTS ---
window.addEventListener('message', (e) => {
    if (e.origin.includes("vidlink.pro")) PlayerManager.handleMessage(e);
});

document.body.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]'); if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'resume-play') PlayerManager.launch(JSON.parse(actionEl.closest('.history-item').dataset.payload), JSON.parse(actionEl.closest('.history-item').dataset.payload).timestamp);
    else if (action === 'manual-switch') PlayerManager.switchProvider();
    else if (action === 'close-player') PlayerManager.close();
    else if (action === 'select-search') {
        const type = DOM.get('media-type').value; const id = actionEl.dataset.id; const title = actionEl.dataset.title;
        DOM.hide('search-results'); if (type === 'movie') PlayerManager.launch({ tmdbId: id, type, title });
        else { AppState.pendingTv = { tmdbId: id, type, title }; MetadataManager.loadTVShow(id, title); }
    }
});

DOM.get('btn-search')?.addEventListener('click', () => { const q = DOM.get('search-query').value.trim(); if (q) Renderer.renderSearch(q, DOM.get('media-type').value); });
DOM.get('season-select')?.addEventListener('change', (e) => MetadataManager.loadEpisodes(AppState.pendingTv.tmdbId, e.target.value));
DOM.get('btn-play-tv')?.addEventListener('click', () => PlayerManager.launch({ ...AppState.pendingTv, season: DOM.get('season-select').value, episode: DOM.get('episode-select').value }));

window.addEventListener('DOMContentLoaded', () => { SyncEngine.init(); Renderer.renderHistory(); });