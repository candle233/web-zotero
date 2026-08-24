# Web Zotero

A lightweight, remotely accessible web companion for an existing local Zotero 7 library. It reads the live Zotero SQLite database in read-only mode and serves local storage PDFs directly, without modifying desktop data.

## Features

- Responsive library for desktop and mobile, with collection filtering and metadata browsing.
- Range-supported PDF streaming and browser-native PDF reading, with automatic fallback: browsers that cannot render PDFs inside an iframe (iOS Safari, in-app browsers) get a card linking to the PDF.js annotator and a new-tab open, plus always-available toolbar escape hatches.
- Zotero full-text cache indexing and phrase search across available PDFs, plus zero-dependency semantic search (LSA over the corpus, Chinese/English tokenization) with hybrid ranking and LSA-based related-paper recommendations.
- RAG question answering over the indexed full text (`POST /api/ai/ask`): local extractive answers with cited passages, upgraded to OpenAI generation when `OPENAI_API_KEY` is set.
- Per-item web notes (plain text plus a TipTap rich-text editor at `/notes`), reading progress, and offline PDF copies stored separately under `data/`.
- Multi-user accounts with owner/editor/viewer roles (scrypt passwords, expiring bearer sessions), with backward-compatible single-password and open modes.
- Server-persisted web annotations (`/api/annotations`, viewport-normalized rects, per-user authorship) with **live sync**: annotation changes stream to every open page over Server-Sent Events (`/api/events`, zero-dependency), so multiple tabs or users see highlights appear in real time.
- Wiki-style bidirectional note links: type `[[` in the rich-text editor to link any library item; item pages render the links and show a "Mentioned in" backlink panel (`GET /api/items/:key/mentions`).
- Local extractive AI reading, with optional OpenAI fallback/upgrade via `OPENAI_API_KEY`.
- Desktop plug-in inventory endpoint and compatibility guidance for installed XPIs.
- Citation export in APA and BibTeX, metadata export in CSV and JSON.
- Desktop annotations browsing plus Markdown/CSV export.
- Lexical related-paper recommendations and service health reporting.
- Interactive PDF annotator (React + PDF.js) at `/annotator` with viewport-normalized highlights, floating color/note toolbar, and a jump-to-page annotation sidebar; annotations sync to the server and mirror to localStorage offline; export as Markdown. Run `npm run build:annotator` after installing dev dependencies.
- Metadata ingestion API: paste a DOI, arXiv ID, ISBN or BibTeX and get normalized item metadata (`POST /api/metadata/resolve`), with DOI content negotiation and Crossref fallback. The sidebar "Fetch" box runs it from the UI and renders a metadata card with a live citation preview.
- CSL citation engine (`POST /api/citations/format`, `GET /api/citations/styles`): citeproc-js with bundled `apa`, `ieee`, `nature`, `gb-t-7714-2015` styles and `en-US`/`zh-CN` locales, plus a graceful fallback formatter. Item detail and the lookup card share a citation panel with style/language/mode switching and one-click copy.

See `ARCHITECTURE.md` for the full architecture blueprint (stack rationale, data flow, API spec, roadmap) and `db/schema.sql` for the PostgreSQL schema of the multi-user build.

## Requirements

- Node.js 22.5+ (uses the built-in SQLite module).
- Zotero 7 with a local SQLite database and PDF storage.
- Zotero must have generated `.zotero-ft-cache` files for full-text search/AI analysis.

## Configuration

Create `.env` in this folder:

```dotenv
PORT=8420
# Loopback by default. Set HOST=0.0.0.0 to reach the server from other
# devices — and always configure WEB_PASSWORD or user accounts first.
HOST=127.0.0.1
ZOTERO_DATABASE=C:\Users\example\Zotero\zotero.sqlite
ZOTERO_STORAGE=C:\Users\example\Zotero\storage
ZOTERO_PROFILE_ROOT=C:\Users\example\AppData\Roaming\Zotero\Zotero\Profiles\example.default
WEB_PASSWORD=change-this-strong-password
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
DATA_DIR=./data
```

`WEB_PASSWORD` protects all API and file endpoints in single-password mode. If omitted, the service is open to anyone who can reach the configured network interface; always set it before remote exposure. Login attempts are rate-limited (10 failures per IP per 5 minutes); use `POST /api/auth/logout` to revoke a session token.

## Formula OCR (one-click LaTeX from PDFs)

The PDF annotator has a `∑ LaTeX` toolbar mode: drag a box around any formula and the recognized LaTeX is copied to your clipboard automatically (with an editable result panel as fallback). Recognition runs through [Pix2Text](https://github.com/breezedeus/Pix2Text), an open-source Mathpix alternative that runs as a separate local service:

```powershell
pip install pix2text
p2t serve -l en,ch_sim -H 127.0.0.1 -p 8503
```

Optional `.env` settings: `FORMULA_OCR_URL` (default `http://127.0.0.1:8503/pix2text`) points the proxy at your instance — the Node server stays dependency-free and only forwards cropped PNGs via `POST /api/formula-ocr`.

## Multi-user mode

Create the first account to switch the server from open/single-password mode to per-user accounts (the first account always becomes the workspace owner):

```powershell
npm run add-user -- you@example.com a-long-password --display "Your Name"
npm run add-user -- colleague@example.com another-password --role viewer
```

Roles: `owner` (manage users, full write), `editor` (read + write), `viewer` (read-only). Clients log in via `POST /api/auth` `{email, password}` and use the returned bearer token; `WEB_PASSWORD` keeps working as an owner-level operator password. Sessions expire after 30 days and can be revoked by deleting the user or changing their password.

### Account self-service

Signed-in users manage their own account without owner help:

- `POST /api/me/password` `{currentPassword, newPassword}` — rotates the password and returns a fresh token (previous sessions are revoked)
- `GET /api/me/sessions` — lists active sessions with a `current` flag
- `DELETE /api/me/sessions/:ref` — revokes one session by its `ref`

## Live sync & offline

- Annotation changes stream to every open page over `GET /api/events` (SSE). Reconnecting clients send `Last-Event-ID` (or `?lastEventId=`) and receive everything they missed from a 200-event replay buffer; event ids are time-seeded so they stay monotonic across server restarts.
- Offline PDF copies are manageable: save with `POST .../offline`, delete one copy with `DELETE /api/items/:key/files/:att/offline`, or clear an entire item with `DELETE /api/items/:key/offline`.

## Library UI shortcuts

- `/` focuses the search box · `Esc` closes search/reader overlays
- `↑` / `↓` walk the library list

## Run

```powershell
npm install
npm start
```

Open the printed `http://<LAN-IP>:8420` address on a phone or computer. For access outside the LAN, place the service behind a TLS reverse proxy or VPN.

## Development

```powershell
npm test                # unit tests (AI, recommendations, metadata, citations, users, annotations, note sanitizer, semantic/LSA, SSE events, PDF coordinates) + typecheck
npm run typecheck       # TypeScript check of the React components (annotator, notes editor)
npm run build:annotator # bundle the /annotator page into public/ (esbuild)
npm run build:notes     # bundle the /notes rich-text editor page into public/ (esbuild)
```

The annotator source lives in `src/pdf/` (coordinates, AnnotationLayer, PdfAnnotationViewer); the notes editor is `src/notes/notes-entry.tsx`; the metadata pipeline is `src/metadata.js` and the CSL engine is `src/citation-service.js`. User accounts and web annotations live in `src/users.js` / `src/annotations-store.js`; rich-note HTML is sanitized server-side in `src/notes-html.js`. Semantic retrieval (LSA) is `src/semantic.js` and RAG answering is `src/ask.js`; the LSA space rebuilds automatically after each full-text index rebuild and persists to `data/semantic-index.sqlite`. The SSE event bus behind live annotation sync is `src/events.js`.

## Safety model

- Zotero SQLite is opened read-only.
- PDF paths are constrained to the resolved Zotero attachment directory.
- Web notes and progress are stored outside Zotero's database.
- Desktop XPI plug-ins are listed for compatibility; browser pages cannot safely execute Zotero XPI code directly.
