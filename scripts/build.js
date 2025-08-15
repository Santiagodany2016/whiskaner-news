// build.js - Whiskaner News feed builder (solo RSS, ESM)
// Node 20.x (fetch global). Requiere deps:
//   - "rss-parser"
//   - "yaml"

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Parser from 'rss-parser';

const parser = new Parser({
  timeout: 20000,
  headers: { 'user-agent': 'whiskaner-news/1.0' }
});

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, 'docs');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'feed.json');

const MAX_ITEMS = parseInt(process.env.MAX_ITEMS || '800', 10);

// ---------- utilidades ----------
function safeDate(d) {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function normalizeItem(base) {
  const published =
    base.published_at || base.pubDate || base.isoDate || base.date;
  const published_at = safeDate(published) || new Date(0).toISOString();
  return {
    id: base.id || base.url || base.link,
    type: base.type || 'article', // article | podcast
    url: base.url || base.link,
    title: (base.title || '').toString().trim(),
    source: base.source || '',
    region: base.region || 'global',
    image: base.image || base.enclosure?.url || null,
    published_at
  };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.id || it.url || '').toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---------- RSS (artículos / podcasts) ----------
async function loadSourcesYaml() {
  const p = path.join(ROOT, 'sources.yaml');
  if (!fs.existsSync(p)) {
    console.warn('sources.yaml no encontrado, se omiten RSS.');
    return [];
  }
  const raw = fs.readFileSync(p, 'utf8');
  const data = YAML.parse(raw);
  if (!Array.isArray(data)) {
    console.warn('sources.yaml no es una lista; se omiten RSS.');
    return [];
  }
  return data;
}

async function fetchFeed(url, kind, meta = {}) {
  try {
    const feed = await parser.parseURL(url);
    const items = (feed.items || []).map((it) =>
      normalizeItem({
        type: kind, // 'article' o 'podcast'
        url: it.link,
        title: it.title,
        source: meta.source || feed.title || '',
        region: meta.region || 'global',
        image: it.enclosure?.url || null,
        published_at: it.isoDate || it.pubDate
      })
    );
    console.log(
      `RSS: ${kind.padEnd(7)} -> ${items.length} items (${meta.source || url})`
    );
    return items;
  } catch (e) {
    console.warn(`RSS: fallo al leer ${kind} :: ${url} :: ${e.message}`);
    return [];
  }
}

async function loadRssItems() {
  const sources = await loadSourcesYaml();
  const tasks = [];
  for (const s of sources) {
    // Solo article/podcast (NO YouTube por RSS)
    if (!s || !s.type || !s.url) continue;
    const kind = s.type.toLowerCase().trim();
    if (kind === 'article' || kind === 'podcast') {
      tasks.push(fetchFeed(s.url, kind, { source: s.source, region: s.region }));
    }
  }
  const results = await Promise.all(tasks);
  return results.flat();
}

// ---------- build ----------
async function main() {
  const started = Date.now();
  console.log('==== Build start (solo RSS, ESM) ====');

  // 1) RSS (artículos / podcasts)
  let merged = await loadRssItems();

  // 2) Filtrar cualquier "video" que pudiera colarse
  merged = merged.filter((i) => i.type !== 'video');

  // 3) dedupe + ordenar
  merged = dedupe(merged);
  merged.sort(
    (a, b) => new Date(b.published_at) - new Date(a.published_at)
  );

  const finalItems = merged.slice(0, MAX_ITEMS);

  // 4) conteos
  const counts = finalItems.reduce((acc, it) => {
    acc[it.type] = (acc[it.type] || 0) + 1;
    return acc;
  }, {});
  console.log(`Conteo por tipo: ${JSON.stringify(counts, null, 2)}`);
  console.log(`OK -> docs/feed.json items: ${finalItems.length}`);

  // 5) escribir archivo
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        total: finalItems.length,
        items: finalItems
      },
      null,
      2
    ),
    'utf8'
  );

  const ms = Date.now() - started;
  console.log(`==== Build end (${ms} ms) ====`);
}

try {
  await main();
} catch (e) {
  console.error('Build failed:', e);
  process.exit(1);
}
