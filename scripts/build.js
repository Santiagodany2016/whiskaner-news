// scripts/build.js — RSS robusto + YouTube API + cupo mínimo de videos
// Node 20+ (trae fetch nativo). package.json: { "type": "module" }

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import RSSParser from "rss-parser";

// ---------- Config ----------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MAX_ITEMS = 800;      // antes 500 → subimos el límite total
const VIDEO_MIN = 100;      // cupo mínimo de videos garantizados
const OUTPUT_DIR = "docs";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "feed.json");
const SOURCES_FILE = "sources.yaml";
const YT_FILE = "youtube_channels.json";
const YT_KEY = process.env.YT_API_KEY || ""; // Secret en GitHub: YT_API_KEY

// ---------- RSS Parser con headers + timeout ----------
const parser = new RSSParser({
  requestOptions: {
    headers: {
      "User-Agent": UA,
      Accept:
        "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    },
    redirect: "follow",
  },
  timeout: 20000, // 20s
});

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, ms = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort("timeout"), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

// Intenta parsear un feed con reintentos + fallback (descarga XML y parseString)
async function parseFeed(url, name, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await parser.parseURL(url);
    } catch (e1) {
      lastErr = e1;
      try {
        const xml = await fetchWithTimeout(url, 20000);
        return await parser.parseString(xml);
      } catch (e2) {
        lastErr = e2;
      }
      await sleep(700 * (i + 1));
    }
  }
  console.error("Error en fuente:", name || url, String(lastErr?.message || lastErr));
  return null;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function firstImage(entry) {
  if (entry?.enclosure?.url) return entry.enclosure.url;
  const content = String(entry?.["content:encoded"] || entry?.content || "");
  const m = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Normaliza al esquema final de tu UI
function toItemSchema({
  id,
  title,
  url,
  source,
  type,
  region,
  published_at,
  image,
  summary,
}) {
  return {
    id: id || url,
    title: title || "(sin título)",
    url,
    source,
    type: type || "article",
    region: region || "global",
    published_at: published_at || null,
    image: image || null,
    summary: summary || null,
  };
}

// ---------- YouTube (API oficial) ----------
async function fetchYouTubeVideos() {
  if (!YT_KEY) {
    console.warn("YT_API_KEY ausente: se omiten videos de YouTube.");
    return [];
  }
  if (!fs.existsSync(YT_FILE)) return [];

  const channels = JSON.parse(fs.readFileSync(YT_FILE, "utf-8"));
  let all = [];

  for (const ch of channels) {
    try {
      const url =
        `https://www.googleapis.com/youtube/v3/search` +
        `?key=${encodeURIComponent(YT_KEY)}` +
        `&channelId=${encodeURIComponent(ch.channelId)}` +
        `&part=snippet` +
        `&order=date` +
        `&type=video` +
        `&maxResults=8`;

      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const vids = (data.items || [])
        .filter((it) => it?.id?.videoId && it?.snippet)
        .map((it) =>
          toItemSchema({
            title: it.snippet.title,
            url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
            source: ch.name || "YouTube",
            type: "video",
            region: ch.region || "global",
            published_at: it.snippet.publishedAt || null,
            image:
              it.snippet.thumbnails?.high?.url ||
              it.snippet.thumbnails?.medium?.url ||
              it.snippet.thumbnails?.default?.url ||
              null,
            summary: stripHtml(it.snippet.description || ""),
          })
        );

      all = all.concat(vids);
    } catch (err) {
      console.error("Error YouTube:", ch.name || ch.channelId, String(err.message || err));
    }
  }
  return all;
}

// ---------- Main ----------
async function main() {
  ensureDir(OUTPUT_DIR);

  // 1) Cargar artículos/podcasts desde sources.yaml (RSS)
  const yamlRaw = fs.readFileSync(SOURCES_FILE, "utf-8");
  const cfg = YAML.load(yamlRaw);
  const sources = (cfg && cfg.sources) || [];

  const bucketArticles = [];
  const bucketPodcasts = [];
  const bucketVideosOther = []; // por si algún RSS devuelve 'video'

  for (const s of sources) {
    if (!s?.url) continue;
    const feed = await parseFeed(s.url, s.name);
    if (!feed?.items) continue;

    for (const e of feed.items) {
      const link = e.link || e.id;
      const title = String(e.title || "").trim();
      if (!link || !title) continue;

      const published =
        e.isoDate || e.pubDate || e.published || e.updated || null;

      const item = toItemSchema({
        id: link,
        title,
        url: link,
        source: s.name || hostnameOf(link) || hostnameOf(s.url),
        type: s.type || "article",
        region: s.region || "global",
        published_at: published ? new Date(published).toISOString() : null,
        image: firstImage(e),
        summary: stripHtml(e.summary || e.contentSnippet || e.content || ""),
      });

      if (item.type === "podcast") bucketPodcasts.push(item);
      else if (item.type === "video") bucketVideosOther.push(item);
      else bucketArticles.push(item);
    }
  }

  // 2) Cargar videos de YouTube por API (si hay clave)
  const bucketVideosYT = await fetchYouTubeVideos();

  // 3) Ordenar cada bucket por fecha desc
  const descByDate = (a, b) => {
    const ta = a.published_at ? Date.parse(a.published_at) : 0;
    const tb = b.published_at ? Date.parse(b.published_at) : 0;
    return tb - ta;
  };
  bucketArticles.sort(descByDate);
  bucketPodcasts.sort(descByDate);
  bucketVideosOther.sort(descByDate);
  bucketVideosYT.sort(descByDate);

  // 4) Construir salida garantizando VIDEO_MIN
  const picked = [];
  const seen = new Set();

  function pushUnique(arr) {
    for (const it of arr) {
      if (!it?.url) continue;
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      picked.push(it);
      if (picked.length >= MAX_ITEMS) break;
    }
  }

  // 4a) Garantizar mínimo de videos (prioriza YouTube)
  const videosCombined = [...bucketVideosYT, ...bucketVideosOther].sort(descByDate);
  pushUnique(videosCombined.slice(0, VIDEO_MIN));

  // 4b) Completar con el resto (artículos + podcasts + videos sobrantes) en orden global
  const rest = [...bucketArticles, ...bucketPodcasts, ...videosCombined].sort(descByDate);
  pushUnique(rest);

  // 5) Escribir archivo
  const out = {
    updated_at: new Date().toISOString(),
    count: picked.length,
    items: picked,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2), "utf8");

  // Métrica útil en logs
  const byType = picked.reduce((acc, it) => {
    acc[it.type] = (acc[it.type] || 0) + 1;
    return acc;
  }, {});
  console.log("Conteo por tipo:", byType);
  console.log(`OK -> ${OUTPUT_FILE} items: ${picked.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
