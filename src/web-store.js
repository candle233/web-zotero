'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class WebStore {
  constructor(dataDir) {
    this.database = new DatabaseSync(path.join(dataDir, 'web-data.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
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
  }

  getNote(itemKey) {
    return this.database.prepare('SELECT item_key AS itemKey, content, updated_at AS updatedAt FROM web_notes WHERE item_key = ?').get(itemKey) || { itemKey, content: '', updatedAt: null };
  }

  saveNote(itemKey, content) {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO web_notes(item_key, content, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(itemKey, String(content || ''), updatedAt);
    return { itemKey, content: String(content || ''), updatedAt };
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
}

module.exports = { WebStore };
