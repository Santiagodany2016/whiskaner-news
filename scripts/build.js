/**
 * scripts/build.js
 * ------------------------------------------------------------
 * Genera docs/feed.json unificando Artículos (RSS/Atom),
 * Podcasts (RSS/Atom) y Videos (YouTube Data API v3).
 *
 * - Lee sources.yaml (rss de artículos y podcasts)
 * - Lee youtube_channels.json (lista de channelId)
 * - Normaliza, deduplica, ordena por fecha
 * - Reserva MIN_VIDEOS antes de recortar a MAX_ITEMS
 * - Escribe docs/feed.json
 *
 * Requiere:
 *   - Node 20+
 *   - npm i yaml xml2js
 *   - process.env.YT_API_KEY (en CI con GitHub Actions)
 */

const fs = require("fs/promises");
const path = require("path");
const { parse: parseYAML } = require("yaml");
const xml2js = require("xml2js");

// --- límites del feed ---
const MAX_ITEMS = 800;      // antes 500
const MIN_VIDEOS = 100;     // cupo mínimo reservado para videos

// --- utilidades de ruta ---
const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const FEED_PATH = path.join(DOCS_DIR, "feed.json");
const SOURCES_YAML = path.join(ROOT, "sources.yaml");
const YT_CHANNELS_JSON = path.join(ROOT, "youtube_channels.json");

// --- helpers generales ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);

// clave única robusta por item
const keyOf = (x) => x.id ?? x.guid ?? x.url ?? x.link ?? x.permalink ?? x.title ?? JSON.stringify(x);

// fecha segura a ISO
function toISODate(input) {
  if (!input) return new Date(0).toISOString();
  try {
    // maneja Date, ISO string, número, etc.
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return new Date(0).toISOString();
    return d.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

// fetch con reintentos
async function fetchJSON(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (i === retries) throw err;
      await sleep(400 * (i + 1));
    }
  }
}

// descarga texto (para RSS/Atom)
async function fetchText(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      if (i === retries) throw err;
      await sleep(400 * (i + 1));
    }
  }
}

// parse RSS/Atom con xml2js
async function parseFeedXML(xml) {
  const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true, normalizeTags: true });
  return parser.parseStringPromise(xml);
}

// normalización RSS/Atom común (article/podcast)
function normalizeRssItem(raw, type, sourceName) {
  // RSS vs Atom - tomar campos más comunes
  const title = raw.title?.trim?.() || raw["media:title"] || raw["dc:title"] || "";
  const link =
    raw.link?.href || // Atom
    raw.link ||       // RSS
    raw.guid?.["_"] || raw.guid || "";
  const date =
    raw.pubDate || raw.published || raw.updated || raw["dc:date"] || raw["dc:created"] || raw["dc:issued"];
  const description =
    raw.description || raw.summary || raw["content:encoded"] || raw.content || "";

  // imagen si existe (media:thumbnail / enclosure / etc.)
  let image =
    raw["media:thumbnail"]?.url ||
    raw["media:content"]?.url ||
    (Array.isArray(raw.enclosure) ? raw.enclosure[0]?.url : raw.enclosure?.url) ||
    null;

  return {
    id: raw.guid?._ || raw.guid || link || title,
    type,                          // 'article' | 'podcast'
    source: sourceName || "",
    title: title?.toString().trim(),
    url: typeof link === "string" ? link : (link?.href || ""),
    date: toISODate(date),
    description: (typeof description === "string" ? description : "").toString(),
    image,
    // campos auxiliares
    region: "GLOBAL"
  };
}

// lee sources.yaml con estructura:
// articles: [ {name, url}, ... ]
// podcasts: [ {name, url}, ... ]
async function readSourcesYaml() {
  const txt = await fs.readFile(SOURCES_YAML, "utf8");
  const y = parseYAML(txt);
  return {
    articles: Array.isArray(y.articles) ? y.articles : [],
    podcasts: Array.isArray(y.podcasts) ? y.podcasts : [],
  };
}

// consume un feed RSS/Atom y devuelve items normalizados
async function pullRssOrAtom({ name, url }, type) {
  try {
    const xml = await fetchText(url);
    const parsed = await parseFeedXML(xml);

    // Detectar RSS vs Atom
    // RSS 2.x → parsed.rss.channel.item
    // Atom → parsed.feed.entry
    let rawItems = [];
    if (parsed?.rss?.channel?.item) {
      rawItems = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item];
    } else if (parsed?.feed?.entry) {
      rawItems = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
    } else {
      // otros formatos mínimos
      rawItems = [];
    }

    const norm = rawItems.map(it => normalizeRssItem(it, type, name));
    return norm;
  } catch (err) {
    console.warn(`[WARN] RSS/Atom fallo (${type}) ${name}: ${err.message}`);
    return [];
  }
}

// YouTube: trae videos recientes por canal
// usa search.list con order=date & type=video
async function pullYouTubeChannel(channelId, apiKey) {
  const collected = [];
  let pageToken = "";
  // límite simple: hasta 50 resultados por canal
  // (suficiente para poblar feed reciente)
  do {
    const params = new URLSearchParams({
      key: apiKey,
      channelId,
      part: "snippet",
      maxResults: "50",
      order: "date",
      type: "video",
      // publishedAfter opcional: últimos 90 días
      publishedAfter: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
    const json = await fetchJSON(url);
    pageToken = json.nextPageToken || "";

    for (const item of json.items || []) {
      if (item.id?.kind !== "youtube#video") continue;
      const vId = item.id.videoId;
      const sn = item.snippet || {};
      collected.push({
        id: vId,
        type: "video",
        source: sn.channelTitle || "YouTube",
        title: sn.title || "",
        url: `https://www.youtube.com/watch?v=${vId}`,
        date: toISODate(sn.publishedAt),
        description: sn.description || "",
        image: sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || null,
        region: "GLOBAL"
      });
    }
    // una página es suficiente para nuestro uso
    break;
  } while (pageToken);

  return collected;
}

async function readYouTubeChannels() {
  try {
    const txt = await fs.readFile(YT_CHANNELS_JSON, "utf8");
    const arr = JSON.parse(txt);
    // puede ser [{channelId, name}] o ["UCxxxx", ...]
    const ids = [];
    for (const entry of arr) {
      if (!entry) continue;
      if (typeof entry === "string") ids.push(entry);
      else if (typeof entry.channelId === "string") ids.push(entry.channelId);
    }
    return ids;
  } catch (err) {
    console.warn(`[WARN] No se pudo leer youtube_channels.json: ${err.message}`);
    return [];
  }
}

// Ensambla todo → feedItems
async function buildFeed() {
  console.log("▶ Iniciando build de feed…");

  const { articles, podcasts } = await readSourcesYaml();
  console.log(`• Fuentes: ${articles.length} artículos, ${podcasts.length} podcasts`);

  const YT_API_KEY = process.env.YT_API_KEY || process.env.GOOGLE_API_KEY;
  const ytChannels = await readYouTubeChannels();

  // --- Pull RSS/Atom (paralelo controlado) ---
  const rssJobs = [];
  for (const src of articles) rssJobs.push(pullRssOrAtom(src, "article"));
  for (const src of podcasts) rssJobs.push(pullRssOrAtom(src, "podcast"));

  const rssResults = await Promise.all(rssJobs);
  const rssItems = rssResults.flat();

  // --- Pull YouTube ---
  let ytItems = [];
  if (YT_API_KEY && ytChannels.length) {
    const ytJobs = ytChannels.map(id => pullYouTubeChannel(id, YT_API_KEY).catch(err => {
      console.warn(`[WARN] YouTube canal ${id}: ${err.message}`); return [];
    }));
    const ytResults = await Promise.all(ytJobs);
    ytItems = ytResults.flat();
  } else {
    if (!YT_API_KEY) console.warn("[WARN] YT_API_KEY no definido; se omiten videos.");
    if (!ytChannels.length) console.warn("[WARN] youtube_channels.json vacío; se omiten videos.");
  }

  // --- Unir, normalizar mínimos y deduplicar ---
  const allRaw = [...rssItems, ...ytItems];

  // seguridad de campos
  const allItems = allRaw.map(x => ({
    id: x.id,
    type: x.type, // 'article'|'podcast'|'video'
    source: x.source || "",
    title: (x.title || "").toString().trim(),
    url: x.url || x.link || "",
    date: toISODate(x.date),
    description: (x.description || "").toString(),
    image: x.image || null,
    region: x.region || "GLOBAL"
  }));

  // deduplicación por clave
  const seen = new Set();
  const deduped = [];
  for (const it of allItems) {
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
  }

  // --- Orden global ---
  deduped.sort(byDateDesc);

  // --- Reserva de videos + recorte final ---
  const videoItems = deduped.filter(i => i.type === "video");
  const otherItems = deduped.filter(i => i.type !== "video");

  const reservedVideos = videoItems.slice(0, Math.min(MIN_VIDEOS, videoItems.length));
  const remainingSlots = Math.max(0, MAX_ITEMS - reservedVideos.length);

  const taken = new Set(reservedVideos.map(keyOf));
  const fillOthers = [];
  for (const item of otherItems) {
    const k = keyOf(item);
    if (taken.has(k)) continue;
    fillOthers.push(item);
    if (fillOthers.length >= remainingSlots) break;
  }

  const feedItems = [...reservedVideos, ...fillOthers].sort(byDateDesc).slice(0, MAX_ITEMS);

  // métricas
  const countBy = (xs, t) => xs.filter(i => i.type === t).length;
  console.log("• Conteo total:", feedItems.length);
  console.log("  - Articles:", countBy(feedItems, "article"));
  console.log("  - Videos  :", countBy(feedItems, "video"));
  console.log("  - Podcasts:", countBy(feedItems, "podcast"));

  return feedItems;
}

// escribe docs/feed.json
async function writeFeedJson(items) {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items
  };
  await fs.writeFile(FEED_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(`✔ Escrito ${FEED_PATH}`);
}

(async function main() {
  try {
    const items = await buildFeed();
    await writeFeedJson(items);
    console.log("✅ Build finalizado OK");
  } catch (err) {
    console.error("❌ Error en build:", err);
    process.exitCode = 1;
  }
})();
