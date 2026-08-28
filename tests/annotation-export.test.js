'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { annotationsToCsv, annotationsToMarkdown } = require('../src/annotation-export');

const SAMPLE = [
  { type: 'highlight', text: 'Hello world', comment: 'Test comment', color: '#ff0000', pageLabel: '5', authorName: 'Alice' },
  { type: 'note', text: 'Note text', comment: '', color: '', pageLabel: '', authorName: '' },
  { type: 'rect', text: null, comment: null, color: '#00ff00', pageLabel: '10', authorName: 'Bob' }
];

// ── CSV ──────────────────────────────────────────────────────────────────────

test('annotationsToCsv includes header row', () => {
  const csv = annotationsToCsv(SAMPLE);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'type,text,comment,color,page,author');
});

test('annotationsToCsv produces one row per annotation', () => {
  const csv = annotationsToCsv(SAMPLE);
  // header + 3 data + trailing newline (last is '')
  const lines = csv.split('\n').filter(Boolean);
  assert.equal(lines.length, 1 + SAMPLE.length);
});

test('annotationsToCsv quotes all fields', () => {
  const csv = annotationsToCsv(SAMPLE);
  const lines = csv.split('\n').filter(Boolean);
  // Data row 1 should have all quoted fields.
  assert.match(lines[1], /^"highlight","Hello world","Test comment","#ff0000","5","Alice"$/);
});

test('annotationsToCsv doubles internal double-quotes (CSV escape)', () => {
  const csv = annotationsToCsv([{ type: 'highlight', text: 'She said "hi"', comment: '', color: '', pageLabel: '', authorName: '' }]);
  // Inside the quoted field: "She said ""hi"""
  // The full row: "highlight","She said ""hi""","","","",""
  assert.ok(csv.includes('"She said ""hi"""'), 'double-quotes should be doubled inside the quoted field');
});

test('annotationsToCsv handles null and undefined values as empty strings', () => {
  const csv = annotationsToCsv([{ type: 'rect', text: null, comment: undefined, color: undefined, pageLabel: null, authorName: null }]);
  const lines = csv.split('\n').filter(Boolean);
  // Row should be "rect","","","","","" — all empty fields quoted.
  assert.match(lines[1], /^"rect","","","","",""$/);
});

test('annotationsToCsv uses \\n as line separator', () => {
  const csv = annotationsToCsv(SAMPLE);
  assert.ok(csv.includes('\n'), 'must contain newlines');
  assert.equal(csv.split('\n').length - 1, SAMPLE.length + 1); // +1 header
});

test('annotationsToCsv returns just header (with newline) for empty input', () => {
  const csv = annotationsToCsv([]);
  assert.equal(csv, 'type,text,comment,color,page,author\n');
});

// ── Markdown ────────────────────────────────────────────────────────────────

test('annotationsToMarkdown starts with # Annotations heading', () => {
  const md = annotationsToMarkdown(SAMPLE);
  assert.ok(md.startsWith('# Annotations\n\n'));
});

test('annotationsToMarkdown emits one bullet per annotation', () => {
  const md = annotationsToMarkdown(SAMPLE);
  const bullets = md.split('\n').filter(line => line.startsWith('- '));
  assert.equal(bullets.length, SAMPLE.length);
});

test('annotationsToMarkdown includes color hex in bullet', () => {
  const md = annotationsToMarkdown(SAMPLE);
  assert.ok(md.includes('#ff0000'), 'first annotation color should appear');
  assert.ok(md.includes('#00ff00'), 'third annotation color should appear');
});

test('annotationsToMarkdown includes page label in bullet when present', () => {
  const md = annotationsToMarkdown(SAMPLE);
  assert.ok(md.includes('p. 5'), 'should include p. 5 for first annotation');
  assert.ok(md.includes('p. 10'), 'should include p. 10 for third annotation');
});

test('annotationsToMarkdown includes comment as blockquote when present', () => {
  const md = annotationsToMarkdown(SAMPLE);
  // Comment for first annotation is "Test comment".
  assert.ok(md.includes('> Test comment'), 'should quote the comment');
});

test('annotationsToMarkdown shows "(no text)" when text is null/missing', () => {
  const md = annotationsToMarkdown([{ type: 'highlight', text: null, comment: '', color: '#fff' }]);
  assert.ok(md.includes('(no text)'));
});

test('annotationsToMarkdown handles multi-line comments', () => {
  const md = annotationsToMarkdown([{ type: 'note', text: 'X', comment: 'line1\nline2\nline3', color: '' }]);
  // Each line should be prefixed with "> ".
  assert.ok(md.includes('> line1\n> line2\n> line3') || md.includes('> line1\n> line2'));
});

test('annotationsToMarkdown returns header + trailing newline for empty input', () => {
  const md = annotationsToMarkdown([]);
  // Just "# Annotations\n\n" plus a trailing newline.
  assert.ok(md.startsWith('# Annotations'));
  assert.ok(md.endsWith('\n'));
});
