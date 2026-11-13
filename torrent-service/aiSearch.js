import https from 'https';
import http from 'http';
import { getDb, upsertMovie, searchCatalog } from './db.js';

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
                    resolve(data);
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

export async function askAiMovieRecommendations(userPrompt) {
    const promptText = `Voce e o MatheusFlix AI, um recomendador de filmes genial. O usuario pediu: "${userPrompt}". Recomende exatamente 4 filmes incriveis que combinem com esse gosto ou tema. Retorne em formato JSON valido contendo uma lista: [{"title":"Nome do Filme","year":2014,"reason":"Por que voce vai amar esse filme"}]. Responda APENAS o JSON.`;

    const encoded = encodeURIComponent(promptText);
    const aiUrl = `https://text.pollinations.ai/${encoded}?model=openai&json=true`;

    let rawList = [];

    try {
        console.log(`[AI] Consultando IA para: "${userPrompt}"...`);
        let rawRes = await fetchJson(aiUrl);
        if (typeof rawRes === 'string') {
            const startIdx = rawRes.indexOf('[');
            const endIdx = rawRes.lastIndexOf(']');
            if (startIdx !== -1 && endIdx !== -1) {
                rawRes = JSON.parse(rawRes.slice(startIdx, endIdx + 1));
            } else {
                const oStart = rawRes.indexOf('{');
                const oEnd = rawRes.lastIndexOf('}');
                if (oStart !== -1 && oEnd !== -1) {
                    rawRes = JSON.parse(rawRes.slice(oStart, oEnd + 1));
                }
            }
        }

        if (Array.isArray(rawRes)) {
            rawList = rawRes;
        } else if (rawRes && typeof rawRes === 'object') {
            if (Array.isArray(rawRes.movies)) rawList = rawRes.movies;
            else if (Array.isArray(rawRes.recommendations)) rawList = rawRes.recommendations;
            else rawList = [rawRes];
        }
    } catch (e) {
        console.warn('[AI] Falha na IA online, usando recomendacao semantica:', e.message);
    }

    if (rawList.length === 0) {
        rawList = fallbackLocalSearch(userPrompt);
    }

    // Enrich each movie with database/Cinemeta metadata
    const enriched = [];
    const db = getDb();

    for (const item of rawList) {
        const title = item.title || item.name;
        if (!title) continue;

        // 1. Try SQLite database first
        let match = db.prepare(`
            SELECT imdb_id, title as name, original_title, year, genres, rating, poster, backdrop, description, is_local
            FROM movies
            WHERE title LIKE ? OR original_title LIKE ?
            LIMIT 1
        `).get(`%${title}%`, `%${title}%`);

        // 2. If not in DB, query Cinemeta
        if (!match) {
            try {
                const searchRes = await fetchJson(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(title)}.json`);
                if (searchRes?.metas && searchRes.metas.length > 0) {
                    const top = searchRes.metas[0];
                    upsertMovie(top);
                    match = {
                        imdb_id: top.imdb_id,
                        name: top.name,
                        year: top.releaseInfo || top.year,
                        genres: top.genres || '',
                        rating: top.imdbRating || 8.0,
                        poster: top.poster,
                        description: top.description,
                        is_local: 0
                    };
                }
            } catch (err) {}
        }

        if (match) {
            enriched.push({
                ...match,
                aiReason: item.reason || 'Recomendado pela IA com base nas suas preferências.'
            });
        } else {
            // Keep with placeholder
            enriched.push({
                imdb_id: `ai_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                name: title,
                year: item.year || 'N/A',
                genres: 'Recomendação IA',
                rating: 8.5,
                poster: 'https://via.placeholder.com/300x450/111318/ffffff?text=' + encodeURIComponent(title),
                description: item.reason || '',
                is_local: 0,
                aiReason: item.reason || 'Recomendado pela inteligência artificial.'
            });
        }
    }

    console.log(`[AI] Retornando ${enriched.length} filmes enriquecidos para o usuário.`);
    return enriched;
}

function fallbackLocalSearch(userPrompt) {
    const lower = userPrompt.toLowerCase();
    let genre = 'all';
    if (/ação|tiro|luta/i.test(lower)) genre = 'Action';
    else if (/ficção|espaço|viagem no tempo|futuro/i.test(lower)) genre = 'Sci-Fi';
    else if (/comédia|engraçado|rir/i.test(lower)) genre = 'Comedy';
    else if (/terror|medo|susto/i.test(lower)) genre = 'Horror';
    else if (/animação|desenho|criança/i.test(lower)) genre = 'Animation';

    const results = searchCatalog({ genre, limit: 4 });
    return results.movies.map(m => ({
        title: m.name,
        year: m.year,
        reason: `Excelente combinação encontrada no acervo com nota ${m.rating || 8.0}⭐ no IMDb.`
    }));
}
