'use strict';

function formatAuthors(creators) {
  return creators.map(person => {
    const name = [person.lastName, person.firstName].filter(Boolean).join(', ');
    return name || person.name || '';
  }).filter(Boolean).join('; ');
}

function citation(item, style = 'apa') {
  const authors = formatAuthors(item.creators);
  const year = (item.fields.date || '').match(/\d{4}/)?.[0] || 'n.d.';
  const title = item.title || 'Untitled';
  const publication = item.fields.publicationTitle || item.fields.publisher || '';
  const doi = item.fields.DOI || '';
  const url = item.fields.url || '';

  if (style === 'bibtex') {
    const key = `${(item.creators[0]?.lastName || 'unknown').replace(/[^a-z]/gi, '').toLowerCase()}${year}${title.split(/\s+/)[0].replace(/[^a-z]/gi, '').toLowerCase()}`;
    return [
      `@misc{${key},`,
      `  title = {${title}},`,
      authors ? `  author = {${authors}},` : '',
      year !== 'n.d.' ? `  year = {${year}},` : '',
      publication ? `  publisher = {${publication}},` : '',
      doi ? `  doi = {${doi}},` : '',
      url ? `  url = {${url}}` : '',
      '}'
    ].filter(Boolean).join('\n');
  }

  const parts = [authors ? `${authors} (${year}).` : `${year}.`, `${title}.`];
  if (publication) parts.push(`${publication}.`);
  if (doi) parts.push(`https://doi.org/${doi.replace(/^https?:\/\/doi\.org\//i, '')}`);
  else if (url) parts.push(url);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function exportFormats(item) {
  return {
    apa: citation(item, 'apa'),
    bibtex: citation(item, 'bibtex')
  };
}

const RIS_TYPE_MAP = new Map([
  ['journalArticle', 'JOUR'], ['book', 'BOOK'], ['bookSection', 'CHAP'],
  ['conferencePaper', 'CONF'], ['thesis', 'THES'], ['report', 'RPRT'],
  ['webpage', 'ELEC'], ['preprint', 'UNPB'], ['dataset', 'DATA'],
]);

/**
 * RIS export: one record per item, tag-per-line, CRLF line endings per spec.
 */
function exportRis(item) {
  const lines = [];
  lines.push(`TY  - ${RIS_TYPE_MAP.get(item.itemType) || 'GEN'}`);
  lines.push(`TI  - ${item.title || ''}`);
  for (const person of item.creators || []) {
    const name = person.lastName
      ? `${person.lastName}, ${person.firstName || ''}`.replace(/,\s*$/, '')
      : person.name || '';
    if (name) lines.push(`AU  - ${name}`);
  }
  const fields = [
    ['publicationTitle', 'JO'], ['publisher', 'PB'], ['volume', 'VL'], ['issue', 'IS'],
    ['pages', 'SP'], ['DOI', 'DO'], ['url', 'UR'], ['ISSN', 'SN'], ['ISBN', 'SN'],
    ['abstractNote', 'AB'], ['language', 'LA'],
  ];
  for (const [key, tag] of fields) {
    if (item.fields[key]) lines.push(`${tag}  - ${item.fields[key]}`);
  }
  const year = (item.fields.date || '').match(/\d{4}/)?.[0];
  if (year) lines.push(`PY  - ${year}`);
  for (const tag of (item.tags || []).slice(0, 30)) lines.push(`KW  - ${tag}`);
  lines.push('ER  - ');
  return lines.join('\r\n') + '\r\n';
}

function exportJson(item) {
  return JSON.stringify({
    itemType: item.itemType,
    title: item.title,
    creators: item.creators,
    fields: item.fields,
    tags: item.tags,
    collections: item.collections,
    key: item.key
  }, null, 2);
}

function exportCsv(item) {
  return ['key,itemType,title,creators,date,publication,doi,url,tags', [
    item.key,
    item.itemType,
    item.title,
    formatAuthors(item.creators),
    item.fields.date || '',
    item.fields.publicationTitle || item.fields.publisher || '',
    item.fields.DOI || '',
    item.fields.url || '',
    item.tags.join('; ')
  ].map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')].join('\n');
}

module.exports = { citation, exportFormats, exportCsv, exportJson, exportRis };
