'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class WebStore {
  constructor(dataDir) {
    this.database = new DatabaseSync(path.join(dataDir, 'web-data.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS web_notes (
        item_key TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reading_progress (
        item_key TEXT PRIMARY KEY,
        scroll_percent REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    // Rich-text notes (R7): sanitized TipTap HTML alongside the plain-text column.
    try {
      this.database.exec('ALTER TABLE web_notes ADD COLUMN content_html TEXT');
    } catch {
      // Column already exists.
    }
  }

  getNote(itemKey) {
    return this.database.prepare(
      'SELECT item_key AS itemKey, content, content_html AS html, updated_at AS updatedAt FROM web_notes WHERE item_key = ?'
    ).get(itemKey) || { itemKey, content: '', html: null, updatedAt: null };
  }

  saveNote(itemKey, content, html = null) {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO web_notes(item_key, content, content_html, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET
        content = excluded.content, content_html = excluded.content_html, updated_at = excluded.updated_at
    `).run(itemKey, String(content || ''), html, updatedAt);
    return { itemKey, content: String(content || ''), html, updatedAt };
  }

  saveProgress(itemKey, percent) {
    const bounded = Math.min(100, Math.max(0, Number(percent) || 0));
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO reading_progress(item_key, scroll_percent, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET scroll_percent = excluded.scroll_percent, updated_at = excluded.updated_at
    `).run(itemKey, bounded, updatedAt);
    return { itemKey, scrollPercent: bounded, updatedAt };
  }

  getProgress(itemKey) {
    return this.database.prepare('SELECT item_key AS itemKey, scroll_percent AS scrollPercent, updated_at AS updatedAt FROM reading_progress WHERE item_key = ?').get(itemKey) || { itemKey, scrollPercent: 0 };
  }

  /**
   * Backlinks for wiki-style note links: notes whose text contains
   * "[[title]]" for the given item title. LIKE is only a prefilter; the
   * exact substring check handles LIKE wildcards inside the title.
   */
  mentions(title) {
    const needle = `[[${String(title || '')}]]`;
    if (!String(title || '').trim()) return [];
    const rows = this.database.prepare(
      "SELECT item_key, content, content_html, updated_at FROM web_notes WHERE content LIKE ? OR content_html LIKE ?"
    ).all(`%${title}%`, `%${title}%`);
    return rows
      .filter(row => String(row.content || '').includes(needle)
        || String(row.content_html || '').includes(needle))
      .map(row => ({ itemKey: row.item_key, updatedAt: row.updated_at }));
  }
}

module.exports = { WebStore };
