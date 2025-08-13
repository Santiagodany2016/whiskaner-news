/**
 * scripts/build.js  (ESM)
 * ------------------------------------------------------------
 * Genera docs/feed.json unificando Artículos (RSS/Atom),
 * Podcasts (RSS/Atom) y Videos (YouTube Data API v3).
 *
 * Requisitos en package.json:
 *   "type": "module"
 *   deps: yaml, xml2js
 *   Node 20+ (tiene fetch global)
 *
 * Cambios clave:
 *   - MAX_ITEMS = 800
 *   - MIN_VIDEOS = 100 (cuota mínima de videos)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYAML } from "yaml";
import { Parser as XMLParser } from "xml2js";

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

// parse RSS/Atom
async function parseFeedXML(xml) {
  const parser = new XMLParser({ explicitArray: false, mergeAttrs: true, normalizeTags: true });
  return parser.parseStringPromise(xml);
}

// normalización RSS/Atom (article/podcast)
function normalizeRssItem(raw, type, sourceName) {
  const title = raw.title?.trim?.() || raw["media:title"] || raw["dc:title"] || "";
  const link =
    raw.link?.href || // Atom
    raw.link ||       // RSS
    raw.guid?.["_"] || raw.guid || "";
  const date =
    raw.pubDate || raw.published || raw.updated || raw["dc:date"] || raw["dc:created"] || raw["dc:issued"];
  const description =
    raw.description || raw.summary || raw["content:encoded"] || raw.content || "";

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
    region: "GLOBAL"
  };
}

// lee sources.yaml
async function readSourcesYaml() {
  const txt = await fs.readFile(SOURCES_YAML, "utf8");
  const y = parseYAML(txt);
  return {
    articles: Array.isArray(y.articles) ? y.articles : [],
    podcasts: Array.isArray(y.podcasts) ? y.podcasts : [],
  };
}

// consume feed RSS/Atom
async function pullRssOrAtom({ name, url }, type) {
  try {
    const xml = await fetchText(url);
    const parsed = await parseFeedXML(xml);

    let rawItems = [];
    if (parsed?.rss?.channel?.item) {
      rawItems = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item];
    } else if (parsed?.feed?.entry) {
      rawItems = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
    }

    return rawItems.map(it => normalizeRssItem(it, type, name));
  } catch (err) {
    console.warn(`[WARN] RSS/Atom fallo (${type}) ${name}: ${err.message}`);
    return [];
  }
}

// YouTube: videos recientes por canal (máx 50, últimos 90 días)
async function pullYouTubeChannel(channelId, apiKey) {
  const collected = [];
  const params = new URLSearchParams({
    key: apiKey,
    channelId,
    part: "snippet",
    maxResults: "50",
    order: "date",
    type: "video",
    publishedAfter: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
  });

  const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
  const json = await fetchJSON(url);

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

  return collected;
}

async function readYouTubeChannels() {
  try {
    const txt = await fs.readFile(YT_CHANNELS_JSON, "utf8");
    const arr = JSON.parse(txt);
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

  // --- Pull RSS/Atom ---
  const rssJobs = [
    ...articles.map(src => pullRssOrAtom(src, "article")),
    ...podcasts.map(src => pullRssOrAtom(src, "podcast")),
  ];
  const rssResults = await Promise.all(rssJobs);
  const rssItems = rssResults.flat();

  // --- Pull YouTube ---
  let ytItems = [];
  if (YT_API_KEY && ytChannels.length) {
    const ytJobs = ytChannels.map(id =>
      pullYouTubeChannel(id, YT_API_KEY).catch(err => {
        console.warn(`[WARN] YouTube canal ${id}: ${err.message}`); return [];
      })
    );
    ytItems = (await Promise.all(ytJobs)).flat();
  } else {
    if (!YT_API_KEY) console.warn("[WARN] YT_API_KEY no definido; se omiten videos.");
    if (!ytChannels.length) console.warn("[WARN] youtube_channels.json vacío; se omiten videos.");
  }

  // --- Unir, normalizar mínimos y deduplicar ---
  const allRaw = [...rssItems, ...ytItems];

  const allItems = allRaw.map(x => ({
    id: x.id,
    type: x.type, // 'article'|'podcast'|'video'
    source: x.source || "",
    title: (x.title || "").toString().trim(),
    url: x.url || x.link || "",
    date: toISODate
