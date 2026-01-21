const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");

// --- KONFIGURÁCIA ---
const SKT_UID = process.env.SKT_UID || "";
const SKT_PASS = process.env.SKT_PASS || ""; 
const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = new addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.2.1",
    name: "SKTorrent",
    description: "Slovenské a české streamy priamo z SKTorrent.eu",
    types: ["movie", "series"],
    resources: ["stream"],
    catalogs: [], // TOTO TU CHÝBALO A SPÔSOBOVALO CHYBU
    idPrefixes: ["tt"]
});

// --- POMOCNÉ FUNKCIE ---
function removeDiacritics(str) {
    return str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";
}

function cleanQuery(str) {
    // Odstráni dvojbodky a prebytočné medzery, ktoré tracker nemá rád
    return str.replace(/[:]/g, "").replace(/\s+/g, " ").trim();
}

async function getMeta(type, imdbId) {
    try {
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
        return res.data && res.data.meta ? res.data.meta : null;
    } catch (e) { 
        console.error("[ERROR] Meta zlyhalo:", e.message);
        return null; 
    }
}

async function searchTorrents(query) {
    const q = cleanQuery(query);
    console.log(`[INFO] 🔎 Hľadám na SKTorrent: '${q}'`);
    try {
        const res = await axios.get(SEARCH_URL, {
            params: { search: q, category: 0 },
            headers: { 
                Cookie: `uid=${SKT_UID.trim()}; pass=${SKT_PASS.trim()};`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000
        });

        if (res.data.includes('name="login"') || res.data.includes('Prihlásenie')) {
            console.error("[ERROR] 🔐 Prihlásenie zlyhalo! Skontroluj UID a PASS v .env");
            return [];
        }

        const $ = cheerio.load(res.data);
        const results = [];

        $('a[href^="details.php?id="]').each((i, el) => {
            const row = $(el).closest("tr");
            const href = $(el).attr("href");
            const id = href.split("id=").pop();
            const name = $(el).attr("title") || $(el).text().trim();
            
            if (!name || results.find(r => r.id === id)) return;

            // Vyťahovanie veľkosti a seedov z tabuľky
            const size = row.find("td").filter((i, td) => /GB|MB/.test($(td).text())).first().text().trim() || "?";
            const seeds = row.find("td").last().prev().text().trim() || "0";

            results.push({ 
                name, 
                id, 
                size, 
                seeds, 
                url: `${BASE_URL}/torrent/download.php?id=${id}` 
            });
        });

        return results;
    } catch (err) { 
        console.error("[ERROR] Search request zlyhal:", err.message);
        return []; 
    }
}

async function getHash(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: { 
                Cookie: `uid=${SKT_UID.trim()}; pass=${SKT_PASS.trim()};`,
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 8000
        });

        if (res.data.slice(0, 100).toString().includes("<html")) return null;

        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        return crypto.createHash("sha1").update(info).digest("hex");
    } catch (e) { 
        return null; 
    }
}

// --- STREAM HANDLER ---
builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(":");
    console.log(`[RAW] Požiadavka: ${type} ${id}`);

    const meta = await getMeta(type, imdbId);
    if (!meta) return { streams: [] };

    const queries = new Set();
    // Pridáme originálny názov
    queries.add(meta.name);
    // Pridáme verziu bez diakritiky (často pomáha na SK trackeroch)
    const cleanName = removeDiacritics(meta.name);
    if (cleanName !== meta.name) queries.add(cleanName);

    let allResults = [];
    for (let q of queries) {
        let searchQuery = q;
        if (type === "series" && season && episode) {
            searchQuery += ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        }
        
        const found = await searchTorrents(searchQuery);
        allResults = [...allResults, ...found];
        
        // Ak sme už niečo našli, nepokračujeme v ďalších pokusoch (šetrí čas)
        if (allResults.length >= 3) break;
    }

    const streams = await Promise.all(allResults.map(async (t) => {
        const infoHash = await getHash(t.url);
        if (!infoHash) return null;
        return {
            title: `${t.name}\n👥 ${t.seeds} | 💾 ${t.size}`,
            infoHash: infoHash,
            name: "SKTorrent"
        };
    }));

    const finalStreams = streams.filter(Boolean);
    console.log(`[INFO] ✅ Odosielam ${finalStreams.length} streamov`);
    return { streams: finalStreams };
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });
console.log(`🚀 SKTorrent addon beží na porte ${port}`);
