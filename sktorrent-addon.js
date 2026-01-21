// SKTorrent Stremio addon - Opravená verzia
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");

// --- KONFIGURÁCIA ---
const SKT_UID = process.env.SKT_UID || "";
const SKT_PASS = process.env.SKT_PASS || "";

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

// Spoločné hlavičky, aby nás servery neblokovali ako botov
const COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "sk-SK,sk;q=0.9,cs;q=0.8,en-US;q=0.7,en;q=0.6"
};

const builder = addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.0.1",
    name: "SKTorrent",
    description: "Streamuj torrenty z SKTorrent.eu (Opravená verzia)",
    types: ["movie", "series"],
    catalogs: [],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸", DE: "🇩🇪", FR: "🇫🇷"
};

// --- POMOCNÉ FUNKCIE ---

function removeDiacritics(str) {
    if (!str) return "";
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

async function getTitleFromIMDb(imdbId) {
    try {
        const res = await axios.get(`https://www.imdb.com/title/${imdbId}/`, { headers: COMMON_HEADERS });
        const $ = cheerio.load(res.data);
        
        // Získanie názvu z title tagu alebo ld+json
        let title = $('title').text().split(' (')[0].replace(' - IMDb', '').trim();
        let originalTitle = title;

        const ldJsonText = $('script[type="application/ld+json"]').html();
        if (ldJsonText) {
            const json = JSON.parse(ldJsonText);
            if (json.name) originalTitle = json.name;
        }

        console.log(`[DEBUG] 🌝 IMDb Názvy: "${title}" / "${originalTitle}"`);
        return { title: decode(title), originalTitle: decode(originalTitle) };
    } catch (err) {
        console.error("[ERROR] IMDb scraping zlyhal (pravdepodobne blokovanie):", err.message);
        return null;
    }
}

async function searchTorrents(query) {
    // POISTKA: Ak je query prázdne, SKTorrent vráti "posledné pridané", čo nechceme
    if (!query || query.trim().length < 2) return [];

    console.log(`[INFO] 🔎 Hľadám na SKTorrent: '${query}'`);
    try {
        const session = axios.create({ 
            headers: { 
                ...COMMON_HEADERS,
                Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}` 
            } 
        });
        const res = await session.get(SEARCH_URL, { params: { search: query, category: 0 } });
        const $ = cheerio.load(res.data);
        const results = [];

        $('a[href^="details.php"] img').each((i, img) => {
            const parent = $(img).closest("a");
            const outerTd = parent.closest("td");
            const fullBlock = outerTd.text().replace(/\s+/g, ' ').trim();
            const href = parent.attr("href") || "";
            const titleAttr = parent.attr("title") || "";
            const torrentId = href.split("id=").pop();
            const category = outerTd.find("b").first().text().trim();
            
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);
            
            if (!category.toLowerCase().includes("film") && !category.toLowerCase().includes("seri")) return;

            results.push({
                name: titleAttr,
                id: torrentId,
                size: sizeMatch ? sizeMatch[1].trim() : "?",
                seeds: seedMatch ? seedMatch[1] : "0",
                category,
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
                ...COMMON_HEADERS,
                Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}`,
                Referer: BASE_URL
            }
        });

        // Kontrola, či sme nedostali HTML (napr. login screen) namiesto torrentu
        const firstByte = Buffer.from(res.data).slice(0, 1).toString();
        if (firstByte === '<') {
            console.error("[ERROR] ⛔️ SKTorrent vrátil HTML namiesto .torrent súboru. Skontroluj UID/PASS!");
            return null;
        }

        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        return crypto.createHash("sha1").update(info).digest("hex");
    } catch (err) {
        console.error("[ERROR] ⛔️ Chyba pri spracovaní .torrent (bencode):", err.message);
        return null;
    }
}

// --- HANDLERY ---

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : null;
    const episode = eRaw ? parseInt(eRaw) : null;

    console.log(`\n[REQUEST] ${type} | ${imdbId} | S:${season} E:${episode}`);

    const titles = await getTitleFromIMDb(imdbId);
    if (!titles) {
        // Fallback: Ak IMDb zlyhá, skúsime aspoň čisté ID, ale SKTorrent ID nepozná
        return { streams: [] };
    }

    const queries = new Set();
    const clean = (t) => t.replace(/\(.*?\)/g, '').replace(/TV (Mini )?Series/gi, '').trim();
    
    const baseNames = [clean(titles.title), clean(titles.originalTitle)];

    baseNames.forEach(name => {
        const noDia = removeDiacritics(name);
        if (type === 'series' && season !== null) {
            const epTag = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            queries.add(`${noDia} ${epTag}`);
            queries.add(`${name} ${epTag}`);
        } else {
            queries.add(noDia);
            queries.add(name);
        }
    });

    let torrents = [];
    for (const q of queries) {
        if (!q || q.length < 3) continue;
        const found = await searchTorrents(q);
        if (found.length > 0) {
            torrents = found;
            break; 
        }
    }

    const streams = await Promise.all(torrents.map(async (t) => {
        const infoHash = await getInfoHashFromTorrent(t.downloadUrl);
        if (!infoHash) return null;

        const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
        const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);

        return {
            name: `SKTorrent\n${t.category}`,
            title: `${t.name}\n👤 ${t.seeds}  📀 ${t.size}${flags.length ? '\n' + flags.join(' ') : ''}`,
            infoHash: infoHash,
            behaviorHints: { bingeGroup: `skt-${imdbId}` }
        };
    }));

    const finalStreams = streams.filter(Boolean);
    console.log(`[INFO] ✅ Odosielam ${finalStreams.length} streamov.`);
    return { streams: finalStreams };
});

serveHTTP(builder.getInterface(), { port: 7000 });
console.log("🚀 SKTorrent addon beží na porte 7000");
