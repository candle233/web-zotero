import React from 'react';
import { createRoot } from 'react-dom/client';
import { PdfAnnotationViewer } from './PdfAnnotationViewer.tsx';
import type { PdfAnnotation } from './types.ts';

/**
 * Browser entry for the bundled annotator page (/annotator?item=KEY&file=ATTACH).
 *
 * R7: annotations persist server-side via /api/annotations (normalized
 * rects, per-user authorship). localStorage stays as an offline mirror and
 * as the fallback when the server cannot be reached.
 */

const STORAGE_PREFIX = 'web-zotero-annotations:';

function storageKey(itemKey: string, attachmentKey: string): string {
  return STORAGE_PREFIX + itemKey + ':' + attachmentKey;
}

function readLocal(itemKey: string, attachmentKey: string): PdfAnnotation[] {
  try {
    const raw = localStorage.getItem(storageKey(itemKey, attachmentKey));
    return raw ? (JSON.parse(raw) as PdfAnnotation[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(itemKey: string, attachmentKey: string, annotations: readonly PdfAnnotation[]): void {
  try {
    localStorage.setItem(storageKey(itemKey, attachmentKey), JSON.stringify(annotations));
  } catch {
    // Storage full or unavailable; the server copy is the source of truth.
  }
}

interface ServerAnnotation {
  id: number;
  itemKey: string;
  attachmentKey: string;
  pageIndex: number;
  pageLabel: string | null;
  type: string;
  rects: { x: number; y: number; width: number; height: number }[];
  color: string;
  commentText: string;
  quoteText: string;
  createdAt: string;
  authorEmail: string | null;
}

function fromServer(row: ServerAnnotation): PdfAnnotation {
  return {
    id: `srv-${row.id}`,
    serverId: row.id,
    pageIndex: row.pageIndex,
    type: (row.type === 'rect' || row.type === 'note' ? row.type : 'highlight') as PdfAnnotation['type'],
    rects: row.rects,
    color: row.color,
    commentText: row.commentText || '',
    quoteText: row.quoteText || '',
    createdAt: row.createdAt,
    authorEmail: row.authorEmail,
  };
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
  const [annotations, setAnnotations] = React.useState<PdfAnnotation[]>([]);
  const [syncStatus, setSyncStatus] = React.useState('Loading annotations…');

  const authHeaders = React.useMemo(
    () => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }),
    [token],
  );

  React.useEffect(() => {
    if (!itemKey || !attachmentKey) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/annotations?itemKey=${encodeURIComponent(itemKey)}&attachmentKey=${encodeURIComponent(attachmentKey)}`,
          { headers: authHeaders },
        );
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const payload = (await response.json()) as { annotations: ServerAnnotation[] };
        if (cancelled) return;
        const loaded = payload.annotations.map(fromServer);
        setAnnotations(loaded);
        writeLocal(itemKey, attachmentKey, loaded);
        setSyncStatus(`${loaded.length} annotation(s) synced`);
      } catch {
        if (cancelled) return;
        setAnnotations(readLocal(itemKey, attachmentKey));
        setSyncStatus('Offline mode — changes stay in this browser');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemKey, attachmentKey, authHeaders]);

  // Live sync (R9): remote annotation changes stream in over SSE. Our own
  // mutations are skipped via serverId matching (the server echoes them too).
  React.useEffect(() => {
    if (!itemKey || !attachmentKey) return;
    const source = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    const onAnnotation = (rawEvent: Event) => {
      const payload = JSON.parse((rawEvent as MessageEvent).data) as {
        action: 'created' | 'updated' | 'deleted';
        by: string | null;
        annotation?: ServerAnnotation;
        annotationId?: number;
        itemKey?: string | null;
        attachmentKey?: string | null;
      };
      if (payload.action === 'deleted') {
        if (payload.itemKey !== null && payload.itemKey !== itemKey) return;
        if (payload.attachmentKey !== null && payload.attachmentKey !== attachmentKey) return;
        setAnnotations(current => current.filter(entry => entry.serverId !== payload.annotationId));
        setSyncStatus(`Live: annotation deleted${payload.by ? ` by ${payload.by}` : ''}`);
        return;
      }
      const row = payload.annotation;
      if (!row || row.itemKey !== itemKey || row.attachmentKey !== attachmentKey) return;
      if (payload.action === 'created') {
        setAnnotations(current =>
          // Our own POST can race with this echo: skip when the server id is
          // already present (either applied or pending replacement).
          current.some(entry => entry.serverId === row.id || entry.id === `srv-${row.id}`)
            ? current
            : [...current, fromServer(row)]);
        setSyncStatus(`Live: annotation added${payload.by ? ` by ${payload.by}` : ''}`);
      } else {
        setAnnotations(current =>
          current.map(entry => (entry.serverId === row.id ? fromServer(row) : entry)));
        setSyncStatus(`Live: annotation updated${payload.by ? ` by ${payload.by}` : ''}`);
      }
    };
    source.addEventListener('annotation', onAnnotation as EventListener);
    return () => {
      source.removeEventListener('annotation', onAnnotation as EventListener);
      source.close();
    };
  }, [itemKey, attachmentKey, token]);

  const persist = React.useCallback(
    (next: PdfAnnotation[]) => {
      setAnnotations(next);
      if (itemKey && attachmentKey) writeLocal(itemKey, attachmentKey, next);
    },
    [itemKey, attachmentKey],
  );

  const createOnServer = React.useCallback(
    async (annotation: PdfAnnotation) => {
      try {
        const response = await fetch('/api/annotations', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            itemKey,
            attachmentKey,
            pageIndex: annotation.pageIndex,
            type: annotation.type,
            rects: annotation.rects,
            color: annotation.color,
            comment: annotation.commentText,
            quote: annotation.quoteText,
          }),
        });
        if (!response.ok) throw new Error(`${response.status}`);
        const payload = (await response.json()) as { annotation: ServerAnnotation & { rects: typeof annotation.rects } };
        setAnnotations(current => {
          const next = current
            // Drop any SSE-echo duplicate of this server id, then promote the
            // local draft to its persisted identity (keeping local rects).
            .filter(entry => entry.serverId !== payload.annotation.id)
            .map(entry =>
              entry.id === annotation.id ? fromServer({ ...payload.annotation, rects: entry.rects }) : entry,
            );
          if (itemKey && attachmentKey) writeLocal(itemKey, attachmentKey, next);
          return next;
        });
        setSyncStatus('Saved to server');
      } catch {
        setSyncStatus('Saved locally — server unreachable');
      }
    },
    [itemKey, attachmentKey, authHeaders],
  );

  const updateOnServer = React.useCallback(
    async (id: string, patch: Partial<PdfAnnotation>) => {
      const target = annotations.find(entry => entry.id === id);
      if (!target?.serverId) return;
      try {
        const response = await fetch(`/api/annotations/${target.serverId}`, {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({ color: patch.color, comment: patch.commentText }),
        });
        if (!response.ok) throw new Error(`${response.status}`);
        setSyncStatus('Saved to server');
      } catch {
        setSyncStatus('Saved locally — server unreachable');
      }
    },
    [annotations, authHeaders],
  );

  const deleteOnServer = React.useCallback(
    async (id: string) => {
      const target = annotations.find(entry => entry.id === id);
      if (!target?.serverId) return;
      try {
        const response = await fetch(`/api/annotations/${target.serverId}`, {
          method: 'DELETE',
          headers: authHeaders,
        });
        if (!response.ok) throw new Error(`${response.status}`);
        setSyncStatus('Deleted on server');
      } catch {
        setSyncStatus('Deleted locally — server unreachable');
      }
    },
    [annotations, authHeaders],
  );

  const formulaOcr = React.useCallback(
    async (dataUrl: string): Promise<{ latex: string }> => {
      const response = await fetch('/api/formula-ocr', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ image: dataUrl }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
      return payload as { latex: string };
    },
    [authHeaders],
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
        onCreate={annotation => {
          persist([...annotations, annotation]);
          void createOnServer(annotation);
        }}
        onUpdate={(id, patch) => {
          persist(annotations.map(entry => (entry.id === id ? { ...entry, ...patch } : entry)));
          void updateOnServer(id, patch);
        }}
        onDelete={id => {
          persist(annotations.filter(entry => entry.id !== id));
          void deleteOnServer(id);
        }}
        onFormulaOcr={formulaOcr}
      />
      <div className="wz-export-row">
        <span className="wz-sync-status" data-testid="sync-status">{syncStatus}</span>
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
window.__webZoteroAnnotator = { version: '1.1.0' };
