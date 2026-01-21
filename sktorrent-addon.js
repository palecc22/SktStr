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

const builder = addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.2.0",
    name: "SKTorrent",
    description: "Slovenské a české streamy priamo z SKTorrent.eu",
    types: ["movie", "series"],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

// --- POMOCNÉ FUNKCIE ---
function removeDiacritics(str) {
    return str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";
}

function cleanQuery(str) {
    return str.replace(/[:]/g, "").replace(/\s+/g, " ").trim();
}

// Získanie metaúdajov z Cinémeta (vracia aj lokalizované názvy)
async function getMeta(type, imdbId) {
    try {
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        return res.data && res.data.meta ? res.data.meta : null;
    } catch (e) { return null; }
}

// Vyhľadávanie na webe
async function searchTorrents(query) {
    const q = cleanQuery(query);
    console.log(`[INFO] 🔎 Hľadám na SKTorrent: '${q}'`);
    try {
        const res = await axios.get(SEARCH_URL, {
            params: { search: q, category: 0 },
            headers: { 
                Cookie: `uid=${SKT_UID.trim()}; pass=${SKT_PASS.trim()};`,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (res.data.includes('name="login"')) {
            console.error("[ERROR] 🔐 Prihlásenie zlyhalo! Skontroluj PASS v .env");
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

            const size = row.find("td").filter((i, td) => /GB|MB/.test($(td).text())).first().text().trim() || "?";
            const seeds = row.find("td").last().prev().text().trim() || "0";

            results.push({ name, id, size, seeds, url: `${BASE_URL}/torrent/download.php?id=${id}` });
        });

        console.log(`[DEBUG] Found: ${results.length}`);
        return results;
    } catch (err) { return []; }
}

async function getHash(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: { Cookie: `uid=${SKT_UID.trim()}; pass=${SKT_PASS.trim()};` }
        });
        if (res.data.slice(0, 100).toString().includes("<html")) return null;
        const torrent = bencode.decode(res.data);
        return crypto.createHash("sha1").update(bencode.encode(torrent.info)).digest("hex");
    } catch (e) { return null; }
}

// --- STREAM HANDLER ---
builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(":");
    const meta = await getMeta(type, imdbId);
    if (!meta) return { streams: [] };

    const queries = new Set();
    // Pridáme originálny názov aj lokalizovaný názov (Cinémeta ho často má v 'name')
    queries.add(meta.name);
    if (meta.name !== removeDiacritics(meta.name)) queries.add(removeDiacritics(meta.name));

    let allResults = [];
    for (let q of queries) {
        let searchQuery = q;
        if (type === "series") searchQuery += ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        
        const found = await searchTorrents(searchQuery);
        allResults = [...allResults, ...found];
        if (allResults.length > 2) break;
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

    return { streams: streams.filter(Boolean) };
});

serveHTTP(builder.getInterface(), { port: 7000 });
