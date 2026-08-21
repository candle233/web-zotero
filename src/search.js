'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class SearchIndex {
  constructor(dataDir, zoteroDatabase) {
    this.zoteroDatabase = zoteroDatabase;
    this.database = new DatabaseSync(path.join(dataDir, 'search-index.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(
        item_key UNINDEXED, attachment_key UNINDEXED, title, authors, text,
        tokenize = 'unicode61 remove_diacritics 2'
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
      const existing = new Set(this.database.prepare('SELECT DISTINCT item_key FROM documents').all().map(row => row.item_key));
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
               snippet(documents, 4, '<mark>', '</mark>', '…', 18) AS snippet,
               bm25(documents, 0, 0, 3, 1, 1) AS score
        FROM documents
        WHERE documents MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(matchQuery, Math.min(100, Math.max(1, limit)));
    } catch {
      return [];
    }
  }
}

module.exports = { SearchIndex };
