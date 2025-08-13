// scripts/build.js (ESM, seguro para Pages)
// - Unifica Artículos (RSS/Atom), Podcasts (RSS/Atom) y Videos (YouTube)
// - Reserva MIN_VIDEOS y sube MAX_ITEMS
// - Si el resultado es 0, conserva el feed.json anterior (no rompe la web)

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYAML } from "yaml";
import { Parser as XMLParser } from "xml2js";

// ----- Config -----
const MAX_ITEMS   = 800;  // tamaño del feed
const MIN_VIDEOS  = 100;  // cupo mínimo de videos
const ROOT        = process.cwd();
const DOCS_DIR    = path.join(ROOT, "docs");
const FEED_PATH   = path.join(DOCS_DIR, "feed.json");
const SOURCES_YML = path.join(ROOT, "sources.yaml");
const YT_FILE     = path.join(ROOT, "youtube_channels.json");

// ----- Helpers -----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const byDateDesc = (a, b) => new Date(b.date) - new Date(a.date);
const keyOf = (x) => x.id ?? x.guid ?? x.url ?? x.link ?? x.permalink ?? x.title ?? JSON.stringify(x);

function toISO(input) {
  try {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
  } catch { return new Date(0).toISOString(); }
}

async function fetchJSON(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

async function fetchText(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

async function parseFeedXML(xml) {
  const parser = new XMLParser({ explicitArray:false, mergeAttrs:true, normalizeTags:true });
  return parser.parseStringPromise(xml);
}

// ----- Sources.yaml (tolerante a estructura) -----
async function readSourcesYaml() {
  try {
    const txt = await fs.readFile(SOURCES_YML, "utf8");
    const y   = parseYAML(txt) || {};

    // aceptar varias formas
    const pick = (obj, ...paths) => {
      for (const p of paths) {
        const v = p.split(".").reduce((a,k)=> (a && a[k]!==undefined)?a[k]:undefined, obj);
        if (Array.isArray(v)) return v;
      }
      return [];
    };

    const articles = pick(y, "articles", "sources.articles", "rss.articles", "feeds.articles")
      .map(x => typeof x === "string" ? { name:x, url:x } : x)
      .filter(x => x?.url);

    const podcasts = pick(y, "podcasts", "sources.podcasts", "rss.podcasts", "feeds.podcasts")
      .map(x => typeof x === "string" ? { name:x, url:x } : x)
      .filter(x => x?.url);

    return { articles, podcasts };
  } catch {
    return { articles:[], podcasts:[] };
  }
}

// ----- RSS/Atom -----
function normalizeRssItem(raw, type, sourceName) {
  const title = raw.title?.trim?.() || raw["media:title"] || raw["dc:title"] || "";
  const link  = raw.link?.href || raw.link || raw.guid?._ || raw.guid || "";
  const date  = raw.pubDate || raw.published || raw.updated || raw["dc:date"] || raw["dc:created"] || "";
  const desc  = raw.description || raw.summary || raw["content:encoded"] || raw.content || "";
  const image =
    raw["media:thumbnail"]?.url ||
    raw["media:content"]?.url ||
    (Array.isArray(raw.enclosure) ? raw.enclosure[0]?.url : raw.enclosure?.url) || null;

  return {
    id: raw.guid?._ || raw.guid || link || title,
    type, source: sourceName || "",
    title: (title || "").toString().trim(),
    url: typeof link === "string" ? link : (link?.href || ""),
    date: toISO(date),
    description: (desc || "").toString(),
    image, region: "GLOBAL"
  };
}

async function pullRssOrAtom({ name, url }, type) {
  try {
    const xml = await fetchText(url);
    const p   = await parseFeedXML(xml);
    let items = [];
    if (p?.rss?.channel?.item) items = Array.isArray(p.rss.channel.item) ? p.rss.channel.item : [p.rss.channel.item];
    else if (p?.feed?.entry)   items = Array.isArray(p.feed.entry) ? p.feed.entry : [p.feed.entry];
    return items.map(i => normalizeRssItem(i, type, name));
  } catch { return []; }
}

// ----- YouTube -----
async function readYouTubeChannels() {
  try {
    const txt = await fs.readFile(YT_FILE, "utf8");
    const arr = JSON.parse(txt);
    return arr.map(e => typeof e === "string" ? e : e?.channelId).filter(Boolean);
  } catch { return []; }
}

async function pullYouTubeChannel(channelId, apiKey) {
  const qs = new URLSearchParams({
    key: apiKey, channelId,
    part:"snippet", maxResults:"50", order:"date", type:"video",
    publishedAfter: new Date(Date.now() - 90*24*3600*1000).toISOString()
  });
  const url = `https://www.googleapis.com/youtube/v3/search?${qs.toString()}`;
  const json = await fetchJSON(url);
  return (json.items || [])
    .filter(i => i.id?.kind === "youtube#video")
    .map(i => {
      const v = i.id.videoId, s = i.snippet || {};
      return {
        id: v, type:"video", source: s.channelTitle || "YouTube",
        title: s.title || "",
        url: `https://www.youtube.com/watch?v=${v}`,
        date: toISO(s.publishedAt),
        description: s.description || "",
        image: s.thumbnails?.high?.url || s.thumbnails?.medium?.url || s.thumbnails?.default?.url || null,
        region:"GLOBAL"
      };
    });
}

// ----- Build -----
async function buildFeed() {
  const { articles, podcasts } = await readSourcesYaml();

  const rssItems = (await Promise.all([
    ...articles.map(a => pullRssOrAtom(a, "article")),
    ...podcasts.map(p => pullRssOrAtom(p, "podcast")),
  ])).flat();

  const ytKey = process.env.YT_API_KEY || process.env.GOOGLE_API_KEY || "";
  const ytIds = await readYouTubeChannels();
  let ytItems = [];
  if (ytKey && ytIds.length) {
    ytItems = (await Promise.all(ytIds.map(id => pullYouTubeChannel(id, ytKey).catch(()=>[])))).flat();
  }

  const all = [...rssItems, ...ytItems].map(x => ({
    id: x.id, type: x.type, source: x.source || "",
    title: (x.title || "").toString().trim(),
    url: x.url || x.link || "",
    date: toISO(x.date), description: (x.description || "").toString(),
    image: x.image || null, region: x.region || "GLOBAL"
  }));

  // dedup
  const seen = new Set(), out = [];
  for (const it of all) { const k = keyOf(it); if (!seen.has(k)) { seen.add(k); out.push(it); } }

  out.sort(byDateDesc);

  // reserva videos
  const vids = out.filter(i => i.type === "video");
  const rest = out.filter(i => i.type !== "video");

  const keepV = vids.slice(0, Math.min(MIN_VIDEOS, vids.length));
  const remain = Math.max(0, MAX_ITEMS - keepV.length);

  const taken = new Set(keepV.map(keyOf));
  const fill = [];
  for (const it of rest) {
    const k = keyOf(it);
    if (taken.has(k)) continue;
    fill.push(it);
    if (fill.length >= remain) break;
  }

  return [...keepV, ...fill].sort(byDateDesc).slice(0, MAX_ITEMS);
}

// ----- Persistencia -----
async function readOldFeedIfAny() {
  try {
    const txt = await fs.readFile(FEED_PATH, "utf8");
    const j = JSON.parse(txt);
    if (Array.isArray(j?.items) && j.items.length) return j;
  } catch {}
  return null;
}

async function writeFeedJson(items) {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  const payload = { generatedAt: new Date().toISOString(), count: items.length, items };
  await fs.writeFile(FEED_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(`✔ feed.json → ${items.length} items`);
}

// ----- Main -----
const items = await buildFeed();

if (items.length === 0) {
  // Nunca rompas la web: conserva feed anterior si existe
  const oldFeed = await readOldFeedIfAny();
  if (oldFeed) {
    console.log("⚠ No se obtuvieron ítems nuevos. Conservo feed anterior.");
    await fs.writeFile(FEED_PATH, JSON.stringify(oldFeed, null, 2), "utf8");
    process.exit(0);
  }
}

await writeFeedJson(items);
console.log("✅ Build OK");
