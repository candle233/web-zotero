# Web Zotero

A lightweight, remotely accessible web companion for an existing local Zotero 7 library. It reads the live Zotero SQLite database in read-only mode and serves local storage PDFs directly, without modifying desktop data.

## Features

- Responsive library for desktop and mobile, with collection filtering and metadata browsing.
- Range-supported PDF streaming and browser-native PDF reading.
- Zotero full-text cache indexing and phrase search across available PDFs.
- Per-item web notes, reading progress, and offline PDF copies stored separately under `data/`.
- Local extractive AI reading, with optional OpenAI fallback/upgrade via `OPENAI_API_KEY`.
- Desktop plug-in inventory endpoint and compatibility guidance for installed XPIs.
- Citation export in APA and BibTeX, metadata export in CSV and JSON.
- Desktop annotations browsing plus Markdown/CSV export.
- Lexical related-paper recommendations and service health reporting.
- Interactive PDF annotator (React + PDF.js) at `/annotator` with viewport-normalized highlights, floating color/note toolbar, and a jump-to-page annotation sidebar; export as Markdown. Run `npm run build:annotator` after installing dev dependencies.
- Metadata ingestion API: paste a DOI, arXiv ID, ISBN or BibTeX and get normalized item metadata (`POST /api/metadata/resolve`), with DOI content negotiation and Crossref fallback.
- CSL citation engine (`POST /api/citations/format`, `GET /api/citations/styles`): citeproc-js with bundled `apa`, `ieee`, `nature`, `gb-t-7714-2015` styles and `en-US`/`zh-CN` locales, plus a graceful fallback formatter.

See `ARCHITECTURE.md` for the full architecture blueprint (stack rationale, data flow, API spec, roadmap) and `db/schema.sql` for the PostgreSQL schema of the multi-user build.

## Requirements

- Node.js 22.5+ (uses the built-in SQLite module).
- Zotero 7 with a local SQLite database and PDF storage.
- Zotero must have generated `.zotero-ft-cache` files for full-text search/AI analysis.

## Configuration

Create `.env` in this folder:

```dotenv
PORT=8420
HOST=0.0.0.0
ZOTERO_DATABASE=C:\Users\example\Zotero\zotero.sqlite
ZOTERO_STORAGE=C:\Users\example\Zotero\storage
ZOTERO_PROFILE_ROOT=C:\Users\example\AppData\Roaming\Zotero\Zotero\Profiles\example.default
WEB_PASSWORD=change-this-strong-password
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
DATA_DIR=./data
```

`WEB_PASSWORD` protects all API and file endpoints. If omitted, the service is open to anyone who can reach the configured network interface; always set it before remote exposure.

## Run

```powershell
npm install
npm start
```

Open the printed `http://<LAN-IP>:8420` address on a phone or computer. For access outside the LAN, place the service behind a TLS reverse proxy or VPN.

## Development

```powershell
npm test                # unit tests (AI, recommendations, metadata, citations, PDF coordinates) + typecheck
npm run typecheck       # TypeScript check of the React/PDF.js annotator components
npm run build:annotator # bundle the /annotator page into public/ (esbuild)
```

The annotator source lives in `src/pdf/` (coordinates, AnnotationLayer, PdfAnnotationViewer); the metadata pipeline is `src/metadata.js` and the CSL engine is `src/citation-service.js`.

## Safety model

- Zotero SQLite is opened read-only.
- PDF paths are constrained to the resolved Zotero attachment directory.
- Web notes and progress are stored outside Zotero's database.
- Desktop XPI plug-ins are listed for compatibility; browser pages cannot safely execute Zotero XPI code directly.
