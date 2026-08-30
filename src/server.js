'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const zlib = require('node:zlib');
const path = require('node:path');
const { URL } = require('node:url');
const { ZoteroDatabase } = require('./zotero-db');
const { SearchIndex } = require('./search');
const { WebStore } = require('./web-store');
const { PgWebStore } = require('./web-store-pg');
const { localSummary, openAiSummary } = require('./local-ai');
const { installedDesktopPlugins } = require('./plugins');
const { exportCsv, exportFormats, exportJson, exportRis } = require('./citation');
const { HealthMonitor } = require('./health');
const { annotationsToCsv, annotationsToMarkdown } = require('./annotation-export');
const { recommend } = require('./recommend');
const { OfflineLibrary } = require('./offline');
const { resolveIdentifier } = require('./metadata');
const { recognizeFormula } = require('./formula-ocr');
const { formatCitations, listStyles } = require('./citation-service');
const { UserStore, hashToken } = require('./users');
const { PgUserStore } = require('./users-pg');
const { WebAnnotationStore } = require('./annotations-store');
const { PgWebAnnotationStore } = require('./annotations-store-pg');
const { PgWorkspaceStore } = require('./workspaces-pg');
const { S3Storage } = require('./s3-storage');
const { sanitizeNoteHtml, noteHtmlToPlainText } = require('./notes-html');
const { SemanticIndex } = require('./semantic');
const { PgSemanticIndex } = require('./semantic-pg');
const { ask } = require('./ask');
const { EventBus } = require('./events');

const PORT = Number(process.env.PORT || 8420);
// Loopback by default: a library server with no configured auth would otherwise
// hand the whole LAN owner access. Set HOST=0.0.0.0 to expose deliberately.
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const ZOTERO_PROFILE_ROOT = process.env.ZOTERO_PROFILE_ROOT ||
  (() => {
    try {
      const profileRoot = path.join(process.env.APPDATA || '', 'Zotero', 'Zotero', 'Profiles');
      return fs.readdirSync(profileRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(profileRoot, entry.name))[0] || '';
    } catch {
      return '';
    }
  })();
const WEB_PASSWORD = process.env.WEB_PASSWORD || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
// OpenAI-compatible endpoint; point at Ollama (e.g. http://127.0.0.1:11434/v1) for local models.
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.openai.com/v1';

const { pickDatabaseUrl, maskConnectionString } = require('./detect-postgres');

fs.mkdirSync(DATA_DIR, { recursive: true });
const zoteroDatabase = new ZoteroDatabase();
const searchIndex = new SearchIndex(DATA_DIR, zoteroDatabase);
const s3Storage = new S3Storage();
const eventBus = new EventBus();
const health = new HealthMonitor({ zoteroDatabase, searchIndex, s3Storage, aiBaseUrl: AI_BASE_URL, openAiApiKey: OPENAI_API_KEY, formulaOcrUrl: process.env.FORMULA_OCR_URL || 'http://127.0.0.1:8503/pix2text' });

// Stores are initialised asynchronously inside main() once PG auto-detection runs.
let webStore, userStore, annotationStore, workspaceStore, semanticIndex;

const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 };

// Sliding-window rate limit for endpoints with external cost (AI tokens,
// Crossref/arXiv quota, OCR compute, full reindex). Per-IP, best effort.
const costlyEndpointLimits = new Map([
  ['/api/ai/summarize', { windowMs: 3600000, max: 30 }],
  ['/api/ai/ask', { windowMs: 3600000, max: 60 }],
  ['/api/metadata/resolve', { windowMs: 3600000, max: 60 }],
  ['/api/formula-ocr', { windowMs: 3600000, max: 60 }],
  ['/api/index/rebuild', { windowMs: 3600000, max: 5 }]
]);
const costlyEndpointHits = new Map(); // ip:path -> [timestamps]

function costlyEndpointExceeded(path, ip) {
  const limit = costlyEndpointLimits.get(path);
  if (!limit) return false;
  const key = `${ip}:${path}`;
  const now = Date.now();
  const hits = (costlyEndpointHits.get(key) || []).filter(t => t > now - limit.windowMs);
  if (hits.length >= limit.max) {
    costlyEndpointHits.set(key, hits);
    return true;
  }
  hits.push(now);
  costlyEndpointHits.set(key, hits);
  return false;
}
// POST endpoints that compute without mutating anything; viewers may call them.
const READ_ONLY_POST_ROUTES = new Set([
  '/api/auth', '/api/metadata/resolve', '/api/citations/format', '/api/ai/summarize', '/api/ai/ask',
  '/api/formula-ocr'
]);

/** Blends FTS bm25 ranking with semantic cosine ranking (both normalized to [0,1]). */
async function hybridSearch(query, limit) {
  const lexical = searchIndex.search(query, limit);
  const semantic = semanticIndex.ready ? await semanticIndex.search(query, limit) : [];
  if (!semantic.length) return lexical.map(result => ({ ...result, mode: 'lexical' }));
  if (!lexical.length) return semantic.map(result => ({ ...result, mode: 'semantic' }));
  const lexScores = lexical.map(result => -result.score);
  const semScores = semantic.map(result => result.score);
  const normalize = (value, min, max) => (max > min ? (value - min) / (max - min) : 1);
  const merged = new Map();
  for (const result of lexical) {
    const blended = 0.45 * normalize(-result.score, Math.min(...lexScores), Math.max(...lexScores));
    merged.set(result.itemKey, { itemKey: result.itemKey, attachmentKey: result.attachmentKey, title: result.title, snippet: result.snippet, mode: 'lexical', blended });
  }
  for (const result of semantic) {
    const blended = 0.55 * normalize(result.score, Math.min(...semScores), Math.max(...semScores));
    const existing = merged.get(result.itemKey);
    if (existing) {
      existing.blended += blended;
      existing.mode = 'hybrid';
    } else {
      merged.set(result.itemKey, { itemKey: result.itemKey, attachmentKey: result.attachmentKey, title: result.title, snippet: result.snippet, mode: 'semantic', blended });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.blended - a.blended)
    .slice(0, limit)
    .map(({ blended, ...result }) => ({ ...result, score: Number(blended.toFixed(4)) }));
}

/** Lexical (title-term overlap) + semantic related-paper merge. */
async function hybridRelated(itemKey, limit) {
  const lexical = recommend(zoteroDatabase.items, itemKey, limit);
  if (!semanticIndex.ready) return lexical.map(entry => ({ ...entry, mode: 'lexical' }));
  const semantic = await semanticIndex.related(itemKey, limit * 2);
  const semanticScores = semantic.map(entry => entry.score);
  const merged = new Map();
  for (const entry of lexical) {
    merged.set(entry.key, { ...entry, mode: 'lexical', blended: 0.45 * (1 - 0.05 * (lexical.indexOf(entry) / Math.max(1, lexical.length - 1))) });
  }
  const min = Math.min(...semanticScores, 0);
  const max = Math.max(...semanticScores, 0.001);
  for (const entry of semantic) {
    const summary = zoteroDatabase.getItemByKey(entry.key);
    if (!summary) continue;
    const blended = 0.55 * ((entry.score - min) / (max - min));
    const existing = merged.get(entry.key);
    if (existing) {
      existing.blended += blended;
      existing.mode = 'hybrid';
    } else {
      merged.set(entry.key, { key: entry.key, title: summary.title, creators: summary.creators, itemType: summary.itemType, mode: 'semantic', blended });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.blended - a.blended)
    .slice(0, limit)
    .map(({ blended, ...entry }) => ({ ...entry, score: Number(blended.toFixed(4)) }));
}


async function authMode() {
  const users = await userStore.count();
  return { mode: users > 0 ? 'users' : (WEB_PASSWORD ? 'legacy' : 'open'), users };
}

/** Constant-time comparison for secrets of unknown length (hash first). */
function secretsMatch(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

// Sliding-window login throttle: per-IP failed-attempt budget. Successful
// logins reset the window so honest users are never locked out by typos.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function clientIp(request) {
  return request.socket?.remoteAddress || 'unknown';
}

function loginThrottled(ip) {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const failures = (loginAttempts.get(ip) || []).filter(timestamp => timestamp > cutoff);
  loginAttempts.set(ip, failures);
  return failures.length >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const failures = loginAttempts.get(ip) || [];
  failures.push(Date.now());
  loginAttempts.set(ip, failures);
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

/**
 * Resolves the request principal across the three auth modes:
 *   users  – per-user session tokens (UserStore), optional operator password;
 *   legacy – single shared WEB_PASSWORD (owner role);
 *   open   – no credentials configured, trusted network only.
 */
async function resolvePrincipal(request, url) {
  const authorization = request.headers.authorization || '';
  // Token sources, in order: Authorization: Bearer, ?token= (legacy clients),
  // then the wz_token cookie set at login — so PDF iframes and EventSource
  // authenticate without leaking tokens into URLs.
  const cookieToken = /(?:^|;\s*)wz_token=([^;]+)/.exec(request.headers.cookie || '')?.[1];
  const queryToken = url.searchParams.get('token');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7)
    : (queryToken || (cookieToken ? decodeURIComponent(cookieToken) : ''));
  const mode = await authMode();
  if (token) {
    const user = await userStore.resolveToken(token);
    if (user) return { kind: 'user', user, role: user.role, token };
    if (WEB_PASSWORD && secretsMatch(token, WEB_PASSWORD)) return { kind: 'legacy', user: null, role: 'owner', token };
    if (mode.mode === 'open') return { kind: 'open', user: null, role: 'owner' };
    return null;
  }
  if (mode.mode === 'open') return { kind: 'open', user: null, role: 'owner' };
  return null;
}

// The Secure attribute is added when the request arrived over https (directly
// or via a TLS-terminating proxy that sets X-Forwarded-Proto) or when the
// operator declares a https PUBLIC_URL. Over plain http it must stay off —
// browsers drop Secure cookies on insecure origins and login would break.
const PUBLIC_URL = process.env.PUBLIC_URL || '';
function cookieAttrs(secure) {
  const base = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';
  return secure ? `${base}; Secure` : base;
}
function isSecureRequest(request) {
  if (PUBLIC_URL.startsWith('https://')) return true;
  const proto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}
function issueAuthCookie(response, token, secure = false) {
  response.setHeader('set-cookie', `wz_token=${encodeURIComponent(token)}; ${cookieAttrs(secure)}`);
}
function clearAuthCookie(response, secure = false) {
  response.setHeader('set-cookie', `wz_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

async function readJson(request) {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1000000) throw Object.assign(new Error('Request too large.'), { statusCode: 413 });
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON body: ${error.message}`), { statusCode: 400 });
  }
}

// Baseline security headers for every static response. CSP allows the two
// esbuild bundles plus inline styles (JS-driven styling); PDF.js runs its
// worker as a same-origin module and may use blob: frames on some browsers.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

// Compressed in-memory copies for large static bundles (annotator.js is 1MB+).
// Keyed by relative path; invalidated never — bundles change only on rebuild,
// which bumps the content but not the path, so the process should restart anyway.
const gzipCache = new Map();

async function serveFile(response, relativePath, contentType, maxAge = 3600, request = null) {
  const filePath = path.join(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(response, 403, { error: 'Forbidden' });
  try {
    const data = await fsp.readFile(filePath);
    const acceptsGzip = request && String(request.headers['accept-encoding'] || '').includes('gzip');
    const worthCompressing = data.length > 1024 && /text|javascript|json/.test(contentType);
    if (acceptsGzip && worthCompressing) {
      let gz = gzipCache.get(relativePath);
      if (!gz || gz.length === 0) {
        gz = zlib.gzipSync(data, { level: 6 });
        gzipCache.set(relativePath, gz);
      }
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': gz.length,
        'content-encoding': 'gzip',
        'cache-control': `public, max-age=${maxAge}`,
        vary: 'Accept-Encoding',
        ...SECURITY_HEADERS
      });
      return response.end(gz);
    }
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': data.length,
      'cache-control': `public, max-age=${maxAge}`,
      ...SECURITY_HEADERS
    });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

async function servePdf(request, response, itemKey, attachmentKey) {
  const pdf = zoteroDatabase.resolvePdf(itemKey, attachmentKey);
  if (!pdf) return sendJson(response, 404, { error: 'PDF not found' });
  let stat;
  try {
    stat = await fsp.stat(pdf.filePath);
  } catch {
    return sendJson(response, 404, { error: 'The PDF file is no longer on disk. Refresh the library.' });
  }
  // The file can vanish or lock between stat and read; an unhandled stream
  // error would crash the whole process, so route it to a clean 410.
  const pipeStream = (stream, headers) => {
    stream.on('error', () => {
      if (!response.headersSent) sendJson(response, 410, { error: 'The PDF became unreadable while streaming.' });
      response.destroy();
    });
    response.writeHead(headers.status, headers.head);
    stream.pipe(response);
  };
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return sendJson(response, 400, { error: 'Invalid range' });
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? stat.size - 1 : Number(match[2]);
    if (start === null) start = Math.max(0, stat.size - Number(match[2]));
    end = Math.min(end, stat.size - 1);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) {
      response.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return response.end();
    }
    return pipeStream(fs.createReadStream(pdf.filePath, { start, end }), {
      status: 206,
      head: {
        'content-type': 'application/pdf',
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'x-content-type-options': 'nosniff'
      }
    });
  }
  return pipeStream(fs.createReadStream(pdf.filePath), {
    status: 200,
    head: {
      'content-type': 'application/pdf',
      'content-length': stat.size,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300'
    }
  });
}

async function serveText(request, response, itemKey, attachmentKey) {
  const pdf = zoteroDatabase.resolvePdf(itemKey, attachmentKey);
  if (!pdf) return sendJson(response, 404, { error: 'PDF not found' });
  try {
    const text = await fsp.readFile(pdf.textCachePath, 'utf8');
    sendJson(response, 200, { itemKey, attachmentKey, pages: [], text });
  } catch {
    sendJson(response, 503, { error: 'No extracted text cache exists for this PDF. Open it once in desktop Zotero or run indexing after Zotero creates the cache.' });
  }
}

function itemMatchesQuery(item, query) {
  return `${item.title} ${item.creators.join(' ')}`.toLowerCase().includes(query);
}

const IMPORT_KEY_PREFIX = 'WEB';
function nextImportKey() {
  return `${IMPORT_KEY_PREFIX}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

const SORTERS = {
  dateModified: (a, b) => String(b.dateModified || '').localeCompare(String(a.dateModified || '')),
  dateAdded: (a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')),
  title: (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'),
  author: (a, b) => (a.creators[0] || '').localeCompare(b.creators[0] || '', 'zh-Hans-CN')
};

function sortItems(items, sort) {
  const sorter = SORTERS[sort] || SORTERS.dateModified;
  return [...items].sort(sorter);
}

/** Shapes a web-imported record like an itemDetail for detail/export views. */
async function importedDetail(key) {
  const imported = await webStore.getImported(key);
  if (!imported) return null;
  return {
    id: null,
    key: imported.key,
    title: imported.title,
    itemType: imported.itemType,
    creators: imported.creators,
    fields: imported.fields,
    tags: [],
    collections: [],
    notes: [],
    annotations: [],
    attachments: [],
    imported: true
  };
}

function normalizeCreators(creators) {
  return creators.map(person => [person.firstName, person.lastName].filter(Boolean).join(' '));
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
    return sendJson(response, 405, { error: 'Method not allowed' });
  }

  const principal = await resolvePrincipal(request, url);
  if (!principal && pathname !== '/api/auth') {
    return sendJson(response, 401, { error: 'Unauthorized', auth: true, mode: (await authMode()).mode });
  }
  const effective = principal || { kind: 'anonymous', user: null, role: 'viewer' };
  if (costlyEndpointExceeded(pathname, clientIp(request))) {
    return sendJson(response, 429, { error: 'Too many requests for this endpoint. Try again later.' });
  }
  if (request.method !== 'GET' && !READ_ONLY_POST_ROUTES.has(pathname)
      && ROLE_RANK[effective.role] < ROLE_RANK.editor) {
    return sendJson(response, 403, { error: `Your role (${effective.role}) is read-only.` });
  }

  if (pathname === '/api/items' && request.method === 'GET') {
    const items = await zoteroDatabase.refreshItems();
    // Web-imported entries join the library (they have no PDFs/collections).
    const combined = items.concat(await webStore.listImported());
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    const collectionId = Number(url.searchParams.get('collection'));
    const tagName = (url.searchParams.get('tag') || '').trim();
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    let filtered = query ? combined.filter(item => itemMatchesQuery(item, query)) : combined;
    const collectionIds = Number.isFinite(collectionId) && collectionId > 0
      ? zoteroDatabase.collectionItemIds(collectionId)
      : null;
    if (collectionIds) filtered = filtered.filter(item => !item.imported && collectionIds.has(item.id));
    if (tagName) {
      const taggedIds = zoteroDatabase.tagItemIds(tagName);
      filtered = filtered.filter(item => !item.imported && taggedIds.has(item.id));
    }
    const sort = url.searchParams.get('sort') || 'dateModified';
    filtered = sortItems(filtered, sort);
    const page = filtered.slice(offset, offset + limit);
    return sendJson(response, 200, {
      count: filtered.length,
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + page.length < filtered.length,
      items: page
    });
  }

  // Batch import from BibTeX/RIS/identifier text into the web layer.
  if (pathname === '/api/items/batch-import' && request.method === 'POST') {
    const body = await readJson(request);
    if (typeof body.input !== 'string' || !body.input.trim()) {
      return sendJson(response, 400, { error: 'Field "input" (string) is required.' });
    }
    let resolved;
    try {
      resolved = await resolveIdentifier(body.input, { timeoutMs: Number(body.timeoutMs) || 12000 });
    } catch (error) {
      return sendJson(response, error.statusCode || 502, { error: error.message || 'Metadata resolution failed.' });
    }
    const records = (resolved.items && resolved.items.length ? resolved.items : [resolved.item]).map(item => ({
      key: nextImportKey(),
      itemType: item.itemType || 'journalArticle',
      title: item.title || 'Untitled',
      creators: item.creators || [],
      fields: item.fields || {}
    }));
    await webStore.saveImported(records);
    return sendJson(response, 201, { imported: records.length, keys: records.map(record => record.key), source: resolved.source });
  }

  // Imported (web-layer) items may be removed; Zotero rows stay read-only.
  if (/^\/api\/items\/[^/]+$/.test(pathname) && request.method === 'DELETE') {
    const key = decodeURIComponent(pathname.split('/')[3]);
    const result = await webStore.deleteImported(key);
    return result.deleted
      ? sendJson(response, 200, result)
      : sendJson(response, 403, { error: 'Zotero library items are read-only; only imported entries can be deleted.' });
  }

  if (pathname.startsWith('/api/items/') && pathname.endsWith('/detail') && request.method === 'GET') {
    const key = decodeURIComponent(pathname.split('/')[3]);
    const detail = zoteroDatabase.itemDetail(key) || await importedDetail(key);
    return detail ? sendJson(response, 200, detail) : sendJson(response, 404, { error: 'Item not found' });
  }

  if (/^\/api\/items\/[^/]+\/export\.(json|csv|bib|txt|ris)$/.test(pathname) && request.method === 'GET') {
    const match = pathname.match(/^\/api\/items\/([^/]+)\/export\.(json|csv|bib|txt|ris)$/);
    const detail = zoteroDatabase.itemDetail(decodeURIComponent(match[1])) || await importedDetail(decodeURIComponent(match[1]));
    if (!detail) return sendJson(response, 404, { error: 'Item not found' });
    let body;
    let type;
    let filename;
    if (match[2] === 'bib') { body = exportFormats(detail).bibtex; type = 'application/x-bibtex; charset=utf-8'; filename = `${detail.key}.bib`; }
    else if (match[2] === 'csv') { body = exportCsv(detail); type = 'text/csv; charset=utf-8'; filename = `${detail.key}.csv`; }
    else if (match[2] === 'json') { body = exportJson(detail); type = 'application/json; charset=utf-8'; filename = `${detail.key}.json`; }
    else if (match[2] === 'ris') { body = exportRis(detail); type = 'application/x-research-info-systems; charset=utf-8'; filename = `${detail.key}.ris`; }
    else { body = exportFormats(detail).apa; type = 'text/plain; charset=utf-8'; filename = `${detail.key}.txt`; }
    response.writeHead(200, {
      'content-type': type,
      'content-disposition': `attachment; filename="${filename}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    });
    return response.end(body);
  }

  // Batch notes export (Markdown digest / JSON compilation)
  if ((pathname === '/api/export/notes.md' || pathname === '/api/export/notes.json') && request.method === 'GET') {
    const allNotes = await webStore.listAllNotes();
    const format = pathname.endsWith('.json') ? 'json' : 'md';
    const collectionId = Number(url.searchParams.get('collection'));
    const tagName = (url.searchParams.get('tag') || '').trim();

    const items = await zoteroDatabase.refreshItems();
    const imported = await webStore.listImported();
    const allItems = items.concat(imported);
    const itemMap = new Map(allItems.map(item => [item.key, item]));

    let filteredNotes = allNotes;
    if (collectionId > 0) {
      const collItemIds = zoteroDatabase.collectionItemIds(collectionId);
      filteredNotes = filteredNotes.filter(n => {
        const it = itemMap.get(n.itemKey);
        return it && !it.imported && collItemIds && collItemIds.has(it.id);
      });
    }
    if (tagName) {
      const tagItemIds = zoteroDatabase.tagItemIds(tagName);
      filteredNotes = filteredNotes.filter(n => {
        const it = itemMap.get(n.itemKey);
        return it && !it.imported && tagItemIds && tagItemIds.has(it.id);
      });
    }

    if (format === 'json') {
      const payload = {
        exportedAt: new Date().toISOString(),
        count: filteredNotes.length,
        notes: filteredNotes.map(n => {
          const item = itemMap.get(n.itemKey);
          return {
            itemKey: n.itemKey,
            title: item?.title || n.itemKey,
            authors: item?.creators || [],
            version: n.version,
            updatedAt: n.updatedAt,
            content: n.content,
            html: n.html
          };
        })
      };
      const jsonStr = JSON.stringify(payload, null, 2);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(jsonStr),
        'content-disposition': 'attachment; filename="web-zotero-notes.json"',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      });
      return response.end(jsonStr);
    }

    let md = `# Web Zotero Notes Export\n\n- **Export Date**: ${new Date().toISOString()}\n- **Total Notes**: ${filteredNotes.length}\n\n---\n\n`;
    for (const n of filteredNotes) {
      const item = itemMap.get(n.itemKey);
      const title = item?.title || n.itemKey;
      const authors = (item?.creators || []).join(', ');
      md += `## ${title}\n\n`;
      if (authors) md += `- **Authors**: ${authors}\n`;
      md += `- **Item Key**: \`${n.itemKey}\`\n`;
      md += `- **Last Updated**: ${n.updatedAt}\n\n`;
      md += `${n.content || ''}\n\n---\n\n`;
    }

    const mdBuffer = Buffer.from(md, 'utf8');
    response.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': mdBuffer.length,
      'content-disposition': 'attachment; filename="web-zotero-notes.md"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    });
    return response.end(mdBuffer);
  }

  if (/^\/api\/items\/[^/]+\/files\/[^/]+$/.test(pathname) && request.method === 'GET') {
    const [, , , itemKey, , attachmentKey] = pathname.split('/');
    return servePdf(request, response, decodeURIComponent(itemKey), decodeURIComponent(attachmentKey));
  }

  if (/^\/api\/items\/[^/]+\/files\/[^/]+\/text$/.test(pathname) && request.method === 'GET') {
    const [, , , itemKey, , attachmentKey] = pathname.split('/');
    return serveText(request, response, decodeURIComponent(itemKey), decodeURIComponent(attachmentKey));
  }

  if (/^\/api\/items\/[^/]+\/notes$/.test(pathname)) {
    const itemKey = decodeURIComponent(pathname.split('/')[3]);
    if (request.method === 'GET') return sendJson(response, 200, await webStore.getNote(itemKey));
    if (request.method === 'DELETE') {
      const result = await webStore.deleteNote(itemKey);
      eventBus.publish('note', {
        action: 'deleted',
        itemKey,
        by: effective.user ? (effective.user.displayName || effective.user.email) : 'Someone'
      });
      return sendJson(response, 200, result);
    }
    const body = await readJson(request);
    const expectedVersion = body.version == null ? null : Number(body.version);
    try {
      let saved;
      if (typeof body.html === 'string') {
        const html = sanitizeNoteHtml(body.html.slice(0, 210000));
        saved = await webStore.saveNote(itemKey, noteHtmlToPlainText(html), html, expectedVersion);
      } else {
        saved = await webStore.saveNote(itemKey, String(body.content || '').slice(0, 200000), null, expectedVersion);
      }
      eventBus.publish('note', {
        action: 'saved',
        itemKey,
        version: saved.version,
        updatedAt: saved.updatedAt,
        html: saved.html,
        content: saved.content,
        by: effective.user ? (effective.user.displayName || effective.user.email) : 'Someone'
      });
      return sendJson(response, 200, saved);
    } catch (error) {
      if (error.statusCode === 409 && error.currentNote) {
        return sendJson(response, 409, {
          error: 'This note was updated by someone else while you were editing.',
          conflict: true,
          current: error.currentNote
        });
      }
      throw error;
    }
  }

  if (/^\/api\/items\/[^/]+\/presence$/.test(pathname) && request.method === 'POST') {
    const itemKey = decodeURIComponent(pathname.split('/')[3]);
    const body = await readJson(request);
    eventBus.publish('note_presence', {
      itemKey,
      user: {
        id: effective.user?.id || null,
        email: effective.user?.email || 'Anonymous',
        displayName: effective.user?.displayName || (effective.user?.email ? effective.user.email.split('@')[0] : 'Anonymous'),
        color: body.color || '#3b82f6'
      },
      state: body.state || 'active',
      timestamp: Date.now()
    });
    return sendJson(response, 200, { ok: true });
  }

  if (/^\/api\/items\/[^/]+\/note-versions$/.test(pathname) && request.method === 'GET') {
    const itemKey = decodeURIComponent(pathname.split('/')[3]);
    return sendJson(response, 200, { versions: await webStore.listNoteVersions(itemKey) });
  }

  if (/^\/api\/items\/[^/]+\/desktop-notes$/.test(pathname) && request.method === 'GET') {
    const detail = zoteroDatabase.itemDetail(decodeURIComponent(pathname.split('/')[3]));
    return detail ? sendJson(response, 200, { notes: detail.notes }) : sendJson(response, 404, { error: 'Item not found' });
  }

  if (/^\/api\/items\/[^/]+\/annotations$/.test(pathname) && request.method === 'GET') {
    const itemKey = decodeURIComponent(pathname.split('/')[3]);
    const detail = zoteroDatabase.itemDetail(itemKey);
    if (!detail) return sendJson(response, 404, { error: 'Item not found' });
    const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'md';
    const annotations = zoteroDatabase.database.prepare(`
      SELECT type, text, comment, color, pageLabel, authorName
      FROM itemAnnotations WHERE parentItemID = ? ORDER BY sortIndex
    `).all(detail.id);
    const body = format === 'csv' ? annotationsToCsv(annotations) : annotationsToMarkdown(annotations);
    response.writeHead(200, {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${itemKey}-annotations.${format}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    });
    return response.end(body);
  }

  // Web-layer annotation export (md/csv) — same formatters as the desktop export.
  if (/^\/api\/items\/[^/]+\/web-annotations\.(md|csv|json)$/.test(pathname) && request.method === 'GET') {
    const match = pathname.match(/^\/api\/items\/([^/]+)\/web-annotations\.(md|csv|json)$/);
    const itemKey = decodeURIComponent(match[1]);
    const format = match[2];
    const annotations = annotationStore.list({ itemKey });
    if (!annotations.length) return sendJson(response, 200, { annotations: [], message: 'No web annotations for this item.' });
    let body;
    let contentType;
    let filename;
    if (format === 'csv') {
      body = annotationsToCsv(annotations.map(a => ({
        type: a.type, text: a.quoteText, comment: a.commentText,
        color: a.color, pageLabel: a.pageLabel, authorName: a.authorEmail
      })));
      contentType = 'text/csv; charset=utf-8';
      filename = `${itemKey}-web-annotations.csv`;
    } else if (format === 'json') {
      body = JSON.stringify({ itemKey, annotations }, null, 2);
      contentType = 'application/json; charset=utf-8';
      filename = `${itemKey}-web-annotations.json`;
    } else {
      body = annotationsToMarkdown(annotations.map(a => ({
        type: a.type, text: a.quoteText, comment: a.commentText,
        color: a.color, pageLabel: a.pageLabel, authorName: a.authorEmail
      })));
      contentType = 'text/markdown; charset=utf-8';
      filename = `${itemKey}-web-annotations.md`;
    }
    response.writeHead(200, {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    });
    return response.end(body);
  }

  if (/^\/api\/items\/[^/]+\/related$/.test(pathname) && request.method === 'GET') {
    await zoteroDatabase.refreshItems();
    const key = decodeURIComponent(pathname.split('/')[3]);
    return sendJson(response, 200, { related: await hybridRelated(key, 10) });
  }

  // Backlinks: which notes contain a "[[<this item's title>]]" wiki link.
  if (/^\/api\/items\/[^/]+\/mentions$/.test(pathname) && request.method === 'GET') {
    const key = decodeURIComponent(pathname.split('/')[3]);
    const item = zoteroDatabase.getItemByKey(key);
    if (!item) return sendJson(response, 404, { error: 'Item not found' });
    const mentions = (await webStore.mentions(item.title)).map(entry => {
      const source = zoteroDatabase.getItemByKey(entry.itemKey);
      return {
        itemKey: entry.itemKey,
        title: source ? source.title : entry.itemKey,
        updatedAt: entry.updatedAt
      };
    });
    return sendJson(response, 200, { title: item.title, mentions });
  }

  if (pathname === '/api/ai/ask' && request.method === 'POST') {
    if (!semanticIndex.ready) {
      return sendJson(response, 503, { error: 'The semantic index is not built yet. Trigger POST /api/index/rebuild first.' });
    }
    const body = await readJson(request);
    if (typeof body.itemKey === 'string' && body.itemKey && !zoteroDatabase.itemDetail(body.itemKey)) {
      return sendJson(response, 404, { error: 'Item not found' });
    }
    try {
      const result = await ask({
        question: body.question,
        itemKey: typeof body.itemKey === 'string' && body.itemKey ? body.itemKey : null,
        semanticIndex,
        apiKey: OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL,
        baseUrl: AI_BASE_URL
      });
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message || 'Question answering failed.' });
    }
  }

  if (/^\/api\/items\/[^/]+\/files\/[^/]+\/offline$/.test(pathname)) {
    const [, , , itemKey, , attachmentKey] = pathname.split('/');
    if (request.method === 'POST') {
      const pdf = zoteroDatabase.resolvePdf(decodeURIComponent(itemKey), decodeURIComponent(attachmentKey));
      if (!pdf) return sendJson(response, 404, { error: 'PDF not found' });
      return sendJson(response, 200, await offlineLibrary.save(pdf.itemKey || decodeURIComponent(itemKey), pdf.key, pdf.filePath));
    }
    if (request.method === 'DELETE') {
      return sendJson(response, 200, await offlineLibrary.remove(decodeURIComponent(itemKey), decodeURIComponent(attachmentKey)));
    }
  }

  if (pathname === '/api/offline' && request.method === 'GET') {
    return sendJson(response, 200, { offline: await offlineLibrary.listDetailed() });
  }

  if (/^\/api\/items\/[^/]+\/offline$/.test(pathname) && request.method === 'DELETE') {
    return sendJson(response, 200, await offlineLibrary.remove(decodeURIComponent(pathname.split('/')[3])));
  }

  // S3 / MinIO / R2 attachment direct presigned upload URL (R7b Phase 3 / R8)
  if ((pathname === '/api/attachments/upload-url' || /^\/api\/items\/[^/]+\/attachments\/upload-url$/.test(pathname)) && request.method === 'POST') {
    if (ROLE_RANK[effective.role] < ROLE_RANK.editor) {
      return sendJson(response, 403, { error: `Your role (${effective.role}) is read-only.` });
    }
    const body = await readJson(request);
    const itemKey = pathname.startsWith('/api/items/') ? decodeURIComponent(pathname.split('/')[3]) : (body.itemKey || 'global');
    const attachmentKey = body.attachmentKey || null;
    const filename = body.filename || 'attachment.pdf';
    const contentType = body.contentType || 'application/pdf';
    // Clamp to a sane range: 1 minute .. 24 hours.
    const expiresIn = Math.min(86400, Math.max(60, Number(body.expiresIn) || 900));

    const fileKey = s3Storage.generateFileKey(itemKey, attachmentKey, filename);
    try {
      const presigned = s3Storage.generatePresignedUploadUrl({
        fileKey,
        contentType,
        expiresIn
      });
      return sendJson(response, 200, presigned);
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message });
    }
  }

  if (/^\/api\/items\/[^/]+\/progress$/.test(pathname)) {
    const itemKey = decodeURIComponent(pathname.split('/')[3]);
    if (request.method === 'GET') return sendJson(response, 200, await webStore.getProgress(itemKey));
    const body = await readJson(request);
    return sendJson(response, 200, await webStore.saveProgress(itemKey, body.percent));
  }

  if (pathname === '/api/stats/reading' && request.method === 'GET') {
    const stats = await webStore.readingStats(url.searchParams.get('limit'));
    // Attach titles for display.
    for (const entry of stats.recent) {
      const item = zoteroDatabase.getItemByKey(entry.itemKey);
      entry.title = item ? item.title : ((await webStore.getImported(entry.itemKey))?.title ?? entry.itemKey);
    }
    return sendJson(response, 200, stats);
  }

  if (pathname === '/api/tags' && request.method === 'GET') {
    return sendJson(response, 200, { tags: zoteroDatabase.listTags() });
  }

  if (pathname === '/api/collections' && request.method === 'GET') {
    const rows = zoteroDatabase.database.prepare(`
      SELECT c.collectionID AS id, c.collectionName AS name, c.parentCollectionID AS parentId,
             (SELECT COUNT(*) FROM collectionItems ci JOIN items i ON i.itemID=ci.itemID
              LEFT JOIN deletedItems d ON d.itemID=i.itemID WHERE ci.collectionID=c.collectionID AND d.itemID IS NULL) AS itemCount
      FROM collections c ORDER BY c.collectionName COLLATE NOCASE
    `).all();
    return sendJson(response, 200, { collections: rows });
  }

  if (pathname === '/api/search' && request.method === 'GET') {
    const query = url.searchParams.get('q') || '';
    const limit = Number(url.searchParams.get('limit') || 30);
    const requestedMode = url.searchParams.get('mode');
    const mode = requestedMode === 'lexical' || requestedMode === 'semantic' || requestedMode === 'hybrid'
      ? requestedMode
      : (semanticIndex.ready ? 'hybrid' : 'lexical');
    let results;
    if (mode === 'lexical') results = searchIndex.search(query, limit).map(result => ({ ...result, mode }));
    else if (mode === 'semantic') results = semanticIndex.ready ? (await semanticIndex.search(query, limit)).map(result => ({ ...result, mode })) : [];
    else results = await hybridSearch(query, limit);
    return sendJson(response, 200, {
      query,
      mode,
      results,
      index: searchIndex.status(),
      semantic: await semanticIndex.status()
    });
  }

  if (pathname === '/api/index/rebuild' && request.method === 'POST') {
    const result = await searchIndex.reindex({ force: url.searchParams.get('force') === '1', limit: 100000 });
    if (result.started) {
      // The LSA math runs in a worker thread; the server keeps answering.
      semanticIndex.rebuildAsync().then(semantic => {
        if (semantic.ready) {
          console.log(`Semantic index built: ${semantic.chunks} chunks, ${semantic.items} items, ${semantic.terms} terms, dim ${semantic.dimensions}`);
        } else if (semantic.reason || semantic.error) {
          console.error(`Semantic index rebuild did not complete: ${semantic.reason || semantic.error}`);
        }
      }).catch(error => console.error(`Semantic index rebuild failed: ${error.message}`));
    }
    return sendJson(response, result.started ? 200 : 202, result);
  }

  if (pathname === '/api/ai/summarize' && request.method === 'POST') {
    const body = await readJson(request);
    const detail = typeof body.itemKey === 'string'
      ? (zoteroDatabase.itemDetail(body.itemKey) || importedDetail(body.itemKey))
      : null;
    if (!detail) return sendJson(response, 404, { error: 'Item not found' });
    // Imported entries have no local PDF; summarize from stored metadata.
    if (detail.imported) {
      const refreshImported = url.searchParams.get('refresh') === '1';
      if (!refreshImported) {
        const cached = await webStore.getCachedSummary(detail.key);
        if (cached) return sendJson(response, 200, { ...cached, cached: true });
      }
      const metaText = [detail.title, detail.fields.abstractNote, detail.fields.publicationTitle]
        .filter(Boolean).join('. ');
      if (!metaText) return sendJson(response, 503, { error: 'This imported item has no abstract to summarize.' });
      const localMeta = localSummary({ title: detail.title, authors: normalizeCreators(detail.creators), text: metaText });
      await webStore.cacheSummary(detail.key, 'local', localMeta);
      return sendJson(response, 200, localMeta);
    }
    const attachment = detail.attachments.find(file => file.exists);
    if (!attachment) return sendJson(response, 409, { error: 'This item has no available PDF.' });
    const refresh = url.searchParams.get('refresh') === '1';
    if (!refresh) {
      const cached = await webStore.getCachedSummary(detail.key);
      if (cached) return sendJson(response, 200, { ...cached, cached: true });
    }
    let extracted;
    try {
        extracted = await fsp.readFile(path.join(zoteroDatabase.storagePath, attachment.key, '.zotero-ft-cache'), 'utf8');
    } catch {
      return sendJson(response, 503, { error: 'No PDF text cache. Open this file once in desktop Zotero first.' });
    }
    const input = {
      title: detail.title,
      authors: normalizeCreators(detail.creators),
      text: extracted
    };
    try {
      if (!OPENAI_API_KEY) {
        const local = localSummary(input);
        await webStore.cacheSummary(detail.key, 'local', local);
        return sendJson(response, 200, local);
      }
      const summary = await openAiSummary({ ...input, apiKey: OPENAI_API_KEY, model: process.env.OPENAI_MODEL, baseUrl: AI_BASE_URL });
      await webStore.cacheSummary(detail.key, summary.provider || 'openai', summary);
      return sendJson(response, 200, summary);
    } catch (error) {
      if (!OPENAI_API_KEY) return sendJson(response, 500, { error: error.message });
      try {
        const fallback = { ...localSummary(input), warning: `OpenAI failed; local analysis used instead: ${error.message}` };
        await webStore.cacheSummary(detail.key, 'local', fallback);
        return sendJson(response, 200, fallback);
      } catch (fallbackError) {
        return sendJson(response, 503, { error: fallbackError.message });
      }
    }
  }

  if (pathname === '/api/metadata/resolve' && request.method === 'POST') {
    const body = await readJson(request);
    if (typeof body.input !== 'string' || !body.input.trim()) {
      return sendJson(response, 400, { error: 'Field "input" (string) is required.' });
    }
    try {
      const result = await resolveIdentifier(body.input, { timeoutMs: Number(body.timeoutMs) || 12000 });
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, error.statusCode || 502, { error: error.message || 'Metadata resolution failed.' });
    }
  }

  if (pathname === '/api/formula-ocr' && request.method === 'POST') {
    const body = await readJson(request);
    try {
      const result = await recognizeFormula(body.image, { timeoutMs: Number(body.timeoutMs) || 30000 });
      const saved = await webStore.saveFormula(result.latex, typeof body.itemKey === 'string' ? body.itemKey : null);
      return sendJson(response, 200, { ...result, historyId: saved.id });
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message || 'Formula recognition failed.' });
    }
  }

  if (pathname === '/api/formulas' && request.method === 'GET') {
    return sendJson(response, 200, { formulas: await webStore.listFormulas(url.searchParams.get('limit')) });
  }

  if (/^\/api\/formulas\/\d+$/.test(pathname) && request.method === 'DELETE') {
    return sendJson(response, 200, await webStore.deleteFormula(Number(pathname.split('/')[3])));
  }

  if (pathname === '/api/citations/styles' && request.method === 'GET') {
    return sendJson(response, 200, listStyles());
  }

  if (pathname === '/api/citations/format' && request.method === 'POST') {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, { error: `Invalid JSON body: ${error.message}` });
    }
    let items = Array.isArray(body.items) ? body.items : null;
    if (!items && typeof body.itemKey === 'string') {
      const detail = zoteroDatabase.itemDetail(body.itemKey);
      if (!detail) return sendJson(response, 404, { error: 'Item not found' });
      items = [{
        key: detail.key,
        itemType: detail.itemType || 'journalArticle',
        title: detail.title,
        creators: detail.creators || [],
        fields: detail.fields || {},
      }];
    }
    try {
      const result = formatCitations({
        items,
        style: body.style,
        lang: body.lang,
        mode: body.mode,
      });
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message || 'Citation formatting failed.' });
    }
  }

  if (pathname === '/api/plugins' && request.method === 'GET') {
    const plugins = await installedDesktopPlugins(ZOTERO_PROFILE_ROOT);
    return sendJson(response, 200, {
      note: 'Desktop XPI plug-ins cannot execute directly in a browser sandbox. These are compatibility and library endpoints for web clients.',
      plugins,
      capabilities: ['metadata', 'notes', 'full-text-search', 'ai-reading']
    });
  }

  if (pathname === '/api/auth' && request.method === 'POST') {
    const ip = clientIp(request);
    if (loginThrottled(ip)) {
      return sendJson(response, 429, { error: 'Too many failed login attempts. Try again in a few minutes.', auth: true });
    }
    const body = await readJson(request);
    const mode = await authMode();
    if (typeof body.email === 'string' && body.email.trim()) {
      try {
        const user = await userStore.authenticate(body.email, body.password);
        clearLoginFailures(ip);
        const token = await userStore.issueToken(user);
        issueAuthCookie(response, token, isSecureRequest(request));
        return sendJson(response, 200, { token, user });
      } catch (error) {
        recordLoginFailure(ip);
        return sendJson(response, error.statusCode || 401, { error: error.message, auth: true });
      }
    }
    if (mode.mode === 'users') {
      return sendJson(response, 401, { error: 'Email and password are required.', auth: true, mode: mode.mode });
    }
    if (!WEB_PASSWORD || !secretsMatch(body.password, WEB_PASSWORD)) {
      recordLoginFailure(ip);
      return sendJson(response, 401, { error: 'Invalid password', auth: true, mode: mode.mode });
    }
    clearLoginFailures(ip);
    issueAuthCookie(response, WEB_PASSWORD, isSecureRequest(request));
    return sendJson(response, 200, { ok: true, token: WEB_PASSWORD, user: { role: 'owner' } });
  }

  // Revokes the caller's session token (user mode); no-op for legacy/open.
  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    clearAuthCookie(response, isSecureRequest(request));
    if (principal?.kind === 'user' && principal.token) await userStore.revokeToken(principal.token);
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === '/api/me' && request.method === 'GET') {
    return sendJson(response, 200, {
      mode: (await authMode()).mode,
      user: effective.user
        ? { email: effective.user.email, displayName: effective.user.displayName, role: effective.user.role }
        : null
    });
  }

  // Self-service account management (user mode only).
  if (pathname === '/api/me/password' && request.method === 'POST') {
    if (!effective.user) return sendJson(response, 400, { error: 'Password changes require a user account (not legacy/open mode).' });
    const body = await readJson(request);
    try {
      const result = await userStore.changePassword(effective.user.id, body.currentPassword, body.newPassword);
      // Other sessions of this user are stale after a rotation.
      await userStore.revokeUserSessions(effective.user.id);
      const fresh = await userStore.issueToken(effective.user);
      return sendJson(response, 200, { ...result, token: fresh });
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message });
    }
  }

  if (pathname === '/api/me/sessions' && request.method === 'GET') {
    if (!effective.user) return sendJson(response, 400, { error: 'Session management requires a user account.' });
    const currentHash = principal?.token ? hashToken(principal.token) : null;
    return sendJson(response, 200, { sessions: await userStore.listSessions(effective.user.id, currentHash) });
  }

  if (/^\/api\/me\/sessions\/[^/]+$/.test(pathname) && request.method === 'DELETE') {
    if (!effective.user) return sendJson(response, 400, { error: 'Session management requires a user account.' });
    try {
      return sendJson(response, 200, await userStore.revokeSession(effective.user.id, decodeURIComponent(pathname.split('/')[4])));
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message });
    }
  }

  if (pathname === '/api/users' && request.method === 'GET') {
    if (ROLE_RANK[effective.role] < ROLE_RANK.owner) return sendJson(response, 403, { error: 'Owner role required.' });
    return sendJson(response, 200, { users: await userStore.listUsers() });
  }

  if (pathname === '/api/users' && request.method === 'POST') {
    if (ROLE_RANK[effective.role] < ROLE_RANK.owner) return sendJson(response, 403, { error: 'Owner role required.' });
    const body = await readJson(request);
    return sendJson(response, 201, { user: await userStore.createUser(body) });
  }

  if (/^\/api\/users\/\d+$/.test(pathname)) {
    if (ROLE_RANK[effective.role] < ROLE_RANK.owner) return sendJson(response, 403, { error: 'Owner role required.' });
    const userId = Number(pathname.split('/')[3]);
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      return sendJson(response, 200, { user: await userStore.updateUser(userId, body) });
    }
    if (request.method === 'DELETE') return sendJson(response, 200, await userStore.deleteUser(userId));
  }

  // ------------------------------------------------------------ workspaces (R7b Phase 3)
  if (pathname === '/api/workspaces' && request.method === 'GET') {
    if (!workspaceStore) return sendJson(response, 501, { error: 'Workspaces require PostgreSQL mode.' });
    if (!effective.user) return sendJson(response, 401, { error: 'Authentication required.' });
    return sendJson(response, 200, { workspaces: await workspaceStore.listWorkspaces(effective.user.id) });
  }

  if (pathname === '/api/workspaces' && request.method === 'POST') {
    if (!workspaceStore) return sendJson(response, 501, { error: 'Workspaces require PostgreSQL mode.' });
    if (!effective.user) return sendJson(response, 401, { error: 'Authentication required.' });
    const body = await readJson(request);
    const workspace = await workspaceStore.createWorkspace({
      name: body.name,
      isPersonal: Boolean(body.isPersonal),
      ownerId: effective.user.id
    });
    return sendJson(response, 201, { workspace });
  }

  if (/^\/api\/workspaces\/\d+$/.test(pathname)) {
    if (!workspaceStore) return sendJson(response, 501, { error: 'Workspaces require PostgreSQL mode.' });
    if (!effective.user) return sendJson(response, 401, { error: 'Authentication required.' });
    const workspaceId = Number(pathname.split('/')[3]);
    if (request.method === 'GET') {
      return sendJson(response, 200, { workspace: await workspaceStore.getWorkspace(workspaceId, effective.user) });
    }
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      return sendJson(response, 200, { workspace: await workspaceStore.updateWorkspace(workspaceId, body, effective.user) });
    }
    if (request.method === 'DELETE') {
      return sendJson(response, 200, await workspaceStore.deleteWorkspace(workspaceId, effective.user));
    }
  }

  if (/^\/api\/workspaces\/\d+\/members$/.test(pathname)) {
    if (!workspaceStore) return sendJson(response, 501, { error: 'Workspaces require PostgreSQL mode.' });
    if (!effective.user) return sendJson(response, 401, { error: 'Authentication required.' });
    const workspaceId = Number(pathname.split('/')[3]);
    if (request.method === 'GET') {
      return sendJson(response, 200, { members: await workspaceStore.listMembers(workspaceId, effective.user) });
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      const member = await workspaceStore.addMember(workspaceId, body, effective.user);
      return sendJson(response, 201, { member });
    }
  }

  if (/^\/api\/workspaces\/\d+\/members\/\d+$/.test(pathname)) {
    if (!workspaceStore) return sendJson(response, 501, { error: 'Workspaces require PostgreSQL mode.' });
    if (!effective.user) return sendJson(response, 401, { error: 'Authentication required.' });
    const [, , , wsId, , memberId] = pathname.split('/');
    const workspaceId = Number(wsId);
    const targetUserId = Number(memberId);
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      const member = await workspaceStore.updateMemberRole(workspaceId, targetUserId, body, effective.user);
      return sendJson(response, 200, { member });
    }
    if (request.method === 'DELETE') {
      return sendJson(response, 200, await workspaceStore.removeMember(workspaceId, targetUserId, effective.user));
    }
  }

  if (pathname === '/api/annotations' && request.method === 'GET') {
    const itemKey = url.searchParams.get('itemKey');
    if (!itemKey) return sendJson(response, 400, { error: 'Query parameter "itemKey" is required.' });
    return sendJson(response, 200, {
      annotations: await annotationStore.list({ itemKey, attachmentKey: url.searchParams.get('attachmentKey') || undefined })
    });
  }

  if (pathname === '/api/annotations' && request.method === 'POST') {
    const body = await readJson(request);
    if (!zoteroDatabase.itemDetail(String(body.itemKey || ''))) {
      return sendJson(response, 404, { error: 'Item not found' });
    }
    const annotation = await annotationStore.create({
      itemKey: body.itemKey,
      attachmentKey: body.attachmentKey,
      authorId: effective.user ? effective.user.id : null,
      pageIndex: body.pageIndex,
      pageLabel: body.pageLabel,
      type: body.type,
      rects: body.rects,
      color: body.color,
      comment: body.comment,
      quote: body.quote
    });
    eventBus.publish('annotation', { action: 'created', by: effective.user ? effective.user.email : null, annotation });
    return sendJson(response, 201, { annotation });
  }

  if (/^\/api\/annotations\/\d+$/.test(pathname)) {
    const annotationId = Number(pathname.split('/')[3]);
    const actor = effective.user ? { id: effective.user.id, role: effective.user.role } : null;
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      const annotation = await annotationStore.update(annotationId, body, actor);
      eventBus.publish('annotation', { action: 'updated', by: effective.user ? effective.user.email : null, annotation });
      return sendJson(response, 200, { annotation });
    }
    if (request.method === 'DELETE') {
      const target = await annotationStore.get(annotationId);
      const result = await annotationStore.remove(annotationId, actor);
      eventBus.publish('annotation', {
        action: 'deleted',
        by: effective.user ? effective.user.email : null,
        annotationId,
        itemKey: target ? target.itemKey : null,
        attachmentKey: target ? target.attachmentKey : null
      });
      return sendJson(response, 200, result);
    }
  }

  // Server-Sent Events stream: live annotation sync for connected pages.
  // EventSource sends Last-Event-ID on reconnect; the query param covers
  // first-load replay requests from the annotator.
  if (pathname === '/api/events' && request.method === 'GET') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    response.write('retry: 5000\n\n');
    const rawLastEventId = request.headers['last-event-id'] ?? url.searchParams.get('lastEventId');
    const lastEventId = rawLastEventId == null || rawLastEventId === ''
      ? null
      : (Number(rawLastEventId) || null);
    const unsubscribe = eventBus.subscribe(
      event => {
        response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
        return true;
      },
      { close: () => response.destroy(), lastEventId }
    );
    const heartbeat = setInterval(() => {
      try {
        response.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);
    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  if (pathname === '/api/health') {
    return sendJson(response, 200, { ...await health.status({ eventBus }), semantic: await semanticIndex.status(), auth: await authMode() });
  }

  return sendJson(response, 404, { error: 'API route not found' });
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const startedAt = Date.now();
  response.on('finish', () => {
    // Compact API request log; static assets stay quiet.
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/events') {
      const line = `${request.method} ${url.pathname} ${response.statusCode} ${Date.now() - startedAt}ms`;
      if (response.statusCode >= 500) console.error(line);
      else console.log(line);
    }
  });
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    const routes = {
      // Entry HTML and un-hashed assets revalidate on every load so UI
      // updates reach already-open browsers without manual hard refreshes;
      // there are no content hashes in these filenames to key caching on.
      '/': ['index.html', 'text/html; charset=utf-8', 0],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8', 0],
      '/styles.css': ['styles.css', 'text/css; charset=utf-8', 0],
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json', 3600],
      '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', 0],
      '/annotator': ['annotator.html', 'text/html; charset=utf-8', 0],
      '/annotator.js': ['annotator.js', 'text/javascript; charset=utf-8', 0],
      '/annotator.css': ['annotator.css', 'text/css; charset=utf-8', 0],
      '/notes': ['notes.html', 'text/html; charset=utf-8', 0],
      '/notes.js': ['notes.js', 'text/javascript; charset=utf-8', 0],
      '/notes.css': ['notes.css', 'text/css; charset=utf-8', 0],
      '/vendor/pdf.worker.min.mjs': ['vendor/pdf.worker.min.mjs', 'text/javascript; charset=utf-8', 0]
    };
    const route = routes[url.pathname];
    if (route) return await serveFile(response, ...route, request);
    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    const status = error.statusCode || 500;
    health.recordError(`${request.method} ${url.pathname}`, error);
    if (status >= 500) console.error(error);
    if (!response.headersSent) sendJson(response, status, { error: error.message || 'Internal server error' });
  }
}

async function main() {
  await zoteroDatabase.refreshItems();

  // Auto-detect PostgreSQL unless DATABASE_URL is explicitly set.
  // pg pool connects lazily, so we probe after instantiation to report the real state.
  const { url: pgUrl } = await pickDatabaseUrl(process.env.DATABASE_URL);
  if (pgUrl) {
    try {
      webStore = new PgWebStore(pgUrl);
      userStore = new PgUserStore(pgUrl);
      annotationStore = new PgWebAnnotationStore(pgUrl);
      workspaceStore = new PgWorkspaceStore(pgUrl);
      semanticIndex = new PgSemanticIndex(pgUrl, {
        apiKey: OPENAI_API_KEY,
        baseUrl: AI_BASE_URL,
        model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
        searchIndex
      });
      health._pgUrl = pgUrl;
      // Probe immediately so the banner shows the real connection state.
      const pgReachable = await health._probePostgres();
      if (pgReachable) {
        console.log(`Using PostgreSQL: ${maskConnectionString(pgUrl)}`);
      } else {
        console.warn(`PostgreSQL unreachable — ${maskConnectionString(pgUrl)}. Falling back to SQLite stores.`);
        webStore = new WebStore(DATA_DIR);
        userStore = new UserStore(DATA_DIR);
        annotationStore = new WebAnnotationStore(DATA_DIR);
        workspaceStore = null;
        semanticIndex = new SemanticIndex(DATA_DIR, searchIndex);
      }
    } catch (err) {
      console.warn(`PostgreSQL error — ${err.message}. Falling back to SQLite stores.`);
      webStore = new WebStore(DATA_DIR);
      userStore = new UserStore(DATA_DIR);
      annotationStore = new WebAnnotationStore(DATA_DIR);
      workspaceStore = null;
      semanticIndex = new SemanticIndex(DATA_DIR, searchIndex);
    }
  } else {
    webStore = new WebStore(DATA_DIR);
    userStore = new UserStore(DATA_DIR);
    annotationStore = new WebAnnotationStore(DATA_DIR);
    workspaceStore = null;
    semanticIndex = new SemanticIndex(DATA_DIR, searchIndex);
  }
  health._bindStores(webStore, userStore, annotationStore);
  const offlineLibrary = new OfflineLibrary(DATA_DIR);

  const server = http.createServer(handle);
  // Keep serving after stray stream/promise errors: log loudly instead of dying.
  process.on('uncaughtException', error => console.error(`uncaughtException: ${error.stack || error}`));
  process.on('unhandledRejection', reason => console.error(`unhandledRejection: ${reason?.stack || reason}`));
  server.listen(PORT, HOST, async () => {
    const mode = await authMode();
    const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
    console.log(`Web Zotero ready on ${PORT} (bound to ${HOST})`);
    if (loopback) {
      console.log('  Remote access: set HOST=0.0.0.0 (plus WEB_PASSWORD or user accounts) to expose to your LAN.');
    } else {
      for (const network of Object.values(os.networkInterfaces()).flat()) {
        if (network?.family === 'IPv4' && !network.internal) console.log(`  http://${network.address}:${PORT}`);
      }
      if (mode.mode === 'open') {
        console.warn('  WARNING: reachable from the network with NO authentication. Set WEB_PASSWORD or create a user account.');
      }
    }
    console.log(`Library items: ${zoteroDatabase.items.length}; indexed documents: ${searchIndex.status().indexed}`);
    console.log(`Auth mode: ${mode.mode}${mode.mode === 'users' ? ` (${mode.users} users)` : ''}`);
    console.log(`Database: ${pgUrl ? `PostgreSQL (${maskConnectionString(pgUrl)})` : 'SQLite (./data)'}`);
    console.log(`  AI: ${OPENAI_API_KEY ? 'OpenAI' : AI_BASE_URL.startsWith('http://127.0.0.1') || AI_BASE_URL.startsWith('http://localhost') ? 'local OpenAI-compatible' : 'local extractive'}`);
    console.log(`  OCR: ${process.env.FORMULA_OCR_URL ? 'enabled' : 'not running (pip install pix2text && p2t serve to enable)'}`);
    console.log(`  S3: ${s3Storage.isConfigured() ? 'configured' : 'disabled'}`);
  });
  setImmediate(async () => {
    try {
      if (semanticIndex.init) await semanticIndex.init();
      const result = await searchIndex.reindex({ limit: 100000 });
      if (result.started) console.log(`Initial index complete: ${result.indexed} indexed, ${result.skipped} skipped`);
      if (semanticIndex.rebuildAsync) {
        const semantic = await semanticIndex.rebuildAsync();
        if (semantic.ready) {
          console.log(`Semantic index ready: ${semantic.chunks} chunks, ${semantic.items} items, ${semantic.terms} terms, dim ${semantic.dimensions}`);
        } else if (semantic.reason) {
          console.log(`Semantic index skipped: ${semantic.reason}`);
        }
      }
    } catch (error) {
      console.error(error.message);
    }
  });
  const shutdown = () => {
    eventBus.closeAll();
    // Force-exit after 5s: lingering keep-alive connections would otherwise
    // keep server.close()'s callback (and the process) alive indefinitely.
    const forceExit = setTimeout(() => process.exit(0), 5000);
    forceExit.unref();
    server.closeAllConnections?.();
    server.close(async () => {
      searchIndex.database?.close?.();
      if (webStore.close) await webStore.close();
      else webStore.database?.close?.();
      if (userStore.close) await userStore.close();
      if (annotationStore.close) await annotationStore.close();
      else annotationStore.database?.close?.();
      if (workspaceStore?.close) await workspaceStore.close();
      if (semanticIndex.close) await semanticIndex.close();
      zoteroDatabase.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { main, handle, handleApi };
