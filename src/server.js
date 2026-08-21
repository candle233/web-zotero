'use strict';

require('dotenv').config();

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
const { exportCsv, exportFormats, exportJson } = require('./citation');
const { HealthMonitor } = require('./health');

const PORT = Number(process.env.PORT || 8420);
const HOST = process.env.HOST || '0.0.0.0';
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
const health = new HealthMonitor({ zoteroDatabase, searchIndex, webStore });

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
  return body ? JSON.parse(body) : {};
}

async function serveFile(response, relativePath, contentType, maxAge = 3600) {
  const filePath = path.join(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(response, 403, { error: 'Forbidden' });
  try {
    const data = await fsp.readFile(filePath);
    response.writeHead(200, { 'content-type': contentType, 'content-length': data.length, 'cache-control': `public, max-age=${maxAge}` });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

async function servePdf(request, response, itemKey, attachmentKey) {
  const pdf = zoteroDatabase.resolvePdf(itemKey, attachmentKey);
  if (!pdf) return sendJson(response, 404, { error: 'PDF not found' });
  const stat = await fsp.stat(pdf.filePath);
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
    const stream = fs.createReadStream(pdf.filePath, { start, end });
    response.writeHead(206, {
      'content-type': 'application/pdf',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'x-content-type-options': 'nosniff'
    });
    stream.pipe(response);
    return;
  }
  response.writeHead(200, {
    'content-type': 'application/pdf',
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=300'
  });
  fs.createReadStream(pdf.filePath).pipe(response);
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
  if (request.method !== 'GET' && request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });

  if (WEB_PASSWORD && pathname !== '/api/auth') {
    const authorization = request.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : url.searchParams.get('token');
    if (token !== WEB_PASSWORD) return sendJson(response, 401, { error: 'Unauthorized', auth: true });
  }

  if (pathname === '/api/items' && request.method === 'GET') {
    const items = await zoteroDatabase.refreshItems();
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    const collectionId = Number(url.searchParams.get('collection'));
    const filtered = query ? items.filter(item => itemMatchesQuery(item, query)) : items;
    const result = Number.isFinite(collectionId) && collectionId > 0
      ? filtered.filter(item => {
          const detail = zoteroDatabase.itemDetail(item.key);
          return detail.collections.some(collection => collection.id === collectionId);
        })
      : filtered;
    return sendJson(response, 200, { count: result.length, items: result.slice(0, 500) });
  }

  if (pathname.startsWith('/api/items/') && pathname.endsWith('/detail') && request.method === 'GET') {
    const key = decodeURIComponent(pathname.split('/')[3]);
    const detail = zoteroDatabase.itemDetail(key);
    return detail ? sendJson(response, 200, detail) : sendJson(response, 404, { error: 'Item not found' });
  }

  if (/^\/api\/items\/[^/]+\/export\.(json|csv|bib|txt)$/.test(pathname) && request.method === 'GET') {
    const match = pathname.match(/^\/api\/items\/([^/]+)\/export\.(json|csv|bib|txt)$/);
    const detail = zoteroDatabase.itemDetail(decodeURIComponent(match[1]));
    if (!detail) return sendJson(response, 404, { error: 'Item not found' });
    let body;
    let type;
    let filename;
    if (match[2] === 'bib') { body = exportFormats(detail).bibtex; type = 'application/x-bibtex; charset=utf-8'; filename = `${detail.key}.bib`; }
    else if (match[2] === 'csv') { body = exportCsv(detail); type = 'text/csv; charset=utf-8'; filename = `${detail.key}.csv`; }
    else if (match[2] === 'json') { body = exportJson(detail); type = 'application/json; charset=utf-8'; filename = `${detail.key}.json`; }
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
    const body = await readJson(request);
    return sendJson(response, 200, webStore.saveNote(itemKey, String(body.content || '').slice(0, 200000)));
  }

  if (/^\/api\/items\/[^/]+\/desktop-notes$/.test(pathname) && request.method === 'GET') {
    const detail = zoteroDatabase.itemDetail(decodeURIComponent(pathname.split('/')[3]));
    return detail ? sendJson(response, 200, { notes: detail.notes }) : sendJson(response, 404, { error: 'Item not found' });
  }

  if (/^\/api\/items\/[^/]+\/progress$/.test(pathname)) {
    const itemKey = decodeURIComponent(pathname.split('/')[3]);
    if (request.method === 'GET') return sendJson(response, 200, webStore.getProgress(itemKey));
    const body = await readJson(request);
    return sendJson(response, 200, webStore.saveProgress(itemKey, body.percent));
  }

  if (pathname === '/api/collections') {
    const rows = zoteroDatabase.database.prepare(`
      SELECT c.collectionID AS id, c.collectionName AS name, c.parentCollectionID AS parentId,
             (SELECT COUNT(*) FROM collectionItems ci JOIN items i ON i.itemID=ci.itemID
              LEFT JOIN deletedItems d ON d.itemID=i.itemID WHERE ci.collectionID=c.collectionID AND d.itemID IS NULL) AS itemCount
      FROM collections c ORDER BY c.collectionName COLLATE NOCASE
    `).all();
    return sendJson(response, 200, { collections: rows });
  }

  if (pathname === '/api/search' && request.method === 'GET') {
    return sendJson(response, 200, {
      query: url.searchParams.get('q') || '',
      results: searchIndex.search(url.searchParams.get('q'), Number(url.searchParams.get('limit') || 30)),
      index: searchIndex.status()
    });
  }

  if (pathname === '/api/index/rebuild' && request.method === 'POST') {
    const result = await searchIndex.reindex({ force: url.searchParams.get('force') === '1', limit: 100000 });
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

  if (pathname === '/api/plugins') {
    const plugins = await installedDesktopPlugins(ZOTERO_PROFILE_ROOT);
    return sendJson(response, 200, {
      note: 'Desktop XPI plug-ins cannot execute directly in a browser sandbox. These are compatibility and library endpoints for web clients.',
      plugins,
      capabilities: ['metadata', 'notes', 'full-text-search', 'ai-reading']
    });
  }

  if (pathname === '/api/auth' && request.method === 'POST') {
    const body = await readJson(request);
    if (!WEB_PASSWORD || body.password !== WEB_PASSWORD) return sendJson(response, 401, { error: 'Invalid password', auth: true });
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === '/api/health') return sendJson(response, 200, health.status());

  return sendJson(response, 404, { error: 'API route not found' });
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    const routes = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
      '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', 0]
    };
    const route = routes[url.pathname];
    if (route) return await serveFile(response, ...route);
    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.message || 'Internal server error' });
  }
}

async function main() {
  await zoteroDatabase.refreshItems();
  const server = http.createServer(handle);
  server.listen(PORT, HOST, async () => {
    const addresses = [`${os.hostname()}:${PORT}`, ...Object.values(os.networkInterfaces()).flat()
      .filter(network => network?.family === 'IPv4' && !network.internal)
      .map(network => `${network.address}:${PORT}`)];
    console.log(`Web Zotero ready on ${PORT}`);
    for (const address of addresses) console.log(`  http://${address}`);
    console.log(`Library items: ${zoteroDatabase.items.length}; indexed documents: ${searchIndex.status().indexed}`);
  });
  setImmediate(() => searchIndex.reindex({ limit: 100000 }).then(result => {
    if (result.started) console.log(`Initial index complete: ${result.indexed} indexed, ${result.skipped} skipped`);
  }).catch(error => console.error(error.message)));
  const shutdown = () => {
    server.close(() => {
      searchIndex.database.close();
      webStore.database.close();
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
