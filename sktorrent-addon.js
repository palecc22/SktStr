// SKTorrent Stremio addon - Kompletná opravená verzia
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");

const SKT_UID = process.env.SKT_UID || "";
const SKT_PASS = process.env.SKT_PASS || ""; // Tu musí byť HASH z cookies!
const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.1.0",
    name: "SKTorrent",
    description: "Streamuj torrenty z SKTorrent.eu (filmy aj seriály)",
    types: ["movie", "series"],
    catalogs: [],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸", DE: "🇩🇪", FR: "🇫🇷"
};

function removeDiacritics(str) {
    return str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

// Získanie metaúdajov cez Cinémeta (nahrádza IMDb scraping)
async function getMetaFromCinemeta(type, imdbId) {
    try {
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        if (res.data && res.data.meta) {
            console.log(`[DEBUG] 🌝 Názov z Cinémeta: ${res.data.meta.name}`);
            return res.data.meta;
        }
    } catch (err) {
        console.error("[ERROR] Cinémeta zlyhala:", err.message);
    }
    return null;
}

async function searchTorrents(query) {
    console.log(`[INFO] 🔎 Hľadám '${query}' na SKTorrent...`);
    try {
        const session = axios.create({ 
            headers: { 
                Cookie: `uid=${SKT_UID.trim()}; pass=${SKT_PASS.trim()};`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
            } 
        });

        const res = await session.get(SEARCH_URL, { params: { search: query, category: 0 } });
        const $ = cheerio.load(res.data);
        
        // Kontrola prihlásenia
        if (res.data.includes('name="login"') || res.data.includes('Prihlásenie')) {
            console.error("[ERROR] 🔐 SKTorrent vás neprihlásil. Skontrolujte UID a PASS hash!");
            return [];
        }

        const results = [];
        $('a[href^="details.php?id="]').each((i, el) => {
            const href = $(el).attr("href");
            const torrentId = href.split("id=").pop();
            let name = $(el).attr("title") || $(el).text().trim();
            
            if (!name || name.length < 2) return;
            if (results.find(r => r.id === torrentId)) return;

            const row = $(el).closest("tr");
            const size = row.find("td").filter((i, td) => $(td).text().includes("GB") || $(td).text().includes("MB")).first().text().trim() || "?";
            const seeds = row.find("td").last().prev().text().trim() || "0";

            results.push({
                name,
                id: torrentId,
                size,
                seeds,
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });

        return results;
    } catch (err) {
        console.error("[ERROR] Vyhľadávanie zlyhalo:", err.message);
        return [];
    }
}

async function getInfoHashFromTorrent(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${SKT_UID.trim()}; pass=${SKT_PASS.trim()};`,
                Referer: BASE_URL,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (res.data.slice(0, 100).toString().includes("<html")) return null;

        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        return crypto.createHash("sha1").update(info).digest("hex");
    } catch (err) {
        return null;
    }
}

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    const meta = await getMetaFromCinemeta(type, imdbId);
    if (!meta) return { streams: [] };

    const queries = new Set();
    const baseNames = [meta.name]; // Cinémeta vrací lokalizovaný název
    
    baseNames.forEach(name => {
        const noDia = removeDiacritics(name);
        let q = noDia;
        if (type === 'series' && season && episode) {
            const epTag = ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            q += epTag;
        }
        queries.add(q);
        queries.add(shortenTitle(noDia));
    });

    let allTorrents = [];
    for (const q of queries) {
        const found = await searchTorrents(q);
        allTorrents = allTorrents.concat(found);
        if (allTorrents.length > 5) break; 
    }

    const streams = (await Promise.all(allTorrents.map(async (t) => {
        const infoHash = await getInfoHashFromTorrent(t.downloadUrl);
        if (!infoHash) return null;

        return {
            title: `${t.name}\n👤 ${t.seeds} | 📀 ${t.size} | SKTorrent`,
            name: `SKT`,
            infoHash
        };
    }))).filter(Boolean);

    console.log(`[INFO] ✅ Odosielam ${streams.length} streamov`);
    return { streams };
});

serveHTTP(builder.getInterface(), { port: 7000 });
console.log("🚀 SKTorrent addon beží na http://localhost:7000/manifest.json");
