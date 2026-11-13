import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import WebTorrent from 'webtorrent';
import { initDb, upsertMovie, searchCatalog, getGenresSummary } from './db.js';
import { seedCatalog, scanLocalMovies } from './seeder.js';
import { askAiMovieRecommendations } from './aiSearch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8085;
const SAVE_PATH = process.env.SAVE_PATH || 'D:\\filmes';
const JELLYFIN_URL = process.env.JELLYFIN_URL || 'http://localhost:8096';
const JELLYFIN_USER = process.env.JELLYFIN_USER || 'rafae';
const JELLYFIN_PW = process.env.JELLYFIN_PW || '10092004';

// Initialize SQLite database
initDb();

// Ensure save path directory exists
try {
    if (!fs.existsSync(SAVE_PATH)) {
        fs.mkdirSync(SAVE_PATH, { recursive: true });
    }
} catch (e) {
    console.warn(`[TorrentService] Could not verify save path "${SAVE_PATH}":`, e.message);
}

// Torrent Client
const client = new WebTorrent();
client.on('error', (err) => {
    console.error('[WebTorrent] Global error:', err.message);
});

// Downloads registry: infoHash -> meta info
const downloadsRegistry = new Map();
const DOWNLOADS_FILE = path.join(__dirname, 'downloads.json');

// Load saved downloads history if available
try {
    if (fs.existsSync(DOWNLOADS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(DOWNLOADS_FILE, 'utf8'));
        if (Array.isArray(saved)) {
            saved.forEach(item => {
                downloadsRegistry.set(item.id, item);
            });
        }
    }
} catch (e) {
    console.warn('[TorrentService] Could not load downloads history:', e.message);
}

function persistDownloads() {
    try {
        const list = Array.from(downloadsRegistry.values()).map(d => ({
            id: d.id,
            imdbId: d.imdbId,
            title: d.title,
            quality: d.quality,
            status: d.status,
            downloaded: d.downloaded || '0 MB',
            total: d.total || '0 MB',
            progress: d.progress || 0,
            completedAt: d.completedAt || null,
            createdAt: d.createdAt || new Date().toISOString()
        }));
        fs.writeFileSync(DOWNLOADS_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        console.error('[TorrentService] Error persisting downloads:', e.message);
    }
}

// Public trackers list for magnet generation
const DEFAULT_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.tracker.cl:1337/announce',
    'udp://9.rarbg.com:2810/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://explodie.org:6969/announce'
];

function buildMagnet(infoHash, name) {
    let magnet = `magnet:?xt=urn:btih:${infoHash}`;
    if (name) magnet += `&dn=${encodeURIComponent(name)}`;
    DEFAULT_TRACKERS.forEach(tr => {
        magnet += `&tr=${encodeURIComponent(tr)}`;
    });
    return magnet;
}

function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(ms) {
    if (!ms || isNaN(ms) || ms === Infinity || ms <= 0) return 'Calculando...';
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${seconds % 60}s`;
    return `${seconds}s`;
}

// HTTP request helper
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const clientLib = url.startsWith('https') ? https : http;
        const req = clientLib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 MatheusFlix/2.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJson(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(12000, () => {
            req.destroy();
            reject(new Error(`Timeout fetching ${url}`));
        });
    });
}

// Jellyfin Library Refresh
async function refreshJellyfinLibrary() {
    console.log('[TorrentService] Triggering Jellyfin library refresh...');
    try {
        const authPayload = JSON.stringify({ Username: JELLYFIN_USER, Pw: JELLYFIN_PW });
        const authRes = await new Promise((resolve) => {
            const req = http.request({
                hostname: 'localhost',
                port: 8096,
                path: '/Users/AuthenticateByName',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Emby-Authorization': 'MediaBrowser Client="MatheusFlix TorrentService", Device="Node", DeviceId="matheusflix_torrent", Version="2.0.0"'
                }
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.write(authPayload);
            req.end();
        });

        const token = authRes?.AccessToken;
        if (!token) {
            console.warn('[TorrentService] Could not authenticate with Jellyfin for library refresh');
            return;
        }

        const refreshReq = http.request({
            hostname: 'localhost',
            port: 8096,
            path: '/Library/Refresh',
            method: 'POST',
            headers: {
                'X-Emby-Token': token
            }
        }, (res) => {
            console.log('[TorrentService] Jellyfin library refresh status:', res.statusCode);
        });
        refreshReq.on('error', (e) => console.warn('[TorrentService] Error requesting library refresh:', e.message));
        refreshReq.end();
    } catch (e) {
        console.error('[TorrentService] Failed to trigger library refresh:', e.message);
    }
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Emby-Token');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost:8085'}`);
    const pathname = urlObj.pathname;

    try {
        // Status endpoint
        if (pathname === '/api/status' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                status: 'online',
                savePath: SAVE_PATH,
                activeTorrents: client.torrents.length,
                totalDownloads: downloadsRegistry.size,
                qbittorrentInstalled: fs.existsSync('C:\\Program Files\\qBittorrent\\qbittorrent.exe')
            }));
            return;
        }

        // Genres endpoint
        if (pathname === '/api/genres' && req.method === 'GET') {
            const genres = getGenresSummary();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ genres }));
            return;
        }

        // AI Movie Search & Semantic Recommendations
        if (pathname === '/api/ai/search' && req.method === 'GET') {
            const query = urlObj.searchParams.get('q') || urlObj.searchParams.get('prompt') || '';
            if (!query) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Query parameter q is required' }));
                return;
            }

            try {
                const movies = await askAiMovieRecommendations(query);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ query, movies }));
            } catch (err) {
                console.error('[TorrentService] AI search error:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        // Unified Movie Catalog Search & Filtering (SQLite backed)
        if (pathname === '/api/movies' && req.method === 'GET') {
            const q = urlObj.searchParams.get('q') || '';
            const genre = urlObj.searchParams.get('genre') || 'all';
            const year = urlObj.searchParams.get('year') || 'all';
            const sort = urlObj.searchParams.get('sort') || 'trending';
            const limit = parseInt(urlObj.searchParams.get('limit'), 10) || 40;
            const offset = parseInt(urlObj.searchParams.get('offset'), 10) || 0;

            const results = searchCatalog({ q, genre, year, sort, limit, offset });

            // If empty and search query provided, try live search
            if (results.movies.length === 0 && q.trim().length > 1) {
                try {
                    const searchUrl = `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`;
                    const cinemeta = await fetchJson(searchUrl);
                    if (cinemeta?.metas && Array.isArray(cinemeta.metas)) {
                        cinemeta.metas.forEach(m => upsertMovie(m));
                        // Re-query
                        const freshResults = searchCatalog({ q, genre, year, sort, limit, offset });
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify(freshResults));
                        return;
                    }
                } catch (e) {
                    // Fall through to existing results
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(results));
            return;
        }

        // Trending Movies (Backward-compatible, powered by SQLite)
        if (pathname === '/api/movies/trending' && req.method === 'GET') {
            const genre = urlObj.searchParams.get('genre') || 'all';
            const year = urlObj.searchParams.get('year') || 'all';
            const sort = urlObj.searchParams.get('sort') || 'trending';

            const results = searchCatalog({ genre, year, sort, limit: 50, offset: 0 });

            // If database still seeding and has few movies, fetch live Cinemeta
            if (results.movies.length < 5) {
                try {
                    const cinemeta = await fetchJson('https://cinemeta-catalogs.strem.io/top/catalog/movie/top.json');
                    const movies = (cinemeta.metas || []).map(m => {
                        upsertMovie(m);
                        return {
                            imdb_id: m.imdb_id,
                            name: m.name,
                            year: m.releaseInfo || m.year,
                            poster: m.poster,
                            description: m.description,
                            genres: m.genres || [],
                            rating: m.imdbRating || (m.popularities?.moviedb ? (m.popularities.moviedb / 10).toFixed(1) : null)
                        };
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ movies }));
                    return;
                } catch (err) {}
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ movies: results.movies }));
            return;
        }

        // Search Movies (FTS5 + Live Fallback)
        if (pathname === '/api/movies/search' && req.method === 'GET') {
            const query = urlObj.searchParams.get('q');
            if (!query) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Query parameter q is required' }));
                return;
            }

            const results = searchCatalog({ q: query, limit: 40 });

            if (results.movies.length < 5) {
                try {
                    const searchUrl = `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(query)}.json`;
                    const cinemeta = await fetchJson(searchUrl);
                    if (cinemeta?.metas) {
                        cinemeta.metas.forEach(m => upsertMovie(m));
                        const fresh = searchCatalog({ q: query, limit: 40 });
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ movies: fresh.movies }));
                        return;
                    }
                } catch (err) {}
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ movies: results.movies }));
            return;
        }

        // Trigger manual catalog sync
        if (pathname === '/api/movies/sync' && req.method === 'POST') {
            seedCatalog(SAVE_PATH).catch(console.error);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Sincronização de catálogo iniciada' }));
            return;
        }

        // Search Torrents for a Movie
        if (pathname === '/api/torrents/search' && req.method === 'GET') {
            const imdb = urlObj.searchParams.get('imdb');
            if (!imdb) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Parameter imdb is required' }));
                return;
            }

            try {
                const [allStreamsRes, ptStreamsRes] = await Promise.allSettled([
                    fetchJson(`https://torrentio.strem.fun/stream/movie/${imdb}.json`),
                    fetchJson(`https://torrentio.strem.fun/language=portuguese/stream/movie/${imdb}.json`)
                ]);

                const streamMap = new Map();

                const processStreams = (streams, isPtSource = false) => {
                    if (!Array.isArray(streams)) return;
                    for (const s of streams) {
                        if (!s.infoHash) continue;
                        const key = s.infoHash.toLowerCase();
                        if (streamMap.has(key)) continue;

                        const fullText = `${s.name || ''} ${s.title || ''}`;
                        const isPt = isPtSource || /dublado|dual|nacional|portuguese|\bpt\b|\bbr\b|🇧🇷|🇵🇹/i.test(fullText);

                        const seedsMatch = s.title?.match(/👤\s*(\d+)/);
                        const seeders = seedsMatch ? parseInt(seedsMatch[1], 10) : 0;

                        const sizeMatch = s.title?.match(/💾\s*([\d\.]+\s*[GMK]B)/i);
                        const size = sizeMatch ? sizeMatch[1] : '';

                        const providerMatch = s.title?.match(/⚙️\s*([^\n\r]+)/);
                        const provider = providerMatch ? providerMatch[1].trim() : 'Torrentio';

                        const firstLine = (s.title || '').split('\n')[0].trim();
                        const filename = s.behaviorHints?.filename || firstLine;

                        let quality = 'HD';
                        if (/4k|2160p/i.test(fullText)) quality = '4K UHD';
                        else if (/1080p/i.test(fullText)) quality = '1080p Full HD';
                        else if (/720p/i.test(fullText)) quality = '720p HD';

                        let audio = 'Original / Legendado';
                        if (/dublado|dual|nacional/i.test(fullText)) {
                            audio = '🇧🇷 Dual Áudio / Dublado';
                        } else if (isPt) {
                            audio = '🇧🇷 Áudio / Legenda PT';
                        }

                        const magnetUri = buildMagnet(key, filename);

                        streamMap.set(key, {
                            infoHash: key,
                            quality,
                            audio,
                            isPortuguese: isPt,
                            seeders,
                            size,
                            provider,
                            filename,
                            magnetUri,
                            rawName: s.name,
                            rawTitle: s.title
                        });
                    }
                };

                if (ptStreamsRes.status === 'fulfilled' && ptStreamsRes.value?.streams) {
                    processStreams(ptStreamsRes.value.streams, true);
                }
                if (allStreamsRes.status === 'fulfilled' && allStreamsRes.value?.streams) {
                    processStreams(allStreamsRes.value.streams, false);
                }

                const torrents = Array.from(streamMap.values()).sort((a, b) => {
                    if (a.isPortuguese && !b.isPortuguese) return -1;
                    if (!a.isPortuguese && b.isPortuguese) return 1;
                    return b.seeders - a.seeders;
                });

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ torrents }));
            } catch (err) {
                console.error('[TorrentService] Torrent search error:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        // List active / completed downloads
        if (pathname === '/api/downloads' && req.method === 'GET') {
            const list = Array.from(downloadsRegistry.values()).map(meta => {
                const torrent = client.get(meta.id);
                if (torrent) {
                    return {
                        id: meta.id,
                        imdbId: meta.imdbId,
                        title: meta.title,
                        quality: meta.quality,
                        name: torrent.name || meta.title,
                        progress: (torrent.progress * 100).toFixed(1),
                        downloadSpeed: formatBytes(torrent.downloadSpeed) + '/s',
                        uploadSpeed: formatBytes(torrent.uploadSpeed) + '/s',
                        downloaded: formatBytes(torrent.downloaded),
                        total: formatBytes(torrent.length),
                        numPeers: torrent.numPeers,
                        timeRemaining: formatTime(torrent.timeRemaining),
                        status: torrent.done ? 'completed' : 'downloading',
                        createdAt: meta.createdAt
                    };
                }
                return {
                    id: meta.id,
                    imdbId: meta.imdbId,
                    title: meta.title,
                    quality: meta.quality,
                    name: meta.title,
                    progress: meta.progress || 100,
                    downloadSpeed: '0 B/s',
                    uploadSpeed: '0 B/s',
                    downloaded: meta.downloaded || 'Concluído',
                    total: meta.total || '',
                    numPeers: 0,
                    timeRemaining: 'Concluído',
                    status: meta.status || 'completed',
                    createdAt: meta.createdAt
                };
            });

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ downloads: list }));
            return;
        }

        // Torrent Streaming Status (Stremio style)
        if (pathname.startsWith('/api/stream/') && pathname.endsWith('/status') && req.method === 'GET') {
            const infoHash = pathname.replace('/api/stream/', '').replace('/status', '').trim().toLowerCase();
            const torrent = client.get(infoHash);
            if (!torrent) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Torrent not active' }));
                return;
            }

            const videoFile = torrent.files?.find(f => /\.(mp4|mkv|webm|avi|mov)$/i.test(f.name)) || torrent.files?.[0];
            const downloadedBytes = torrent.downloaded || 0;
            const canPlay = downloadedBytes > 2 * 1024 * 1024 || torrent.progress > 0.01;

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                ready: torrent.ready,
                name: torrent.name,
                fileName: videoFile?.name || '',
                fileLength: videoFile?.length || 0,
                progress: (torrent.progress * 100).toFixed(1),
                downloadSpeed: formatBytes(torrent.downloadSpeed) + '/s',
                numPeers: torrent.numPeers,
                canPlay,
                downloaded: formatBytes(downloadedBytes),
                total: formatBytes(torrent.length)
            }));
            return;
        }

        // Live Torrent Streaming endpoint (Range / 206 Partial Content)
        if (pathname.startsWith('/api/stream/') && req.method === 'GET') {
            const infoHash = pathname.replace('/api/stream/', '').trim().toLowerCase();
            let torrent = client.get(infoHash);

            if (!torrent) {
                const magnet = urlObj.searchParams.get('magnet');
                const title = urlObj.searchParams.get('title') || 'Streaming Torrent';
                if (!magnet) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Torrent not found. Please provide magnet parameter.' }));
                    return;
                }

                const metaItem = {
                    id: infoHash,
                    title: title,
                    quality: 'Streaming',
                    status: 'downloading',
                    createdAt: new Date().toISOString()
                };
                downloadsRegistry.set(infoHash, metaItem);
                persistDownloads();

                torrent = client.add(magnet, { path: SAVE_PATH });
                torrent.on('done', () => {
                    console.log(`[Streaming] 🎉 Stream completely downloaded: "${torrent.name}"!`);
                    metaItem.status = 'completed';
                    metaItem.progress = 100;
                    persistDownloads();
                    scanLocalMovies(SAVE_PATH);
                    refreshJellyfinLibrary();
                });
            }

            const streamFile = (file) => {
                file.select();

                const total = file.length;
                let contentType = 'video/mp4';
                if (file.name.endsWith('.mkv')) contentType = 'video/x-matroska';
                else if (file.name.endsWith('.webm')) contentType = 'video/webm';

                const range = req.headers.range;
                if (!range) {
                    res.writeHead(200, {
                        'Content-Length': total,
                        'Content-Type': contentType,
                        'Accept-Ranges': 'bytes'
                    });
                    file.createReadStream().pipe(res);
                } else {
                    const parts = range.replace(/bytes=/, '').split('-');
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
                    const chunksize = (end - start) + 1;

                    res.writeHead(206, {
                        'Content-Range': `bytes ${start}-${end}/${total}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunksize,
                        'Content-Type': contentType
                    });
                    file.createReadStream({ start, end }).pipe(res);
                }
            };

            if (torrent.files && torrent.files.length > 0) {
                const videoFile = torrent.files.find(f => /\.(mp4|mkv|webm|avi|mov)$/i.test(f.name)) || torrent.files[0];
                streamFile(videoFile);
            } else {
                torrent.once('ready', () => {
                    const videoFile = torrent.files.find(f => /\.(mp4|mkv|webm|avi|mov)$/i.test(f.name)) || torrent.files[0];
                    streamFile(videoFile);
                });
            }
            return;
        }

        // Start a download
        if (pathname === '/api/downloads/start' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const { magnet, imdbId, title, quality, filename } = data;
                    if (!magnet) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'magnet URL is required' }));
                        return;
                    }

                    const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
                    const infoHash = hashMatch ? hashMatch[1].toLowerCase() : null;

                    if (!infoHash) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid magnet link' }));
                        return;
                    }

                    const existingTorrent = client.get(infoHash);
                    if (existingTorrent) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: 'Download already active', id: infoHash }));
                        return;
                    }

                    console.log(`[TorrentService] Starting download: "${title || filename}" into ${SAVE_PATH}`);

                    const metaItem = {
                        id: infoHash,
                        imdbId: imdbId || '',
                        title: title || filename || 'Filme',
                        quality: quality || '1080p',
                        status: 'downloading',
                        createdAt: new Date().toISOString()
                    };
                    downloadsRegistry.set(infoHash, metaItem);
                    persistDownloads();

                    const torrent = client.add(magnet, { path: SAVE_PATH }, (t) => {
                        console.log(`[TorrentService] Torrent ready: "${t.name}" (${formatBytes(t.length)})`);
                    });

                    torrent.on('done', () => {
                        console.log(`[TorrentService] 🎉 Download COMPLETED: "${torrent.name}"!`);
                        const item = downloadsRegistry.get(infoHash);
                        if (item) {
                            item.status = 'completed';
                            item.progress = 100;
                            item.downloaded = formatBytes(torrent.length);
                            item.total = formatBytes(torrent.length);
                            item.completedAt = new Date().toISOString();
                            persistDownloads();
                        }
                        scanLocalMovies(SAVE_PATH);
                        refreshJellyfinLibrary();
                    });

                    torrent.on('error', (err) => {
                        console.error(`[TorrentService] Torrent error on "${title}":`, err.message);
                        const item = downloadsRegistry.get(infoHash);
                        if (item) {
                            item.status = 'error';
                            persistDownloads();
                        }
                    });

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        success: true,
                        message: 'Download iniciado com sucesso',
                        id: infoHash,
                        title: title || filename
                    }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // Cancel / delete download
        if (pathname.startsWith('/api/downloads/') && req.method === 'DELETE') {
            const id = pathname.replace('/api/downloads/', '').trim().toLowerCase();
            const torrent = client.get(id);
            if (torrent) {
                torrent.destroy(() => {
                    console.log(`[TorrentService] Torrent stopped: ${id}`);
                });
            }
            downloadsRegistry.delete(id);
            persistDownloads();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Download removido' }));
            return;
        }

        // Launch in qBittorrent directly
        if (pathname === '/api/qbittorrent/open' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const { magnet } = data;
                    if (!magnet) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'magnet parameter is required' }));
                        return;
                    }

                    const qbtExe = 'C:\\Program Files\\qBittorrent\\qbittorrent.exe';
                    if (fs.existsSync(qbtExe)) {
                        spawn(qbtExe, [magnet], { detached: true, stdio: 'ignore' }).unref();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Enviado para o qBittorrent com sucesso!' }));
                    } else {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'qBittorrent não encontrado em ' + qbtExe }));
                    }
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // 404 for unknown routes
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    } catch (globalErr) {
        console.error('[TorrentService] Unhandled server error:', globalErr);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: globalErr.message }));
    }
});

server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 MatheusFlix Torrent & Discovery Service iniciado!`);
    console.log(`📡 Porta: http://localhost:${PORT}`);
    console.log(`📁 Pasta de Destino: ${SAVE_PATH}`);
    console.log(`🍿 Jellyfin Server: ${JELLYFIN_URL}`);
    console.log(`=======================================================`);

    // Start background catalog seeding
    seedCatalog(SAVE_PATH).catch(err => {
        console.warn('[TorrentService] Background seeding error:', err.message);
    });
});
