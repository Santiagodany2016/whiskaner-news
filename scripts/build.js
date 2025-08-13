// scripts/build.js (versión robusta)
// - User-Agent "navegador" (muchos feeds lo exigen: YouTube, revistas)
// - requestOptions correcto para rss-parser
// - timeout + reintentos
// - fallback: fetch XML y parser.parseString
// - mejor manejo de errores sin bloquear el job

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import RSSParser from "rss-parser";

const MAX_ITEMS = 500;
const OUTPUT_DIR = "docs";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "feed.json");
const SOURCES_FILE = "sources.yaml";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const parser = new RSSParser({
  // 👇 esta es la forma en que rss-parser acepta headers
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

/** Espera ms milisegundos */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Descarga con timeout usando AbortController (Node 18+) */
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
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

/** Intenta parsear un feed con reintentos y fallback */
async function parseFeed(url, name, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      // 1) Intento directo
      return await parser.parseURL(url);
    } catch (e1) {
      lastErr = e1;
      // 2) Fallback: descargar XML y parsear string
      try {
        const xml = await fetchWithTimeout(url, 20000);
        return await parser.parseString(xml);
      } catch (e2) {
        lastErr = e2;
      }
      // pequeño backoff y reintento
      await sleep(800 * (i + 1));
    }
  }
  console.error("Error en fuente:", name || url, String(lastErr?.message || lastErr));
  return null;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function guessTypeFromUrl(url) {
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "video";
  if (u.includes("podcast") || u.includes(".mp3") || u.includes("libsyn.com") || u.includes("anchor.fm"))
    return "podcast";
  return "article";
}

function firstImage(entry) {
  if (entry.enclosure && entry.enclosure.url) return entry.enclosure.url;
  const content = String(entry["content:encoded"] || entry.content || "");
  const m = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const raw = fs.readFileSync(SOURCES_FILE, "utf8");
  const cfg = YAML.load(raw);
  const sources = (cfg && cfg.sources) || [];
  const items = [];

  for (const s of sources) {
    if (!s?.url) continue;
    const name = s.name || s.url;
    const url = s.url.trim();

    const feed = await parseFeed(url, name);
    if (!feed) continue;

    for (const e of feed.items || []) {
      const link = e.link || e.id;
      const title = (e.title || "").toString().trim();
      if (!link || !title) continue;

      const published = e.isoDate || e.pubDate || e.published || null;
      items.push({
        id: link,
        title,
        url: link,
        source: (new URL(link).hostname).replace(/^www\./, ""),
        type: s.type || guessTypeFromUrl(link),
        region: s.region || "global",
        published_at: published ? new Date(published).toISOString() : null,
        image: firstImage(e),
        summary: e.summary ? stripHtml(e.summary).slice(0, 300) : null,
      });
    }
  }

  // dedupe por url (último gana)
  const map = new Map();
  for (const it of items) map.set(it.url, it);
  const deduped = Array.from(map.values());

  // ordenar por fecha si existe
  deduped.sort((a, b) => {
    const ta = a.published_at ? Date.parse(a.published_at) : 0;
    const tb = b.published_at ? Date.parse(b.published_at) : 0;
    return tb - ta;
  });

  ensureDir(OUTPUT_DIR);
  const out = {
    updated_at: new Date().toISOString(),
    count: deduped.length,
    items: deduped.slice(0, MAX_ITEMS),
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log("OK ->", OUTPUT_FILE, "items:", out.items.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
