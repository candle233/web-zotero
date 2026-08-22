# Web Zotero

A lightweight, remotely accessible web companion for an existing local Zotero 7 library. It reads the live Zotero SQLite database in read-only mode and serves local storage PDFs directly, without modifying desktop data.

## Features

- Responsive library for desktop and mobile, with collection filtering and metadata browsing.
- Range-supported PDF streaming and browser-native PDF reading.
- Zotero full-text cache indexing and phrase search across available PDFs, plus zero-dependency semantic search (LSA over the corpus, Chinese/English tokenization) with hybrid ranking and LSA-based related-paper recommendations.
- RAG question answering over the indexed full text (`POST /api/ai/ask`): local extractive answers with cited passages, upgraded to OpenAI generation when `OPENAI_API_KEY` is set.
- Per-item web notes (plain text plus a TipTap rich-text editor at `/notes`), reading progress, and offline PDF copies stored separately under `data/`.
- Multi-user accounts with owner/editor/viewer roles (scrypt passwords, expiring bearer sessions), with backward-compatible single-password and open modes.
- Server-persisted web annotations (`/api/annotations`, viewport-normalized rects, per-user authorship).
- Local extractive AI reading, with optional OpenAI fallback/upgrade via `OPENAI_API_KEY`.
- Desktop plug-in inventory endpoint and compatibility guidance for installed XPIs.
- Citation export in APA and BibTeX, metadata export in CSV and JSON.
- Desktop annotations browsing plus Markdown/CSV export.
- Lexical related-paper recommendations and service health reporting.
- Interactive PDF annotator (React + PDF.js) at `/annotator` with viewport-normalized highlights, floating color/note toolbar, and a jump-to-page annotation sidebar; annotations sync to the server and mirror to localStorage offline; export as Markdown. Run `npm run build:annotator` after installing dev dependencies.
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

`WEB_PASSWORD` protects all API and file endpoints in single-password mode. If omitted, the service is open to anyone who can reach the configured network interface; always set it before remote exposure.

## Multi-user mode

Create the first account to switch the server from open/single-password mode to per-user accounts (the first account always becomes the workspace owner):

```powershell
npm run add-user -- you@example.com a-long-password --display "Your Name"
npm run add-user -- colleague@example.com another-password --role viewer
```

Roles: `owner` (manage users, full write), `editor` (read + write), `viewer` (read-only). Clients log in via `POST /api/auth` `{email, password}` and use the returned bearer token; `WEB_PASSWORD` keeps working as an owner-level operator password. Sessions expire after 30 days and can be revoked by deleting the user or changing their password.

## Run

```powershell
npm install
npm start
```

Open the printed `http://<LAN-IP>:8420` address on a phone or computer. For access outside the LAN, place the service behind a TLS reverse proxy or VPN.

## Development

```powershell
npm test                # unit tests (AI, recommendations, metadata, citations, users, annotations, note sanitizer, semantic/LSA, PDF coordinates) + typecheck
npm run typecheck       # TypeScript check of the React components (annotator, notes editor)
npm run build:annotator # bundle the /annotator page into public/ (esbuild)
npm run build:notes     # bundle the /notes rich-text editor page into public/ (esbuild)
```

The annotator source lives in `src/pdf/` (coordinates, AnnotationLayer, PdfAnnotationViewer); the notes editor is `src/notes/notes-entry.tsx`; the metadata pipeline is `src/metadata.js` and the CSL engine is `src/citation-service.js`. User accounts and web annotations live in `src/users.js` / `src/annotations-store.js`; rich-note HTML is sanitized server-side in `src/notes-html.js`. Semantic retrieval (LSA) is `src/semantic.js` and RAG answering is `src/ask.js`; the LSA space rebuilds automatically after each full-text index rebuild and persists to `data/semantic-index.sqlite`.

## Safety model

- Zotero SQLite is opened read-only.
- PDF paths are constrained to the resolved Zotero attachment directory.
- Web notes and progress are stored outside Zotero's database.
- Desktop XPI plug-ins are listed for compatibility; browser pages cannot safely execute Zotero XPI code directly.
