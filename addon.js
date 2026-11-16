// addon.js
const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";
const STREMIO_PAGE_SIZE = 40;

// --- 1. MARVEL MOVIE FRANCHISE DEFINITIONS ---
const MARVEL_MOVIE_CONFIG = {
  "X-Men": {
    collectionQueries: [
      "X-Men Collection",
      "Deadpool Collection",
      "The Wolverine Collection"
    ],
    keywordQueries: ["x-men", "wolverine", "deadpool"],
    searchQueries: ["X-Men", "Wolverine", "Logan", "Deadpool", "The New Mutants"],
    titleAllowRegex:
      /^x-men|^x2\b|wolverine|logan|deadpool|new mutants/i
  },
  "Avengers": {
    collectionQueries: ["The Avengers Collection"],
    keywordQueries: ["avengers"],
    searchQueries: ["The Avengers", "Avengers", "Captain America: Civil War"],
    titleAllowRegex: /avengers|captain america: civil war/i
  },
  "Thor": {
    collectionQueries: ["Thor Collection"],
    keywordQueries: ["thor"],
    searchQueries: [
      "Thor",
      "Thor: The Dark World",
      "Thor: Ragnarok",
      "Thor: Love and Thunder"
    ],
    titleAllowRegex: /^thor\b|thor:/i
  },
  "Dr. Strange": {
    collectionQueries: ["Doctor Strange Collection"],
    keywordQueries: ["doctor strange"],
    searchQueries: [
      "Doctor Strange",
      "Doctor Strange in the Multiverse of Madness"
    ],
    titleAllowRegex: /doctor strange|dr\. strange/i
  },
  "Guardians of the Galaxy": {
    collectionQueries: ["Guardians of the Galaxy Collection"],
    keywordQueries: ["guardians of the galaxy"],
    searchQueries: ["Guardians of the Galaxy"],
    titleAllowRegex: /guardians of the galaxy/i
  },
  "Black Panther": {
    collectionQueries: ["Black Panther Collection"],
    keywordQueries: ["black panther"],
    searchQueries: ["Black Panther", "Black Panther: Wakanda Forever"],
    titleAllowRegex: /black panther/i
  },
  "Blade": {
    collectionQueries: ["Blade Collection"],
    keywordQueries: ["blade"],
    searchQueries: ["Blade", "Blade II", "Blade: Trinity"],
    titleAllowRegex: /^blade\b|blade ii|blade: trinity/i
  },
  "SpiderMan": {
    collectionQueries: [
      "Spider-Man Collection",
      "The Amazing Spider-Man Collection",
      "Spider-Man (Avengers) Collection",
      "Spider-Verse Collection"
    ],
    keywordQueries: ["spider-man", "miles morales"],
    searchQueries: ["Spider-Man", "Spider-Verse"],
    titleAllowRegex: /spider-man|spider-verse/i
  },
  "Venom": {
    collectionQueries: ["Venom Collection"],
    keywordQueries: ["venom"],
    searchQueries: [
      "Venom",
      "Venom: Let There Be Carnage",
      "Venom: The Last Dance"
    ],
    titleAllowRegex: /^venom\b|venom:/i
  }
};

const MARVEL_MOVIE_GENRES = Object.keys(MARVEL_MOVIE_CONFIG);

// --- 2. ADDON MANIFEST ---
const manifest = {
  id: "community.marvel.universe.v1",
  version: "1.0.0",
  name: "Marvel Universe Cinema & Series",
  description:
    "Dynamic Marvel movies and series organized by hero and team franchise, powered by TMDB.",
  resources: ["catalog"],
  types: ["movie"],
  catalogs: [
    {
      type: "movie",
      id: "marvel_movies",
      name: "Marvel",
      extra: [
        { name: "genre", options: MARVEL_MOVIE_GENRES, isRequired: false },
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    }
  ],
  idPrefixes: ["tt"]
};

const builder = new addonBuilder(manifest);

// --- 3. CACHES & DIAGNOSTIC STATS ---
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const keywordIdCache = new Map();
const collectionCache = new Map();
const externalIdCache = new Map();
const pageCache = new Map();
const stats = {
  startedAt: new Date().toISOString(),
  tmdbKeyConfigured: Boolean(TMDB_API_KEY),
  requestsServed: 0,
  recentRequests: [],
  lastErrors: []
};

function recordError(msg) {
  stats.lastErrors.unshift({ time: new Date().toISOString(), message: msg });
  if (stats.lastErrors.length > 15) stats.lastErrors.pop();
}

async function tmdbFetch(path, params = {}) {
  if (!TMDB_API_KEY) {
    recordError("TMDB_API_KEY environment variable is missing.");
    return null;
  }
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      recordError(`TMDB ${path} returned HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    recordError(`TMDB ${path} network error: ${err.message}`);
    return null;
  }
}

async function resolveKeywordIds(phrases) {
  const ids = new Set();
  await Promise.all(
    phrases.map(async (phrase) => {
      const key = phrase.toLowerCase().trim();
      if (keywordIdCache.has(key)) {
        keywordIdCache.get(key).forEach((id) => ids.add(id));
        return;
      }
      const data = await tmdbFetch("/search/keyword", { query: key });
      const matched = (data?.results || [])
        .filter((r) => r.name.toLowerCase() === key || r.name.toLowerCase().includes(key))
        .slice(0, 2)
        .map((r) => r.id);

      keywordIdCache.set(key, matched);
      matched.forEach((id) => ids.add(id));
    })
  );
  return Array.from(ids);
}

async function fetchCollectionParts(collectionQueries) {
  const parts = [];
  await Promise.all(
    collectionQueries.map(async (query) => {
      const key = query.toLowerCase().trim();
      if (collectionCache.has(key)) {
        parts.push(...collectionCache.get(key));
        return;
      }
      const searchData = await tmdbFetch("/search/collection", { query });
      const topCollections = (searchData?.results || []).slice(0, 2);
      const fetchedParts = [];

      for (const col of topCollections) {
        const colDetails = await tmdbFetch(`/collection/${col.id}`);
        if (Array.isArray(colDetails?.parts)) {
          fetchedParts.push(...colDetails.parts);
        }
      }

      collectionCache.set(key, fetchedParts);
      parts.push(...fetchedParts);
    })
  );
  return parts;
}

async function resolveImdbId(tmdbType, tmdbId) {
  const cacheKey = `${tmdbType}:${tmdbId}`;
  if (externalIdCache.has(cacheKey)) return externalIdCache.get(cacheKey);

  const data = await tmdbFetch(`/${tmdbType}/${tmdbId}/external_ids`);
  const imdbId = data?.imdb_id && data.imdb_id.startsWith("tt") ? data.imdb_id : null;
  externalIdCache.set(cacheKey, imdbId);
  return imdbId;
}

async function hydrateTmdbResults(rawItems, stremioType, genreLabel) {
  const tmdbType = stremioType === "series" ? "tv" : "movie";
  const validItems = rawItems.filter((item) => item && item.id && item.poster_path);
  const metas = [];
  const BATCH_SIZE = 15;

  for (let i = 0; i < validItems.length; i += BATCH_SIZE) {
    const batch = validItems.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        const imdbId = await resolveImdbId(tmdbType, item.id);
        if (!imdbId) return null;

        const title = item.title || item.name || "Untitled";
        const dateStr = item.release_date || item.first_air_date || "";
        const year = dateStr ? dateStr.slice(0, 4) : "";

        return {
          id: imdbId,
          type: stremioType,
          name: title,
          poster: `${TMDB_IMG_BASE}${item.poster_path}`,
          posterShape: "regular",
          releaseInfo: year,
          description: item.overview || "",
          genres: genreLabel ? [genreLabel] : []
        };
      })
    );
    metas.push(...batchResults);
  }

  const deduped = new Map();
  for (const m of metas) {
    if (m && !deduped.has(m.id)) deduped.set(m.id, m);
  }
  return Array.from(deduped.values());
}

// --- 4. MARVEL MOVIES ENGINE ---
async function fetchMarvelMoviesSlice(genreName, skip = 0) {
  const cacheKey = `marvel_movies:${genreName || "ALL"}`;
  const cached = pageCache.get(cacheKey);
  let allMetas = null;

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    allMetas = cached.metas;
  } else {
    const configsToRun =
      genreName && MARVEL_MOVIE_CONFIG[genreName]
        ? [MARVEL_MOVIE_CONFIG[genreName]]
        : Object.values(MARVEL_MOVIE_CONFIG);

    const allCollectionQueries = configsToRun.flatMap((c) => c.collectionQueries || []);
    const collectionItems = await fetchCollectionParts(allCollectionQueries);

    let extraItems = [];
    if (genreName && MARVEL_MOVIE_CONFIG[genreName]) {
      const cfg = MARVEL_MOVIE_CONFIG[genreName];
      const [marvelBaseIds, franchiseIds] = await Promise.all([
        resolveKeywordIds(["marvel cinematic universe", "marvel comics", "based on comic"]),
        resolveKeywordIds(cfg.keywordQueries || [])
      ]);

      const withKeywords =
        marvelBaseIds.length && franchiseIds.length
          ? `${marvelBaseIds.join("|")},${franchiseIds.join("|")}`
          : franchiseIds.join("|");

      const [discoverRes, ...searchResponses] = await Promise.all([
        withKeywords
          ? tmdbFetch("/discover/movie", {
              sort_by: "primary_release_date.asc",
              include_adult: "false",
              with_keywords: withKeywords,
              page: 1
            })
          : Promise.resolve(null),
        ...(cfg.searchQueries || []).map((q) =>
          tmdbFetch("/search/movie", { query: q, include_adult: "false", page: 1 })
        )
      ]);

      const candidateItems = [
        ...(discoverRes?.results || []),
        ...searchResponses.flatMap((r) => (r?.results || []).slice(0, 6))
      ];

      extraItems = candidateItems.filter((item) => {
        const title = item?.title || "";
        return cfg.titleAllowRegex ? cfg.titleAllowRegex.test(title) : true;
      });
    }

    const hydrated = await hydrateTmdbResults(
      [...collectionItems, ...extraItems],
      "movie",
      genreName
    );

    // Order chronologically by release year
    hydrated.sort((a, b) =>
      (a.releaseInfo || "9999").localeCompare(b.releaseInfo || "9999")
    );

    allMetas = hydrated;
    if (allMetas.length > 0) {
      pageCache.set(cacheKey, { metas: allMetas, timestamp: Date.now() });
    }
  }

  return allMetas.slice(skip, skip + STREMIO_PAGE_SIZE);
}

async function resolveCatalogRequest({ type, id, extra }) {
  if (id !== "marvel_movies") {
    return { metas: [] };
  }

  const skip = parseInt(extra?.skip || 0, 10);
  const genre = extra?.genre && extra.genre !== "None" ? extra.genre : null;

  if (extra?.search) {
    const page = Math.floor(skip / 20) + 1;
    const searchRes = await tmdbFetch("/search/movie", {
      query: extra.search,
      include_adult: "false",
      page
    });
    const metas = await hydrateTmdbResults(searchRes?.results || [], type, genre);
    return { metas };
  }

  const metas = await fetchMarvelMoviesSlice(genre, skip);
  return { metas };
}

// --- 5. SDK & EXPRESS SERVER ROUTES ---
builder.defineCatalogHandler(async (args) => resolveCatalogRequest(args));

const app = express();
const PORT = process.env.PORT || 7000;

function parseExtraSegment(rawSegment) {
  const extra = {};
  if (!rawSegment) return extra;
  const decoded = decodeURIComponent(rawSegment);
  for (const pair of decoded.split("&")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, " "));
      const val = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, " "));
      extra[key] = val;
    }
  }
  return extra;
}

app.get("/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    version: manifest.version,
    marvelMovieCategories: MARVEL_MOVIE_GENRES,
    cachedPages: pageCache.size,
    resolvedKeywordsCount: keywordIdCache.size,
    ...stats
  });
});

app.get("/manifest.json", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.json(manifest);
});

app.get(["/catalog/:type/:id.json", "/catalog/:type/:id/:extra.json"], async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  const { type, id } = req.params;
  const extra = parseExtraSegment(req.params.extra);
  if (req.query.genre && !extra.genre) extra.genre = String(req.query.genre);
  if (req.query.search && !extra.search) extra.search = String(req.query.search);
  if (req.query.skip && !extra.skip) extra.skip = String(req.query.skip);

  const result = await resolveCatalogRequest({ type, id, extra });

  stats.requestsServed++;
  stats.recentRequests.unshift({
    time: new Date().toISOString(),
    rawUrl: req.originalUrl,
    parsedType: type,
    parsedGenre: extra.genre || null,
    count: result.metas.length,
    firstTitle: result.metas[0]?.name || null
  });
  if (stats.recentRequests.length > 20) stats.recentRequests.pop();

  res.json(result);
});

app.use(getRouter(builder.getInterface()));

async function warmInitialPages() {
  if (!TMDB_API_KEY) return;
  try {
    await fetchMarvelMoviesSlice(null, 0);
    for (const g of MARVEL_MOVIE_GENRES) {
      await fetchMarvelMoviesSlice(g, 0);
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (_) {
    // On-demand requests will retry if warm-up hits a transient error
  }
}

app.listen(PORT, () => {
  console.log(`Marvel Stremio Addon v${manifest.version} running on port ${PORT}`);
  setTimeout(warmInitialPages, 2000);
});