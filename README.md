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

## Safety model

- Zotero SQLite is opened read-only.
- PDF paths are constrained to the resolved Zotero attachment directory.
- Web notes and progress are stored outside Zotero's database.
- Desktop XPI plug-ins are listed for compatibility; browser pages cannot safely execute Zotero XPI code directly.
