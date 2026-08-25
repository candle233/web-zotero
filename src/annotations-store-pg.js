'use strict';

/**
 * PostgreSQL-backed WebAnnotationStore — API-compatible with the SQLite
 * WebAnnotationStore (src/annotations-store.js), fully async. Selected in
 * server.js when DATABASE_URL is set. Operates on the web_annotations table
 * in db/schema.sql.
 */

const { Pool } = require('pg');
const { normalizeRects, ANNOTATION_TYPES } = require('./annotations-store');

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizeColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? String(color).toLowerCase() : '#ffd400';
}

function asJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

class PgWebAnnotationStore {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString: String(connectionString || '').trim(), max: 5 });
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  rowToAnnotation(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      itemKey: row.item_key,
      attachmentKey: row.attachment_key,
      authorId: row.author_id == null ? null : Number(row.author_id),
      authorEmail: row.author_email || null,
      pageIndex: Number(row.page_index),
      pageLabel: row.page_label ?? null,
      type: row.type,
      rects: asJson(row.rects_json, []),
      color: row.color,
      commentText: row.comment_text || '',
      quoteText: row.quote_text || '',
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  async create({ itemKey, attachmentKey, authorId = null, pageIndex, pageLabel = null, type = 'highlight', rects, color, comment = '', quote = '' }) {
    if (!itemKey || !attachmentKey) throw httpError(400, 'itemKey and attachmentKey are required.');
    const page = Number(pageIndex);
    if (!Number.isInteger(page) || page < 0 || page > 100000) throw httpError(400, 'pageIndex must be a non-negative integer.');
    const kind = ANNOTATION_TYPES.includes(type) ? type : 'highlight';
    const normalizedRects = normalizeRects(rects);
    const { rows } = await this.query(`
      INSERT INTO web_annotations
        (item_key, attachment_key, author_id, page_index, page_label, type, rects_json, color, comment_text, quote_text, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now(), now())
      RETURNING id
    `, [
      String(itemKey), String(attachmentKey),
      authorId == null ? null : Number(authorId),
      page,
      pageLabel == null ? null : String(pageLabel).slice(0, 32),
      kind,
      JSON.stringify(normalizedRects),
      normalizeColor(color),
      String(comment || '').slice(0, 10000),
      String(quote || '').slice(0, 2000)
    ]);
    return await this.get(Number(rows[0].id));
  }

  async get(id) {
    const { rows } = await this.query(`
      SELECT a.*, u.email AS author_email FROM web_annotations a
      LEFT JOIN users u ON u.id = a.author_id
      WHERE a.id = $1
    `, [Number(id)]);
    return this.rowToAnnotation(rows[0]);
  }

  async list({ itemKey, attachmentKey } = {}) {
    if (!itemKey) throw httpError(400, 'itemKey is required.');
    const sql = attachmentKey
      ? `SELECT a.*, u.email AS author_email FROM web_annotations a
         LEFT JOIN users u ON u.id = a.author_id
         WHERE a.item_key = $1 AND a.attachment_key = $2
         ORDER BY a.page_index, a.created_at`
      : `SELECT a.*, u.email AS author_email FROM web_annotations a
         LEFT JOIN users u ON u.id = a.author_id
         WHERE a.item_key = $1
         ORDER BY a.page_index, a.created_at`;
    const params = attachmentKey ? [String(itemKey), String(attachmentKey)] : [String(itemKey)];
    const { rows } = await this.query(sql, params);
    return rows.map(row => this.rowToAnnotation(row));
  }

  async update(id, { color, comment } = {}, actor = null) {
    const existing = await this.get(id);
    if (!existing) throw httpError(404, 'Annotation not found.');
    if (actor && actor.role !== 'owner' && actor.id !== existing.authorId) {
      throw httpError(403, 'Only the author or an owner can edit this annotation.');
    }
    await this.query(`
      UPDATE web_annotations SET
        color = $1, comment_text = $2, updated_at = now()
      WHERE id = $3
    `, [
      color !== undefined ? normalizeColor(color) : existing.color,
      comment !== undefined ? String(comment).slice(0, 10000) : existing.commentText,
      existing.id
    ]);
    return await this.get(existing.id);
  }

  async remove(id, actor = null) {
    const existing = await this.get(id);
    if (!existing) throw httpError(404, 'Annotation not found.');
    if (actor && actor.role !== 'owner' && actor.id !== existing.authorId) {
      throw httpError(403, 'Only the author or an owner can delete this annotation.');
    }
    await this.query('DELETE FROM web_annotations WHERE id = $1', [existing.id]);
    return { ok: true };
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PgWebAnnotationStore };
