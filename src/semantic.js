'use strict';

/**
 * Zero-dependency semantic retrieval (R8, local form): LSA over the FTS corpus.
 *
 * Pipeline: tokenize (latin words + CJK char bigrams) -> chunk -> TF-IDF ->
 * truncated SVD (subspace iteration, seeded/deterministic) -> persist term
 * basis (U), singular values and chunk/item vectors to semantic-index.sqlite.
 * Queries and items are projected into the k-dim latent space and ranked by
 * cosine similarity, which matches co-occurring vocabulary (e.g. "deep
 * learning" ~ "neural networks") that exact FTS phrase search misses.
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

const LATIN_STOP_WORDS = new Set(`a about above after again against all also am an and any are as at be because been before being between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just more most my no nor not now of on only or other our ours out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your`.split(/\s+/));

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const LATIN_WORD = /[a-z][a-z0-9'-]{1,}/g;
const DEFAULT_K = 64;
const MIN_CHUNKS = 8;
const MAX_DOC_CHARS = 600000;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Float32Array -> Buffer for SQLite BLOB binding (node:sqlite rejects bare ArrayBuffers). */
function toBlob(float32) {
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

/** Reinterpret a SQLite BLOB (Uint8Array) as Float32Array (byte-level copy). */
function fromBlob(uint8) {
  const copy = new Uint8Array(uint8.byteLength);
  copy.set(uint8);
  return new Float32Array(copy.buffer);
}

/** Latin words (stop-filtered) + CJK character bigrams: "神经网络" -> 神经,经网,网络 */
function tokenize(text) {
  const tokens = [];
  const lowered = String(text || '').toLowerCase();
  for (const match of lowered.match(LATIN_WORD) || []) {
    if (!LATIN_STOP_WORDS.has(match)) tokens.push(match);
  }
  for (const run of lowered.match(CJK_RUN) || []) {
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < 200) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const spaceAt = clean.lastIndexOf(' ', end);
      if (spaceAt > start + size * 0.6) end = spaceAt;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push({ start, text: piece });
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** Modified Gram-Schmidt over the columns of a rows x k matrix (row-major). */
function orthonormalizeColumns(matrix, rows, k, random) {
  const col = new Float64Array(rows);
  const prev = new Float64Array(rows);
  for (let j = 0; j < k; j += 1) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt === 1) {
        for (let i = 0; i < rows; i += 1) matrix[i * k + j] = random() - 0.5;
      }
      for (let i = 0; i < rows; i += 1) col[i] = matrix[i * k + j];
      for (let p = 0; p < j; p += 1) {
        let dot = 0;
        for (let i = 0; i < rows; i += 1) {
          prev[i] = matrix[i * k + p];
          dot += prev[i] * col[i];
        }
        if (dot !== 0) for (let i = 0; i < rows; i += 1) col[i] -= dot * prev[i];
      }
      for (let i = 0; i < rows; i += 1) matrix[i * k + j] = col[i];
      let norm = 0;
      for (let i = 0; i < rows; i += 1) norm += matrix[i * k + j] * matrix[i * k + j];
      norm = Math.sqrt(norm);
      if (norm > 1e-9) {
        for (let i = 0; i < rows; i += 1) matrix[i * k + j] /= norm;
        break;
      }
    }
  }
}

class SemanticIndex {
  constructor(dataDir, searchIndex) {
    this.searchIndex = searchIndex;
    this.database = new DatabaseSync(path.join(dataDir, 'semantic-index.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE IF NOT EXISTS terms (term TEXT PRIMARY KEY, idx INTEGER NOT NULL, df INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id INTEGER PRIMARY KEY,
        item_key TEXT NOT NULL,
        attachment_key TEXT,
        title TEXT,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        vec BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        item_key TEXT PRIMARY KEY,
        attachment_key TEXT,
        title TEXT,
        vec BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_item_idx ON chunks (item_key);
    `);
    this.building = false;
    this.ready = false;
    this.k = 0;
    this.sigma = null;
    this.basis = null;        // Float32Array terms x k (row-major)
    this.termIndex = new Map();
    this.termDf = new Map();
    this.chunkVectors = [];   // { chunkId, itemKey, attachmentKey, title, position, text, vec: Float32Array }
    this.itemVectors = new Map();
    this.load();
  }

  load() {
    const meta = new Map(this.database.prepare('SELECT key, value FROM meta').all().map(row => [row.key, row.value]));
    const chunkCount = Number(meta.get('chunkCount') || 0);
    this.k = Number(meta.get('k') || 0);
    if (!this.k || chunkCount < MIN_CHUNKS) return;
    this.sigma = fromBlob(meta.get('sigma'));
    this.basis = fromBlob(meta.get('basis'));
    this.termIndex = new Map();
    this.termDf = new Map();
    for (const row of this.database.prepare('SELECT term, idx, df FROM terms').all()) {
      this.termIndex.set(row.term, row.idx);
      this.termDf.set(row.term, row.df);
    }
    this.chunkVectors = this.database.prepare(
      'SELECT chunk_id AS chunkId, item_key AS itemKey, attachment_key AS attachmentKey, title, position, text, vec FROM chunks'
    ).all().map(row => ({ ...row, vec: fromBlob(row.vec) }));
    this.itemVectors = new Map(
      this.database.prepare('SELECT item_key, attachment_key AS attachmentKey, title, vec FROM items').all()
        .map(row => [row.item_key, { ...row, attachmentKey: row.attachmentKey, title: row.title, vec: fromBlob(row.vec) }])
    );
    this.ready = this.basis.length === this.termIndex.size * this.k && this.sigma.length === this.k;
  }

  status() {
    return {
      ready: this.ready,
      building: this.building,
      chunks: this.chunkVectors.length,
      items: this.itemVectors.size,
      terms: this.termIndex.size,
      dimensions: this.k
    };
  }

  /**
   * Rebuilds the LSA space from the FTS corpus (search-index.documents).
   * Subspace iteration: X <- orth(A (A^T X)); sigma from the final A^T X norms.
   */
  rebuild({ iterations = 8 } = {}) {
    if (this.building) return { started: false, message: 'Semantic indexing is already running.' };
    const documents = this.searchIndex.database
      .prepare('SELECT item_key, attachment_key, title, text FROM documents').all();
    const chunkRows = [];
    for (const doc of documents) {
      const chunks = chunkText(String(doc.text || '').slice(0, MAX_DOC_CHARS));
      chunks.forEach((chunk, position) => chunkRows.push({
        itemKey: doc.item_key, attachmentKey: doc.attachment_key,
        title: doc.title || '', position, text: chunk.text
      }));
    }
    if (chunkRows.length < MIN_CHUNKS) {
      return { started: true, ready: false, chunks: chunkRows.length, reason: 'corpus too small for LSA' };
    }
    this.building = true;
    try {
      const k = Math.min(DEFAULT_K, Math.floor(chunkRows.length / 2));
      const totalChunks = chunkRows.length;

      // Term frequencies per chunk + document frequency.
      const chunkTokens = chunkRows.map(chunk => {
        const freq = new Map();
        for (const token of tokenize(chunk.text)) freq.set(token, (freq.get(token) || 0) + 1);
        return freq;
      });
      const df = new Map();
      for (const freq of chunkTokens) {
        for (const term of freq.keys()) df.set(term, (df.get(term) || 0) + 1);
      }
      const keptTerms = [...df.entries()].filter(([, count]) => count >= 2).map(([term]) => term)
        .sort((a, b) => df.get(b) - df.get(a));
      const termIndexMap = new Map(keptTerms.map((term, idx) => [term, idx]));
      const vocab = keptTerms.length;

      // Sparse weighted matrix A (terms x chunks), rows l2-normalized.
      const ptr = new Int32Array(totalChunks + 1);
      const idxOut = [];
      const weightOut = [];
      chunkTokens.forEach((freq, c) => {
        let norm = 0;
        const entries = [];
        for (const [term, tf] of freq) {
          const idx = termIndexMap.get(term);
          if (idx === undefined) continue;
          const w = (1 + Math.log(tf)) * Math.log(1 + totalChunks / df.get(term));
          entries.push([idx, w]);
          norm += w * w;
        }
        norm = Math.sqrt(norm);
        for (const [idx, w] of entries) {
          idxOut.push(idx);
          weightOut.push(norm > 1e-12 ? w / norm : 0);
        }
        ptr[c + 1] = idxOut.length;
      });
      const colIdx = Int32Array.from(idxOut);
      const colW = Float64Array.from(weightOut);

      const random = mulberry32(0x5a4c3b2e);
      const basis = new Float64Array(vocab * k);
      for (let i = 0; i < basis.length; i += 1) basis[i] = random() - 0.5;
      orthonormalizeColumns(basis, vocab, k, random);

      const projectChunks = out => {
        out.fill(0);
        for (let c = 0; c < totalChunks; c += 1) {
          const outBase = c * k;
          for (let n = ptr[c]; n < ptr[c + 1]; n += 1) {
            const t = colIdx[n];
            const w = colW[n];
            const inBase = t * k;
            for (let j = 0; j < k; j += 1) out[outBase + j] += w * basis[inBase + j];
          }
        }
      };
      const backProject = (chunkSpace, out) => {
        out.fill(0);
        for (let c = 0; c < totalChunks; c += 1) {
          const inBase = c * k;
          for (let n = ptr[c]; n < ptr[c + 1]; n += 1) {
            const t = colIdx[n];
            const w = colW[n];
            const outBase = t * k;
            for (let j = 0; j < k; j += 1) out[outBase + j] += w * chunkSpace[inBase + j];
          }
        }
      };

      const chunkSpace = new Float64Array(totalChunks * k);
      const nextBasis = new Float64Array(vocab * k);
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        projectChunks(chunkSpace);          // A^T X
        backProject(chunkSpace, nextBasis); // A (A^T X)
        basis.set(nextBasis);
        orthonormalizeColumns(basis, vocab, k, random);
      }
      projectChunks(chunkSpace); // final V^T with unnormalized sigma scale

      const sigma = new Float32Array(k);
      for (let j = 0; j < k; j += 1) {
        let sum = 0;
        for (let c = 0; c < totalChunks; c += 1) sum += chunkSpace[c * k + j] * chunkSpace[c * k + j];
        sigma[j] = Math.sqrt(sum);
      }

      const chunkVecs = chunkRows.map((row, c) => {
        const vec = new Float32Array(k);
        let norm = 0;
        for (let j = 0; j < k; j += 1) {
          vec[j] = sigma[j] > 1e-9 ? chunkSpace[c * k + j] / sigma[j] : 0;
          norm += vec[j] * vec[j];
        }
        norm = Math.sqrt(norm);
        if (norm > 1e-12) for (let j = 0; j < k; j += 1) vec[j] /= norm;
        return { ...row, vec };
      });

      const itemAcc = new Map();
      for (const chunk of chunkVecs) {
        if (!itemAcc.has(chunk.itemKey)) {
          itemAcc.set(chunk.itemKey, { attachmentKey: chunk.attachmentKey, title: chunk.title, vec: new Float64Array(k) });
        }
        const acc = itemAcc.get(chunk.itemKey);
        for (let j = 0; j < k; j += 1) acc.vec[j] += chunk.vec[j];
      }
      const itemVecs = new Map();
      for (const [itemKey, acc] of itemAcc) {
        const vec = new Float32Array(k);
        let norm = 0;
        for (let j = 0; j < k; j += 1) norm += acc.vec[j] * acc.vec[j];
        norm = Math.sqrt(norm);
        for (let j = 0; j < k; j += 1) vec[j] = norm > 1e-12 ? acc.vec[j] / norm : 0;
        itemVecs.set(itemKey, { attachmentKey: acc.attachmentKey, title: acc.title, vec });
      }

      this.persist(k, sigma, basis, keptTerms, df, chunkVecs, itemVecs);
      this.k = k;
      this.sigma = sigma;
      this.basis = Float32Array.from(basis);
      this.termIndex = termIndexMap;
      this.termDf = new Map(keptTerms.map(term => [term, df.get(term)]));
      this.chunkVectors = chunkVecs;
      this.itemVectors = itemVecs;
      this.ready = true;
      return { started: true, ready: true, chunks: totalChunks, items: itemVecs.size, terms: vocab, dimensions: k };
    } finally {
      this.building = false;
    }
  }

  persist(k, sigma, basis, terms, df, chunkVecs, itemVecs) {
    try {
      this.database.exec('BEGIN IMMEDIATE');
      this.database.exec('DELETE FROM meta; DELETE FROM terms; DELETE FROM chunks; DELETE FROM items;');
      const meta = this.database.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
      meta.run('k', k);
      meta.run('chunkCount', chunkVecs.length);
      meta.run('builtAt', new Date().toISOString());
      meta.run('sigma', toBlob(sigma));
      meta.run('basis', toBlob(Float32Array.from(basis)));
      const insertTerm = this.database.prepare('INSERT INTO terms(term, idx, df) VALUES (?, ?, ?)');
      terms.forEach((term, idx) => insertTerm.run(term, idx, df.get(term)));
      const insertChunk = this.database.prepare(
        'INSERT INTO chunks(item_key, attachment_key, title, position, text, vec) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const chunk of chunkVecs) {
        insertChunk.run(chunk.itemKey, chunk.attachmentKey, chunk.title, chunk.position, chunk.text, toBlob(chunk.vec));
      }
      const insertItem = this.database.prepare(
        'INSERT INTO items(item_key, attachment_key, title, vec) VALUES (?, ?, ?, ?)'
      );
      for (const [itemKey, item] of itemVecs) {
        insertItem.run(itemKey, item.attachmentKey, item.title, toBlob(item.vec));
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  projectQuery(queryText) {
    if (!this.ready) return null;
    const freq = new Map();
    for (const token of tokenize(queryText)) freq.set(token, (freq.get(token) || 0) + 1);
    const k = this.k;
    const projected = new Float64Array(k);
    let matched = 0;
    for (const [term, tf] of freq) {
      const idx = this.termIndex.get(term);
      if (idx === undefined) continue;
      matched += 1;
      const w = (1 + Math.log(tf)) * Math.log(1 + this.chunkVectors.length / this.termDf.get(term));
      const base = idx * k;
      for (let j = 0; j < k; j += 1) {
        projected[j] += this.sigma[j] > 1e-9 ? w * this.basis[base + j] / this.sigma[j] : 0;
      }
    }
    if (!matched) return null;
    let norm = 0;
    for (let j = 0; j < k; j += 1) norm += projected[j] * projected[j];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) return null;
    for (let j = 0; j < k; j += 1) projected[j] /= norm;
    return projected;
  }

  search(queryText, limit = 30) {
    const query = this.projectQuery(queryText);
    if (!query) return [];
    const k = this.k;
    const perItem = new Map();
    for (const chunk of this.chunkVectors) {
      let score = 0;
      for (let j = 0; j < k; j += 1) score += query[j] * chunk.vec[j];
      if (score <= 0.02) continue;
      const existing = perItem.get(chunk.itemKey);
      if (!existing || score > existing.score) {
        perItem.set(chunk.itemKey, {
          itemKey: chunk.itemKey,
          attachmentKey: chunk.attachmentKey,
          title: chunk.title,
          score,
          // Escaped because the UI renders snippets as HTML (lexical snippets carry <mark>).
          snippet: escapeHtml(chunk.text.length > 280 ? `${chunk.text.slice(0, 280)}…` : chunk.text)
        });
      }
    }
    return [...perItem.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  related(itemKey, limit = 10) {
    const source = this.itemVectors.get(itemKey);
    if (!source || !this.ready) return [];
    const k = this.k;
    const results = [];
    for (const [key, item] of this.itemVectors) {
      if (key === itemKey) continue;
      let score = 0;
      for (let j = 0; j < k; j += 1) score += source.vec[j] * item.vec[j];
      if (score > 0.05) results.push({ key, title: item.title, score });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  chunksFor(itemKey) {
    return this.chunkVectors.filter(chunk => chunk.itemKey === itemKey)
      .sort((a, b) => a.position - b.position);
  }

  close() {
    this.database.close();
  }
}

module.exports = { SemanticIndex, tokenize, chunkText };
