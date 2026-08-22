/**
 * Viewport-normalized annotation coordinates for PDF.js.
 *
 * Annotations must never be stored in CSS pixels: zoom, device pixel ratio and
 * rotation would all corrupt them. Instead every rect is stored relative to the
 * PDF page's *user-space* box (`viewport.viewBox` = [xMin, yMin, xMax, yMax])
 * as dimensionless values in [0, 1]:
 *
 *     normalized = (pdfPoint - viewBoxOrigin) / viewBoxSize
 *
 * `viewport.transform` is the affine matrix PDF.js builds to map user-space
 * points to viewport CSS pixels (including flip + rotation + offset). We invert
 * it analytically, so the mapping is lossless for any scale/rotation and works
 * without a live PageViewport instance (unit-testable with a plain object).
 *
 * This module uses erasable TypeScript syntax only (no enums/namespaces) so it
 * can also run directly under `node --experimental-strip-types`.
 */

/** Rect in normalized page space: x, y, width, height all within [0, 1]. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Structural subset of DOMRect (left/top/right/bottom in CSS pixels). */
export interface DomRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Structural subset of pdfjs PageViewport sufficient for the math below. */
export interface ViewportLike {
  /** [xMin, yMin, xMax, yMax] in PDF user-space units. */
  viewBox: number[];
  /** Affine [a, b, c, d, e, f] mapping user-space -> viewport CSS pixels. */
  transform: number[];
  width: number;
  height: number;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Invert a 2x3 affine transform [a, b, c, d, e, f] where
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * Returns null for a singular (degenerate) matrix.
 */
export function invertAffine(t: readonly number[]): number[] | null {
  const [a, b, c, d, e, f] = t;
  if ([a, b, c, d, e, f].some(v => !Number.isFinite(v))) return null;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

function viewBoxSize(viewBox: readonly number[]): { ox: number; oy: number; w: number; h: number } {
  const [xMin, yMin, xMax, yMax] = viewBox;
  const w = xMax - xMin;
  const h = yMax - yMin;
  if (!(w > 0) || !(h > 0)) throw new Error('Invalid viewBox: width and height must be positive.');
  return { ox: xMin, oy: yMin, w, h };
}

/** Viewport CSS point -> normalized [0,1] point (clamped). */
export function viewportToNormalizedPoint(x: number, y: number, viewport: ViewportLike): { x: number; y: number } {
  const inv = invertAffine(viewport.transform);
  if (!inv) throw new Error('Viewport transform is not invertible.');
  const [a, b, c, d, e, f] = inv;
  const pdfX = a * x + c * y + e;
  const pdfY = b * x + d * y + f;
  const box = viewBoxSize(viewport.viewBox);
  return {
    x: clamp01((pdfX - box.ox) / box.w),
    y: clamp01((pdfY - box.oy) / box.h),
  };
}

/** Normalized [0,1] point -> viewport CSS point (unclamped by design). */
export function normalizedToViewportPoint(nx: number, ny: number, viewport: ViewportLike): { x: number; y: number } {
  const box = viewBoxSize(viewport.viewBox);
  const pdfX = box.ox + nx * box.w;
  const pdfY = box.oy + ny * box.h;
  const [a, b, c, d, e, f] = viewport.transform;
  return {
    x: a * pdfX + c * pdfY + e,
    y: b * pdfX + d * pdfY + f,
  };
}

/**
 * Viewport-space rect (CSS px) -> normalized rect.
 * All four corners are mapped and the bounding box taken, which stays correct
 * for rotated viewports (90/180/270°) where the rect axes swap.
 */
export function viewportRectToNormalized(rect: Rect, viewport: ViewportLike): Rect {
  const corners: Array<[number, number]> = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ];
  const points = corners.map(([x, y]) => viewportToNormalizedPoint(x, y, viewport));
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Normalized rect -> viewport-space rect (CSS px) for overlay rendering. */
export function normalizedRectToViewport(rect: Rect, viewport: ViewportLike): Rect {
  const corners: Array<[number, number]> = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ];
  const points = corners.map(([nx, ny]) => normalizedToViewportPoint(nx, ny, viewport));
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Convert a DOMRect-like (client rect) to a rect local to the page container. */
export function domRectToLocalRect(dom: DomRectLike, container: DomRectLike): Rect | null {
  const x0 = Math.max(dom.left, container.left) - container.left;
  const y0 = Math.max(dom.top, container.top) - container.top;
  const x1 = Math.min(dom.right, container.right) - container.left;
  const y1 = Math.min(dom.bottom, container.bottom) - container.top;
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null; // fully outside the page
  return { x: x0, y: y0, width, height };
}

/**
 * Merge rects that sit on the same text line. Browsers report one client rect
 * per inline fragment; a selection spanning a line break on the same line would
 * otherwise produce duplicate slivers. Rects whose vertical centers overlap are
 * merged into their union. Input must be in viewport (CSS px) space.
 */
export function mergeLineRects(rects: readonly Rect[]): Rect[] {
  const sorted = [...rects].sort((r1, r2) => r1.y - r2.y || r1.x - r2.x);
  const merged: Rect[] = [];
  for (const rect of sorted) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const prevCenter = prev.y + prev.height / 2;
      const currCenter = rect.y + rect.height / 2;
      const sameLine =
        currCenter >= prev.y && currCenter <= prev.y + prev.height ||
        prevCenter >= rect.y && prevCenter <= rect.y + rect.height;
      if (sameLine) {
        const x0 = Math.min(prev.x, rect.x);
        const y0 = Math.min(prev.y, rect.y);
        const x1 = Math.max(prev.x + prev.width, rect.x + rect.width);
        const y1 = Math.max(prev.y + prev.height, rect.y + rect.height);
        merged[merged.length - 1] = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        continue;
      }
    }
    merged.push({ ...rect });
  }
  return merged;
}

/**
 * Build normalized annotation rects from a text selection.
 * `clientRects` come from `range.getClientRects()`, `containerRect` from the
 * page element's `getBoundingClientRect()`. Returns normalized rects ready to
 * persist (`rects_json`), ordered top-to-bottom, left-to-right.
 */
export function selectionToNormalizedRects(
  clientRects: readonly DomRectLike[],
  containerRect: DomRectLike,
  viewport: ViewportLike,
): Rect[] {
  const localRects: Rect[] = [];
  for (const dom of clientRects) {
    const local = domRectToLocalRect(dom, containerRect);
    if (!local) continue;
    if (local.width < 1 || local.height < 1) continue; // caret/artifact slivers
    localRects.push(local);
  }
  return mergeLineRects(localRects)
    .map(rect => viewportRectToNormalized(rect, viewport))
    // Reading order: top of page first. User-space y grows upward, so a
    // top-of-page rect has a LARGER normalized y — sort descending.
    .sort((r1, r2) => r2.y - r1.y || r1.x - r2.x);
}

/** Serialize rects for storage (annotations.rects_json). */
export function serializeRects(rects: readonly Rect[]): string {
  return JSON.stringify(rects.map(({ x, y, width, height }) => ({ x, y, width, height })));
}

/** Parse and validate stored rects; invalid entries are skipped. */
export function parseRects(json: string): Rect[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rects: Rect[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const { x, y, width, height } = candidate;
    if (
      typeof x === 'number' && typeof y === 'number' &&
      typeof width === 'number' && typeof height === 'number' &&
      [x, y, width, height].every(v => Number.isFinite(v)) &&
      width > 0 && height > 0 && x >= 0 && y >= 0 && x <= 1 && y <= 1 &&
      x + width <= 1 + 1e-9 && y + height <= 1 + 1e-9
    ) {
      rects.push({ x, y, width, height });
    }
  }
  return rects;
}
