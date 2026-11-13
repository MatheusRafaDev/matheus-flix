import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { upsertMovie, getDb, translateGenres } from './db.js';

let localCache = null;
let lastScanTime = 0;

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 MatheusFlix/2.0' } }, (res) => {
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
        req.setTimeout(8000, () => {
            req.destroy();
            reject(new Error(`Timeout fetching ${url}`));
        });
    });
}

export function cleanMovieName(raw) {
    const yearMatch = raw.match(/\b(19\d\d|20\d\d)\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

    let name = raw.replace(/\.(mkv|mp4|avi|ts|mov)$/i, '');
    name = name.replace(/\[ACESSE\.\.\.[^\]]+\]/gi, '');
    name = name.replace(/\((19\d\d|20\d\d)\)/g, '');
    name = name.replace(/\b(19\d\d|20\d\d)\b.*/, '');
    name = name.replace(/(\.|\_)/g, ' ');
    name = name.replace(/\[[^\]]+\]/g, ' ');
    name = name.replace(/\b(1080p|720p|2160p|4k|bluray|bdrip|web-dl|webrip|dual|dublado|nacional|ac3|aac|x264|x265|hevc|h264|imax|open matte|fullhd|ch|edition|proper|remux|dts-hd|ma|5\.1|7\.1)\b.*/i, '');
    name = name.replace(/[\(\)\[\]\-]/g, ' ');
    // Remove trailing "1" if like "Carros 1", "Toy Story 1"
    name = name.replace(/\b([A-Za-z]+)\s+1\b/i, '$1');
    name = name.replace(/\s+/g, ' ').trim();

    return { title: name, year };
}

export function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function getLocalLibrary(savePath = 'D:\\filmes', force = false) {
    const now = Date.now();
    if (!force && localCache && (now - lastScanTime < 60000)) {
        return localCache;
    }

    if (!fs.existsSync(savePath)) {
        return [];
    }

    const db = getDb();
    const results = [];
    const entries = fs.readdirSync(savePath, { withFileTypes: true });

    for (const entry of entries) {
        const fullItemPath = path.join(savePath, entry.name);
        let videoFile = null;
        let srtFile = null;
        let stat = null;
        let folderName = '';

        if (entry.isDirectory()) {
            folderName = entry.name;
            try {
                const sub = fs.readdirSync(fullItemPath, { withFileTypes: true });
                const v = sub.find(f => f.isFile() && /\.(mp4|mkv|avi|webm|ts)$/i.test(f.name));
                const s = sub.find(f => f.isFile() && /\.(srt|vtt)$/i.test(f.name));
                if (v) {
                    videoFile = path.join(fullItemPath, v.name);
                    stat = fs.statSync(videoFile);
                }
                if (s) {
                    srtFile = path.join(fullItemPath, s.name);
                }
            } catch (e) {}
        } else if (entry.isFile() && /\.(mp4|mkv|avi|webm|ts)$/i.test(entry.name)) {
            videoFile = fullItemPath;
            try {
                stat = fs.statSync(videoFile);
            } catch (e) {}
        }

        if (!videoFile || !stat) continue;

        const rawName = folderName || entry.name;
        const { title: cleanName, year: detectedYear } = cleanMovieName(rawName);
        if (cleanName.length < 2) continue;

        let movieData = null;

        // Query Cinemeta with clean title
        try {
            const searchRes = await fetchJson(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(cleanName)}.json`);
            if (searchRes?.metas && searchRes.metas.length > 0) {
                // If year detected, find matching year meta, else fallback to top
                let match = searchRes.metas[0];
                if (detectedYear) {
                    const yearMatch = searchRes.metas.find(m => {
                        const mYear = parseInt(m.releaseInfo || m.year, 10);
                        return mYear === detectedYear || Math.abs(mYear - detectedYear) <= 1;
                    });
                    if (yearMatch) match = yearMatch;
                }

                match.is_local = 1;
                upsertMovie(match);

                movieData = {
                    imdb_id: match.imdb_id,
                    title: cleanName.length > 3 ? cleanName : match.name,
                    original_title: match.name,
                    year: parseInt(match.releaseInfo || match.year, 10) || detectedYear,
                    genres: translateGenres(match.genres),
                    rating: parseFloat(match.imdbRating) || 8.0,
                    poster: match.poster || '',
                    backdrop: match.background || match.backdrop || '',
                    description: match.description || 'Filme salvo na sua biblioteca local D:\\filmes.'
                };
            }
        } catch (err) {}

        // Fallback to SQLite DB if Cinemeta search failed or was rate-limited
        if (!movieData) {
            try {
                const row = db.prepare(`
                    SELECT * FROM movies 
                    WHERE (title LIKE ? OR original_title LIKE ?) 
                    LIMIT 1
                `).get(`%${cleanName}%`, `%${cleanName}%`);

                if (row) {
                    movieData = {
                        imdb_id: row.imdb_id,
                        title: cleanName,
                        original_title: row.original_title,
                        year: row.year || detectedYear,
                        genres: row.genres,
                        rating: row.rating,
                        poster: row.poster,
                        backdrop: row.backdrop,
                        description: row.description
                    };
                }
            } catch (e) {}
        }

        // Quality detection from filename/folder
        let quality = '1080p';
        if (/2160p|4k/i.test(rawName)) quality = '4K Ultra HD';
        else if (/720p/i.test(rawName)) quality = '720p HD';
        else if (/bluray|bdrip/i.test(rawName)) quality = '1080p BluRay';
        else if (/web-dl|webrip/i.test(rawName)) quality = '1080p WEB-DL';

        const ext = path.extname(videoFile).replace('.', '').toUpperCase();

        results.push({
            id: movieData?.imdb_id || `local_${encodeURIComponent(cleanName)}`,
            imdbId: movieData?.imdb_id || '',
            title: movieData?.title || cleanName,
            originalTitle: movieData?.original_title || cleanName,
            cleanName,
            rawName,
            year: movieData?.year || detectedYear || '',
            poster: movieData?.poster || '',
            backdrop: movieData?.backdrop || '',
            description: movieData?.description || 'Filme salvo na sua pasta local D:\\filmes.',
            genres: movieData?.genres || 'Cinema',
            rating: movieData?.rating ? Number(movieData.rating).toFixed(1) : '8.0',
            quality,
            format: ext,
            sizeBytes: stat.size,
            sizeFormatted: formatBytes(stat.size),
            videoPath: videoFile,
            srtPath: srtFile,
            streamUrl: `/api/local/stream?file=${encodeURIComponent(videoFile)}`,
            hasSubtitle: !!srtFile,
            isLocal: true,
            folderName
        });
    }

    // Sort alphabetically by title
    results.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));

    localCache = results;
    lastScanTime = now;
    return results;
}

export function streamLocalVideo(filePath, req, res) {
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Local file not found' }));
        return;
    }

    const stat = fs.statSync(filePath);
    const total = stat.size;

    let contentType = 'video/mp4';
    if (filePath.endsWith('.mkv')) contentType = 'video/x-matroska';
    else if (filePath.endsWith('.webm')) contentType = 'video/webm';
    else if (filePath.endsWith('.avi')) contentType = 'video/x-msvideo';

    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, {
            'Content-Length': total,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(filePath).pipe(res);
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
        fs.createReadStream(filePath, { start, end }).pipe(res);
    }
}
