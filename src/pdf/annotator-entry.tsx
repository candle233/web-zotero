import React from 'react';
import { createRoot } from 'react-dom/client';
import { PdfAnnotationViewer } from './PdfAnnotationViewer.tsx';
import type { PdfAnnotation } from './types.ts';

/**
 * Browser entry for the bundled annotator page (/annotator?item=KEY&file=ATTACH).
 * Annotations are kept in localStorage keyed by attachment so they survive
 * reloads; the PostgreSQL build (db/schema.sql) replaces this with the
 * /api/annotations endpoints.
 */

const STORAGE_PREFIX = 'web-zotero-annotations:';

function storageKey(itemKey: string, attachmentKey: string): string {
  return STORAGE_PREFIX + itemKey + ':' + attachmentKey;
}

function loadAnnotations(itemKey: string, attachmentKey: string): PdfAnnotation[] {
  try {
    const raw = localStorage.getItem(storageKey(itemKey, attachmentKey));
    return raw ? (JSON.parse(raw) as PdfAnnotation[]) : [];
  } catch {
    return [];
  }
}

function annotationsToMarkdown(annotations: readonly PdfAnnotation[], title: string): string {
  const lines = [`# Annotations — ${title}`, ''];
  for (const annotation of annotations) {
    lines.push(`## p. ${annotation.pageIndex + 1}`);
    if (annotation.quoteText) lines.push(`> ${annotation.quoteText.replace(/\n/g, '\n> ')}`);
    if (annotation.commentText) lines.push('', `**Note:** ${annotation.commentText}`);
    lines.push('');
  }
  return lines.join('\n');
}

function AnnotatorApp() {
  const params = new URLSearchParams(window.location.search);
  const itemKey = params.get('item') || '';
  const attachmentKey = params.get('file') || '';
  const title = params.get('title') || itemKey;
  const token = localStorage.getItem('web-zotero-token') || '';
  const [annotations, setAnnotations] = React.useState<PdfAnnotation[]>(() =>
    itemKey && attachmentKey ? loadAnnotations(itemKey, attachmentKey) : [],
  );

  const persist = React.useCallback(
    (next: PdfAnnotation[]) => {
      setAnnotations(next);
      if (itemKey && attachmentKey) {
        localStorage.setItem(storageKey(itemKey, attachmentKey), JSON.stringify(next));
      }
    },
    [itemKey, attachmentKey],
  );

  if (!itemKey || !attachmentKey) {
    return (
      <div className="wz-viewer">
        <header className="wz-toolbar"><span className="wz-title">Annotator</span></header>
        <p className="wz-error" role="alert">Missing ?item=KEY&amp;file=ATTACHMENT query parameters.</p>
      </div>
    );
  }

  return (
    <div>
      <PdfAnnotationViewer
        pdfUrl={`/api/items/${encodeURIComponent(itemKey)}/files/${encodeURIComponent(attachmentKey)}`}
        httpHeaders={token ? { authorization: `Bearer ${token}` } : undefined}
        workerUrl="/vendor/pdf.worker.min.mjs"
        annotations={annotations}
        onCreate={annotation => persist([...annotations, annotation])}
        onUpdate={(id, patch) =>
          persist(annotations.map(annotation => (annotation.id === id ? { ...annotation, ...patch } : annotation)))}
        onDelete={id => persist(annotations.filter(annotation => annotation.id !== id))}
      />
      <div className="wz-export-row">
        <button
          type="button"
          onClick={() => {
            const markdown = annotationsToMarkdown(annotations, title);
            const blob = new Blob([markdown], { type: 'text/markdown' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `${itemKey}-annotations.md`;
            link.click();
            URL.revokeObjectURL(link.href);
          }}
        >
          Export annotations as Markdown
        </button>
      </div>
    </div>
  );
}

const container = document.getElementById('annotator-root');
if (container) {
  createRoot(container).render(<AnnotatorApp />);
}

// Test hooks for Playwright (documented in tests; not used in production code).
declare global {
  interface Window {
    __webZoteroAnnotator?: {
      version: string;
    };
  }
}
window.__webZoteroAnnotator = { version: '1.0.0' };
