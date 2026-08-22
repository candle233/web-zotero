'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sanitizeNoteHtml, noteHtmlToPlainText, plainTextToNoteHtml } = require('../src/notes-html');

test('sanitizeNoteHtml removes script/style/iframe blocks with their content', () => {
  const dirty = '<p>ok</p><script>alert(1)</script><style>p{color:red}</style><p>after</p>';
  assert.equal(sanitizeNoteHtml(dirty), '<p>ok</p><p>after</p>');
  assert.equal(sanitizeNoteHtml('<iframe src="https://evil.example"></iframe><p>x</p>'), '<p>x</p>');
  assert.equal(sanitizeNoteHtml('<p>a</p><script src="https://evil.example/x.js">'), '<p>a</p>');
});

test('sanitizeNoteHtml strips event handler attributes and unwraps unknown tags', () => {
  const dirty = '<p onclick="steal()">keep <span class="x" onmouseover="x">text</span></p><marquee>gone</marquee>';
  assert.equal(sanitizeNoteHtml(dirty), '<p>keep text</p>gone');
});

test('sanitizeNoteHtml validates links and drops javascript: hrefs', () => {
  assert.equal(
    sanitizeNoteHtml('<a href="https://example.com/a?b=1" target="_blank">link</a>'),
    '<a href="https://example.com/a?b=1" rel="noopener">link</a>'
  );
  assert.equal(sanitizeNoteHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeNoteHtml('<a href="java\tscript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeNoteHtml('<a href="/relative">rel</a>'), '<a href="/relative" rel="noopener">rel</a>');
});

test('sanitizeNoteHtml keeps the TipTap whitelist intact', () => {
  const clean = '<h2>Title</h2><p>Some <strong>bold</strong> and <em>italic</em> with <code>code</code>.</p>'
    + '<ul><li>one</li><li>two</li></ul><blockquote>quote</blockquote><pre><code>x = 1</code></pre><hr><p><br></p>';
  assert.equal(sanitizeNoteHtml(clean), clean);
});

test('sanitizeNoteHtml removes comments and html wrapper', () => {
  assert.equal(sanitizeNoteHtml('<!-- secret --><div><p>a</p></div>'), '<p>a</p>');
});

test('noteHtmlToPlainText converts sanitized html to readable text', () => {
  assert.equal(noteHtmlToPlainText('<h2>T</h2><p>a<br>b</p><ul><li>li</li></ul>'), 'T\na\nb\nli');
  assert.equal(noteHtmlToPlainText(''), '');
});

test('plainTextToNoteHtml escapes markup and keeps paragraph breaks', () => {
  assert.equal(plainTextToNoteHtml('a < b\n\nc & d'), '<p>a &lt; b</p><p>c &amp; d</p>');
  assert.equal(plainTextToNoteHtml('   '), '');
});
