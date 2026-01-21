// SKTorrent Stremio addon s pokročilým fallback systémom pre filmy a seriály
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");

const SKT_UID = process.env.SKT_UID || "";
const SKT_PASS = process.env.SKT_PASS || "";

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.0.0",
    name: "SKTorrent",
    description: "Streamuj torrenty z SKTorrent.eu (filmy aj seriály)",
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "sktorrent-movie", name: "SKTorrent Filmy" },
        { type: "series", id: "sktorrent-series", name: "SKTorrent Seriály" }
    ],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

function removeDiacritics(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

function isMultiSeason(title) {
    return /(S\d{2}E\d{2}-\d{2}|Complete|All Episodes|Season \d+(-\d+)?)/i.test(title);
}

async function getTitleFromIMDb(imdbId, type) {
    try {
        // Stremio používa Cinémeta ako hlavný zdroj dát
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        
        if (!res.data || !res.data.meta) {
            throw new Error("Meta údaje neboli nájdené");
        }

        const meta = res.data.meta;
        const title = meta.name; // Lokalizovaný názov (ak je dostupný)
        
        // Niektoré filmy majú v meta dátach aj pôvodný názov
        const originalTitle = meta.name; 

        console.log(`[DEBUG] 🌝 Názov z Cinémeta: ${title}`);
        return { title, originalTitle };
    } catch (err) {
        console.error("[ERROR] Cinémeta API zlyhalo:", err.message);
        return null;
    }
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
        const results = [];

        // Hľadáme všetky odkazy na detaily (funguje pre zoznam aj postery)
        $('a[href^="details.php?id="]').each((i, el) => {
            const href = $(el).attr("href");
            const torrentId = href.split("id=").pop();
            
            // Získame názov - buď z title atribútu alebo textu odkazu
            let name = $(el).attr("title") || $(el).text().trim();
            
            // Ak je meno prázdne (napr. pri obrázkoch), skúsime vziať alt z img vnútri
            if (!name) name = $(el).find('img').attr('alt');
            
            if (!name || name.length < 2) return;

            // Filtrujeme duplicity (jeden torrent môže mať v riadku viac odkazov)
            if (results.find(r => r.id === torrentId)) return;

            // Nájdeme veľkosť (často v rovnakom riadku <tr>)
            const row = $(el).closest("tr");
            const size = row.find("td").filter((i, td) => $(td).text().includes("GB") || $(td).text().includes("MB")).first().text().trim() || "?";
            const seeds = row.find("td").last().prev().text().trim() || "0";

            results.push({
                name: name,
                id: torrentId,
                size: size,
                seeds: seeds,
                category: "Torrent",
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });

        // Debug: Ak nič nenašlo, vypíšeme kúsok HTML pre kontrolu prihlásenia
        if (results.length === 0) {
            const isLoginPresent = res.data.includes('name="login"') || res.data.includes('Prihlásenie');
            if (isLoginPresent) console.error("[ERROR] 🔐 SKTorrent vás neprihlásil. Skontrolujte UID a PASS!");
        }

        console.log(`[INFO] 📦 Nájdených torrentov: ${results.length}`);
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
                // Skús pridať bodkočiarku na koniec a uisti sa, že v premenných nie sú medzery
                'Cookie': `uid=${SKT_UID.trim()}; pass=${SKT_PASS.trim()};`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Referer': 'https://sktorrent.eu/torrent/torrents_v2.php',
                'Upgrade-Insecure-Requests': '1'
            },
            maxRedirects: 5
        });

        // Kontrola, či neprišlo HTML
        const dataStart = res.data.slice(0, 100).toString();
        if (dataStart.includes("<html") || dataStart.includes("<!DOCTYPE")) {
            // TU JE KRITICKÝ BOD: Vypíšeme titulok stránky, aby sme vedeli, čo sa stalo
            const title = dataStart.match(/<title>(.*?)<\/title>/i)?.[1] || "neznáme HTML";
            console.error(`[ERROR] Server namiesto súboru vrátil webstránku: "${title}"`);
            return null;
        }

        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        return crypto.createHash("sha1").update(info).digest("hex");
    } catch (err) {
        console.error("[ERROR] Chyba pri sťahovaní:", err.message);
        return null;
    }
}

async function toStream(t) {
    if (isMultiSeason(t.name)) {
        console.log(`[DEBUG] ❌ Preskakujem multi-season balík: '${t.name}'`);
        return null;
    }
    const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
    const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
    const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

    let cleanedTitle = t.name.replace(/^Stiahni si\s*/i, "").trim();
    const categoryPrefix = t.category.trim().toLowerCase();
    if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) {
        cleanedTitle = cleanedTitle.slice(t.category.length).trim();
    }

    const infoHash = await getInfoHashFromTorrent(t.downloadUrl);
    if (!infoHash) return null;

    return {
        title: `${cleanedTitle}\n👤 ${t.seeds}  📀 ${t.size}  🩲 sktorrent.eu${flagsText}`,
        name: `SKTorrent\n${t.category}`,
        behaviorHints: { bingeGroup: cleanedTitle },
        infoHash
    };
}

builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`\n====== 🎮 RAW Požiadavka: type='${type}', id='${id}' ======`);

    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    console.log(`====== 🎮 STREAM Požiadavka pre typ='${type}' imdbId='${imdbId}' season='${season}' episode='${episode}' ======`);

    const titles = await getTitleFromIMDb(imdbId, type);
    if (!titles) return { streams: [] };

    const { title, originalTitle } = titles;
    const queries = new Set();
    const baseTitles = [title, originalTitle].map(t => t.replace(/\(.*?\)/g, '').replace(/TV (Mini )?Series/gi, '').trim());

    baseTitles.forEach(base => {
        const noDia = removeDiacritics(base);
        const short = shortenTitle(noDia);

        if (type === 'series' && season && episode) {
            const epTag = ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            [base, noDia, short].forEach(b => {
                queries.add(b + epTag);
                queries.add((b + epTag).replace(/[\':]/g, ''));
                queries.add((b + epTag).replace(/[\':]/g, '').replace(/\s+/g, '.'));
            });
        } else {
            [base, noDia, short].forEach(b => {
                queries.add(b);
                queries.add(b.replace(/[\':]/g, ''));
                queries.add(b.replace(/[\':]/g, '').replace(/\s+/g, '.'));
            });
        }
    });

    let torrents = [];
    let attempt = 1;
    for (const q of queries) {
        console.log(`[DEBUG] 🔍 Pokus ${attempt++}: Hľadám '${q}'`);
        torrents = await searchTorrents(q);
        if (torrents.length > 0) break;
    }

    const streams = (await Promise.all(torrents.map(toStream))).filter(Boolean);
    console.log(`[INFO] ✅ Odosielam ${streams.length} streamov do Stremio`);
    return { streams };
});

builder.defineCatalogHandler(({ type, id }) => {
    console.log(`[DEBUG] 📚 Katalóg požiadavka pre typ='${type}' id='${id}'`);
    return { metas: [] }; // aktivuje prepojenie
});

console.log("\ud83d\udccc Manifest debug výpis:", builder.getInterface().manifest);
serveHTTP(builder.getInterface(), { port: 7000 });
console.log("\ud83d\ude80 SKTorrent addon beží na http://localhost:7000/manifest.json");







