'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

// Snippet markers that cannot appear in PDF text; they survive FTS5 and get
// converted to <mark> only after the surrounding text is HTML-escaped, so a
// hostile text layer can never inject markup through snippet HTML.
const MARK_START = '\u0001';
const MARK_END = '\u0002';

function safeSnippet(rawSnippet) {
  return escapeHtml(rawSnippet)
    .replaceAll(MARK_START, '<mark>')
    .replaceAll(MARK_END, '</mark>');
}

class SearchIndex {
  constructor(dataDir, zoteroDatabase) {
    this.zoteroDatabase = zoteroDatabase;
    this.database = new DatabaseSync(path.join(dataDir, 'search-index.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(
        item_key UNINDEXED, attachment_key UNINDEXED, title, authors, text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS index_state (
        item_key TEXT PRIMARY KEY,
        indexed_at TEXT NOT NULL
      );
    `);
    this.indexing = false;
  }

  async reindex({ force = false, limit = Infinity } = {}) {
    if (this.indexing) return { started: false, message: 'Indexing is already running.' };
    this.indexing = true;
    const started = Date.now();
    try {
      const items = await this.zoteroDatabase.refreshItems();
      const candidates = items.filter(item => item.pdfCount > 0).slice(0, limit);
      const existing = new Map(this.database.prepare('SELECT item_key, indexed_at FROM index_state').all().map(row => [row.item_key, row.indexed_at]));
      let indexed = 0;
      let skipped = 0;
      for (const item of candidates) {
        if (!force && existing.has(item.key)) continue;
        const detail = this.zoteroDatabase.itemDetail(item.key);
        const attachment = detail.attachments.find(file => file.exists);
        if (!attachment) {
          skipped += 1;
          continue;
        }
        const textCache = path.join(this.zoteroDatabase.storagePath, attachment.key, '.zotero-ft-cache');
        try {
          const raw = await fsp.readFile(textCache, 'utf8');
          const text = raw.replace(/\s+/g, ' ').trim();
          if (!text) throw new Error('empty text cache');
          this.database.prepare('DELETE FROM documents WHERE item_key = ?').run(item.key);
          this.database.prepare('INSERT INTO documents(item_key, attachment_key, title, authors, text) VALUES (?, ?, ?, ?, ?)')
            .run(item.key, attachment.key, item.title, item.creators.join(' '), text.slice(0, 900000));
          const indexedAt = new Date().toISOString();
          this.database.prepare(`
            INSERT INTO index_state(item_key, indexed_at) VALUES (?, ?)
            ON CONFLICT(item_key) DO UPDATE SET indexed_at = excluded.indexed_at
          `).run(item.key, indexedAt);
          indexed += 1;
        } catch {
          skipped += 1;
        }
      }
      return { started: true, indexed, skipped, total: candidates.length, durationMs: Date.now() - started };
    } finally {
      this.indexing = false;
    }
  }

  status() {
    const count = this.database.prepare('SELECT COUNT(*) AS count FROM documents').get().count;
    return { indexed: count, running: this.indexing };
  }

  search(query, limit = 30) {
    const clean = String(query || '').replace(/["*()]/g, ' ').trim();
    if (!clean) return [];
    const terms = clean.split(/\s+/).filter(Boolean);
    const matchQuery = terms.map(term => `"${term.replace(/"/g, '')}"`).join(' OR ');
    try {
      return this.database.prepare(`
        SELECT item_key AS itemKey, attachment_key AS attachmentKey, title, authors,
               snippet(documents, 4, '${MARK_START}', '${MARK_END}', '…', 18) AS snippet,
               bm25(documents, 0, 0, 3, 1, 1) AS score
        FROM documents
        WHERE documents MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(matchQuery, Math.min(100, Math.max(1, limit)))
        .map(row => ({ ...row, snippet: safeSnippet(row.snippet), pageIndex: this.detectPage(row.attachmentKey, row.snippet) }));
    } catch {
      return [];
    }
  }

  /**
   * Best-effort 0-based page number for a snippet: Zotero's .zotero-ft-cache
   * keeps form feeds as page separators, so locate the snippet text in the
   * raw cache and count the form feeds before it. Returns null on any miss —
   * callers must treat the field as optional.
   */
  detectPage(attachmentKey, snippetHtml) {
    if (!attachmentKey || !this.zoteroDatabase?.storagePath) return null;
    try {
      const raw = fs.readFileSync(
        path.join(this.zoteroDatabase.storagePath, String(attachmentKey), '.zotero-ft-cache'),
        'utf8'
      );
      // \f -> space keeps every character offset identical (1:1 swap), so an
      // index found here maps straight back onto `raw` for counting markers.
      const finder = raw.replace(/[ \t\r\n\f]+/g, ' ');
      const plain = snippetHtml.replace(/<mark>|<\/mark>/g, '').replace(/&[a-z0-9#]+;/gi, ' ');
      const candidates = [];
      for (const segment of plain.split('…')) {
        const piece = segment.replace(/[ \t\r\n]+/g, ' ').trim();
        if (piece.length >= 12) candidates.push(piece.slice(0, 100));
      }
      let index = -1;
      for (const candidate of candidates) {
        index = finder.indexOf(candidate);
        if (index >= 0) break;
        if (candidate.length > 24) {
          index = finder.indexOf(candidate.slice(0, 24));
          if (index >= 0) break;
        }
      }
      if (index < 0) return null;
      return raw.slice(0, index).split('\f').length - 1;
    } catch {
      return null;
    }
  }
}

module.exports = { SearchIndex };
