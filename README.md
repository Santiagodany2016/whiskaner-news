# Whisky News – Feed estático (sin base de datos)

Este proyecto genera **`docs/feed.json`** a partir de una lista de **feeds RSS/Atom** y lo publica como archivo estático (ideal para **GitHub Pages**). Tu app solo hace `GET` a ese JSON y pinta las noticias.

## 🚀 Cómo usarlo (paso a paso)

### 1) Crea tu repositorio
1. Crea un repo nuevo en GitHub (por ejemplo `whisky-news`).
2. Sube estos archivos (o arrastra el zip descomprimido).

### 2) Edita tus fuentes
Abre **`sources.yaml`** y añade/edita tus feeds. Cada fuente necesita:
- `name`: nombre de la fuente
- `url`: URL del RSS/Atom (o de YouTube RSS de un canal)
- `type`: `article`, `video`, `podcast`, `book`, `event`
- `region`: `global`, `us`, `uk`, `jp`, etc.

> 💡 Cómo encontrar RSS: visita la web, **ver código fuente** y busca `rss` / `atom` / `application/rss+xml`. O prueba añadiendo `/feed` al dominio. En YouTube: `https://www.youtube.com/feeds/videos.xml?channel_id=TU_ID`.

### 3) Habilita GitHub Pages
1. En **Settings → Pages**:  
   - **Source**: *Deploy from a branch*  
   - **Branch**: `main` y **Folder**: `/docs`
2. Guarda. Tu sitio quedará en: `https://TU_USUARIO.github.io/NOMBRE_REPO/`

### 4) Activa el workflow
- Ve a **Actions** → habilita workflows si te lo pide.  
- Ejecuta manualmente **“Build & Publish Whisky Feed”** (botón *Run workflow*).  
- Se generará `docs/feed.json` y quedará publicado.  
- A partir de ahí, **se ejecuta automático cada hora** (puedes ajustar el cron).

### 5) Consume el JSON desde tu app
Haz un `GET` a:
```
https://TU_USUARIO.github.io/NOMBRE_REPO/feed.json
```
o si usas la carpeta `/docs` por defecto:
```
https://TU_USUARIO.github.io/NOMBRE_REPO/docs/feed.json
```
(Selecciona la ruta que muestre tu Pages; por defecto servirá `docs/*` en la raíz).

La estructura del JSON es:
```json
{
  "updated_at": "2025-01-01T00:00:00.000Z",
  "count": 123,
  "items": [
    {
      "id": "https://…",
      "title": "…",
      "url": "https://…",
      "source": "whiskyadvocate.com",
      "type": "article",
      "region": "us",
      "published_at": "2025-01-01T10:00:00.000Z",
      "image": "https://…",
      "summary": "… (opcional)"
    }
  ]
}
```

---

## ⚙️ Personalización rápida
- Cambia el intervalo en `.github/workflows/build.yml` → `cron: "0 * * * *"` (cada hora).  
- Límite de ítems: edita `MAX_ITEMS` en `scripts/build.js` (por defecto 500).  
- Resumen automático: define `ENABLE_SUMMARY=true` y añade tu clave en `OPENAI_API_KEY` como secret si quieres generar resúmenes (opcional, desactivado).

## ❓ Problemas comunes
- **No aparece `feed.json`**: ejecuta el workflow manualmente la primera vez.  
- **No carga en mi app**: revisa la URL exacta de Pages y CORS (GitHub Pages permite CORS público).  
- **Una fuente no actualiza**: verifica que su RSS funciona en el navegador.

---

## 🧪 Vista previa
Abre `docs/index.html` en el navegador (o visita tu GitHub Pages) para ver un listado simple de las noticias.

¡Listo! Sin servidores, sin base de datos. Solo un JSON estático siempre fresco.
