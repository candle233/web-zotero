'use strict';

/**
 * LaTeX formula OCR proxy (R10): forwards cropped formula images to a local
 * Pix2Text service (https://github.com/breezedeus/Pix2Text — open-source
 * Mathpix alternative).
 *
 * The engine runs out-of-process so this Node server stays dependency-free:
 *   pip install pix2text
 *   p2t serve -l en,ch_sim -H 127.0.0.1 -p 8503
 * The endpoint is POST /pix2text with multipart fields (verified against
 * pix2text/serve.py): image=<file>, file_type=formula, resized_shape=768.
 * For file_type=formula the response is { status_code, results: "<latex>" }.
 */

const DEFAULT_OCR_URL = process.env.FORMULA_OCR_URL || 'http://127.0.0.1:8503/pix2text';
const SETUP_HINT =
  'Install and start Pix2Text first: "pip install pix2text" then ' +
  '"p2t serve -l en,ch_sim -H 127.0.0.1 -p 8503" (or point FORMULA_OCR_URL at a running instance).';

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/** Decodes a data URL ("data:image/png;base64,...") into a Buffer. */
function decodeDataUrl(dataUrl) {
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) throw httpError(400, 'Field "image" must be a base64 PNG/JPEG/WebP data URL.');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < 64) throw httpError(400, 'The cropped image is too small to contain a formula.');
  if (buffer.length > 8 * 1024 * 1024) throw httpError(413, 'The cropped image exceeds the 8 MB limit.');
  return { buffer, mimeType: `image/${match[1] === 'jpg' ? 'jpeg' : match[1]}` };
}

/**
 * Normalizes the Pix2Text response into a LaTeX string. `results` is the raw
 * LaTeX for file_type=formula; other file types return element lists.
 * Surrounding $ / $$ delimiters are stripped defensively.
 */
function parseOcrResponse(payload) {
  if (!payload || typeof payload !== 'object') throw httpError(502, 'The OCR engine returned an invalid response.');
  if (payload.status_code && payload.status_code !== 200) {
    throw httpError(502, `The OCR engine failed (status ${payload.status_code}).`);
  }
  let latex = '';
  if (typeof payload.results === 'string') latex = payload.results;
  else if (Array.isArray(payload.results)) {
    latex = payload.results.map(entry => (entry && typeof entry === 'object' ? String(entry.text || '') : String(entry || ''))).join(' ');
  }
  latex = latex.trim().replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim();
  if (!latex) throw httpError(422, 'No formula was recognized in the selected region — try a tighter selection.');
  return latex.slice(0, 10000);
}

async function recognizeFormula(dataUrl, { url = DEFAULT_OCR_URL, timeoutMs = 30000, fetchImpl } = {}) {
  const { buffer, mimeType } = decodeDataUrl(dataUrl);
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mimeType }), 'formula.png');
  form.append('file_type', 'formula');
  form.append('resized_shape', '768');
  const doFetch = fetchImpl || fetch;
  let response;
  try {
    response = await doFetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timed out' : 'connection refused';
    throw httpError(503, `Formula OCR engine ${reason}. ${SETUP_HINT}`);
  }
  if (!response.ok) {
    // The engine answers 500 when its detector finds nothing usable (e.g. a
    // blank or text-only region) — surface actionable guidance instead.
    if (response.status >= 500) {
      throw httpError(422, 'No formula was recognized in the selected region. Try a tighter selection around the formula itself.');
    }
    const detail = await response.text().catch(() => '');
    throw httpError(502, `OCR engine HTTP ${response.status}.${detail.slice(0, 200) ? ` ${detail.slice(0, 200)}` : ''}`);
  }
  const payload = await response.json().catch(() => null);
  return { latex: parseOcrResponse(payload), provider: 'pix2text' };
}

module.exports = { recognizeFormula, parseOcrResponse, decodeDataUrl, SETUP_HINT };
