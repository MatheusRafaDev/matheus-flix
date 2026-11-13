import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'movies.db');

let db = null;

// Portuguese translation for movie genres
export const GENRE_MAP = {
    'Action': 'Ação',
    'Adventure': 'Aventura',
    'Animation': 'Animação',
    'Comedy': 'Comédia',
    'Crime': 'Crime',
    'Documentary': 'Documentário',
    'Drama': 'Drama',
    'Family': 'Família',
    'Fantasy': 'Fantasia',
    'Horror': 'Terror',
    'Mystery': 'Mistério',
    'Romance': 'Romance',
    'Sci-Fi': 'Ficção Científica',
    'Science Fiction': 'Ficção Científica',
    'Thriller': 'Suspense',
    'War': 'Guerra',
    'Western': 'Faroeste'
};

export const GENRE_LIST = [
    { id: 'all', name: 'Todos', icon: '🔥' },
    { id: 'Action', name: 'Ação', icon: '💥' },
    { id: 'Sci-Fi', name: 'Ficção Científica', icon: '🚀' },
    { id: 'Animation', name: 'Animação', icon: '🎨' },
    { id: 'Comedy', name: 'Comédia', icon: '🤣' },
    { id: 'Horror', name: 'Terror', icon: '👻' },
    { id: 'Adventure', name: 'Aventura', icon: '🏰' },
    { id: 'Thriller', name: 'Suspense', icon: '🕵️' },
    { id: 'Drama', name: 'Drama', icon: '🎭' },
    { id: 'Romance', name: 'Romance', icon: '❤️' },
    { id: 'Crime', name: 'Crime', icon: '🔎' },
    { id: 'Fantasy', name: 'Fantasia', icon: '🧙' },
    { id: 'Family', name: 'Família', icon: '👨‍👩‍👧' },
    { id: 'Western', name: 'Faroeste', icon: '🤠' }
];

export function getDb() {
    if (!db) {
        initDb();
    }
    return db;
}

export function initDb() {
    db = new DatabaseSync(DB_PATH);

    // Create main movies table
    db.exec(`
        CREATE TABLE IF NOT EXISTS movies (
            imdb_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            original_title TEXT,
            year INTEGER,
            release_date TEXT,
            genres TEXT,
            rating REAL,
            votes INTEGER,
            poster TEXT,
            backdrop TEXT,
            description TEXT,
            popularity REAL,
            is_local INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_movies_year ON movies(year DESC);
        CREATE INDEX IF NOT EXISTS idx_movies_rating ON movies(rating DESC);
        CREATE INDEX IF NOT EXISTS idx_movies_genres ON movies(genres);
        CREATE INDEX IF NOT EXISTS idx_movies_pop ON movies(popularity DESC);
        CREATE INDEX IF NOT EXISTS idx_movies_title ON movies(title);
    `);

    // Create Full Text Search (FTS5) table
    try {
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS movies_fts USING fts5(
                imdb_id UNINDEXED,
                title,
                original_title,
                description,
                genres
            );
        `);
    } catch (e) {
        console.warn('[Database] FTS5 initialization warning:', e.message);
    }

    console.log(`[Database] SQLite inicializado com sucesso em "${DB_PATH}"!`);
    return db;
}

export function translateGenres(genresArr) {
    if (!genresArr) return '';
    const list = Array.isArray(genresArr) ? genresArr : String(genresArr).split(/[,\/]/);
    const translated = list.map(g => {
        const trimmed = g.trim();
        return GENRE_MAP[trimmed] || trimmed;
    }).filter(Boolean);
    return [...new Set(translated)].join(', ');
}

export function upsertMovie(movie) {
    if (!movie || !movie.imdb_id) return null;

    const database = getDb();
    const now = new Date().toISOString();

    const title = movie.name || movie.title || '';
    const originalTitle = movie.original_title || '';
    const year = parseInt(movie.releaseInfo || movie.year, 10) || null;
    const releaseDate = movie.release_date || (year ? `${year}-01-01` : null);
    const genres = translateGenres(movie.genres);
    const rating = parseFloat(movie.imdbRating || movie.rating) || null;
    const votes = parseInt(movie.votes, 10) || null;
    const poster = movie.poster || '';
    const backdrop = movie.backdrop || movie.background || '';
    const description = movie.description || movie.overview || '';
    const popularity = parseFloat(movie.popularity || movie.popularities?.moviedb || 0);
    const isLocal = movie.is_local ? 1 : 0;

    const stmt = database.prepare(`
        INSERT INTO movies (
            imdb_id, title, original_title, year, release_date, genres,
            rating, votes, poster, backdrop, description, popularity, is_local,
            created_at, updated_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(imdb_id) DO UPDATE SET
            title = excluded.title,
            original_title = COALESCE(excluded.original_title, movies.original_title),
            year = COALESCE(excluded.year, movies.year),
            release_date = COALESCE(excluded.release_date, movies.release_date),
            genres = CASE WHEN excluded.genres != '' THEN excluded.genres ELSE movies.genres END,
            rating = COALESCE(excluded.rating, movies.rating),
            poster = CASE WHEN excluded.poster != '' THEN excluded.poster ELSE movies.poster END,
            description = CASE WHEN excluded.description != '' THEN excluded.description ELSE movies.description END,
            popularity = CASE WHEN excluded.popularity > 0 THEN excluded.popularity ELSE movies.popularity END,
            is_local = MAX(movies.is_local, excluded.is_local),
            updated_at = excluded.updated_at;
    `);

    stmt.run(
        movie.imdb_id, title, originalTitle, year, releaseDate, genres,
        rating, votes, poster, backdrop, description, popularity, isLocal,
        now, now
    );

    // Update FTS5 index
    try {
        const ftsDel = database.prepare('DELETE FROM movies_fts WHERE imdb_id = ?');
        ftsDel.run(movie.imdb_id);

        const ftsIns = database.prepare('INSERT INTO movies_fts (imdb_id, title, original_title, description, genres) VALUES (?, ?, ?, ?, ?)');
        ftsIns.run(movie.imdb_id, title, originalTitle, description, genres);
    } catch (e) {
        // FTS update failure shouldn't crash
    }

    return movie.imdb_id;
}

export function searchCatalog({ q = '', genre = 'all', year = null, sort = 'trending', limit = 40, offset = 0 } = {}) {
    const database = getDb();
    let whereClauses = [];
    let params = [];

    // Search query
    const cleanQuery = q.trim();
    if (cleanQuery) {
        try {
            // Check if FTS matches anything
            // Format query for prefix matching on each word: "dead*"
            const ftsQuery = cleanQuery.split(/\s+/).filter(Boolean).map(w => `${w.replace(/["'*]/g, '')}*`).join(' ');
            if (ftsQuery) {
                whereClauses.push(`imdb_id IN (SELECT imdb_id FROM movies_fts WHERE movies_fts MATCH ?)`);
                params.push(ftsQuery);
            }
        } catch (e) {
            // Fallback to LIKE
            whereClauses.push(`(title LIKE ? OR original_title LIKE ? OR description LIKE ?)`);
            const likeTerm = `%${cleanQuery}%`;
            params.push(likeTerm, likeTerm, likeTerm);
        }
    }

    // Genre filter
    if (genre && genre !== 'all') {
        const ptGenre = GENRE_MAP[genre] || genre;
        whereClauses.push(`(genres LIKE ? OR genres LIKE ?)`);
        params.push(`%${genre}%`, `%${ptGenre}%`);
    }

    // Year filter
    if (year && year !== 'all') {
        if (year === 'classic') {
            whereClauses.push(`year < 2010`);
        } else {
            const yr = parseInt(year, 10);
            if (!isNaN(yr)) {
                whereClauses.push(`year = ?`);
                params.push(yr);
            }
        }
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Sort order
    let orderSql = 'ORDER BY popularity DESC, year DESC';
    if (sort === 'rating') {
        orderSql = 'ORDER BY rating DESC, votes DESC, year DESC';
    } else if (sort === 'newest') {
        orderSql = 'ORDER BY year DESC, rating DESC';
    } else if (sort === 'alpha') {
        orderSql = 'ORDER BY title ASC';
    }

    // Count query
    const countStmt = database.prepare(`SELECT COUNT(*) as total FROM movies ${whereSql}`);
    const countRow = countStmt.get(...params);
    const total = countRow?.total || 0;

    // Data query
    const queryStmt = database.prepare(`
        SELECT imdb_id, title as name, original_title, year, release_date, genres,
               rating, poster, backdrop, description, popularity, is_local
        FROM movies
        ${whereSql}
        ${orderSql}
        LIMIT ? OFFSET ?
    `);

    const movies = queryStmt.all(...params, limit, offset);

    return {
        movies,
        total,
        limit,
        offset,
        page: Math.floor(offset / limit) + 1
    };
}

export function getGenresSummary() {
    const database = getDb();
    const countTotal = database.prepare('SELECT COUNT(*) as total FROM movies').get()?.total || 0;

    const result = GENRE_LIST.map(g => {
        if (g.id === 'all') {
            return { ...g, count: countTotal };
        }
        const ptGenre = GENRE_MAP[g.id] || g.id;
        const count = database.prepare(`
            SELECT COUNT(*) as cnt FROM movies 
            WHERE genres LIKE ? OR genres LIKE ?
        `).get(`%${g.id}%`, `%${ptGenre}%`)?.cnt || 0;

        return { ...g, count };
    });

    return result;
}

export function markLocalMovies(movieTitles = []) {
    const database = getDb();
    const updateStmt = database.prepare('UPDATE movies SET is_local = 1 WHERE title LIKE ? OR original_title LIKE ?');
    movieTitles.forEach(t => {
        if (t && t.length > 2) {
            try {
                updateStmt.run(`%${t}%`, `%${t}%`);
            } catch (e) {}
        }
    });
}
