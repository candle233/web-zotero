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
      CREATE TABLE IF NOT EXISTS note_versions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        item_key     TEXT NOT NULL,
        content      TEXT NOT NULL DEFAULT '',
        content_html TEXT,
        version      INTEGER NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS note_versions_item_idx ON note_versions (item_key, id);
      CREATE TABLE IF NOT EXISTS ai_summaries (
        item_key     TEXT PRIMARY KEY,
        provider     TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS formula_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        latex       TEXT NOT NULL,
        item_key    TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_items (
        key           TEXT PRIMARY KEY,
        item_type     TEXT NOT NULL DEFAULT 'journalArticle',
        title         TEXT NOT NULL,
        creators_json TEXT NOT NULL DEFAULT '[]',
        fields_json   TEXT NOT NULL DEFAULT '{}',
        imported_at   TEXT NOT NULL
      );
    `);
    // Rich-text notes (R7): sanitized TipTap HTML alongside the plain-text column.
    try {
      this.database.exec('ALTER TABLE web_notes ADD COLUMN content_html TEXT');
    } catch {
      // Column already exists.
    }
    // Optimistic concurrency for note editing (R9b): monotonically increasing
    // per-note version; writers send the version they based their edit on.
    try {
      this.database.exec('ALTER TABLE web_notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    } catch {
      // Column already exists.
    }
  }

  getNote(itemKey) {
    return this.database.prepare(
      'SELECT item_key AS itemKey, content, content_html AS html, updated_at AS updatedAt, version FROM web_notes WHERE item_key = ?'
    ).get(itemKey) || { itemKey, content: '', html: null, updatedAt: null, version: 0 };
  }

  listAllNotes() {
    return this.database.prepare(`
      SELECT item_key AS itemKey, content, content_html AS html, updated_at AS updatedAt, version
      FROM web_notes ORDER BY datetime(updated_at) DESC
    `).all().map(r => ({
      itemKey: r.itemKey,
      content: r.content,
      html: r.html,
      updatedAt: r.updatedAt,
      version: Number(r.version)
    }));
  }

  /**
   * Saves a note with optimistic concurrency (R9b): when expectedVersion is
   * given and differs from the stored one, throws 409 carrying the server's
   * current note so the caller can merge. Every accepted save archives the
   * replaced version (last 20 kept per item).
   */
  saveNote(itemKey, content, html = null, expectedVersion = null) {
    const httpError = status => Object.assign(new Error('version conflict'), { statusCode: status });
    const existing = this.getNote(itemKey);
    if (expectedVersion != null && existing.updatedAt && Number(expectedVersion) !== existing.version) {
      throw Object.assign(httpError(409), { currentNote: existing });
    }
    const previousVersion = existing.version || 0;
    const updatedAt = new Date().toISOString();
    const nextVersion = previousVersion + 1;
    if (existing.updatedAt) {
      this.database.prepare(`
        INSERT INTO note_versions(item_key, content, content_html, version, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(String(itemKey), existing.content || '', existing.html ?? null, previousVersion, existing.updatedAt);
      this.database.prepare(`
        DELETE FROM note_versions WHERE item_key = ? AND id NOT IN (
          SELECT id FROM note_versions WHERE item_key = ? ORDER BY id DESC LIMIT 20
        )
      `).run(String(itemKey), String(itemKey));
    }
    this.database.prepare(`
      INSERT INTO web_notes(item_key, content, content_html, updated_at, version) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET
        content = excluded.content, content_html = excluded.content_html,
        updated_at = excluded.updated_at, version = excluded.version
    `).run(itemKey, String(content || ''), html, updatedAt, nextVersion);
    return { itemKey, content: String(content || ''), html, updatedAt, version: nextVersion };
  }

  listNoteVersions(itemKey, limit = 20) {
    return this.database.prepare(`
      SELECT id, version, content, content_html AS html, created_at AS createdAt
      FROM note_versions WHERE item_key = ? ORDER BY version DESC LIMIT ?
    `).all(String(itemKey), Math.min(50, Math.max(1, Number(limit) || 20)))
      .map(row => ({ ...row, html: row.html ?? null }));
  }

  deleteNote(itemKey) {
    const existed = Boolean(this.getNote(itemKey).updatedAt);
    this.database.prepare('DELETE FROM web_notes WHERE item_key = ?').run(String(itemKey));
    return { ok: true, deleted: existed };
  }

  // ---------------------------------------------------------------------------
  // Web-layer imported items (batch BibTeX/RIS import): stored beside — never
  // inside — the read-only Zotero database.
  // ---------------------------------------------------------------------------

  saveImported(records) {
    const now = new Date().toISOString();
    const insert = this.database.prepare(`
      INSERT INTO web_items(key, item_type, title, creators_json, fields_json, imported_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        item_type = excluded.item_type, title = excluded.title,
        creators_json = excluded.creators_json, fields_json = excluded.fields_json,
        imported_at = excluded.imported_at
    `);
    const saved = [];
    for (const record of records) {
      insert.run(
        String(record.key),
        String(record.itemType || 'journalArticle'),
        String(record.title || 'Untitled').slice(0, 2000),
        JSON.stringify(record.creators || []),
        JSON.stringify(record.fields || {}),
        now
      );
      saved.push(record.key);
    }
    return { ok: true, keys: saved, importedAt: now };
  }

  listImported() {
    return this.database.prepare(`
      SELECT key, item_type AS itemType, title, creators_json, fields_json, imported_at AS dateModified
      FROM web_items ORDER BY datetime(imported_at) DESC
    `).all().map(row => ({
      id: null,
      key: row.key,
      title: row.title,
      itemType: row.itemType,
      creators: JSON.parse(row.creators_json).map(person =>
        [person.firstName, person.lastName].filter(Boolean).join(' ') || person.name || ''),
      pdfCount: 0,
      noteCount: 0,
      dateAdded: row.dateModified,
      dateModified: row.dateModified,
      imported: true
    }));
  }

  getImported(key) {
    const row = this.database.prepare(`
      SELECT key, item_type AS itemType, title, creators_json, fields_json, imported_at AS importedAt
      FROM web_items WHERE key = ?
    `).get(String(key));
    if (!row) return null;
    return {
      ...row,
      creators: JSON.parse(row.creators_json),
      fields: JSON.parse(row.fields_json)
    };
  }

  getCachedSummary(itemKey) {
    const row = this.database.prepare(
      'SELECT provider, payload_json AS payload, created_at AS createdAt FROM ai_summaries WHERE item_key = ?'
    ).get(String(itemKey));
    if (!row) return null;
    try {
      return { provider: row.provider, createdAt: row.createdAt, ...JSON.parse(row.payload) };
    } catch {
      return null;
    }
  }

  cacheSummary(itemKey, provider, payload) {
    this.database.prepare(`
      INSERT INTO ai_summaries(item_key, provider, payload_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET
        provider = excluded.provider, payload_json = excluded.payload_json,
        created_at = excluded.created_at
    `).run(String(itemKey), String(provider), JSON.stringify(payload), new Date().toISOString());
  }

  /** Reading stats: items with recorded progress, most recent first. */
  readingStats(limit = 20) {
    const rows = this.database.prepare(`
      SELECT rp.item_key AS itemKey, rp.scroll_percent AS percent, rp.updated_at AS updatedAt
      FROM reading_progress rp
      WHERE rp.scroll_percent > 0
      ORDER BY datetime(rp.updated_at) DESC LIMIT ?
    `).all(Math.min(100, Math.max(1, Number(limit) || 20)));
    const started = this.database.prepare(
      'SELECT COUNT(*) AS n FROM reading_progress WHERE scroll_percent > 0'
    ).get().n;
    const finished = this.database.prepare(
      'SELECT COUNT(*) AS n FROM reading_progress WHERE scroll_percent >= 95'
    ).get().n;
    return { started, finished, recent: rows };
  }

  saveFormula(latex, itemKey = null) {
    const now = new Date().toISOString();
    const result = this.database.prepare(
      'INSERT INTO formula_history(latex, item_key, created_at) VALUES (?, ?, ?)'
    ).run(String(latex).slice(0, 10000), itemKey ? String(itemKey) : null, now);
    return { id: Number(result.lastInsertRowid), latex: String(latex), itemKey, createdAt: now };
  }

  listFormulas(limit = 30) {
    return this.database.prepare(`
      SELECT id, latex, item_key AS itemKey, created_at AS createdAt
      FROM formula_history ORDER BY id DESC LIMIT ?
    `).all(Math.min(100, Math.max(1, Number(limit) || 30)));
  }

  deleteFormula(id) {
    const result = this.database.prepare('DELETE FROM formula_history WHERE id = ?').run(Number(id));
    return { ok: true, deleted: Number(result.changes) > 0 };
  }

  deleteImported(key) {
    const result = this.database.prepare('DELETE FROM web_items WHERE key = ?').run(String(key));
    return { ok: true, deleted: Number(result.changes) > 0 };
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

  close() {
    this.database.close();
  }
}

module.exports = { WebStore };
