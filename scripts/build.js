// scripts/build.js (ESM) — listo para usar
// Genera docs/feed.json unificando Artículos (RSS/Atom), Podcasts (RSS/Atom) y Videos (YouTube)

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYAML } from "yaml";
import { Parser as XMLParser } from "xml2js";

// ----- Configuración -----
const MAX_ITEMS = 800;   // tamaño del feed
const MIN_VIDEOS = 100;  // reserva mínima de videos

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const FEED_PATH = path.join(DOCS_DIR, "feed.json");
const SOURCES_YAML = path.join(ROOT, "sources.yaml");
const YT_CHANNELS_JSON = path.join(ROOT, "youtube_channels.json");

// ----- Helpers -----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);
const keyOf = (x) =>
  x.id ?? x.guid ?? x.url ?? x.link ?? x.permalink ?? x.title ?? JSON.stringify(x);

function toISODate(input) {
  try {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

async function fetchJSON(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === retries) throw err;
      await sleep(400 * (i + 1));
    }
  }
}

async function parseFeedXML(xml) {
  const parser = new XMLParser({
    explicitArray: false,
    mergeAttrs: true,
    normalizeTags: true,
  });
  return parser.parseStringPromise(xml);
}

// ----- Normalizadores -----
function normalizeRssItem(raw, type, sourceName) {
  const title = raw.title?.trim?.() || raw["media:title"] || raw["dc:title"] || "";
  const link = raw.link?.href || raw.link || raw.guid?._ || raw.guid || "";
  const date = raw.pubDate || raw.published || raw.updated || raw["dc:date"] || "";
  const description =
    raw.description || raw.summary || raw["content:encoded"] || raw.content || "";
  const image =
    raw["media:thumbnail"]?.url ||
    raw["media:content"]?.url ||
    (Array.isArray(raw.enclosure) ? raw.enclosure[0]?.url : raw.enclosure?.url) ||
    null;

  return {
    id: raw.guid?._ || raw.guid || link || title,
    type, // 'article' | 'podcast'
    source: sourceName || "",
    title: (title || "").toString().trim(),
    url: typeof link === "string" ? link : link?.href || "",
    date: toISODate(date),
    description: (description || "").toString(),
    image,
    region: "GLOBAL",
  };
}

// ----- Lectores de fuentes -----
async function readSourcesYaml() {
  const txt = await fs.readFile(SOURCES_YAML, "utf8");
  const y = parseYAML(txt);
  return {
    articles: Array.isArray(y.articles) ? y.articles : [],
    podcasts: Array.isArray(y.podcasts) ? y.podcasts : [],
  };
}

async function pullRssOrAtom({ name, url }, type) {
  try {
    const xml = await fetchText(url);
    const parsed = await parseFeedXML(xml);

    let rawItems = [];
    if (parsed?.rss?.channel?.item) {
      rawItems = Array.isArray(parsed.rss.channel.item)
        ? parsed.rss.channel.item
        : [parsed.rss.channel.item];
    } else if (parsed?.feed?.entry) {
      rawItems = Array.isArray(parsed.feed.entry)
        ? parsed.feed.entry
        : [parsed.feed.entry];
    }
    return rawItems.map((it) => normalizeRssItem(it, type, name));
  } catch {
    return [];
  }
}

async function readYouTubeChannels() {
  try {
    const txt = await fs.readFile(YT_CHANNELS_JSON, "utf8");
    const arr = JSON.parse(txt);
    return arr
      .map((e) => (typeof e === "string" ? e : e?.channelId))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function pullYouTubeChannel(channelId, apiKey) {
  const params = new URLSearchParams({
    key: apiKey,
    channelId,
    part: "snippet",
    maxResults: "50",
    order: "date",
    type: "video",
    publishedAfter: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
  });
  const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
  const json = await fetchJSON(url);

  return (json.items || [])
    .filter((i) => i.id?.kind === "youtube#video")
    .map((item) => {
      const vId = item.id.videoId;
      const sn = item.snippet || {};
      return {
        id: vId,
        type: "video",
        source: sn.channelTitle || "YouTube",
        title: sn.title || "",
        url: `https://www.youtube.com/watch?v=${vId}`,
        date: toISODate(sn.publishedAt),
        description: sn.description || "",
        image: sn.thumbnails?.high?.url || sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || null,
        region: "GLOBAL",
      };
    });
}

// ----- Build del feed -----
async function buildFeed() {
  const { articles, podcasts } = await readSourcesYaml();
  const YT_API_KEY = process.env.YT_API_KEY || process.env.GOOGLE_API_KEY;
  const ytChannels = await readYouTubeChannels();

  const rssItems = (
    await Promise.all([
      ...articles.map((src) => pullRssOrAtom(src, "article")),
      ...podcasts.map((src) => pullRssOrAtom(src, "podcast")),
    ])
  ).flat();

  let ytItems = [];
  if (YT_API_KEY && ytChannels.length) {
    ytItems = (
      await Promise.all(
        ytChannels.map((id) =>
          pullYouTubeChannel(id, YT_API_KEY).catch(() => [])
        )
      )
    ).flat();
  }

  const allItems = [...rssItems, ...ytItems].map((x) => ({
    id: x.id,
    type: x.type,
    source: x.source || "",
    title: (x.title || "").toString().trim(),
    url: x.url || x.link || "",
    date: toISODate(x.date),
    description: (x.description || "").toString(),
    image: x.image || null,
    region: x.region || "GLOBAL",
  }));

  // de-dup
  const seen = new Set();
  const deduped = [];
  for (const it of allItems) {
    const k = keyOf(it);
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(it);
    }
  }

  // orden global
  deduped.sort(byDateDesc);

  // reserva videos + recorte
  const videoItems = deduped.filter((i) => i.type === "video");
  const otherItems = deduped.filter((i) => i.type !== "video");

  const reservedVideos = videoItems.slice(0, Math.min(MIN_VIDEOS, videoItems.length));
  const remaining = Math.max(0, MAX_ITEMS - reservedVideos.length);

  const taken = new Set(reservedVideos.map(keyOf));
  const fillOthers = [];
  for (const item of otherItems) {
    const k = keyOf(item);
    if (taken.has(k)) continue;
    fillOthers.push(item);
    if (fillOthers.length >= remaining) break;
  }

  return [...reservedVideos, ...fillOthers].sort(byDateDesc).slice(0, MAX_ITEMS);
}

// ----- Escritura -----
async function writeFeedJson(items) {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
  await fs.writeFile(FEED_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(`✔ Escrito ${FEED_PATH} con ${items.length} items`);
}

// ----- Main -----
const items = await buildFeed();
await writeFeedJson(items);
console.log("✅ Build finalizado");
