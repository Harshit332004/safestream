// Replace with your actual TMDB Read Access Token (API Key) v3
const TMDB_API_KEY = '797f74f09af514f1d6f9ecdbf70e8597';

let selectedTvId = null;

function resetSearch() {
    document.getElementById('search-results').style.display = 'none';
    document.getElementById('tv-fields').style.display = 'none';
    document.getElementById('search-query').value = '';
    selectedTvId = null;
}

async function searchTmdb() {
    const query = document.getElementById('search-query').value.trim();
    const type = document.getElementById('video-type').value;
    
    if (!query) {
        alert("Please enter a search term.");
        return;
    }
    
    if (TMDB_API_KEY === 'YOUR_TMDB_API_KEY_HERE') {
        alert("Please replace 'YOUR_TMDB_API_KEY_HERE' in script.js with your actual TMDB API Key!");
        return;
    }

    const searchUrl = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=en-US&page=1`;

    try {
        const resultsContainer = document.getElementById('search-results');
        resultsContainer.innerHTML = '<div class="search-result-item" style="text-align: center;">⏳ Searching...</div>';
        resultsContainer.style.display = 'block';

        const response = await fetch(searchUrl);
        const data = await response.json();
        
        resultsContainer.innerHTML = '';
        
        if (data.results && data.results.length > 0) {
            data.results.forEach(item => {
                const title = type === 'movie' ? item.title : item.name;
                const releaseDate = type === 'movie' ? item.release_date : item.first_air_date;
                const year = releaseDate ? releaseDate.split('-')[0] : 'Unknown';
                
                const resultItem = document.createElement('div');
                resultItem.className = 'search-result-item';
                resultItem.innerHTML = `<strong>${title}</strong> <span style="color: var(--text-secondary); font-size: 0.85em;">(${year})</span>`;
                resultItem.onclick = () => handleResultClick(item.id, title, type);
                
                resultsContainer.appendChild(resultItem);
            });
            resultsContainer.style.display = 'block';
            document.getElementById('tv-fields').style.display = 'none';
        } else {
            resultsContainer.innerHTML = '<div class="search-result-item">No results found.</div>';
            resultsContainer.style.display = 'block';
        }
    } catch (e) {
        console.error("Search error:", e);
        alert("Error searching TMDB. Check console.");
    }
}

function handleResultClick(id, title, type) {
    document.getElementById('search-results').style.display = 'none';
    window.currentMediaTitle = title;
    
    if (type === 'movie') {
        loadStream(id, 'movie');
    } else {
        selectedTvId = id;
        document.getElementById('selected-show-title').innerText = `Selected: ${title}`;
        document.getElementById('tv-fields').style.display = 'block';
    }
}

function playSelectedShow() {
    if (!selectedTvId) return;
    const season = document.getElementById('season').value;
    const episode = document.getElementById('episode').value;
    loadStream(selectedTvId, 'tv', season, episode);
}

// === DEPLOYMENT CONFIG ===
// If deploying Frontend to Vercel & Backend to Render, put your Render URL here:
// Example: const BACKEND_URL = "https://my-streamsafe-backend.onrender.com";
const BACKEND_URL = "https://safestream-ulch.onrender.com"; 

let freezeCheckInterval = null;
let lastTimeStr = -1;
let frozenSeconds = 0;
let lastKnownTime = 0;
let userPaused = false;
let reloadRetries = 0;
let lastSyncTime = 0;
let offlineSyncQueue = JSON.parse(localStorage.getItem('streamsafe_offline_queue') || '[]');

function flushPendingSync() {
    if (!navigator.onLine || offlineSyncQueue.length === 0) return;
    const queueToProcess = [...offlineSyncQueue];
    offlineSyncQueue = [];
    localStorage.setItem('streamsafe_offline_queue', '[]');
    
    queueToProcess.forEach(async (data) => {
        try {
            await fetch(`${BACKEND_URL}/api/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
                body: JSON.stringify(data)
            });
        } catch (e) {
            offlineSyncQueue.push(data);
            localStorage.setItem('streamsafe_offline_queue', JSON.stringify(offlineSyncQueue));
        }
    });
}
window.addEventListener('online', flushPendingSync);

document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopFreezeDetection();
    else {
        if (window.currentMedia) startFreezeDetection();
        else renderHistory(); // Refresh history when user returns to tab
    }
});

document.addEventListener('DOMContentLoaded', () => {
    renderHistory();
    
    // Check network speed and offline status
    if (!navigator.onLine) {
        const warning = document.getElementById('network-warning');
        if (warning) {
            warning.innerText = "⚠️ You are offline. Video streaming requires an internet connection.";
            warning.style.display = 'block';
        }
    } else if (navigator.connection) {
        const type = navigator.connection.effectiveType;
        if (type === '2g' || type === 'slow-2g') {
            const warning = document.getElementById('network-warning');
            if (warning) warning.style.display = 'block';
        }
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(registration => {
            console.log('PWA ServiceWorker registered successfully!');
        }).catch(err => {
            console.log('ServiceWorker registration failed: ', err);
        });
    }
});

// Function to load the stream
function loadStream(tmdbId, type, season, episode, startAt) {
    if (!tmdbId) {
        console.error("No TMDB ID provided");
        return;
    }

    // Optimize default Vidlink player for low-end devices
    let url = `https://vidlink.pro/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`;
    if (type === 'tv') {
        url += `/${season}/${episode}`;
    }

    url += '?primaryColor=3b82f6&autoplay=true&title=false&poster=false';
    if (startAt) {
        url += `&startAt=${startAt}`;
        lastKnownTime = startAt;
    } else {
        lastKnownTime = 0;
    }

    // Dynamic iframe injection for strict memory management with tap-shield/fade
    const wrapper = document.getElementById('iframe-wrapper');
    wrapper.innerHTML = `<iframe id="video-player" src="${url}" style="animation: fadeIn 0.3s ease-out;" allowfullscreen allow="autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write"></iframe>`;

    document.getElementById('player-container').style.display = 'block';
    
    // Save current media context for the PLAYER_EVENT tracker
    window.currentMedia = { tmdbId, type, season, episode };

    // Scroll to player smoothly
    setTimeout(() => {
        document.getElementById('player-container').scrollIntoView({ behavior: 'smooth' });
    }, 100);

    startFreezeDetection();
}

function reloadPlayer() {
    if (!window.currentMedia) return;
    console.log("Reloading player to recover from freeze");
    loadStream(window.currentMedia.tmdbId, window.currentMedia.type, window.currentMedia.season, window.currentMedia.episode, Math.floor(lastKnownTime));
}

function closePlayer() {
    const wrapper = document.getElementById('iframe-wrapper');
    const iframe = document.getElementById('video-player');
    if (iframe) iframe.removeAttribute('src'); // Stop ghost audio from continuing
    // Completely destroy the iframe node to aggressively free RAM on mobile
    wrapper.innerHTML = '';
    document.getElementById('player-container').style.display = 'none';
    window.currentMedia = null;
    stopFreezeDetection();
    renderHistory();
}

function startFreezeDetection() {
    stopFreezeDetection();
    frozenSeconds = 0;
    lastTimeStr = -1;
    // Check every 3 seconds for timestamp freezing
    freezeCheckInterval = setInterval(() => {
        if (!window.currentMedia) return;
        
        // Smarter signal: don't reload if tab hidden, offline, or explicitly paused
        if (document.visibilityState !== "visible" || !navigator.onLine || userPaused) {
            frozenSeconds = 0;
            return;
        }

        if (lastTimeStr === lastKnownTime && lastKnownTime > 0) {
            frozenSeconds += 3;
            // If frozen for ~12 seconds, reload
            if (frozenSeconds >= 12) {
                if (reloadRetries < 3) {
                    reloadRetries++;
                    console.log(`Freeze detected! Auto-reloading (Attempt ${reloadRetries}/3)`);
                    reloadPlayer();
                } else {
                    console.error("Max reload retries reached. Stopping auto-reload.");
                    stopFreezeDetection();
                }
            }
        } else {
            frozenSeconds = 0;
            lastTimeStr = lastKnownTime;
            reloadRetries = 0; // reset retries if video moves naturally
        }
    }, 3000);
}

function stopFreezeDetection() {
    if (freezeCheckInterval) clearInterval(freezeCheckInterval);
}

// Listen for media events to update progress perfectly to the second
window.addEventListener('message', async (event) => {
    if (event.origin !== 'https://vidlink.pro') return;
    
    // Fallback MEDIA_DATA
    if (event.data?.type === 'MEDIA_DATA') {
        const mediaData = event.data.data;
        localStorage.setItem('vidLinkProgress', JSON.stringify(mediaData));
    }

    // Exact precision tracking
    if (event.data?.type === 'PLAYER_EVENT') {
        const { event: eventType, currentTime, duration } = event.data.data;
        
        if (eventType === 'pause') userPaused = true;
        if (eventType === 'play' || eventType === 'playing') userPaused = false;

        // Update our freeze detector variable
        if (eventType === 'timeupdate') {
            lastKnownTime = currentTime;
        }

        // Sync to backend every 5 seconds or when paused/ended
        if (eventType === 'pause' || eventType === 'ended' || (eventType === 'timeupdate' && Date.now() - lastSyncTime > 5000)) {
            if (eventType === 'timeupdate') lastSyncTime = Date.now();
            if (!window.currentMedia) return;
            
            const payload = {
                tmdbId: window.currentMedia.tmdbId,
                type: window.currentMedia.type,
                title: window.currentMediaTitle || "Current Stream",
                season: window.currentMedia.season,
                episode: window.currentMedia.episode,
                timestamp: currentTime,
                duration: duration
            };
            
            if (!navigator.onLine) {
                offlineSyncQueue.push(payload);
                localStorage.setItem('streamsafe_offline_queue', JSON.stringify(offlineSyncQueue));
                return;
            }
            
            try {
                // Ensure server is running for this to work
                await fetch(`${BACKEND_URL}/api/sync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
                    cache: 'no-store',
                    body: JSON.stringify(payload)
                });
            } catch (e) {
                offlineSyncQueue.push(payload);
                localStorage.setItem('streamsafe_offline_queue', JSON.stringify(offlineSyncQueue));
            }
        }
    }
});

// Render the watch history on load (prioritizing Cloud Backend)
async function renderHistory() {
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = `
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
    `;
    
    try {
        let res;
        for (let i = 0; i < 3; i++) {
            try {
                res = await fetch(`${BACKEND_URL}/api/history`, {
                    headers: { 'x-api-key': 'streamsafe-secret' },
                    cache: 'no-store'
                });
                if (res.ok) break;
            } catch (e) {
                if (i === 2) throw e;
                historyList.innerHTML = `
                    <div class="skeleton skeleton-card" style="display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:0.9rem;">
                        ⏳ Waking up server... (${i+1}/3)
                    </div>
                `;
                console.warn(`Backend wake-up delay... retrying (${i+1}/3)`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        
        if (!res || !res.ok) throw new Error("Backend response not OK");
        const data = await res.json();
        
        if (!data.history || data.history.length === 0) {
            fallbackLocalHistory(historyList);
            return;
        }

        let html = '';
        data.history.forEach(entry => {
            const title = entry.title && entry.title !== "Current Stream" ? entry.title : `ID: ${entry.tmdbId}`;
            const progress = Math.min((entry.timestamp / entry.duration) * 100, 100);
            const meta = entry.type === 'tv' ? `S${entry.season} E${entry.episode}` : 'Movie';
            let startAt = Math.floor(entry.timestamp);
            
            if (entry.timestamp >= entry.duration - 10) {
                startAt = 0; // Restart from beginning if completed
            }

            html += `
                <div class="history-item">
                    <div class="delete-btn" onclick="event.stopPropagation(); deleteHistory('${entry.tmdbId}', '${entry.type}', '${entry.season}', '${entry.episode}')">✕</div>
                    <div onclick="loadStream('${entry.tmdbId}', '${entry.type}', '${entry.season}', '${entry.episode}', ${startAt})">
                        <h3>${title}</h3>
                        <div class="history-meta">${meta}</div>
                        <div class="progress-bar-container">
                            <div class="progress-bar" style="width: ${progress}%"></div>
                        </div>
                    </div>
                </div>
            `;
        });
        historyList.innerHTML = html;

    } catch (e) {
        // Fallback if backend server isn't running
        fallbackLocalHistory(historyList);
    }
}

function fallbackLocalHistory(historyList) {
    const storedData = localStorage.getItem('vidLinkProgress');
    if (!storedData) {
        historyList.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.875rem;">No watch history found. Play a video to start tracking!</p>';
        return;
    }

    try {
        const historyObj = JSON.parse(storedData);
        const entries = Object.values(historyObj).sort((a, b) => (b.last_updated || 0) - (a.last_updated || 0));

        if (entries.length === 0) {
            historyList.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.875rem;">No watch history found yet.</p>';
            return;
        }

        let html = '';
        entries.forEach(entry => {
            const title = entry.title || `TMDB ID: ${entry.id}`;
            let progress = 0;
            let startAt = 0;
            let meta = '';
            let season = 1;
            let episode = 1;

            if (entry.type === 'movie' && entry.progress) {
                progress = (entry.progress.watched / entry.progress.duration) * 100;
                startAt = Math.floor(entry.progress.watched);
            } else if (entry.type === 'tv') {
                season = entry.last_season_watched || 1;
                episode = entry.last_episode_watched || 1;
                meta = `S${season} E${episode}`;
                
                const epKey = `s${season}e${episode}`;
                if (entry.show_progress && entry.show_progress[epKey] && entry.show_progress[epKey].progress) {
                    const epProg = entry.show_progress[epKey].progress;
                    progress = (epProg.watched / epProg.duration) * 100;
                    startAt = Math.floor(epProg.watched);
                }
            }

            progress = Math.min(Math.max(progress, 0), 100);

            html += `
                <div class="history-item">
                    <div class="delete-btn" onclick="event.stopPropagation(); deleteLocalHistory('${entry.id}')">✕</div>
                    <div onclick="loadStream('${entry.id}', '${entry.type}', '${season}', '${episode}', ${startAt})">
                        <h3>${title}</h3>
                        ${meta ? `<div class="history-meta">${meta}</div>` : ''}
                        <div class="progress-bar-container">
                            <div class="progress-bar" style="width: ${progress}%"></div>
                        </div>
                    </div>
                </div>
            `;
        });
        historyList.innerHTML = html;
    } catch (e) {
        console.error("Error parsing history", e);
        historyList.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.875rem;">Failed to load local history.</p>';
    }
}

async function deleteHistory(tmdbId, type, season, episode) {
    if (!confirm("Remove this from Continue Watching?")) return;
    
    // First remove from local offline queue if it's there
    let queue = JSON.parse(localStorage.getItem('streamsafe_offline_queue') || '[]');
    queue = queue.filter(item => !(item.tmdbId == tmdbId && item.type == type && item.season == season && item.episode == episode));
    localStorage.setItem('streamsafe_offline_queue', JSON.stringify(queue));

    try {
        await fetch(`${BACKEND_URL}/api/history`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'streamsafe-secret' },
            body: JSON.stringify({ tmdbId, type, season, episode })
        });
        renderHistory();
    } catch(e) {
        console.error(e);
        alert("Failed to delete history.");
    }
}

function deleteLocalHistory(id) {
    if (!confirm("Remove this from Continue Watching?")) return;
    const storedData = localStorage.getItem('vidLinkProgress');
    if (storedData) {
        let historyObj = JSON.parse(storedData);
        const entryKey = Object.keys(historyObj).find(k => historyObj[k].id == id);
        if (entryKey) {
            delete historyObj[entryKey];
            localStorage.setItem('vidLinkProgress', JSON.stringify(historyObj));
        }
    }
    renderHistory();
}
