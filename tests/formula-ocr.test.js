'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { recognizeFormula, parseOcrResponse, decodeDataUrl, SETUP_HINT } = require('../src/formula-ocr');

// A 1x1 red PNG, repeated to clear the 64-byte minimum-size guard.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000d49444154789c626001000000ffff030000060005' +
  '57bfabd40000000049454e44ae4260820000000000000000000000000',
  'hex'
);
const DATA_URL = `data:image/png;base64,${TINY_PNG.toString('base64')}`;

test('decodeDataUrl accepts base64 PNG data URLs and rejects junk', () => {
  const { mimeType } = decodeDataUrl(DATA_URL);
  assert.equal(mimeType, 'image/png');
  assert.throws(() => decodeDataUrl('not-a-data-url'), /data URL/);
  assert.throws(() => decodeDataUrl('data:image/png;base64,AAAA'), /too small/);
});

test('parseOcrResponse returns raw LaTeX and strips $ delimiters', () => {
  assert.equal(parseOcrResponse({ status_code: 200, results: '\\frac{a}{b}' }), '\\frac{a}{b}');
  assert.equal(parseOcrResponse({ status_code: 200, results: '$$x^2 + y^2$$' }), 'x^2 + y^2');
  assert.equal(parseOcrResponse({ status_code: 200, results: '$E = mc^2$' }), 'E = mc^2');
});

test('parseOcrResponse joins element lists and rejects empty results', () => {
  assert.equal(
    parseOcrResponse({ status_code: 200, results: [{ text: 'a+b' }, { text: 'c' }] }),
    'a+b c'
  );
  assert.throws(() => parseOcrResponse({ status_code: 200, results: '   ' }), /No formula/);
  assert.throws(() => parseOcrResponse({ status_code: 500, results: 'x' }), /OCR engine failed/);
});

test('recognizeFormula posts multipart to the engine and returns LaTeX', async () => {
  let capturedBody;
  let capturedUrl;
  const latex = await recognizeFormula(DATA_URL, {
    url: 'http://ocr.test/pix2text',
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedBody = options.body;
      return { ok: true, status: 200, json: async () => ({ status_code: 200, results: '\\int_0^1 x dx' }) };
    }
  }).catch(async error => {
    // Node's FormData body streams; if the environment lacks FormData the
    // module is unusable — surface that loudly instead of silently passing.
    throw error;
  });
  assert.equal(capturedUrl, 'http://ocr.test/pix2text');
  assert.ok(capturedBody instanceof FormData, 'request body should be multipart FormData');
  const entries = [...capturedBody.entries()];
  assert.equal(entries.find(([key]) => key === 'file_type')?.[1], 'formula');
  const image = entries.find(([key]) => key === 'image');
  assert.ok(image, 'multipart must include the image field');
  assert.equal(latex.latex, '\\int_0^1 x dx');
  assert.equal(latex.provider, 'pix2text');
});

test('recognizeFormula maps engine outages to 503 with setup hint', async () => {
  await assert.rejects(
    recognizeFormula(DATA_URL, {
      fetchImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { cause: {} }); }
    }),
    error => {
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /pip install pix2text/);
      assert.ok(error.message.includes(SETUP_HINT.split('.')[0]));
      return true;
    }
  );
});
