// Agrega RSS/Atom -> docs/feed.json (sin base de datos)
import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import RSSParser from "rss-parser";

const MAX_ITEMS = 500;
const OUTPUT_DIR = "docs";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "feed.json");
const SOURCES_FILE = "sources.yaml";

const parser = new RSSParser({
  headers: { "User-Agent": "WhiskyNewsBot/1.0 (+https://example.com)" }
});

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function guessTypeFromUrl(url) {
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "video";
  if (u.includes("podcast") || u.includes(".mp3") || u.includes("rss.acast") || u.includes("anchor.fm")) return "podcast";
  return "article";
}

function firstImage(entry) {
  if (entry.enclosure && entry.enclosure.url) return entry.enclosure.url;
  const content = String(entry["content:encoded"] || entry.content || "");
  const m = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function stripHtml(html) {
  return String(html||"").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const raw = fs.readFileSync(SOURCES_FILE, "utf8");
  const cfg = YAML.load(raw);
  const sources = (cfg && cfg.sources) || [];
  const items = [];

  for (const s of sources) {
    if (!s || !s.url) continue;
    try {
      const feed = await parser.parseURL(s.url);
      for (const e of feed.items || []) {
        const link = e.link || e.id;
        const title = (e.title || "").toString().trim();
        if (!link || !title) continue;

        const published = e.isoDate || e.pubDate || e.published || null;
        items.push({
          id: link,
          title,
          url: link,
          source: (new URL(link).hostname).replace(/^www\./,""),
          type: s.type || guessTypeFromUrl(link),
          region: s.region || "global",
          published_at: published ? new Date(published).toISOString() : null,
          image: firstImage(e),
          summary: e.summary ? stripHtml(e.summary).slice(0, 300) : null
        });
      }
    } catch (err) {
      console.error("Error en fuente:", s.name || s.url, err.message || err);
    }
  }

  // dedupe por url
  const map = new Map();
  for (const it of items) if (!map.has(it.url)) map.set(it.url, it);
  const deduped = Array.from(map.values());

  // ordenar por fecha si existe
  deduped.sort((a,b) => {
    const ta = a.published_at ? Date.parse(a.published_at) : 0;
    const tb = b.published_at ? Date.parse(b.published_at) : 0;
    return tb - ta;
  });

  ensureDir(OUTPUT_DIR);
  const out = {
    updated_at: new Date().toISOString(),
    count: deduped.length,
    items: deduped.slice(0, MAX_ITEMS)
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log("OK ->", OUTPUT_FILE, "items:", out.items.length);
}

main().catch(e => { console.error(e); process.exit(1); });
