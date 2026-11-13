import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { upsertMovie, markLocalMovies, getDb } from './db.js';

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
        req.setTimeout(12000, () => {
            req.destroy();
            reject(new Error(`Timeout fetching ${url}`));
        });
    });
}

const SEED_GENRES = [
    'Action',
    'Sci-Fi',
    'Animation',
    'Comedy',
    'Horror',
    'Adventure',
    'Thriller',
    'Drama',
    'Romance',
    'Crime',
    'Fantasy',
    'Family',
    'Western'
];

export async function seedCatalog(savePath = 'D:\\filmes') {
    const db = getDb();
    const currentCount = db.prepare('SELECT COUNT(*) as count FROM movies').get()?.count || 0;
    console.log(`[Seeder] Catálogo inicial contém ${currentCount} filmes.`);

    // 1. Fetch general top trending movies
    try {
        console.log('[Seeder] Baixando lançamentos e filmes em alta...');
        const topData = await fetchJson('https://cinemeta-catalogs.strem.io/top/catalog/movie/top.json');
        if (topData?.metas) {
            topData.metas.forEach(m => upsertMovie(m));
            console.log(`[Seeder] Inseridos ${topData.metas.length} filmes em alta.`);
        }
    } catch (e) {
        console.warn('[Seeder] Erro ao buscar filmes em alta:', e.message);
    }

    // 2. Fetch each genre in sequence
    for (const genre of SEED_GENRES) {
        try {
            const url = `https://cinemeta-catalogs.strem.io/top/catalog/movie/top/genre=${genre}.json`;
            const data = await fetchJson(url);
            if (data?.metas && Array.isArray(data.metas)) {
                let inserted = 0;
                data.metas.forEach(m => {
                    if (m && m.imdb_id) {
                        upsertMovie(m);
                        inserted++;
                    }
                });
                console.log(`[Seeder] Gênero "${genre}": ${inserted} filmes sincronizados no banco.`);
            }
        } catch (err) {
            console.warn(`[Seeder] Falha ao sincronizar gênero ${genre}:`, err.message);
        }
        await new Promise(r => setTimeout(r, 350));
    }

    // 3. Scan and enrich local movies
    await scanLocalMovies(savePath);

    const finalCount = db.prepare('SELECT COUNT(*) as count FROM movies').get()?.count || 0;
    console.log(`[Seeder] 🎉 Catálogo do MatheusFlix atualizado! Total: ${finalCount} filmes indexados.`);
}

export async function scanLocalMovies(savePath = 'D:\\filmes') {
    try {
        if (!fs.existsSync(savePath)) return;
        const entries = fs.readdirSync(savePath, { withFileTypes: true });

        for (const entry of entries) {
            const name = entry.name;

            // Clean filename
            const clean = name
                .replace(/\.(mkv|mp4|avi|ts|mov)$/i, '')
                .replace(/(\.|\_|\-)/g, ' ')
                .replace(/\[[^\]]+\]/g, ' ')
                .replace(/\b(1080p|720p|2160p|4k|bluray|bdrip|web-dl|webrip|dual|dublado|nacional|ac3|aac|x264|x265|hevc|h264|imax|open matte|fullhd|ch|edition|proper)\b.*/i, '')
                .replace(/\b(19\d\d|20\d\d)\b.*/i, '')
                .replace(/\(\d{4}\)/g, '')
                .trim();

            if (clean.length < 2) continue;

            // Search Cinemeta for metadata
            try {
                const searchRes = await fetchJson(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(clean)}.json`);
                if (searchRes?.metas && searchRes.metas.length > 0) {
                    const topMatch = searchRes.metas[0];
                    topMatch.is_local = 1;
                    upsertMovie(topMatch);
                    console.log(`[Seeder] ✅ Local catalogado: "${clean}" -> "${topMatch.name}" (${topMatch.imdb_id})`);
                }
            } catch (err) {}
            await new Promise(r => setTimeout(r, 200));
        }
    } catch (e) {
        console.warn('[Seeder] Erro ao varrer pasta local:', e.message);
    }
}
