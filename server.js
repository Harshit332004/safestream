/**
 * StreamSafe Engine v9.1 - Hardened Manual Control
 * Fixed: TMDB Episode Dropdowns & Manual Provider Switching
 */

const CONFIG = {
    TMDB_KEY: '797f74f09af514f1d6f9ecdbf70e8597',
    API_URL: 'https://safestream-ulch.onrender.com/api',
    SYNC_DEBOUNCE_S: 5,
    DEBOUNCE_MS: 3000,
    HEARTBEAT_TIMEOUT: 8000,
    MAX_QUEUE_SIZE: 50,
    RETRY_LIMIT: 2
};

const PROVIDERS = [
    {
        name: 'Vidlink',
        supportsEvents: true,
        buildUrl: ({ type, id, s, e, time }) =>
            `https://vidlink.pro/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}?primaryColor=3b82f6&autoplay=true&startAt=${time || 0}`
    },
    {
        name: 'VidSrc.to',
        supportsEvents: false,
        buildUrl: ({ type, id, s, e }) =>
            `https://vidsrc.to/embed/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}`
    },
    {
        name: 'SuperFlix',
        supportsEvents: false,
        buildUrl: ({ type, id, s, e }) =>
            `https://superflix.icu/api/${type}/${id}${type === 'tv' ? `/${s}/${e}` : ''}`
    }
];

const AppState = {
    activeMedia: null,
    providerIndex: 0,
    lastKnownTime: 0,
    lastSyncTime: 0,
    isPlaying: false,
    historyCache: new Map(),
    offlineQueue: [],
    pendingTv: null
};

// --- DOM UTILITIES ---
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

// --- SYNC ENGINE ---
const SyncEngine = {
    init() {
        let local = [];
        try { local = JSON.parse(localStorage.getItem('streamsafe_cache') || '[]'); } catch (e) { local = []; }
        local.forEach(item => AppState.historyCache.set(this.makeKey(item), item));
        this.fetchRemote();
    },
    makeKey: (i) => `${i.tmdbId}_${i.type}_${i.season || 1}_${i.episode || 1}`,
    async fetchRemote() {
        if (!navigator.onLine) return;
        try {
            const res = await fetch(`${CONFIG.API_URL}/continue-watching`, { headers: { 'x-api-key': 'streamsafe-secret' } });
            const { history } = await res.json();
            history.forEach(item => AppState.historyCache.set(this.makeKey(item), item));
            Renderer.renderHistory();
        } catch (e) { }
    },
    saveProgress(time, duration = 0, isComplete = false) {
        if (!AppState.activeMedia || !PROVIDERS[AppState.providerIndex].supportsEvents) return;
        const key = this.makeKey(AppState.activeMedia);
        const payload = { ...AppState.activeMedia, timestamp: time, duration: duration || 1, last_updated: Date.now() };
        if (isComplete || (duration > 0 && time > duration - 10)) {
            AppState.historyCache.delete(key);
        } else {
            AppState.historyCache.set(key, payload);
        }
        localStorage.setItem('streamsafe_cache', JSON.stringify(Array.from(AppState.historyCache.values())));
    }
};

// --- METADATA MANAGER (FIXED DROPDOWNS) ---
const MetadataManager = {
    async loadTVShow(id, title) {
        DOM.show('tv-selector');
        DOM.get('tv-title-display').textContent = `Loading metadata...`;
        DOM.get('btn-play-tv').disabled = true;

        try {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${id}?api_key=${CONFIG.TMDB_KEY}`);
            const data = await res.json();

            const seasonSelect = DOM.get('season-select');
            // Filter specials (Season 0) and populate
            seasonSelect.innerHTML = data.seasons
                .filter(s => s.season_number > 0)
                .map(s => `<option value="${s.season_number}">Season ${s.season_number}</option>`)
                .join('');

            DOM.get('tv-title-display').textContent = title;

            // Trigger episode load for first season
            if (seasonSelect.value) {
                await this.loadEpisodes(id, seasonSelect.value);
            }
        } catch (e) { DOM.toast("Failed to fetch TV details."); }
    },

    async loadEpisodes(id, seasonNumber) {
        const epSelect = DOM.get('episode-select');
        epSelect.innerHTML = `<option>Loading episodes...</option>`;
        DOM.get('btn-play-tv').disabled = true;

        try {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${id}/season/${seasonNumber}?api_key=${CONFIG.TMDB_KEY}`);
            const data = await res.json();

            epSelect.innerHTML = data.episodes
                .map(e => `<option value="${e.episode_number}">Ep ${e.episode_number}: ${e.name}</option>`)
                .join('');

            DOM.get('btn-play-tv').disabled = false;
        } catch (e) { DOM.toast("Failed to fetch episodes."); }
    }
};

// --- PLAYER MANAGER (MANUAL CONTROL) ---
const PlayerManager = {
    heartbeat: null,
    launch(item, startAt = 0) {
        AppState.activeMedia = item;
        AppState.lastKnownTime = startAt;
        AppState.lastSyncTime = startAt;
        AppState.providerIndex = 0;
        DOM.show('player-section');
        this.injectIframe();
    },
    injectIframe() {
        const provider = PROVIDERS[AppState.providerIndex];
        const m = AppState.activeMedia;
        const url = provider.buildUrl({ type: m.type, id: m.tmdbId, s: m.season, e: m.episode, time: AppState.lastKnownTime });

        DOM.get('provider-badge').textContent = provider.name;
        const wrapper = DOM.get('iframe-wrapper');
        wrapper.innerHTML = `<div class="player-loader">Connecting to ${provider.name}...</div>`;

        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.allowFullscreen = true;
        iframe.allow = "autoplay; fullscreen";

        iframe.onload = () => {
            wrapper.querySelector('.player-loader')?.remove();
            wrapper.appendChild(iframe);
        };
    },
    switchProvider() {
        AppState.providerIndex = (AppState.providerIndex + 1) % PROVIDERS.length;
        DOM.toast(`Swapping server to: ${PROVIDERS[AppState.providerIndex].name}`);
        this.injectIframe();
    },
    close() {
        DOM.get('iframe-wrapper').innerHTML = '';
        DOM.hide('player-section');
        SyncEngine.saveProgress(AppState.lastKnownTime);
        AppState.activeMedia = null;
        Renderer.renderHistory();
    }
};

// --- RENDERER ---
const Renderer = {
    renderHistory() {
        const grid = DOM.get('history-grid');
        const items = Array.from(AppState.historyCache.values()).sort((a, b) => b.last_updated - a.last_updated).slice(0, 15);
        if (!items.length) { grid.innerHTML = '<p style="color:var(--muted)">No history yet.</p>'; return; }
        const frag = document.createDocumentFragment();
        const tpl = DOM.get('tpl-history-item').content;
        items.forEach(i => {
            const clone = document.importNode(tpl, true);
            const el = clone.querySelector('.history-item');
            el.dataset.payload = JSON.stringify(i);
            clone.querySelector('.item-title').textContent = i.title;
            clone.querySelector('.item-meta').textContent = i.type === 'tv' ? `S${i.season} E${i.episode}` : 'Movie';
            clone.querySelector('.progress-fill').style.width = `${(i.timestamp / i.duration) * 100}%`;
            frag.appendChild(clone);
        });
        grid.replaceChildren(frag);
    }
};

// --- GLOBAL EVENT DELEGATION ---
document.body.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'manual-switch') PlayerManager.switchProvider();
    else if (action === 'close-player') PlayerManager.close();
    else if (action === 'resume-play') {
        const p = JSON.parse(actionEl.closest('.history-item').dataset.payload);
        PlayerManager.launch(p, p.timestamp);
    }
    else if (action === 'select-search') {
        const id = actionEl.dataset.id;
        const title = actionEl.dataset.title;
        const type = DOM.get('media-type').value;
        DOM.hide('search-results');
        if (type === 'movie') PlayerManager.launch({ tmdbId: id, type, title });
        else {
            AppState.pendingTv = { tmdbId: id, type, title };
            MetadataManager.loadTVShow(id, title);
        }
    }
});

// --- SPECIFIC UI LISTENERS ---
DOM.get('season-select')?.addEventListener('change', (e) => {
    if (AppState.pendingTv) MetadataManager.loadEpisodes(AppState.pendingTv.tmdbId, e.target.value);
});

DOM.get('btn-play-tv')?.addEventListener('click', () => {
    PlayerManager.launch({
        ...AppState.pendingTv,
        season: DOM.get('season-select').value,
        episode: DOM.get('episode-select').value
    });
});

DOM.get('btn-search')?.addEventListener('click', () => {
    const q = DOM.get('search-query').value;
    // (Search implementation from previous V9 Elite build goes here)
});

window.addEventListener('DOMContentLoaded', () => { SyncEngine.init(); Renderer.renderHistory(); });