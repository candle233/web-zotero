'use strict';

/**
 * Server-side persistence for interactive PDF annotations (SQLite build).
 *
 * Rows mirror db/schema.sql `annotations`: viewport-normalized rects
 * (each {x,y,width,height} in [0,1]) so highlights survive zoom/rotation,
 * plus author ownership for the multi-user workspace.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ANNOTATION_TYPES = ['highlight', 'rect', 'note', 'ink', 'strike'];
const MAX_RECTS = 64;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function normalizeRects(rects) {
  if (!Array.isArray(rects) || rects.length === 0) throw httpError(400, 'rects must be a non-empty array.');
  if (rects.length > MAX_RECTS) throw httpError(400, `rects must contain at most ${MAX_RECTS} entries.`);
  return rects.map(rect => {
    if (!rect || typeof rect !== 'object') throw httpError(400, 'Each rect must be an object.');
    const { x, y, width, height } = rect;
    for (const value of [x, y, width, height]) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw httpError(400, 'Rect coordinates must be finite numbers.');
      }
    }
    return {
      x: clamp01(x),
      y: clamp01(y),
      width: clamp01(width),
      height: clamp01(height)
    };
  });
}

function normalizeColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? String(color).toLowerCase() : '#ffd400';
}

class WebAnnotationStore {
  constructor(dataDir) {
    this.database = new DatabaseSync(path.join(dataDir, 'web-data.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS web_annotations (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_key       TEXT NOT NULL,
        attachment_key TEXT NOT NULL,
        author_id      INTEGER,
        page_index     INTEGER NOT NULL CHECK (page_index >= 0),
        page_label     TEXT,
        type           TEXT NOT NULL DEFAULT 'highlight',
        rects_json     TEXT NOT NULL,
        color          TEXT NOT NULL DEFAULT '#ffd400',
        comment_text   TEXT NOT NULL DEFAULT '',
        quote_text     TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_annotations_item_idx ON web_annotations (item_key, attachment_key, page_index);
    `);
  }

  create({ itemKey, attachmentKey, authorId = null, pageIndex, pageLabel = null, type = 'highlight', rects, color, comment = '', quote = '' }) {
    if (!itemKey || !attachmentKey) throw httpError(400, 'itemKey and attachmentKey are required.');
    const page = Number(pageIndex);
    if (!Number.isInteger(page) || page < 0 || page > 100000) throw httpError(400, 'pageIndex must be a non-negative integer.');
    const kind = ANNOTATION_TYPES.includes(type) ? type : 'highlight';
    const normalizedRects = normalizeRects(rects);
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO web_annotations
        (item_key, attachment_key, author_id, page_index, page_label, type, rects_json, color, comment_text, quote_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(itemKey), String(attachmentKey),
      authorId == null ? null : Number(authorId),
      page,
      pageLabel == null ? null : String(pageLabel).slice(0, 32),
      kind,
      JSON.stringify(normalizedRects),
      normalizeColor(color),
      String(comment || '').slice(0, 10000),
      String(quote || '').slice(0, 2000),
      now, now
    );
    return this.get(Number(result.lastInsertRowid));
  }

  rowToAnnotation(row) {
    if (!row) return null;
    return {
      id: row.id,
      itemKey: row.item_key,
      attachmentKey: row.attachment_key,
      authorId: row.author_id,
      authorEmail: row.author_email || null,
      pageIndex: row.page_index,
      pageLabel: row.page_label,
      type: row.type,
      rects: JSON.parse(row.rects_json),
      color: row.color,
      commentText: row.comment_text,
      quoteText: row.quote_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  get(id) {
    const row = this.database.prepare(`
      SELECT a.*, u.email AS author_email FROM web_annotations a
      LEFT JOIN users u ON u.id = a.author_id
      WHERE a.id = ?
    `).get(Number(id));
    return this.rowToAnnotation(row);
  }

  list({ itemKey, attachmentKey } = {}) {
    if (!itemKey) throw httpError(400, 'itemKey is required.');
    const rows = attachmentKey
      ? this.database.prepare(`
          SELECT a.*, u.email AS author_email FROM web_annotations a
          LEFT JOIN users u ON u.id = a.author_id
          WHERE a.item_key = ? AND a.attachment_key = ?
          ORDER BY a.page_index, a.created_at
        `).all(String(itemKey), String(attachmentKey))
      : this.database.prepare(`
          SELECT a.*, u.email AS author_email FROM web_annotations a
          LEFT JOIN users u ON u.id = a.author_id
          WHERE a.item_key = ?
          ORDER BY a.page_index, a.created_at
        `).all(String(itemKey));
    return rows.map(row => this.rowToAnnotation(row));
  }

  update(id, { color, comment } = {}, actor = null) {
    const existing = this.get(id);
    if (!existing) throw httpError(404, 'Annotation not found.');
    if (actor && actor.role !== 'owner' && actor.id !== existing.authorId) {
      throw httpError(403, 'Only the author or an owner can edit this annotation.');
    }
    this.database.prepare(`
      UPDATE web_annotations SET
        color = ?, comment_text = ?, updated_at = ?
      WHERE id = ?
    `).run(
      color !== undefined ? normalizeColor(color) : existing.color,
      comment !== undefined ? String(comment).slice(0, 10000) : existing.commentText,
      new Date().toISOString(),
      existing.id
    );
    return this.get(existing.id);
  }

  remove(id, actor = null) {
    const existing = this.get(id);
    if (!existing) throw httpError(404, 'Annotation not found.');
    if (actor && actor.role !== 'owner' && actor.id !== existing.authorId) {
      throw httpError(403, 'Only the author or an owner can delete this annotation.');
    }
    this.database.prepare('DELETE FROM web_annotations WHERE id = ?').run(existing.id);
    return { ok: true };
  }

  close() {
    this.database.close();
  }
}

module.exports = { WebAnnotationStore, normalizeRects, ANNOTATION_TYPES };
