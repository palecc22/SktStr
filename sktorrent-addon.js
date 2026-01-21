const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");

// --- KONFIGURÁCIA ---
const SKT_UID = process.env.SKT_UID || "TVOJE_UID";
const SKT_PASS = process.env.SKT_PASS || "TVOJ_PASS_HASH"; // Musí byť hash z cookies!
const BASE_URL = "https://sktorrent.eu";

const manifest = {
    id: "org.sktorrent.stable",
    version: "2.0.0",
    name: "SKTorrent Stable",
    description: "Spoľahlivý scraper pre SKTorrent.eu",
    types: ["movie", "series"],
    resources: ["stream"],
    catalogs: [], // Povinné pre úspešný štart
    idPrefixes: ["tt"]
};

const builder = new addonBuilder(manifest);

// --- POMOCNÉ FUNKCIE ---

// Čistí názvy od diakritiky pre lepšiu kompatibilitu
const slugify = (text) => text ? text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim() : "";

// Získanie metaúdajov zo Stremio (názov filmu)
async function getMeta(type, imdbId) {
    try {
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        return res.data && res.data.meta ? res.data.meta : null;
    } catch (e) { return null; }
}

// Samotné vyhľadávanie na trackeri
async function fetchTorrents(query) {
    console.log(`[INFO] 🔎 Vyhľadávam: "${query}"`);
    try {
        const res = await axios.get(`${BASE_URL}/torrent/torrents_v2.php`, {
            params: { search: query, category: 0 },
            headers: { 
                Cookie: `uid=${SKT_UID.trim()}; pass=${SKT_PASS.trim()};`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
            },
            timeout: 10000
        });

        if (res.data.includes('name="login"')) {
            console.error("[ERROR] 🔐 Neplatné prihlásenie (UID/PASS)!");
            return [];
        }

        const $ = cheerio.load(res.data);
        const results = [];

        // Parsovanie tabuľky torrentov
        $('a[href^="details.php?id="]').each((i, el) => {
            const row = $(el).closest("tr");
            const detailUrl = $(el).attr("href");
            const torrentId = detailUrl.split("id=").pop();
            const name = $(el).attr("title") || $(el).text().trim();

            if (!name || results.find(r => r.id === torrentId)) return;

            // Získanie veľkosti a seedov z buniek tabuľky
            const size = row.find("td").filter((_, td) => /GB|MB/.test($(td).text())).first().text().trim() || "?";
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
    } catch (err) { return []; }
}

// Stiahnutie torrentu a extrakcia InfoHashu
async function extractHash(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: { Cookie: `uid=${SKT_UID.trim()}; pass=${SKT_PASS.trim()};` },
            timeout: 7000
        });

        if (res.data.slice(0, 100).toString().includes("<html")) return null;

        const decoded = bencode.decode(res.data);
        return crypto.createHash("sha1").update(bencode.encode(decoded.info)).digest("hex");
    } catch (e) { return null; }
}

// --- HANDLER PRE STREAMY ---

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(":");
    const meta = await getMeta(type, imdbId);
    
    if (!meta) return { streams: [] };

    let searchQuery = meta.name;
    
    // Pridanie SxxExx pre seriály
    if (type === "series" && season && episode) {
        searchQuery += ` S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
    }

    const foundTorrents = await fetchTorrents(searchQuery);

    const streams = await Promise.all(foundTorrents.map(async (t) => {
        const infoHash = await extractHash(t.downloadUrl);
        if (!infoHash) return null;

        return {
            title: `${t.name}\n👥 Seeds: ${t.seeds} | 💾 Size: ${t.size}`,
            infoHash: infoHash,
            name: "SKTorrent"
        };
    }));

    const finalStreams = streams.filter(Boolean);
    console.log(`[OK] Odosielam ${finalStreams.length} streamov.`);
    return { streams: finalStreams };
});

// --- ŠTART SERVERA ---
const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });
console.log(`🚀 Addon beží na porte ${port}`);
