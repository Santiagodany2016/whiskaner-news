/* build.js - Whiskaner News feed builder
 * Node 20.x (tiene fetch global). Requiere:
 *   - rss-parser
 *   - yaml
 *
 * Asegúrate que package.json incluya (si usas deps):
 *   "rss-parser": "^3.12.0",
 *   "yaml": "^2.4.0"
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const Parser = require('rss-parser');

const parser = new Parser({
  timeout: 20000,
  headers: { 'user-agent': 'whiskaner-news/1.0' }
});

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, 'docs');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'feed.json');

const MAX_ITEMS = parseInt(process.env.MAX_ITEMS || '800', 10);
const VIDEO_MIN = parseInt(process.env.VIDEO_MIN || '100', 10); // cupo mínimo de videos

const YT_KEY = process.env.YT_API_KEY;

// ---------- utilidades ----------
function safeDate(d) {
  const t = new Date(d);
  return isNaN(t.getTime()) ? null : t.toISOString();
}

function normalizeItem(base) {
  // Campos mínimos y normalización de fechas
  const published = base.published_at || base.pubDate || base.isoDate || base.date;
  const published_at = safeDate(published) || new Date(0).toISOString();
  return {
    id: base.id || base.url || base.link,
    type: base.type || 'article',
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
  // Se espera una lista de objetos con al menos { type, url, source?, region? }
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
    console.log(`RSS: ${kind.padEnd(7)} -> ${items.length} items (${meta.source || url})`);
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
    // Nota: NO incluir fuentes de YouTube por RSS (tal como pediste)
    if (!s || !s.type || !s.url) continue;
    const kind = s.type.toLowerCase().trim();
    if (kind === 'article' || kind === 'podcast') {
      tasks.push(fetchFeed(s.url, kind, { source: s.source, region: s.region }));
    }
  }
  const results = await Promise.all(tasks);
  return results.flat();
}

// ---------- YouTube ----------
async function loadYouTubeItems() {
  console.log('YouTube: verificando prerequisitos...');
  const ytPath = path.resolve(ROOT, 'youtube_channels.json');
  if (!YT_KEY) {
    console.warn('YouTube: YT_API_KEY ausente -> se omite YouTube');
    return [];
  }
  if (!fs.existsSync(ytPath)) {
    console.warn('YouTube: youtube_channels.json no encontrado en raíz -> se omite YouTube');
    return [];
  }

  let channels = [];
  try {
    channels = JSON.parse(fs.readFileSync(ytPath, 'utf8'));
    if (!Array.isArray(channels)) throw new Error('Formato inválido (no array).');
  } catch (e) {
    console.warn(`YouTube: error leyendo youtube_channels.json :: ${e.message}`);
    return [];
  }

  console.log(`YouTube: ${channels.length} canales`);

  async function fetchChannelLatest(c) {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('key', YT_KEY);
    url.searchParams.set('channelId', c.channelId);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('order', 'date');
    url.searchParams.set('maxResults', '50'); // por página
    // Puedes paginar si lo necesitas (nextPageToken), 50 suele bastar

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      console.warn(`YouTube: canal ${c.name} -> error de red :: ${err.message}`);
      return [];
    }

    if (!res.ok) {
      const text = await res.text();
      console.warn(
        `YouTube: canal ${c.name} -> HTTP ${res.status} ${res.statusText} :: ${text.slice(0, 200)}`
      );
      return [];
    }

    const data = await res.json();
    const items = (data.items || []).map((v) =>
      normalizeItem({
        id: `yt:${v.id.videoId}`,
        type: 'video',
        url: `https://www.youtube.com/watch?v=${v.id.videoId}`,
        title: v.snippet.title,
        source: c.name,
        region: c.region || 'global',
        image:
          v.snippet.thumbnails?.medium?.url ||
          v.snippet.thumbnails?.high?.url ||
          v.snippet.thumbnails?.default?.url ||
          null,
        published_at: v.snippet.publishedAt
      })
    );

    console.log(`YouTube: canal ${c.name} -> ${items.length} videos`);
    return items;
  }

  const all = [];
  for (const c of channels) {
    const got = await fetchChannelLatest(c);
    all.push(...got);
  }
  return all;
}

// ---------- build ----------
async function main() {
  const started = Date.now();
  console.log('==== Build start ====');

  // 1) RSS (artículos / podcasts)
  const rssItems = await loadRssItems();

  // 2) YouTube (videos)
  const ytItems = await loadYouTubeItems();

  // 3) merge + dedupe
  let merged = dedupe([...rssItems, ...ytItems]);

  // 4) ordenar por fecha desc
  merged.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  // 5) reservar cupo para videos
  const videos = merged.filter((i) => i.type === 'video');
  const others = merged.filter((i) => i.type !== 'video');

  // Selección priorizada: primero un bloque mínimo de videos recientes,
  // luego completamos con el resto por fecha.
  const prioritized = [
    ...videos.slice(0, VIDEO_MIN),
    ...others
  ].sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  const finalItems = prioritized.slice(0, MAX_ITEMS);

  // 6) conteos
  const counts = finalItems.reduce((acc, it) => {
    acc[it.type] = (acc[it.type] || 0) + 1;
    return acc;
  }, {});
  console.log(`Conteo por tipo: ${JSON.stringify(counts, null, 2)}`);
  console.log(`OK -> docs/feed.json items: ${finalItems.length}`);

  // 7) escribir archivo
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

main().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
