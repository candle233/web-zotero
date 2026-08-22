'use strict';

/**
 * Server-side sanitizer for rich-text note HTML (TipTap output).
 *
 * Zero-dependency whitelist filter: everything the editor emits is kept,
 * everything else is dropped. Dangerous paired elements (script, style,
 * iframe, ...) are removed WITH their content; disallowed tags are unwrapped
 * (tag removed, inner text kept); all attributes are stripped except
 * validated <a href>. The PostgreSQL/Prisma build should switch to a
 * maintained sanitizer library - this keeps the SQLite build dependency-free.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'hr'
]);

const DANGEROUS_BLOCK_NAMES = 'script|style|iframe|object|embed|noscript|svg|math|template|form|textarea|select';
const DANGEROUS_BLOCKS = new RegExp('<\\s*(' + DANGEROUS_BLOCK_NAMES + ')\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>', 'gi');
const DANGEROUS_SINGLES = new RegExp('<\\s*(?:' + DANGEROUS_BLOCK_NAMES + ')\\b[^>]*/?\\s*>', 'gi');
const HTML_COMMENTS = /<!--[\s\S]*?-->/g;
// Control characters (C0 + DEL) that browsers ignore inside URLs.
const URL_CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

function sanitizeHref(value) {
  const href = String(value).replace(URL_CONTROL_CHARS, '');
  return /^(https?:\/\/|\/|#|mailto:)/i.test(href) ? href : null;
}

function sanitizeNoteHtml(input) {
  const html = String(input || '');
  const withoutBlocks = html
    .replace(HTML_COMMENTS, '')
    .replace(DANGEROUS_BLOCKS, '')
    .replace(DANGEROUS_SINGLES, '');
  return withoutBlocks.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (match, closing, rawName) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    if (closing) return '</' + name + '>';
    if (name === 'a') {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match);
      const clean = href ? sanitizeHref(href[2] ?? href[3] ?? href[4] ?? '') : null;
      return clean ? '<a href="' + clean.replace(/"/g, '&quot;') + '" rel="noopener">' : '<a>';
    }
    return '<' + name + '>';
  });
}

function noteHtmlToPlainText(html) {
  return String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/blockquote|\/pre)\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function plainTextToNoteHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!escaped.trim()) return '';
  return escaped.split(/\n{2,}/).map(paragraph =>
    '<p>' + paragraph.replace(/\n/g, '<br>') + '</p>').join('');
}

module.exports = { sanitizeNoteHtml, noteHtmlToPlainText, plainTextToNoteHtml };
