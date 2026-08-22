import type { Rect } from './coordinates.ts';

export type AnnotationKind = 'highlight' | 'rect' | 'note';

export interface PdfAnnotation {
  id: string;
  /** 0-based page index within the document. */
  pageIndex: number;
  type: AnnotationKind;
  /** Normalized rects in [0,1] page space (see coordinates.ts). */
  rects: Rect[];
  /** Hex color, e.g. "#ffd400". */
  color: string;
  commentText: string;
  quoteText: string;
  createdAt: string;
}

export const ANNOTATION_COLORS = ['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5'] as const;

export function annotationLabel(annotation: PdfAnnotation): string {
  const kind = { highlight: 'Highlight', rect: 'Area', note: 'Note' }[annotation.type];
  return `p. ${annotation.pageIndex + 1} · ${kind}`;
}
