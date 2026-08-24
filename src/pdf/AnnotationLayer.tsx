import React from 'react';
import { normalizedRectToViewport } from './coordinates.ts';
import type { ViewportLike } from './coordinates.ts';
import type { PdfAnnotation } from './types.ts';

export interface AnnotationLayerProps {
  /** Current page viewport (any scale/rotation — rects remap losslessly). */
  viewport: ViewportLike;
  annotations: PdfAnnotation[];
  selectedId: string | null;
  /** Annotation currently playing the locate-flash animation. */
  flashId: string | null;
  onSelect: (id: string, at: { x: number; y: number }) => void;
}

/**
 * Absolutely-positioned overlay rendered above the PDF canvas/text layer.
 * Every stored rect is denormalized through the *current* viewport, so zooming
 * or rotating the page re-positions highlights without touching stored data.
 */
export function AnnotationLayer({ viewport, annotations, selectedId, flashId, onSelect }: AnnotationLayerProps) {
  return (
    <div className="wz-annotation-layer" data-testid="annotation-layer">
      {annotations.map(annotation =>
        annotation.rects.map((rect, rectIndex) => {
          const box = normalizedRectToViewport(rect, viewport);
          return (
            <div
              key={`${annotation.id}:${rectIndex}`}
              className={[
                'wz-annotation-rect',
                annotation.id === selectedId ? 'wz-selected' : '',
                annotation.id === flashId ? 'wz-flash' : '',
                annotation.type,
              ].filter(Boolean).join(' ')}
              style={{
                left: `${box.x}px`,
                top: `${box.y}px`,
                width: `${box.width}px`,
                height: `${box.height}px`,
                backgroundColor: annotation.color,
              }}
              title={annotation.quoteText || annotation.commentText}
              onMouseDown={event => {
                event.preventDefault();
                event.stopPropagation();
                onSelect(annotation.id, { x: event.clientX, y: event.clientY });
              }}
            />
          );
        }),
      )}
    </div>
  );
}
