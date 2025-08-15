import { parse } from 'rss-parser';
import YAML from 'yaml';
import fs from 'fs/promises';
import path from 'path';

const MAX_ITEMS = 800;
const USER_AGENT = 'whiskaner-news/1.0';

async function main() {
  try {
    console.log('📰 Iniciando construcción de feed...');
    
    // Leer fuentes
    const sourcesYaml = await fs.readFile('./sources.yaml', 'utf-8');
    const sources = YAML.parse(sourcesYaml).feeds;

    let allItems = [];
    
    // Procesar cada fuente
    for (const source of sources) {
      if (!['article', 'podcast'].includes(source.type)) {
        console.warn(`⚠️  Tipo '${source.type}' ignorado para ${source.url}`);
        continue;
      }

      try {
        console.log(`🔍 Procesando ${source.source}...`);
        const parser = new parse({
          timeout: 20000,
          headers: { 'User-Agent': USER_AGENT }
        });

        const feed = await parser.parseURL(source.url);
        
        // Normalizar items
        const normalizedItems = feed.items.map(item => ({
          id: item.guid || item.link.toLowerCase(),
          type: source.type,
          url: item.link,
          title: item.title.trim(),
          source: source.source,
          region: source.region,
          image: source.type === 'article' && item.enclosure?.url ? item.enclosure.url : null,
          published_at: item.isoDate || item.pubDate || new Date(0).toISOString()
        }));

        allItems.push(...normalizedItems);
      } catch (error) {
        console.error(`❌ Error procesando ${source.url}:`, error.message);
      }
    }

    // Deduplicar y ordenar
    const uniqueItems = Array.from(
      new Map(allItems.map(item => [item.id, item])).values()
    ).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

    // Limitar cantidad
    const limitedItems = uniqueItems.slice(0, MAX_ITEMS);

    // Crear directorio docs si no existe
    await fs.mkdir('./docs', { recursive: true });

    // Escribir archivo
    const output = {
      generated_at: new Date().toISOString(),
      total: limitedItems.length,
      items: limitedItems
    };

    await fs.writeFile('./docs/feed.json', JSON.stringify(output, null, 2));
    console.log(`✅ Feed generado con ${limitedItems.filter(i => i.type === 'article').length} artículos y ${limitedItems.filter(i => i.type === 'podcast').length} podcasts`);

  } catch (error) {
    console.error('❌ Error crítico:', error);
    process.exit(1);
  }
}

main();
