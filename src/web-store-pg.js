'use strict';

/**
 * PostgreSQL-backed WebStore — API-compatible with the SQLite WebStore
 * (src/web-store.js), fully async. Selected in server.js when DATABASE_URL
 * is set. Tables live in db/schema.sql (web_notes, note_versions,
 * reading_progress_web, web_items, formula_history, ai_summaries).
 */

const { Pool } = require('pg');

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/** JSONB columns may arrive as objects (pg parses them) — normalize. */
function asJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

class PgWebStore {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString: String(connectionString || '').trim(), max: 10 });
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  // ----------------------------------------------------------------- notes

  async getNote(itemKey) {
    const { rows } = await this.query(
      'SELECT item_key AS "itemKey", content, content_html AS html, updated_at AS "updatedAt", version FROM web_notes WHERE item_key = $1',
      [String(itemKey)]
    );
    const row = rows[0];
    if (!row) return { itemKey: String(itemKey), content: '', html: null, updatedAt: null, version: 0 };
    return {
      itemKey: row.itemKey,
      content: row.content || '',
      html: row.html ?? null,
      updatedAt: new Date(row.updatedAt).toISOString(),
      version: Number(row.version)
    };
  }

  async saveNote(itemKey, content, html = null, expectedVersion = null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existingRes = await client.query(
        'SELECT item_key AS "itemKey", content, content_html AS html, updated_at AS "updatedAt", version FROM web_notes WHERE item_key = $1 FOR UPDATE',
        [String(itemKey)]
      );
      const existingRow = existingRes.rows[0];
      const existing = existingRow
        ? {
            itemKey: existingRow.itemKey,
            content: existingRow.content || '',
            html: existingRow.html ?? null,
            updatedAt: new Date(existingRow.updatedAt).toISOString(),
            version: Number(existingRow.version)
          }
        : { itemKey: String(itemKey), content: '', html: null, updatedAt: null, version: 0 };

      if (expectedVersion != null && existing.updatedAt && Number(expectedVersion) !== existing.version) {
        throw Object.assign(httpError(409, 'version conflict'), { currentNote: existing });
      }

      const previousVersion = existing.version || 0;
      const nextVersion = previousVersion + 1;
      const now = new Date();

      if (existing.updatedAt) {
        await client.query(
          'INSERT INTO note_versions(item_key, content, content_html, version, created_at) VALUES ($1, $2, $3, $4, $5)',
          [String(itemKey), existing.content || '', existing.html ?? null, previousVersion, new Date(existing.updatedAt)]
        );
        await client.query(`
          DELETE FROM note_versions WHERE item_key = $1 AND id NOT IN (
            SELECT id FROM note_versions WHERE item_key = $1 ORDER BY id DESC LIMIT 20
          )
        `, [String(itemKey)]);
      }

      await client.query(`
        INSERT INTO web_notes(item_key, content, content_html, updated_at, version) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(item_key) DO UPDATE SET
          content = excluded.content, content_html = excluded.content_html,
          updated_at = excluded.updated_at, version = excluded.version
      `, [String(itemKey), String(content || ''), html, now, nextVersion]);

      await client.query('COMMIT');
      return { itemKey: String(itemKey), content: String(content || ''), html, updatedAt: now.toISOString(), version: nextVersion };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteNote(itemKey) {
    const existing = await this.getNote(itemKey);
    const existed = Boolean(existing.updatedAt);
    await this.query('DELETE FROM web_notes WHERE item_key = $1', [String(itemKey)]);
    return { ok: true, deleted: existed };
  }

  async listNoteVersions(itemKey, limit = 20) {
    const { rows } = await this.query(`
      SELECT id, version, content, content_html AS html, created_at AS "createdAt"
      FROM note_versions WHERE item_key = $1 ORDER BY version DESC LIMIT $2
    `, [String(itemKey), Math.min(50, Math.max(1, Number(limit) || 20))]);
    return rows.map(row => ({
      id: Number(row.id),
      version: Number(row.version),
      content: row.content || '',
      html: row.html ?? null,
      createdAt: new Date(row.createdAt).toISOString()
    }));
  }

  // -------------------------------------------------------------- progress

  async saveProgress(itemKey, percent) {
    const bounded = Math.min(100, Math.max(0, Number(percent) || 0));
    const now = new Date();
    const { rows } = await this.query(`
      INSERT INTO reading_progress_web(item_key, scroll_percent, updated_at) VALUES ($1, $2, $3)
      ON CONFLICT(item_key) DO UPDATE SET scroll_percent = excluded.scroll_percent, updated_at = excluded.updated_at
      RETURNING scroll_percent AS "scrollPercent", updated_at AS "updatedAt"
    `, [String(itemKey), bounded, now]);
    const row = rows[0];
    return {
      itemKey: String(itemKey),
      scrollPercent: Number(row.scrollPercent),
      updatedAt: new Date(row.updatedAt).toISOString()
    };
  }

  async getProgress(itemKey) {
    const { rows } = await this.query(
      'SELECT scroll_percent AS "scrollPercent", updated_at AS "updatedAt" FROM reading_progress_web WHERE item_key = $1',
      [String(itemKey)]
    );
    const row = rows[0];
    if (!row) return { itemKey: String(itemKey), scrollPercent: 0 };
    return {
      itemKey: String(itemKey),
      scrollPercent: Number(row.scrollPercent),
      updatedAt: new Date(row.updatedAt).toISOString()
    };
  }

  // ------------------------------------------------------- imported items

  async saveImported(records) {
    const now = new Date();
    const saved = [];
    for (const record of records) {
      await this.query(`
        INSERT INTO web_items(key, item_type, title, creators_json, fields_json, imported_at)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
        ON CONFLICT(key) DO UPDATE SET
          item_type = excluded.item_type, title = excluded.title,
          creators_json = excluded.creators_json, fields_json = excluded.fields_json,
          imported_at = excluded.imported_at
      `, [
        String(record.key),
        String(record.itemType || 'journalArticle'),
        String(record.title || 'Untitled').slice(0, 2000),
        JSON.stringify(record.creators || []),
        JSON.stringify(record.fields || {}),
        now
      ]);
      saved.push(record.key);
    }
    return { ok: true, keys: saved, importedAt: now.toISOString() };
  }

  async listImported() {
    const { rows } = await this.query(`
      SELECT key, item_type AS "itemType", title, creators_json, imported_at AS "importedAt"
      FROM web_items ORDER BY imported_at DESC
    `);
    return rows.map(row => {
      const creators = asJson(row.creators_json, []);
      const dateIso = new Date(row.importedAt).toISOString();
      return {
        id: null,
        key: row.key,
        title: row.title,
        itemType: row.itemType,
        creators: creators.map(person => [person.firstName, person.lastName].filter(Boolean).join(' ') || person.name || ''),
        pdfCount: 0,
        noteCount: 0,
        dateAdded: dateIso,
        dateModified: dateIso,
        imported: true
      };
    });
  }

  async getImported(key) {
    const { rows } = await this.query(`
      SELECT key, item_type AS "itemType", title, creators_json, fields_json, imported_at AS "importedAt"
      FROM web_items WHERE key = $1
    `, [String(key)]);
    const row = rows[0];
    if (!row) return null;
    return {
      key: row.key,
      itemType: row.itemType,
      title: row.title,
      creators: asJson(row.creators_json, []),
      fields: asJson(row.fields_json, {}),
      importedAt: new Date(row.importedAt).toISOString()
    };
  }

  async deleteImported(key) {
    const result = await this.query('DELETE FROM web_items WHERE key = $1', [String(key)]);
    return { ok: true, deleted: Number(result.rowCount) > 0 };
  }

  // ------------------------------------------------------- formula history

  async saveFormula(latex, itemKey = null) {
    const now = new Date();
    const { rows } = await this.query(
      'INSERT INTO formula_history(latex, item_key, created_at) VALUES ($1, $2, $3) RETURNING id',
      [String(latex).slice(0, 10000), itemKey ? String(itemKey) : null, now]
    );
    return { id: Number(rows[0].id), latex: String(latex), itemKey, createdAt: now.toISOString() };
  }

  async listFormulas(limit = 30) {
    const { rows } = await this.query(`
      SELECT id, latex, item_key AS "itemKey", created_at AS "createdAt"
      FROM formula_history ORDER BY id DESC LIMIT $1
    `, [Math.min(100, Math.max(1, Number(limit) || 30))]);
    return rows.map(row => ({
      id: Number(row.id),
      latex: row.latex,
      itemKey: row.itemKey,
      createdAt: new Date(row.createdAt).toISOString()
    }));
  }

  async deleteFormula(id) {
    const result = await this.query('DELETE FROM formula_history WHERE id = $1', [Number(id)]);
    return { ok: true, deleted: Number(result.rowCount) > 0 };
  }

  // ------------------------------------------------------------ summaries

  async getCachedSummary(itemKey) {
    const { rows } = await this.query(
      'SELECT provider, payload_json AS payload, created_at AS "createdAt" FROM ai_summaries WHERE item_key = $1',
      [String(itemKey)]
    );
    const row = rows[0];
    if (!row) return null;
    return { provider: row.provider, createdAt: new Date(row.createdAt).toISOString(), ...asJson(row.payload, {}) };
  }

  async cacheSummary(itemKey, provider, payload) {
    await this.query(`
      INSERT INTO ai_summaries(item_key, provider, payload_json, created_at)
      VALUES ($1, $2, $3::jsonb, now())
      ON CONFLICT(item_key) DO UPDATE SET
        provider = excluded.provider, payload_json = excluded.payload_json, created_at = now()
    `, [String(itemKey), String(provider), JSON.stringify(payload)]);
  }

  // ---------------------------------------------------------------- stats

  async readingStats(limit = 20) {
    const recentRows = await this.query(`
      SELECT item_key AS "itemKey", scroll_percent AS percent, updated_at AS "updatedAt"
      FROM reading_progress_web WHERE scroll_percent > 0
      ORDER BY updated_at DESC LIMIT $1
    `, [Math.min(100, Math.max(1, Number(limit) || 20))]);
    const startedRows = await this.query('SELECT COUNT(*) AS n FROM reading_progress_web WHERE scroll_percent > 0');
    const finishedRows = await this.query('SELECT COUNT(*) AS n FROM reading_progress_web WHERE scroll_percent >= 95');
    return {
      started: Number(startedRows.rows[0].n),
      finished: Number(finishedRows.rows[0].n),
      recent: recentRows.rows.map(row => ({
        itemKey: row.itemKey,
        percent: Number(row.percent),
        updatedAt: new Date(row.updatedAt).toISOString()
      }))
    };
  }

  /** Backlinks for [[wiki-link]] mentions in any note. */
  async mentions(title) {
    if (!String(title || '').trim()) return [];
    const needle = `[[${String(title)}]]`;
    const { rows } = await this.query(
      'SELECT item_key, content, content_html AS html, updated_at AS "updatedAt" FROM web_notes WHERE content ILIKE $1 OR content_html ILIKE $1',
      [`%${title}%`]
    );
    return rows
      .filter(row => String(row.content || '').includes(needle) || String(row.html || '').includes(needle))
      .map(row => ({
        itemKey: row.item_key,
        updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date().toISOString()
      }));
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PgWebStore };
