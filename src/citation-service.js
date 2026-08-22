'use strict';

/**
 * Citation formatting engine built on citeproc-js with a dependency-free
 * fallback formatter so the endpoint degrades gracefully instead of failing.
 *
 * Styles: apa | ieee | nature | gb-t-7714-2015 (China national standard).
 * Locales: en-US | zh-CN (see csl-styles/locales-*.xml).
 */

const fs = require('node:fs');
const path = require('node:path');
const { itemToCslJson } = require('./metadata');

let CSL = null;
try {
  CSL = require('citeproc');
} catch {
  CSL = null; // fallback formatter takes over
}

const STYLES_DIR = path.join(__dirname, '..', 'csl-styles');
const STYLE_FILES = new Map([
  ['apa', 'apa.csl'],
  ['ieee', 'ieee.csl'],
  ['nature', 'nature.csl'],
  ['gb-t-7714-2015', 'china-national-standard-gb-t-7714-2015-numeric.csl'],
]);
const LOCALE_FILES = new Map([
  ['en-US', 'locales-en-US.xml'],
  ['zh-CN', 'locales-zh-CN.xml'],
]);
const DEFAULT_LANG = 'en-US';

function readOptional(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function listStyles() {
  const styles = [];
  for (const [id, file] of STYLE_FILES) {
    const xml = readOptional(path.join(STYLES_DIR, file));
    if (!xml) continue;
    const title = /<title>([^<]+)<\/title>/i.exec(xml)?.[1]?.trim() || id;
    const defaultLocale = /default-locale="([^"]+)"/i.exec(xml)?.[1] || DEFAULT_LANG;
    styles.push({ id, title, defaultLocale });
  }
  return { styles, locales: [...LOCALE_FILES.keys()] };
}

function normalizeLang(lang) {
  const value = String(lang || DEFAULT_LANG);
  if (LOCALE_FILES.has(value)) return value;
  const prefix = value.slice(0, 2).toLowerCase();
  if (prefix === 'zh') return 'zh-CN';
  return DEFAULT_LANG;
}

function normalizeStyle(style) {
  return STYLE_FILES.has(style) ? style : 'apa';
}

function ensureCslRecord(entry, index) {
  if (entry && typeof entry === 'object' && entry.fields && Array.isArray(entry.creators)) {
    const record = itemToCslJson(entry);
    if (!record.id) record.id = `item-${index}`;
    return record;
  }
  if (entry && typeof entry === 'object') {
    const record = { ...entry };
    if (!record.id) record.id = `item-${index}`;
    return record;
  }
  return { id: `item-${index}`, type: 'document', title: String(entry || '') };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// citeproc-js engine
// ---------------------------------------------------------------------------
function formatWithCiteproc(records, styleXml, lang) {
  const localeCache = new Map();
  const retrieveLocale = requestedLang => {
    const normalized = normalizeLang(requestedLang);
    if (localeCache.has(normalized)) return localeCache.get(normalized);
    const xml = readOptional(path.join(STYLES_DIR, LOCALE_FILES.get(normalized)));
    if (xml) localeCache.set(normalized, xml);
    return xml || undefined;
  };

  const byId = new Map(records.map(record => [String(record.id), record]));
  const sys = {
    retrieveLocale,
    retrieveItem: id => byId.get(String(id)),
  };
  const citeproc = new CSL.Engine(sys, styleXml, lang);
  citeproc.updateItems(records.map(record => String(record.id)));

  const [bibMeta, entries] = citeproc.makeBibliography();
  // citeproc sorts the bibliography per the style's <sort> rule; entry_ids
  // reports the item ids in OUTPUT order, so labels stay correct when the
  // order differs from the input order (e.g. APA author/date sorting).
  const bibliography = entries.map((html, index) => ({
    id: String(bibMeta?.entry_ids?.[index]?.[0] ?? records[index]?.id ?? `entry-${index}`),
    html,
  }));

  const inText = records.map(record => {
    const citation = {
      citationItems: [{ id: String(record.id) }],
      properties: { noteIndex: 0 },
    };
    const preview = citeproc.previewCitationCluster(citation, [], [], 'html');
    // citeproc-js returns the rendered string directly; some forks return an
    // array of [index, string, id] clusters — normalize both.
    const text = typeof preview === 'string'
      ? preview
      : Array.isArray(preview) && preview.length > 0 ? String(preview[preview.length - 1][1] ?? '') : '';
    return { id: String(record.id), html: text };
  });

  return { bibliography, inText };
}

// ---------------------------------------------------------------------------
// Fallback formatter (used when citeproc-js or a style file is unavailable)
// ---------------------------------------------------------------------------
function authorList(record, { and = '&', separator = ', ' }) {
  const authors = record.author || [];
  const names = authors.map(author => {
    if (author.literal) return author.literal;
    const family = author.family || '';
    const initials = String(author.given || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(given => `${given[0].toUpperCase()}.`)
      .join(' ');
    return [family, initials].filter(Boolean).join(', ');
  }).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(separator)}${separator === ', ' ? ', ' : separator}${and} ${names[names.length - 1]}`;
}

function yearOf(record) {
  const parts = record.issued && record.issued['date-parts'] && record.issued['date-parts'][0];
  return parts && parts[0] ? String(parts[0]) : 'n.d.';
}

function fallbackFormat(record, style) {
  const authors = authorList(record, { and: '&', separator: ', ' });
  const year = yearOf(record);
  const title = record.title || 'Untitled';
  const container = Array.isArray(record['container-title']) ? record['container-title'][0] : record['container-title'] || '';
  const volume = record.volume || '';
  const issue = record.issue || '';
  const pages = record.page || '';
  const doi = record.DOI || '';
  const url = record.URL || '';
  const parts = [];

  if (style === 'ieee') {
    parts.push(`${authors || 'Anon'}${authors ? ',' : ''} "${title},"`);
    if (container) parts.push(`*${container}*,`);
    const vol = [volume ? `vol. ${volume}` : '', issue ? `no. ${issue}` : ''].filter(Boolean).join(', ');
    if (vol) parts.push(`${vol},`);
    if (pages) parts.push(`pp. ${pages},`);
    parts.push(`${year}.`);
  } else if (style === 'nature') {
    parts.push(`${authors.split(`, & `)[0]}${(record.author || []).length > 1 ? ' et al.' : ''}. ${title}.`);
    if (container) parts.push(`*${container}*`);
    const volPages = [volume, pages].filter(Boolean).join(', ');
    if (volPages) parts.push(`${volPages} (${year}).`);
    else parts.push(`(${year}).`);
  } else if (style === 'gb-t-7714-2015') {
    const mark = { 'article-journal': '[J]', book: '[M]', 'paper-conference': '[C]', report: '[R]', thesis: '[D]' }[record.type] || '[Z]';
    parts.push(`${authors || 'Anon'}. ${title}${mark}.`);
    if (container) parts.push(`${container},`);
    const vi = [year, volume ? `${volume}${issue ? `(${issue})` : ''}` : ''].filter(Boolean).join(', ');
    if (vi) parts.push(`${vi}${pages ? `: ${pages}` : ''}.`);
    if (doi) parts.push(`DOI:${doi}.`);
  } else { // apa
    parts.push(`${authors ? `${authors} ` : ''}(${year}). ${title}.`);
    if (container) {
      const vi = [volume, issue ? `(${issue})` : ''].filter(Boolean).join('');
      parts.push(`*${container}*${vi ? `, ${vi}` : ''}${pages ? `, ${pages}` : ''}.`);
    }
    if (doi) parts.push(`https://doi.org/${doi}`);
    else if (url) parts.push(url);
  }
  return `<div class="csl-entry">${escapeHtml(parts.join(' ').replace(/\s+/g, ' ').trim())}</div>`;
}

function fallbackFormatInText(record, style) {
  const first = (record.author || [])[0];
  const name = first ? (first.literal || first.family || 'Anon') : 'Anon';
  const year = yearOf(record);
  if (style === 'ieee' || style === 'gb-t-7714-2015' || style === 'nature') return `(${name} ${year})`;
  return `(${name}, ${year})`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function formatCitations({ items, style = 'apa', lang = DEFAULT_LANG, mode = 'bibliography' }) {
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error('`items` must be a non-empty array.');
    error.statusCode = 400;
    throw error;
  }
  const styleId = normalizeStyle(style);
  const langId = normalizeLang(lang);
  const records = items.map(ensureCslRecord);
  const wanted = mode === 'in-text' ? 'inText' : 'bibliography';

  const styleXml = readOptional(path.join(STYLES_DIR, STYLE_FILES.get(styleId)));
  if (CSL && styleXml) {
    try {
      const result = formatWithCiteproc(records, styleXml, langId);
      return {
        engine: 'citeproc-js',
        style: styleId,
        lang: langId,
        mode: mode === 'in-text' ? 'in-text' : 'bibliography',
        entries: result[wanted],
      };
    } catch (error) {
      return {
        engine: 'fallback',
        style: styleId,
        lang: langId,
        mode: mode === 'in-text' ? 'in-text' : 'bibliography',
        warning: `citeproc-js failed (${error.message}); fallback formatter used.`,
        entries: records.map(record => ({
          id: String(record.id),
          html: mode === 'in-text' ? escapeHtml(fallbackFormatInText(record, styleId)) : fallbackFormat(record, styleId),
        })),
      };
    }
  }

  const reason = !CSL ? 'citeproc-js is not installed' : `style file for "${styleId}" is missing`;
  return {
    engine: 'fallback',
    style: styleId,
    lang: langId,
    mode: mode === 'in-text' ? 'in-text' : 'bibliography',
    warning: `${reason}; fallback formatter used.`,
    entries: records.map(record => ({
      id: String(record.id),
      html: mode === 'in-text' ? escapeHtml(fallbackFormatInText(record, styleId)) : fallbackFormat(record, styleId),
    })),
  };
}

module.exports = { formatCitations, listStyles };
