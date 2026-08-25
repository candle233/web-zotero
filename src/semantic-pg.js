'use strict';

/**
 * PostgreSQL & pgvector production semantic search (R8b).
 *
 * Supports:
 * 1. pgvector extension (when installed) with HNSW vector_cosine_ops index and `<=>` operator.
 * 2. Fallback JSON vector storage with SQL/in-memory cosine similarity.
 * 3. OpenAI / Ollama compatible embeddings API (`/v1/embeddings`), with built-in normalized feature extractor fallback.
 */

const { Pool } = require('pg');
const { chunkText, tokenize } = require('./semantic');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 1e-12 ? dot / denom : 0;
}

/**
 * Built-in deterministic TF-IDF feature hashing embedder.
 * Used when no external embedding API is available.
 */
function localEmbed(text, dimensions = 64) {
  const tokens = tokenize(text);
  const vec = new Float64Array(dimensions);
  if (!tokens.length) return Array.from(vec);

  for (const token of tokens) {
    // FNV-1a hash
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const idx = Math.abs(hash) % dimensions;
    const sign = (hash & 1) ? 1 : -1;
    vec[idx] += sign;
  }

  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-12) {
    for (let i = 0; i < dimensions; i++) vec[i] /= norm;
  }
  return Array.from(vec);
}

class PgSemanticIndex {
  constructor(connectionString, config = {}) {
    this.pool = new Pool({ connectionString: String(connectionString || '').trim(), max: 10 });
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = (config.baseUrl || process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = config.model || process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
    this.dimensions = Number(config.dimensions) || 64;
    this.hasPgVector = false;
    this.ready = false;
    this.building = false;
  }

  async init() {
    // 1. Create table
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS document_embeddings (
        id BIGSERIAL PRIMARY KEY,
        item_key TEXT NOT NULL,
        attachment_key TEXT,
        title TEXT,
        position INT NOT NULL DEFAULT 0,
        chunk_text TEXT NOT NULL,
        dimensions INT NOT NULL,
        embedding_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (item_key, position)
      );
      CREATE INDEX IF NOT EXISTS document_embeddings_item_idx ON document_embeddings (item_key);
    `);

    // 2. Check if pgvector is available
    try {
      const extRes = await this.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
      if (extRes.rows.length > 0) {
        this.hasPgVector = true;
        await this.pool.query(`
          ALTER TABLE document_embeddings ADD COLUMN IF NOT EXISTS embedding vector(${this.dimensions});
        `);
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS document_embeddings_hnsw_idx
          ON document_embeddings USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
        `).catch(() => {});
      }
    } catch {
      this.hasPgVector = false;
    }

    const countRes = await this.pool.query('SELECT COUNT(*) AS n FROM document_embeddings');
    this.ready = Number(countRes.rows[0]?.n || 0) > 0;
  }

  async embedText(text) {
    if (this.apiKey) {
      try {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: this.model,
            input: String(text).slice(0, 8000)
          }),
          signal: AbortSignal.timeout(10000)
        });
        if (response.ok) {
          const data = await response.json();
          const vec = data.data?.[0]?.embedding;
          if (Array.isArray(vec) && vec.length > 0) return vec;
        }
      } catch (err) {
        console.warn(`External embedding failed (${err.message}), falling back to local embedder.`);
      }
    }
    return localEmbed(text, this.dimensions);
  }

  async indexDocument(itemKey, attachmentKey, title, fullText) {
    const chunks = chunkText(fullText);
    if (!chunks.length) return 0;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM document_embeddings WHERE item_key = $1', [itemKey]);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vec = await this.embedText(chunk.text);
        const dims = vec.length;

        if (this.hasPgVector) {
          const vectorStr = `[${vec.join(',')}]`;
          await client.query(`
            INSERT INTO document_embeddings
              (item_key, attachment_key, title, position, chunk_text, dimensions, embedding_json, embedding)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
          `, [itemKey, attachmentKey, title, i, chunk.text, dims, JSON.stringify(vec), vectorStr]);
        } else {
          await client.query(`
            INSERT INTO document_embeddings
              (item_key, attachment_key, title, position, chunk_text, dimensions, embedding_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [itemKey, attachmentKey, title, i, chunk.text, dims, JSON.stringify(vec)]);
        }
      }
      await client.query('COMMIT');
      this.ready = true;
      return chunks.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async search(queryText, limit = 30) {
    if (!queryText || !queryText.trim()) return [];
    const queryVec = await this.embedText(queryText);

    if (this.hasPgVector) {
      const vectorStr = `[${queryVec.join(',')}]`;
      const { rows } = await this.pool.query(`
        SET LOCAL hnsw.ef_search = 40;
        SELECT
          item_key AS "itemKey",
          attachment_key AS "attachmentKey",
          title,
          chunk_text AS "chunkText",
          (1 - (embedding <=> $1::vector)) AS score
        FROM document_embeddings
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $2;
      `, [vectorStr, limit * 2]);

      const perItem = new Map();
      for (const row of rows) {
        const score = Number(row.score);
        if (score <= 0.02) continue;
        if (!perItem.has(row.itemKey) || score > perItem.get(row.itemKey).score) {
          perItem.set(row.itemKey, {
            itemKey: row.itemKey,
            attachmentKey: row.attachmentKey,
            title: row.title,
            score,
            snippet: escapeHtml(row.chunkText.length > 280 ? `${row.chunkText.slice(0, 280)}…` : row.chunkText)
          });
        }
      }
      return [...perItem.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    }

    // Fallback in-database / in-memory cosine ranking
    const { rows } = await this.pool.query(`
      SELECT item_key AS "itemKey", attachment_key AS "attachmentKey", title, chunk_text AS "chunkText", embedding_json AS "embedding"
      FROM document_embeddings
    `);

    const perItem = new Map();
    for (const row of rows) {
      const vec = Array.isArray(row.embedding) ? row.embedding : (typeof row.embedding === 'string' ? JSON.parse(row.embedding) : []);
      const score = cosineSimilarity(queryVec, vec);
      if (score <= 0.02) continue;
      if (!perItem.has(row.itemKey) || score > perItem.get(row.itemKey).score) {
        perItem.set(row.itemKey, {
          itemKey: row.itemKey,
          attachmentKey: row.attachmentKey,
          title: row.title,
          score,
          snippet: escapeHtml(row.chunkText.length > 280 ? `${row.chunkText.slice(0, 280)}…` : row.chunkText)
        });
      }
    }
    return [...perItem.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async related(itemKey, limit = 10) {
    const { rows: sourceRows } = await this.pool.query(
      'SELECT embedding_json FROM document_embeddings WHERE item_key = $1 LIMIT 1',
      [itemKey]
    );
    if (!sourceRows.length) return [];
    const sourceVec = Array.isArray(sourceRows[0].embedding_json)
      ? sourceRows[0].embedding_json
      : JSON.parse(sourceRows[0].embedding_json);

    const { rows } = await this.pool.query(`
      SELECT item_key AS "itemKey", title, embedding_json AS "embedding"
      FROM document_embeddings
      WHERE item_key != $1
    `, [itemKey]);

    const perItem = new Map();
    for (const row of rows) {
      const vec = Array.isArray(row.embedding) ? row.embedding : JSON.parse(row.embedding);
      const score = cosineSimilarity(sourceVec, vec);
      if (score > 0.05) {
        if (!perItem.has(row.itemKey) || score > perItem.get(row.itemKey).score) {
          perItem.set(row.itemKey, { key: row.itemKey, title: row.title, score });
        }
      }
    }
    return [...perItem.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async chunksFor(itemKey) {
    const { rows } = await this.pool.query(`
      SELECT id AS "chunkId", item_key AS "itemKey", attachment_key AS "attachmentKey", title, position, chunk_text AS "text"
      FROM document_embeddings
      WHERE item_key = $1
      ORDER BY position ASC
    `, [itemKey]);
    return rows;
  }

  async status() {
    const { rows } = await this.pool.query(`
      SELECT
        COUNT(*) AS chunks,
        COUNT(DISTINCT item_key) AS items
      FROM document_embeddings
    `);
    return {
      ready: this.ready,
      building: this.building,
      chunks: Number(rows[0]?.chunks || 0),
      items: Number(rows[0]?.items || 0),
      pgvector: this.hasPgVector,
      dimensions: this.dimensions,
      model: this.apiKey ? this.model : 'local-hash'
    };
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PgSemanticIndex, localEmbed, cosineSimilarity };
