'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { ZoteroDatabase } = require('./zotero-db');
const { SearchIndex } = require('./search');
const { WebStore } = require('./web-store');
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
const { UserStore } = require('./users');
const { WebAnnotationStore } = require('./annotations-store');
const { sanitizeNoteHtml, noteHtmlToPlainText } = require('./notes-html');
const { SemanticIndex } = require('./semantic');
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

fs.mkdirSync(DATA_DIR, { recursive: true });
const zoteroDatabase = new ZoteroDatabase();
const searchIndex = new SearchIndex(DATA_DIR, zoteroDatabase);
const webStore = new WebStore(DATA_DIR);
const userStore = new UserStore(DATA_DIR);
const annotationStore = new WebAnnotationStore(DATA_DIR);
const semanticIndex = new SemanticIndex(DATA_DIR, searchIndex);
const eventBus = new EventBus();
const health = new HealthMonitor({ zoteroDatabase, searchIndex, webStore });
const offlineLibrary = new OfflineLibrary(DATA_DIR);

const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 };
// POST endpoints that compute without mutating anything; viewers may call them.
const READ_ONLY_POST_ROUTES = new Set([
  '/api/auth', '/api/metadata/resolve', '/api/citations/format', '/api/ai/summarize', '/api/ai/ask',
  '/api/formula-ocr'
]);

/** Blends FTS bm25 ranking with LSA cosine ranking (both normalized to [0,1]). */
function hybridSearch(query, limit) {
  const lexical = searchIndex.search(query, limit);
  const semantic = semanticIndex.ready ? semanticIndex.search(query, limit) : [];
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

/** Lexical (title-term overlap) + LSA related-paper merge. */
function hybridRelated(itemKey, limit) {
  const lexical = recommend(zoteroDatabase.items, itemKey, limit);
  if (!semanticIndex.ready) return lexical.map(entry => ({ ...entry, mode: 'lexical' }));
  const semantic = semanticIndex.related(itemKey, limit * 2);
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

function authMode() {
  const users = userStore.count();
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
function resolvePrincipal(request, url) {
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : url.searchParams.get('token');
  const mode = authMode();
  if (token) {
    const user = userStore.resolveToken(token);
    if (user) return { kind: 'user', user, role: user.role, token };
    if (WEB_PASSWORD && secretsMatch(token, WEB_PASSWORD)) return { kind: 'legacy', user: null, role: 'owner', token };
    if (mode.mode === 'open') return { kind: 'open', user: null, role: 'owner' };
    return null;
  }
  if (mode.mode === 'open') return { kind: 'open', user: null, role: 'owner' };
  return null;
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

async function serveFile(response, relativePath, contentType, maxAge = 3600) {
  const filePath = path.join(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(response, 403, { error: 'Forbidden' });
  try {
    const data = await fsp.readFile(filePath);
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

function normalizeCreators(creators) {
  return creators.map(person => [person.firstName, person.lastName].filter(Boolean).join(' '));
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
    return sendJson(response, 405, { error: 'Method not allowed' });
  }

  const principal = resolvePrincipal(request, url);
  if (!principal && pathname !== '/api/auth') {
    return sendJson(response, 401, { error: 'Unauthorized', auth: true, mode: authMode().mode });
  }
  const effective = principal || { kind: 'anonymous', user: null, role: 'viewer' };
  if (request.method !== 'GET' && !READ_ONLY_POST_ROUTES.has(pathname)
      && ROLE_RANK[effective.role] < ROLE_RANK.editor) {
    return sendJson(response, 403, { error: `Your role (${effective.role}) is read-only.` });
  }

  if (pathname === '/api/items' && request.method === 'GET') {
    const items = await zoteroDatabase.refreshItems();
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    const collectionId = Number(url.searchParams.get('collection'));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const filtered = query ? items.filter(item => itemMatchesQuery(item, query)) : items;
    const collectionIds = Number.isFinite(collectionId) && collectionId > 0
      ? zoteroDatabase.collectionItemIds(collectionId)
      : null;
    const result = collectionIds
      ? filtered.filter(item => collectionIds.has(item.id))
      : filtered;
    const page = result.slice(offset, offset + limit);
    return sendJson(response, 200, {
      count: result.length,
      total: result.length,
      offset,
      limit,
      hasMore: offset + page.length < result.length,
      items: page
    });
  }

  if (pathname.startsWith('/api/items/') && pathname.endsWith('/detail') && request.method === 'GET') {
    const key = decodeURIComponent(pathname.split('/')[3]);
    const detail = zoteroDatabase.itemDetail(key);
    return detail ? sendJson(response, 200, detail) : sendJson(response, 404, { error: 'Item not found' });
  }

  if (/^\/api\/items\/[^/]+\/export\.(json|csv|bib|txt|ris)$/.test(pathname) && request.method === 'GET') {
    const match = pathname.match(/^\/api\/items\/([^/]+)\/export\.(json|csv|bib|txt|ris)$/);
    const detail = zoteroDatabase.itemDetail(decodeURIComponent(match[1]));
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
    if (request.method === 'GET') return sendJson(response, 200, webStore.getNote(itemKey));
    if (request.method === 'DELETE') {
      return sendJson(response, 200, webStore.deleteNote(itemKey));
    }
    const body = await readJson(request);
    if (typeof body.html === 'string') {
      const html = sanitizeNoteHtml(body.html.slice(0, 210000));
      return sendJson(response, 200, webStore.saveNote(itemKey, noteHtmlToPlainText(html), html));
    }
    return sendJson(response, 200, webStore.saveNote(itemKey, String(body.content || '').slice(0, 200000)));
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

  if (/^\/api\/items\/[^/]+\/related$/.test(pathname) && request.method === 'GET') {
    await zoteroDatabase.refreshItems();
    const key = decodeURIComponent(pathname.split('/')[3]);
    return sendJson(response, 200, { related: hybridRelated(key, 10) });
  }

  // Backlinks: which notes contain a "[[<this item's title>]]" wiki link.
  if (/^\/api\/items\/[^/]+\/mentions$/.test(pathname) && request.method === 'GET') {
    const key = decodeURIComponent(pathname.split('/')[3]);
    const item = zoteroDatabase.getItemByKey(key);
    if (!item) return sendJson(response, 404, { error: 'Item not found' });
    const mentions = webStore.mentions(item.title).map(entry => {
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
        model: process.env.OPENAI_MODEL
      });
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message || 'Question answering failed.' });
    }
  }

  if (/^\/api\/items\/[^/]+\/files\/[^/]+\/offline$/.test(pathname) && request.method === 'POST') {
    const [, , , itemKey, , attachmentKey] = pathname.split('/');
    const pdf = zoteroDatabase.resolvePdf(decodeURIComponent(itemKey), decodeURIComponent(attachmentKey));
    if (!pdf) return sendJson(response, 404, { error: 'PDF not found' });
    return sendJson(response, 200, await offlineLibrary.save(pdf.itemKey || decodeURIComponent(itemKey), pdf.key, pdf.filePath));
  }

  if (pathname === '/api/offline' && request.method === 'GET') {
    return sendJson(response, 200, { offline: await offlineLibrary.listDetailed() });
  }

  if (/^\/api\/items\/[^/]+\/progress$/.test(pathname)) {
    const itemKey = decodeURIComponent(pathname.split('/')[3]);
    if (request.method === 'GET') return sendJson(response, 200, webStore.getProgress(itemKey));
    const body = await readJson(request);
    return sendJson(response, 200, webStore.saveProgress(itemKey, body.percent));
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
    else if (mode === 'semantic') results = semanticIndex.ready ? semanticIndex.search(query, limit).map(result => ({ ...result, mode })) : [];
    else results = hybridSearch(query, limit);
    return sendJson(response, 200, {
      query,
      mode,
      results,
      index: searchIndex.status(),
      semantic: semanticIndex.status()
    });
  }

  if (pathname === '/api/index/rebuild' && request.method === 'POST') {
    const result = await searchIndex.reindex({ force: url.searchParams.get('force') === '1', limit: 100000 });
    if (result.started) {
      setImmediate(() => {
        try {
          const semantic = semanticIndex.rebuild();
          if (semantic.ready) {
            console.log(`Semantic index built: ${semantic.chunks} chunks, ${semantic.items} items, ${semantic.terms} terms, dim ${semantic.dimensions}`);
          }
        } catch (error) {
          console.error(`Semantic index rebuild failed: ${error.message}`);
        }
      });
    }
    return sendJson(response, result.started ? 200 : 202, result);
  }

  if (pathname === '/api/ai/summarize' && request.method === 'POST') {
    const body = await readJson(request);
    const detail = typeof body.itemKey === 'string' ? zoteroDatabase.itemDetail(body.itemKey) : null;
    if (!detail) return sendJson(response, 404, { error: 'Item not found' });
    const attachment = detail.attachments.find(file => file.exists);
    if (!attachment) return sendJson(response, 409, { error: 'This item has no available PDF.' });
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
      if (!OPENAI_API_KEY) return sendJson(response, 200, localSummary(input));
      const summary = await openAiSummary({ ...input, apiKey: OPENAI_API_KEY, model: process.env.OPENAI_MODEL });
      return sendJson(response, 200, summary);
    } catch (error) {
      if (!OPENAI_API_KEY) return sendJson(response, 500, { error: error.message });
      try {
        return sendJson(response, 200, { ...localSummary(input), warning: `OpenAI failed; local analysis used instead: ${error.message}` });
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
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message || 'Formula recognition failed.' });
    }
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
    const mode = authMode();
    if (typeof body.email === 'string' && body.email.trim()) {
      try {
        const user = userStore.authenticate(body.email, body.password);
        clearLoginFailures(ip);
        return sendJson(response, 200, { token: userStore.issueToken(user), user });
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
    return sendJson(response, 200, { ok: true, token: WEB_PASSWORD, user: { role: 'owner' } });
  }

  // Revokes the caller's session token (user mode); no-op for legacy/open.
  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    if (principal?.kind === 'user' && principal.token) userStore.revokeToken(principal.token);
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === '/api/me' && request.method === 'GET') {
    return sendJson(response, 200, {
      mode: authMode().mode,
      user: effective.user
        ? { email: effective.user.email, displayName: effective.user.displayName, role: effective.user.role }
        : null
    });
  }

  if (pathname === '/api/users' && request.method === 'GET') {
    if (ROLE_RANK[effective.role] < ROLE_RANK.owner) return sendJson(response, 403, { error: 'Owner role required.' });
    return sendJson(response, 200, { users: userStore.listUsers() });
  }

  if (pathname === '/api/users' && request.method === 'POST') {
    if (ROLE_RANK[effective.role] < ROLE_RANK.owner) return sendJson(response, 403, { error: 'Owner role required.' });
    const body = await readJson(request);
    return sendJson(response, 201, { user: userStore.createUser(body) });
  }

  if (/^\/api\/users\/\d+$/.test(pathname)) {
    if (ROLE_RANK[effective.role] < ROLE_RANK.owner) return sendJson(response, 403, { error: 'Owner role required.' });
    const userId = Number(pathname.split('/')[3]);
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      return sendJson(response, 200, { user: userStore.updateUser(userId, body) });
    }
    if (request.method === 'DELETE') return sendJson(response, 200, userStore.deleteUser(userId));
  }

  if (pathname === '/api/annotations' && request.method === 'GET') {
    const itemKey = url.searchParams.get('itemKey');
    if (!itemKey) return sendJson(response, 400, { error: 'Query parameter "itemKey" is required.' });
    return sendJson(response, 200, {
      annotations: annotationStore.list({ itemKey, attachmentKey: url.searchParams.get('attachmentKey') || undefined })
    });
  }

  if (pathname === '/api/annotations' && request.method === 'POST') {
    const body = await readJson(request);
    if (!zoteroDatabase.itemDetail(String(body.itemKey || ''))) {
      return sendJson(response, 404, { error: 'Item not found' });
    }
    const annotation = annotationStore.create({
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
      const annotation = annotationStore.update(annotationId, body, actor);
      eventBus.publish('annotation', { action: 'updated', by: effective.user ? effective.user.email : null, annotation });
      return sendJson(response, 200, { annotation });
    }
    if (request.method === 'DELETE') {
      const target = annotationStore.get(annotationId);
      const result = annotationStore.remove(annotationId, actor);
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
  if (pathname === '/api/events' && request.method === 'GET') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    response.write('retry: 5000\n\n');
    const unsubscribe = eventBus.subscribe(
      event => {
        response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
        return true;
      },
      { close: () => response.destroy() }
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
    return sendJson(response, 200, { ...health.status(), semantic: semanticIndex.status(), auth: authMode() });
  }

  return sendJson(response, 404, { error: 'API route not found' });
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    const routes = {
      // Entry HTML and its un-hashed assets revalidate on every load so UI
      // updates reach already-open browsers; hashed bundles cache long.
      '/': ['index.html', 'text/html; charset=utf-8', 0],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8', 0],
      '/styles.css': ['styles.css', 'text/css; charset=utf-8', 0],
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json', 3600],
      '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', 0],
      '/annotator': ['annotator.html', 'text/html; charset=utf-8', 0],
      '/annotator.js': ['annotator.js', 'text/javascript; charset=utf-8', 86400],
      '/annotator.css': ['annotator.css', 'text/css; charset=utf-8', 86400],
      '/notes': ['notes.html', 'text/html; charset=utf-8', 0],
      '/notes.js': ['notes.js', 'text/javascript; charset=utf-8', 86400],
      '/notes.css': ['notes.css', 'text/css; charset=utf-8', 86400],
      '/vendor/pdf.worker.min.mjs': ['vendor/pdf.worker.min.mjs', 'text/javascript; charset=utf-8', 86400]
    };
    const route = routes[url.pathname];
    if (route) return await serveFile(response, ...route);
    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    if ((error.statusCode || 500) >= 500) console.error(error);
    if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.message || 'Internal server error' });
  }
}

async function main() {
  await zoteroDatabase.refreshItems();
  const server = http.createServer(handle);
  // Keep serving after stray stream/promise errors: log loudly instead of dying.
  process.on('uncaughtException', error => console.error(`uncaughtException: ${error.stack || error}`));
  process.on('unhandledRejection', reason => console.error(`unhandledRejection: ${reason?.stack || reason}`));
  server.listen(PORT, HOST, async () => {
    const mode = authMode();
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
  });
  setImmediate(() => searchIndex.reindex({ limit: 100000 }).then(result => {
    if (result.started) console.log(`Initial index complete: ${result.indexed} indexed, ${result.skipped} skipped`);
    try {
      const semantic = semanticIndex.rebuild();
      if (semantic.ready) {
        console.log(`Semantic index ready: ${semantic.chunks} chunks, ${semantic.items} items, ${semantic.terms} terms, dim ${semantic.dimensions}`);
      } else if (semantic.reason) {
        console.log(`Semantic index skipped: ${semantic.reason}`);
      }
    } catch (error) {
      console.error(`Semantic index build failed: ${error.message}`);
    }
  }).catch(error => console.error(error.message)));
  const shutdown = () => {
    eventBus.closeAll();
    // Force-exit after 5s: lingering keep-alive connections would otherwise
    // keep server.close()'s callback (and the process) alive indefinitely.
    const forceExit = setTimeout(() => process.exit(0), 5000);
    forceExit.unref();
    server.closeAllConnections?.();
    server.close(() => {
      searchIndex.database.close();
      webStore.database.close();
      userStore.close();
      annotationStore.close();
      semanticIndex.close();
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
