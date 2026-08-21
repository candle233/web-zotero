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

module.exports = { citation, exportFormats, exportCsv, exportJson };
