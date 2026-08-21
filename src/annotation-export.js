'use strict';

function escapeCsv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function annotationsToCsv(annotations) {
  const rows = [['type', 'text', 'comment', 'color', 'page', 'author'].join(',')];
  for (const annotation of annotations) {
    rows.push([
      annotation.type,
      annotation.text || '',
      annotation.comment || '',
      annotation.color || '',
      annotation.pageLabel || '',
      annotation.authorName || ''
    ].map(escapeCsv).join(','));
  }
  return `${rows.join('\n')}\n`;
}

function annotationsToMarkdown(annotations) {
  const lines = ['# Annotations', ''];
  for (const annotation of annotations) {
    const page = annotation.pageLabel ? ` — p. ${annotation.pageLabel}` : '';
    const comment = annotation.comment ? `\n\n> ${String(annotation.comment).replace(/\n+/g, '\n> ')}` : '';
    lines.push(`- ${annotation.color || '#6aa5ff'}${page}: ${annotation.text || '(no text)'}${comment}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { annotationsToCsv, annotationsToMarkdown };
