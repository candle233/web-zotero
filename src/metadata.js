'use strict';

/**
 * Academic metadata ingestion pipeline.
 *
 * Input: DOI, arXiv ID, ISBN or a BibTeX blob -> output: internal Item model
 * plus the standard CSL-JSON record it was derived from.
 *
 * Identifier resolution strategy:
 *   DOI   : GET https://doi.org/{doi} with `Accept: application/vnd.citationstyles.csl+json`
 *           (native CSL-JSON content negotiation); on failure fall back to the
 *           Crossref API and convert its message to CSL-JSON.
 *   arXiv : GET https://export.arxiv.org/api/query?id_list={id} and parse the Atom XML.
 *   ISBN  : GET https://openlibrary.org/isbn/{isbn}.json (bonus provider).
 *   BibTeX: parsed locally, no network.
 */

// Charset admits <> (legacy Wiley DOIs) but not quotes/whitespace; surrounding
// sentence punctuation is stripped by the caller.
const DOI_PATTERN = /\b(10\.\d{4,9}\/[^\s"']+)\b/i;
const ARXIV_PATTERN = /\b(?:arxiv\s*:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?)\b/i;
const ARXIV_OLD_PATTERN = /\b(?:arxiv\s*:\s*)?([a-z-]+\/\d{7}(?:v\d+)?)\b/i;
const ISBN_PATTERN = /\b(97[89][-\s]?\d[-\s]?[\d-\s]{8,}[\dXx]|(?=[0-9Xx-\s]{10}\b)\d[\d-\s]{8}[\dXx])\b/;

const CSL_TYPE_TO_ITEM_TYPE = new Map([
  ['article-journal', 'journalArticle'],
  ['article-magazine', 'journalArticle'],
  ['article-newspaper', 'journalArticle'],
  // doi.org content negotiation returns Crossref record types rather than CSL
  // types; map those aliases too so resolved items keep their real type.
  ['journal-article', 'journalArticle'],
  ['proceedings-article', 'conferencePaper'],
  ['book-chapter', 'bookSection'],
  ['posted-content', 'preprint'],
  ['monograph', 'book'],
  ['report-component', 'report'],
  ['dissertation', 'thesis'],
  ['preprint', 'preprint'],
  ['book', 'book'],
  ['chapter', 'bookSection'],
  ['paper-conference', 'conferencePaper'],
  ['report', 'report'],
  ['thesis', 'thesis'],
  ['webpage', 'webpage'],
  ['dataset', 'dataset'],
  ['speech', 'presentation'],
  ['manuscript', 'manuscript'],
  ['document', 'document'],
]);

const ITEM_TYPE_TO_CSL_TYPE = new Map([
  ['journalArticle', 'article-journal'],
  ['preprint', 'preprint'],
  ['book', 'book'],
  ['bookSection', 'chapter'],
  ['conferencePaper', 'paper-conference'],
  ['report', 'report'],
  ['thesis', 'thesis'],
  ['webpage', 'webpage'],
  ['dataset', 'dataset'],
  ['presentation', 'speech'],
  ['manuscript', 'manuscript'],
  ['document', 'document'],
  ['other', 'document'],
]);

const BIBTEX_TYPE_TO_CSL_TYPE = new Map([
  ['article', 'article-journal'],
  ['inproceedings', 'paper-conference'],
  ['conference', 'paper-conference'],
  ['book', 'book'],
  ['incollection', 'chapter'],
  ['phdthesis', 'thesis'],
  ['mastersthesis', 'thesis'],
  ['techreport', 'report'],
  ['unpublished', 'manuscript'],
  ['misc', 'document'],
]);

const BIBTEX_FIELD_MAP = new Map([
  ['title', 'title'],
  ['journal', 'container-title'],
  ['journaltitle', 'container-title'],
  ['booktitle', 'container-title'],
  ['publisher', 'publisher'],
  ['volume', 'volume'],
  ['number', 'issue'],
  ['issue', 'issue'],
  ['pages', 'page'],
  ['year', 'issued-year'],
  ['month', 'issued-month'],
  ['date', 'issued'],
  ['doi', 'DOI'],
  ['url', 'URL'],
  ['abstract', 'abstract'],
  ['keywords', 'keyword'],
  ['eprint', 'number'],
  ['isbn', 'ISBN'],
  ['issn', 'ISSN'],
  ['language', 'language'],
  ['note', 'note'],
]);

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function firstString(value) {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

/**
 * doi.org abstracts often embed JATS XML tags (<jats:p>, <jats:sup>, …).
 * Strip them (keeping inner text) so the UI shows clean prose.
 */
function stripInlineMarkup(value) {
  return firstString(value)
    .replace(/<\/?[a-z][a-z0-9]*(?::[a-z0-9]+)?(\s[^>]*)?\/?>/gi, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function datePartsToIso(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const [year, month = 1, day = 1] = parts;
  if (!Number.isFinite(year)) return '';
  return [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}

function extractIssued(cslRecord) {
  const issued = cslRecord.issued && cslRecord.issued['date-parts'];
  if (issued && issued.length > 0) return datePartsToIso(issued[0]);
  return '';
}

// ---------------------------------------------------------------------------
// Identifier detection
// ---------------------------------------------------------------------------
function detectIdentifier(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) return { type: 'unknown', value: '' };
  if (/^@/.test(input) && /\{\s*[^,]*,/.test(input)) return { type: 'bibtex', value: input };
  if (/\}\s*$/.test(input) && /@\w+\s*\{/.test(input)) return { type: 'bibtex', value: input };

  const doiMatch = DOI_PATTERN.exec(input.replace(/^doi\s*:\s*/i, ''));
  if (doiMatch) return { type: 'doi', value: doiMatch[1].replace(/[.,;)]+$/, '') };

  const arxivExplicit = /\barxiv\s*:\s*([^\s]+)/i.exec(input);
  if (arxivExplicit) return { type: 'arxiv', value: arxivExplicit[1].replace(/[.,;)]+$/, '') };
  const arxivMatch = ARXIV_PATTERN.exec(input);
  if (arxivMatch) return { type: 'arxiv', value: arxivMatch[1] };
  const arxivOld = ARXIV_OLD_PATTERN.exec(input);
  if (arxivOld) return { type: 'arxiv', value: arxivOld[1] };

  const isbnMatch = ISBN_PATTERN.exec(input.replace(/-/g, ''));
  if (isbnMatch) return { type: 'isbn', value: isbnMatch[1].replace(/[\s-]/g, '') };

  return { type: 'unknown', value: input };
}

// ---------------------------------------------------------------------------
// CSL-JSON <-> internal Item model (bidirectional)
// ---------------------------------------------------------------------------
function creatorsFromCsl(cslRecord) {
  const creators = [];
  for (const [index, raw] of (cslRecord.author || []).entries()) {
    creators.push(cslCreatorToInternal(raw, 'author', index));
  }
  for (const [index, raw] of (cslRecord.editor || []).entries()) {
    creators.push(cslCreatorToInternal(raw, 'editor', index));
  }
  for (const [index, raw] of (cslRecord.translator || []).entries()) {
    creators.push(cslCreatorToInternal(raw, 'translator', index));
  }
  return creators;
}

function cslCreatorToInternal(raw, creatorType, index) {
  if (raw.literal) {
    return { creatorType, orderIndex: index, name: String(raw.literal) };
  }
  return {
    creatorType,
    orderIndex: index,
    firstName: firstString(raw.given),
    lastName: firstString(raw.family),
  };
}

function cslJsonToItem(cslRecord) {
  const record = Array.isArray(cslRecord) ? cslRecord[0] : cslRecord;
  if (!record || typeof record !== 'object') throw httpError(422, 'Not a CSL-JSON record.');
  const item = {
    key: '',
    itemType: CSL_TYPE_TO_ITEM_TYPE.get(record.type) || 'document',
    title: firstString(record.title),
    creators: creatorsFromCsl(record),
    fields: {
      abstractNote: stripInlineMarkup(record.abstract),
      publicationTitle: firstString(record['container-title']),
      volume: firstString(record.volume),
      issue: firstString(record.issue),
      pages: firstString(record.page),
      date: extractIssued(record),
      DOI: firstString(record.DOI),
      url: firstString(record.URL),
      ISSN: firstString(record.ISSN),
      ISBN: firstString(record.ISBN),
      publisher: firstString(record.publisher),
      language: firstString(record.language),
    },
    extra: {},
  };
  for (const [key, value] of Object.entries(record)) {
    if (!['id', 'type', 'title', 'author', 'editor', 'translator', 'abstract', 'container-title',
      'volume', 'issue', 'page', 'issued', 'DOI', 'URL', 'ISSN', 'ISBN', 'publisher', 'language'].includes(key)) {
      item.extra[key] = value;
    }
  }
  return item;
}

function itemToCslJson(item) {
  const fields = item.fields || {};
  const csl = {
    id: item.key || `item-${Math.abs(hashString(item.title || 'untitled'))}`,
    type: ITEM_TYPE_TO_CSL_TYPE.get(item.itemType) || 'document',
    title: item.title || '',
  };
  for (const creatorType of ['author', 'editor', 'translator']) {
    const creators = (item.creators || []).filter(creator => (creator.creatorType || 'author') === creatorType);
    if (creators.length > 0) {
      csl[creatorType] = creators.map(creator => {
        if (creator.name) return { literal: creator.name };
        const entry = {};
        if (creator.firstName) entry.given = creator.firstName;
        if (creator.lastName) entry.family = creator.lastName;
        return entry;
      });
    }
  }
  const assign = (cslKey, value) => {
    if (value) csl[cslKey] = value;
  };
  assign('abstract', fields.abstractNote);
  assign('container-title', fields.publicationTitle);
  assign('volume', fields.volume);
  assign('issue', fields.issue);
  assign('page', fields.pages);
  assign('DOI', fields.DOI);
  assign('URL', fields.url);
  assign('ISSN', fields.ISSN);
  assign('ISBN', fields.ISBN);
  assign('publisher', fields.publisher);
  assign('language', fields.language);
  const yearMatch = String(fields.date || '').match(/(\d{4})/);
  if (yearMatch) csl.issued = { 'date-parts': [[Number(yearMatch[1])]] };
  if (item.extra) {
    for (const [key, value] of Object.entries(item.extra)) {
      if (!(key in csl)) csl[key] = value;
    }
  }
  return csl;
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveDoi(doi, { fetchImpl, timeoutMs }) {
  // The value came out of DOI_PATTERN, re-validate before building a URL.
  if (!DOI_PATTERN.test(doi)) throw httpError(422, `Not a valid DOI: ${doi}`);
  const doFetch = fetchImpl || fetch;
  try {
    const response = await fetchWithTimeout(`https://doi.org/${doi}`, {
      headers: { accept: 'application/vnd.citationstyles.csl+json' },
      redirect: 'follow',
    }, timeoutMs, doFetch);
    if (response.ok) {
      const payload = await response.json();
      return { record: Array.isArray(payload) ? payload[0] : payload, source: 'doi.org (CSL-JSON content negotiation)' };
    }
  } catch {
    // fall through to Crossref
  }
  const response = await fetchWithTimeout(`https://api.crossref.org/works/${doi}`, {
    headers: { accept: 'application/json' },
  }, timeoutMs, doFetch);
  if (!response.ok) throw httpError(502, `doi.org and Crossref both failed (Crossref HTTP ${response.status}).`);
  const payload = await response.json();
  if (!payload || !payload.message) throw httpError(502, 'Crossref response did not contain a message payload.');
  return { record: crossrefMessageToCsl(payload.message), source: 'Crossref API fallback' };
}

function crossrefMessageToCsl(message) {
  const csl = {
    id: message.DOI || 'crossref',
    type: crossrefTypeToCslType(message.type),
    title: firstString(message.title),
    'container-title': firstString(message['container-title'] || message['event'] && message['event'].name),
  };
  if (Array.isArray(message.author) && message.author.length > 0) {
    csl.author = message.author.map(person => ({
      given: person.given || '',
      family: person.family || '',
      ...(person.name ? { literal: person.name } : {}),
    }));
  }
  const direct = new Map([
    ['volume', 'volume'],
    ['issue', 'issue'],
    ['DOI', 'DOI'],
    ['URL', 'URL'],
    ['publisher', 'publisher'],
    ['language', 'language'],
    ['abstract', 'abstract'],
  ]);
  for (const [crossrefKey, cslKey] of direct) {
    if (message[crossrefKey]) csl[cslKey] = String(message[crossrefKey]);
  }
  if (message.page) csl.page = String(message.page).replace(/--/g, '-');
  if (Array.isArray(message.ISSN) && message.ISSN.length > 0) csl.ISSN = message.ISSN[0];
  if (Array.isArray(message.ISBN) && message.ISBN.length > 0) csl.ISBN = message.ISBN[0];
  if (message.issued && message.issued['date-parts']) csl.issued = message.issued;
  return csl;
}

function crossrefTypeToCslType(type) {
  const map = {
    'journal-article': 'article-journal',
    'proceedings-article': 'paper-conference',
    book: 'book',
    chapter: 'chapter',
    'report-component': 'report',
    posted: 'preprint',
    dissertation: 'thesis',
  };
  return map[type] || 'document';
}

// ---------------------------------------------------------------------------
// arXiv Atom XML parsing (dependency-free)
// ---------------------------------------------------------------------------
function tagContent(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? match[1].trim() : '';
}

function stripXmlTags(value) {
  return value.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function parseArxivAtom(xml) {
  const entryMatch = /<entry>([\s\S]*?)<\/entry>/i.exec(xml);
  if (!entryMatch) throw httpError(502, 'arXiv response contained no <entry> element.');
  const entry = entryMatch[1];
  const idUrl = tagContent(entry, 'id');
  const arxivId = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//i, '');
  const record = {
    id: arxivId || 'arxiv',
    type: 'preprint',
    title: stripXmlTags(tagContent(entry, 'title')),
    'container-title': 'arXiv',
    number: arxivId,
    abstract: stripXmlTags(tagContent(entry, 'summary')),
    author: [],
    issued: { 'date-parts': [[Number(String(tagContent(entry, 'published')).slice(0, 4)) || new Date().getFullYear()]] },
    URL: idUrl,
  };
  const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>/gi;
  let authorMatch;
  while ((authorMatch = authorRegex.exec(entry)) !== null) {
    record.author.push({ family: stripXmlTags(authorMatch[1]), given: '' });
  }
  const doi = tagContent(entry, 'arxiv:doi');
  if (doi) record.DOI = doi;
  const journalRef = tagContent(entry, 'arxiv:journal_ref');
  if (journalRef) {
    record['container-title'] = journalRef;
    record.type = 'article-journal';
  }
  return record;
}

async function resolveArxiv(arxivId, { fetchImpl, timeoutMs }) {
  if (!ARXIV_PATTERN.test(arxivId) && !ARXIV_OLD_PATTERN.test(arxivId)) {
    throw httpError(422, `Not a valid arXiv ID: ${arxivId}`);
  }
  const doFetch = fetchImpl || fetch;
  const response = await fetchWithTimeout(
    `https://export.arxiv.org/api/query?id_list=${arxivId}`,
    { headers: { accept: 'application/atom+xml' } },
    timeoutMs,
    doFetch,
  );
  if (!response.ok) throw httpError(502, `arXiv API returned HTTP ${response.status}.`);
  const xml = await response.text();
  return { record: parseArxivAtom(xml), source: 'arXiv Atom API' };
}

async function resolveIsbn(isbn, { fetchImpl, timeoutMs }) {
  const doFetch = fetchImpl || fetch;
  const response = await fetchWithTimeout(
    `https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`,
    { headers: { accept: 'application/json' } },
    timeoutMs,
    doFetch,
  );
  if (!response.ok) throw httpError(502, `OpenLibrary returned HTTP ${response.status}.`);
  const payload = await response.json();
  const record = {
    id: payload.key || isbn,
    type: 'book',
    title: payload.title || '',
    publisher: Array.isArray(payload.publishers) ? payload.publishers[0] : '',
    ISBN: isbn,
    author: [],
  };
  for (const authorRef of (payload.authors || []).slice(0, 10)) {
    if (authorRef.key) {
      try {
        const authorResponse = await fetchWithTimeout(`https://openlibrary.org${authorRef.key}.json`, {}, timeoutMs, doFetch);
        if (authorResponse.ok) {
          const authorPayload = await authorResponse.json();
          record.author.push({ literal: authorPayload.name || '' });
        }
      } catch {
        // author enrichment is best-effort
      }
    }
  }
  if (Array.isArray(payload.publish_dates) && payload.publish_dates.length > 0) {
    const year = Number(String(payload.publish_dates[0]).match(/(\d{4})/)?.[1]);
    if (year) record.issued = { 'date-parts': [[year]] };
  }
  return { record, source: 'OpenLibrary API' };
}

// ---------------------------------------------------------------------------
// BibTeX parsing (dependency-free)
// ---------------------------------------------------------------------------
function splitBibtexEntries(blob) {
  const entries = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < blob.length; index += 1) {
    const char = blob[index];
    if (char === '{') {
      if (depth === 0 && start === -1) start = index;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const at = blob.lastIndexOf('@', start);
        entries.push(blob.slice(at >= 0 ? at : start, index + 1));
        start = -1;
      }
    }
  }
  return entries.map(entry => entry.trim()).filter(Boolean);
}

function parseBibtexValue(raw) {
  let value = '';
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '{') {
      let depth = 1;
      let close = index + 1;
      while (close < raw.length && depth > 0) {
        if (raw[close] === '{') depth += 1;
        else if (raw[close] === '}') depth -= 1;
        close += 1;
      }
      value += raw.slice(index + 1, close - 1);
      index = close;
    } else if (char === '"') {
      const close = raw.indexOf('"', index + 1);
      const end = close === -1 ? raw.length : close;
      value += raw.slice(index + 1, end);
      index = end + 1;
    } else {
      const next = raw.indexOf('#', index);
      const chunk = next === -1 ? raw.slice(index) : raw.slice(index, next);
      value += chunk.trim();
      index = next === -1 ? raw.length : next + 1;
    }
  }
  return value.replace(/([{}])/g, '').replace(/\s+/g, ' ').trim();
}

function parseBibtexAuthors(raw) {
  return raw.split(/\s+and\s+/i).map(part => part.trim()).filter(Boolean).map(name => {
    if (/,.*/.test(name)) {
      const [last, ...rest] = name.split(',');
      return { lastName: last.trim(), firstName: rest.join(',').trim() };
    }
    const pieces = name.split(' ');
    if (pieces.length === 1) return { name: pieces[0] };
    return { firstName: pieces.slice(0, -1).join(' '), lastName: pieces[pieces.length - 1] };
  });
}

function parseBibtexEntry(entry) {
  const header = /^@\s*(\w+)\s*\{\s*([^,]*),/.exec(entry);
  if (!header) return null;
  const [, rawType, citationKey] = header;
  const body = entry.slice(header[0].length);
  const fields = {};
  const fieldRegex = /(\w+)\s*=\s*/g;
  let match;
  const assignments = [];
  while ((match = fieldRegex.exec(body)) !== null) {
    assignments.push({ name: match[1].toLowerCase(), at: match.index, valueStart: fieldRegex.lastIndex });
  }
  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = assignments[index];
    const nextStart = index + 1 < assignments.length ? assignments[index + 1].at : body.length;
    const rawValue = body.slice(assignment.valueStart, nextStart).replace(/,\s*$/, '');
    fields[assignment.name] = parseBibtexValue(rawValue);
  }
  return { type: rawType.toLowerCase(), citationKey, fields };
}

function bibtexEntryToCsl(parsed) {
  const csl = {
    id: parsed.citationKey || 'bibtex',
    type: BIBTEX_TYPE_TO_CSL_TYPE.get(parsed.type) || 'document',
    title: parsed.fields.title || '',
  };
  if (parsed.fields.author) {
    csl.author = parseBibtexAuthors(parsed.fields.author).map(creator =>
      creator.name ? { literal: creator.name } : { family: creator.lastName, given: creator.firstName });
  }
  if (parsed.fields.editor) {
    csl.editor = parseBibtexAuthors(parsed.fields.editor).map(creator =>
      creator.name ? { literal: creator.name } : { family: creator.lastName, given: creator.firstName });
  }
  for (const [bibtexKey, cslKey] of BIBTEX_FIELD_MAP) {
    const value = parsed.fields[bibtexKey];
    if (!value) continue;
    if (cslKey === 'page') csl.page = value.replace(/--/g, '-');
    else if (cslKey === 'issued-year') csl.issued = { 'date-parts': [[Number(value) || 0]] };
    else if (cslKey === 'issued-month') {
      const year = csl.issued && csl.issued['date-parts'] ? csl.issued['date-parts'][0][0] : new Date().getFullYear();
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const monthIndex = months.indexOf(value.slice(0, 3).toLowerCase()) + 1;
      csl.issued = { 'date-parts': [[year, monthIndex || 1]] };
    } else if (cslKey === 'issued') csl.issued = { 'date-parts': [[Number(value.slice(0, 4)) || 0]] };
    else if (cslKey === 'number') csl.number = value; // arXiv eprint id
    else csl[cslKey] = value;
  }
  if (parsed.fields.keywords) csl.keyword = parsed.fields.keywords;
  return csl;
}

function parseBibtex(blob) {
  return splitBibtexEntries(blob).map(parseBibtexEntry).filter(Boolean).map(bibtexEntryToCsl);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
async function resolveIdentifier(rawInput, options = {}) {
  const { fetchImpl = null, timeoutMs = 12000 } = options;
  const detected = detectIdentifier(rawInput);
  if (detected.type === 'unknown') {
    throw httpError(400, 'Could not detect a DOI, arXiv ID, ISBN or BibTeX in the input.');
  }
  if (detected.type === 'bibtex') {
    const records = parseBibtex(detected.value);
    if (records.length === 0) throw httpError(422, 'BibTeX input contained no parseable entries.');
    const items = records.map(cslJsonToItem);
    return { source: 'BibTeX parser', identifierType: 'bibtex', item: items[0], items, csl: records[0], cslRecords: records };
  }

  const resolvers = {
    doi: resolveDoi,
    arxiv: resolveArxiv,
    isbn: resolveIsbn,
  };
  const { record, source } = await resolvers[detected.type](detected.value, { fetchImpl, timeoutMs });
  return {
    source,
    identifierType: detected.type,
    identifier: detected.value,
    item: cslJsonToItem(record),
    csl: record,
  };
}

module.exports = {
  detectIdentifier,
  resolveIdentifier,
  parseBibtex,
  parseArxivAtom,
  cslJsonToItem,
  itemToCslJson,
  crossrefMessageToCsl,
  bibtexEntryToCsl,
};
