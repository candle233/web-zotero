import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invertAffine,
  viewportRectToNormalized,
  normalizedRectToViewport,
  viewportToNormalizedPoint,
  normalizedToViewportPoint,
  mergeLineRects,
  selectionToNormalizedRects,
  serializeRects,
  parseRects,
} from '../src/pdf/coordinates.ts';

/**
 * Reference viewport mirroring pdfjs PageViewport for a 612x792 pt page
 * (US Letter), scale 2, no rotation. Its transform maps user-space points to
 * CSS pixels: x' = 2x, y' = -2y + 1584 (y flipped).
 */
const letterViewport = {
  viewBox: [0, 0, 612, 792],
  transform: [2, 0, 0, -2, 0, 1584],
  width: 1224,
  height: 1584,
};

const rotatedViewport = {
  viewBox: [0, 0, 612, 792],
  // 90° rotation at scale 1: produced by pdfjs for rotation=90 (axes swapped).
  transform: [0, 1, 1, 0, 0, 0],
  width: 792,
  height: 612,
};

test('invertAffine inverts a scale+flip transform', () => {
  const inv = invertAffine(letterViewport.transform);
  assert.ok(inv);
  // Apply transform then its inverse -> identity.
  const [a, b, c, d, e, f] = letterViewport.transform;
  const x = 61.2;
  const y = 400;
  const sx = a * x + c * y + e;
  const sy = b * x + d * y + f;
  const [ia, ib, ic, id, ie, if_] = inv;
  assert.ok(Math.abs(ia * sx + ic * sy + ie - x) < 1e-9);
  assert.ok(Math.abs(ib * sx + id * sy + if_ - y) < 1e-9);
});

test('invertAffine rejects singular transforms', () => {
  assert.equal(invertAffine([1, 2, 2, 4, 0, 0]), null);
  assert.equal(invertAffine([Number.NaN, 0, 0, 1, 0, 0]), null);
});

test('viewportToNormalizedPoint maps page corners into [0,1]^2 (user-space convention)', () => {
  // Normalized coordinates live in PDF *user space*: x grows right, y grows UP
  // (origin at the page's bottom-left). The CSS top-left corner therefore maps
  // to (0, 1) and the CSS bottom-right corner to (1, 0).
  const cssTopLeft = viewportToNormalizedPoint(0, 0, letterViewport);
  const cssBottomRight = viewportToNormalizedPoint(1224, 1584, letterViewport);
  assert.equal(cssTopLeft.x, 0);
  assert.equal(cssTopLeft.y, 1);
  assert.equal(cssBottomRight.x, 1);
  assert.equal(cssBottomRight.y, 0);
});

test('normalizedToViewportPoint is the inverse of viewportToNormalizedPoint', () => {
  const point = { x: 300.5, y: 777.25 };
  const normalized = viewportToNormalizedPoint(point.x, point.y, letterViewport);
  const restored = normalizedToViewportPoint(normalized.x, normalized.y, letterViewport);
  assert.ok(Math.abs(restored.x - point.x) < 1e-9);
  assert.ok(Math.abs(restored.y - point.y) < 1e-9);
});

test('normalized rect round-trips losslessly through zoom change', () => {
  const rect = { x: 100, y: 200, width: 400, height: 50 };
  const normalized = viewportRectToNormalized(rect, letterViewport);
  // Every normalized component stays within [0, 1].
  for (const value of [normalized.x, normalized.y, normalized.width, normalized.height]) {
    assert.ok(value >= 0 && value <= 1, `value ${value} out of [0,1]`);
  }
  const restored = normalizedRectToViewport(normalized, letterViewport);
  assert.ok(Math.abs(restored.x - rect.x) < 1e-9);
  assert.ok(Math.abs(restored.y - rect.y) < 1e-9);
  assert.ok(Math.abs(restored.width - rect.width) < 1e-9);
  assert.ok(Math.abs(restored.height - rect.height) < 1e-9);

  // Rendering the same normalized rect at a different scale (zoom out to 1x)
  // yields proportionally smaller CSS coordinates.
  const zoomedViewport = {
    viewBox: [0, 0, 612, 792],
    transform: [1, 0, 0, -1, 0, 792],
    width: 612,
    height: 792,
  };
  const atHalfScale = normalizedRectToViewport(normalized, zoomedViewport);
  assert.ok(Math.abs(atHalfScale.x - rect.x / 2) < 1e-9);
  assert.ok(Math.abs(atHalfScale.y - (rect.y / 2)) < 1e-9);
});

test('normalized rect maps correctly under 90 degree rotation', () => {
  const normalized = { x: 0.25, y: 0.5, width: 0.5, height: 0.1 };
  const rotated = normalizedRectToViewport(normalized, rotatedViewport);
  // With transform [0,1,1,0,0,0]: (x,y) -> (y, x). Corners stay in-bounds and
  // the bounding box occupies the swapped extents of the normalized rect.
  assert.ok(rotated.width > 0 && rotated.height > 0);
  const roundTrip = viewportRectToNormalized(rotated, rotatedViewport);
  assert.ok(Math.abs(roundTrip.x - normalized.x) < 1e-9);
  assert.ok(Math.abs(roundTrip.y - normalized.y) < 1e-9);
  assert.ok(Math.abs(roundTrip.width - normalized.width) < 1e-9);
  assert.ok(Math.abs(roundTrip.height - normalized.height) < 1e-9);
});

test('mergeLineRects unites rects on the same text line', () => {
  const merged = mergeLineRects([
    { x: 10, y: 100, width: 40, height: 12 },
    { x: 55, y: 101, width: 30, height: 11 },
    { x: 10, y: 130, width: 60, height: 12 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].x, 10);
  assert.ok(Math.abs(merged[0].width - 75) < 0.5);
  assert.equal(merged[1].y, 130);
});

test('selectionToNormalizedRects normalizes, clips and orders client rects', () => {
  const container = { left: 50, top: 100, right: 50 + 612, bottom: 100 + 792 };
  const rects = selectionToNormalizedRects(
    [
      { left: 70, top: 120, right: 200, bottom: 134 },  // first line, in page
      { left: 240, top: 120, right: 400, bottom: 134 }, // same line, merged with the first
      { left: 10, top: 120, right: 40, bottom: 134 },   // left of page -> clipped out
      { left: 70, top: 500, right: 200, bottom: 514 },  // lower line
    ],
    container,
    { viewBox: [0, 0, 612, 792], transform: [1, 0, 0, -1, 0, 792], width: 612, height: 792 },
  );
  // Same-line rects merge, the off-page rect is clipped -> 2 normalized rects.
  assert.equal(rects.length, 2);
  // Reading order: top of page first. User-space y grows upward, so the
  // top-of-page rect (smaller CSS top) has the larger normalized y and sorts first.
  assert.ok(rects[0].y > rects[1].y);
  const firstLine = rects.find(rect => rect.y > 0.9);
  assert.ok(firstLine, 'a rect near the top of the page should have y close to 1');
  const secondLine = rects.find(rect => rect.y < 0.9);
  assert.ok(secondLine, 'a rect lower on the page should have y well below 1');
  for (const rect of rects) {
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 1);
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 1);
  }
});

test('serializeRects / parseRects round-trip and reject invalid payloads', () => {
  const rects = [
    { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    { x: 0.5, y: 0.6, width: 0.1, height: 0.05 },
  ];
  assert.deepEqual(parseRects(serializeRects(rects)), rects);
  assert.deepEqual(parseRects('not json'), []);
  assert.deepEqual(parseRects('{"x":1}'), []);
  assert.deepEqual(parseRects('[{ "x": 0.9, "y": 0, "width": 0.5, "height": 0.1 }]'), []); // x+w > 1
});
