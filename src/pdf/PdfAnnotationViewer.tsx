import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { selectionToNormalizedRects, viewportRectToNormalized } from './coordinates.ts';
import type { Rect, ViewportLike } from './coordinates.ts';
import { AnnotationLayer } from './AnnotationLayer.tsx';
import { ANNOTATION_COLORS } from './types.ts';
import type { PdfAnnotation } from './types.ts';

export interface PdfAnnotationViewerProps {
  pdfUrl: string;
  httpHeaders?: Record<string, string>;
  workerUrl?: string;
  /** Controlled annotation list (source of truth lives in the parent). */
  annotations: PdfAnnotation[];
  onCreate: (annotation: PdfAnnotation) => void | Promise<void>;
  onUpdate: (id: string, patch: Partial<PdfAnnotation>) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onDocumentLoaded?: (info: { pages: number }) => void;
  /** 1-based page to scroll to once the document and its pages are mounted. */
  initialPage?: number;
  /**
   * Formula OCR (R10): receives a cropped PNG data URL of the region the
   * user dragged in formula mode, resolves to recognized LaTeX. Provided by
   * the entry point (it owns auth + the /api/formula-ocr call).
   */
  onFormulaOcr?: (dataUrl: string) => Promise<{ latex: string }>;
}

interface PageViewState {
  viewport: ViewportLike;
  pageIndex: number;
}

interface ToolbarState {
  x: number;
  y: number;
  annotationId: string;
}

interface FormulaState {
  status: 'loading' | 'done' | 'error';
  latex?: string;
  message?: string;
  copied?: boolean;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the execCommand path */ }
  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    return ok;
  } catch {
    return false;
  }
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ann-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sortAnnotations(annotations: readonly PdfAnnotation[]): PdfAnnotation[] {
  // Reading order: page asc, then top-of-page first (user-space y desc).
  return [...annotations].sort(
    (a, b) => a.pageIndex - b.pageIndex || (b.rects[0]?.y ?? 0) - (a.rects[0]?.y ?? 0),
  );
}

/**
 * Browser PDF reader with an interactive annotation system on top of PDF.js.
 *
 * Layout: header toolbar | scrollable page canvas | annotation sidebar.
 * Highlights are created from text-layer selections, stored with normalized
 * rects ([x,y,w,h] in [0,1] relative to viewport.viewBox), and re-rendered
 * losslessly under any zoom/rotation via AnnotationLayer.
 */
export function PdfAnnotationViewer(props: PdfAnnotationViewerProps) {
  const { pdfUrl, httpHeaders, workerUrl, annotations } = props;
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.25);
  const [rotation, setRotation] = useState(0);
  const [pageLimit, setPageLimit] = useState(20);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [areaMode, setAreaMode] = useState(false);
  const [formulaMode, setFormulaMode] = useState(false);
  const [formula, setFormula] = useState<FormulaState | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadingTaskRef = useRef<{ destroy: () => Promise<void> } | null>(null);
  const pageViewports = useRef(new Map<number, ViewportLike>());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (workerUrl) GlobalWorkerOptions.workerSrc = workerUrl;
  }, [workerUrl]);

  useEffect(() => {
    let cancelled = false;
    const task = getDocument({ url: pdfUrl, httpHeaders, withCredentials: true });
    loadingTaskRef.current = task;
    task.promise.then(
      doc => {
        if (cancelled) return;
        setPdfDoc(doc);
        props.onDocumentLoaded?.({ pages: doc.numPages });
      },
      error => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
      loadingTaskRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl]);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    void loadingTaskRef.current?.destroy();
  }, []);

  const handleTextSelect = useCallback(
    async (pageIndex: number, rects: Rect[], quoteText: string, at: { x: number; y: number }) => {
      if (rects.length === 0) return;
      const annotation: PdfAnnotation = {
        id: newId(),
        pageIndex,
        type: 'highlight',
        rects,
        color: ANNOTATION_COLORS[0],
        commentText: '',
        quoteText: quoteText.slice(0, 2000),
        createdAt: new Date().toISOString(),
      };
      await props.onCreate(annotation);
      setSelectedId(annotation.id);
      setToolbar({ x: at.x, y: at.y, annotationId: annotation.id });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onCreate],
  );

  const handleAreaSelect = useCallback(
    async (pageIndex: number, cssRect: Rect, at: { x: number; y: number }) => {
      const viewport = pageViewports.current.get(pageIndex);
      if (!viewport) return;
      const normalized = viewportRectToNormalized(cssRect, viewport);
      if (normalized.width <= 0.002 || normalized.height <= 0.002) return; // accidental click
      const annotation: PdfAnnotation = {
        id: newId(),
        pageIndex,
        type: 'rect',
        rects: [normalized],
        color: ANNOTATION_COLORS[3],
        commentText: '',
        quoteText: '',
        createdAt: new Date().toISOString(),
      };
      await props.onCreate(annotation);
      setSelectedId(annotation.id);
      setToolbar({ x: at.x, y: at.y, annotationId: annotation.id });
      setAreaMode(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onCreate],
  );

  const handleFormulaCrop = useCallback(
    async (dataUrl: string | null) => {
      setFormulaMode(false);
      if (!dataUrl) {
        setFormula({ status: 'error', message: 'Could not crop the selected region.' });
        return;
      }
      if (!props.onFormulaOcr) {
        setFormula({ status: 'error', message: 'Formula OCR is not configured on this page.' });
        return;
      }
      setFormula({ status: 'loading' });
      try {
        const result = await props.onFormulaOcr(dataUrl);
        setFormula({ status: 'done', latex: result.latex, copied: false });
        // "One-click" flow: recognition auto-copies; the panel's Copy button
        // is the fallback when the clipboard write needs a user gesture.
        void copyText(result.latex).then(ok => {
          setFormula(current => (current?.status === 'done' ? { ...current, copied: ok } : current));
        });
      } catch (error) {
        setFormula({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onFormulaOcr],
  );

  // Deep-link support (?page=N): mount enough pages, then scroll once.
  const initialPageDone = useRef(false);
  const initialPage = props.initialPage;
  useEffect(() => {
    if (!pdfDoc || !initialPage || initialPageDone.current) return;
    if (initialPage > pageLimit) setPageLimit(initialPage + 10);
    const frame = requestAnimationFrame(() => {
      const target = scrollRef.current?.querySelector(`[data-page-index="${initialPage - 1}"]`);
      if (target) {
        target.scrollIntoView({ block: 'start' });
        initialPageDone.current = true;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pdfDoc, pageLimit]); // eslint-disable-line react-hooks/exhaustive-deps

  const locateAnnotation = useCallback((annotation: PdfAnnotation) => {    setSelectedId(annotation.id);
    setFlashId(annotation.id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1400);
    const pageElement = scrollRef.current?.querySelector<HTMLElement>(`[data-page-index="${annotation.pageIndex}"]`);
    pageElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Clicking an existing highlight on the page opens the action toolbar
  // (colors / note / delete) anchored at the click position.
  const selectOnPage = useCallback((id: string, at: { x: number; y: number }) => {
    if (!annotations.some(annotation => annotation.id === id)) return;
    setSelectedId(id);
    setToolbar({ x: at.x, y: at.y, annotationId: id });
  }, [annotations]);

  const changeColor = useCallback(
    async (id: string, color: string) => {
      await props.onUpdate(id, { color });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onUpdate],
  );

  const removeAnnotation = useCallback(
    async (id: string) => {
      await props.onDelete(id);
      setToolbar(null);
      setSelectedId(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onDelete],
  );

  const onMouseUp = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (areaMode) return; // drawing an area annotation, not selecting text
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const pageElement = (range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement
      )?.closest<HTMLElement>('[data-page-index]');
      if (!pageElement || !scrollRef.current?.contains(pageElement)) return;
      const pageIndex = Number(pageElement.dataset.pageIndex);
      const viewport = pageViewports.current.get(pageIndex);
      if (!viewport) return;
      const rects = selectionToNormalizedRects(
        Array.from(range.getClientRects()),
        pageElement.getBoundingClientRect(),
        viewport,
      );
      const quoteText = range.toString().replace(/\s+/g, ' ').trim();
      if (rects.length === 0 || !quoteText) return;
      selection.removeAllRanges();
      void handleTextSelect(pageIndex, rects, quoteText, { x: event.clientX, y: event.clientY });
    },
    [handleTextSelect, areaMode],
  );

  const sorted = sortAnnotations(annotations);
  const pages = Math.min(pdfDoc?.numPages ?? 0, pageLimit);

  return (
    <div className="wz-viewer">
      <header className="wz-toolbar">
        <span className="wz-title">Annotator</span>
        <span className="wz-pages">{pdfDoc ? `${pdfDoc.numPages} pages` : loadError ? 'load failed' : 'loading…'}</span>
        <div className="wz-zoom">
          <button type="button" onClick={() => setScale(s => Math.max(0.4, s / 1.2))} aria-label="Zoom out">−</button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScale(s => Math.min(5, s * 1.2))} aria-label="Zoom in">+</button>
        </div>
        <div className="wz-rotate">
          <button type="button" onClick={() => setRotation(r => (r + 270) % 360)} aria-label="Rotate left">⟲</button>
          <button type="button" onClick={() => setRotation(r => (r + 90) % 360)} aria-label="Rotate right">⟳</button>
        </div>
        <button
          type="button"
          className={`wz-area-toggle${areaMode ? ' wz-area-active' : ''}`}
          aria-pressed={areaMode}
          title="Draw a rectangular area annotation (drag on the page)"
          onClick={() => {
            setAreaMode(mode => !mode);
            setFormulaMode(false);
          }}
        >
          ▦ Area
        </button>
        <button
          type="button"
          className={`wz-area-toggle wz-formula-toggle${formulaMode ? ' wz-area-active' : ''}`}
          aria-pressed={formulaMode}
          title="Drag a box around a formula to recognize it as LaTeX and copy"
          onClick={() => {
            setFormulaMode(mode => !mode);
            setAreaMode(false);
          }}
        >
          ∑ LaTeX
        </button>
      </header>
      <div className="wz-body">
        <div className="wz-scroll" ref={scrollRef} onMouseUp={onMouseUp} data-testid="pdf-scroll">
          {loadError && <p className="wz-error" role="alert">Failed to load PDF: {loadError}</p>}
          {Array.from({ length: pages }, (_, index) => (
            <PdfPageView
              key={index}
              pdf={pdfDoc}
              pageIndex={index}
              scale={scale}
              rotation={rotation}
              viewportSink={pageViewports.current}
              annotations={annotations.filter(annotation => annotation.pageIndex === index)}
              selectedId={selectedId}
              flashId={flashId}
                  onSelect={selectOnPage}
                  areaMode={areaMode}
                  formulaMode={formulaMode}
                  onAreaSelect={(rect, at) => void handleAreaSelect(index, rect, at)}
                  onFormulaCrop={dataUrl => void handleFormulaCrop(dataUrl)}
                />
          ))}
          {pdfDoc && pdfDoc.numPages > pageLimit && (
            <button type="button" className="wz-load-more" onClick={() => setPageLimit(limit => limit + 20)}>
              Load more pages ({pageLimit}/{pdfDoc.numPages})
            </button>
          )}
        </div>
        <aside className="wz-sidebar" data-testid="annotation-sidebar">
          <h3>Annotations ({sorted.length})</h3>
          {sorted.length === 0 && <p className="wz-empty">Select text in the PDF to create a highlight.</p>}
          <ol>
            {sorted.map(annotation => (
              <li
                key={annotation.id}
                className={annotation.id === selectedId ? 'wz-selected-item' : ''}
                onClick={() => locateAnnotation(annotation)}
              >
                <div className="wz-sidebar-item-head">
                  <span className="wz-chip" style={{ backgroundColor: annotation.color }}>
                    p. {annotation.pageIndex + 1}
                  </span>
                  <button
                    type="button"
                    className="wz-sidebar-delete"
                    title="Delete this annotation"
                    aria-label={`Delete annotation on page ${annotation.pageIndex + 1}`}
                    onClick={event => {
                      event.stopPropagation();
                      void props.onDelete(annotation.id);
                      if (toolbar?.annotationId === annotation.id) setToolbar(null);
                    }}
                  >
                    🗑
                  </button>
                </div>
                {annotation.quoteText && <blockquote>{annotation.quoteText}</blockquote>}
                {annotation.commentText && <p className="wz-comment">{annotation.commentText}</p>}
              </li>
            ))}
          </ol>
        </aside>
      </div>
      {toolbar && (
        <FloatingToolbar
          x={toolbar.x}
          y={toolbar.y}
          annotation={annotations.find(annotation => annotation.id === toolbar.annotationId) ?? null}
          onColor={color => void changeColor(toolbar.annotationId, color)}
          onComment={text => void props.onUpdate(toolbar.annotationId, { commentText: text })}
          onDelete={() => void removeAnnotation(toolbar.annotationId)}
          onClose={() => setToolbar(null)}
        />
      )}
      {formula && (
        <FormulaPanel
          state={formula}
          onChange={latex => setFormula(current => (current ? { ...current, latex } : current))}
          onCopy={async () => {
            const ok = await copyText(formula.latex || '');
            setFormula(current => (current ? { ...current, copied: ok } : current));
          }}
          onClose={() => setFormula(null)}
        />
      )}
    </div>
  );
}

interface PdfPageViewProps {
  pdf: PDFDocumentProxy | null;
  pageIndex: number;
  scale: number;
  rotation: number;
  viewportSink: Map<number, ViewportLike>;
  annotations: PdfAnnotation[];
  selectedId: string | null;
  flashId: string | null;
  onSelect: (id: string, at: { x: number; y: number }) => void;
  areaMode: boolean;
  formulaMode: boolean;
  onAreaSelect: (cssRect: Rect, at: { x: number; y: number }) => void;
  onFormulaCrop: (dataUrl: string | null) => void;
}

function PdfPageView({ pdf, pageIndex, scale, rotation, viewportSink, annotations, selectedId, flashId, onSelect, areaMode, formulaMode, onAreaSelect, onFormulaCrop }: PdfPageViewProps) {
  const [view, setView] = useState<PageViewState | null>(null);
  const [draft, setDraft] = useState<{ origin: { x: number; y: number }; current: { x: number; y: number } } | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);

  const pointerLocal = (event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const box = wrapperRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const draftRect = (state: { origin: { x: number; y: number }; current: { x: number; y: number } }): Rect => ({
    x: Math.min(state.origin.x, state.current.x),
    y: Math.min(state.origin.y, state.current.y),
    width: Math.abs(state.current.x - state.origin.x),
    height: Math.abs(state.current.y - state.origin.y),
  });

  /**
   * Crops a CSS-pixel rect out of this page's canvas. The backing store is
   * DPR-scaled relative to the CSS size, so map through the actual pixel
   * ratio; a white underlay keeps transparent PDF regions OCR-friendly.
   */
  const cropToDataUrl = (cssRect: Rect): string | null => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const sx = Math.max(0, Math.floor(cssRect.x * scaleX));
    const sy = Math.max(0, Math.floor(cssRect.y * scaleY));
    const sw = Math.min(canvas.width - sx, Math.max(1, Math.floor(cssRect.width * scaleX)));
    const sh = Math.min(canvas.height - sy, Math.max(1, Math.floor(cssRect.height * scaleY)));
    if (sw < 8 || sh < 8) return null;
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const context = out.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, sw, sh);
    context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return out.toDataURL('image/png');
  };

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let textLayerInstance: { cancel: () => void } | null = null;
    let page: { cleanup: () => void } | null = null;

    (async () => {
      const pdfPage = await pdf.getPage(pageIndex + 1);
      if (cancelled) return;
      page = pdfPage;
      const viewport = pdfPage.getViewport({ scale, rotation });
      viewportSink.set(pageIndex, viewport);
      setView({ viewport, pageIndex });

      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const task = pdfPage.render({
        canvas,
        canvasContext: context,
        viewport,
        // The backing store is DPR-sized; scale the drawing to match or the
        // page renders at 1/outputScale in the canvas corner on HiDPI screens.
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      });
      renderTask = task;
      await task.promise;
      if (cancelled) return;

      const textContainer = textLayerRef.current;
      if (textContainer) {
        textContainer.replaceChildren();
        textContainer.style.width = `${Math.floor(viewport.width)}px`;
        textContainer.style.height = `${Math.floor(viewport.height)}px`;
        const layer = new TextLayer({
          textContentSource: pdfPage.streamTextContent(),
          container: textContainer,
          viewport,
        });
        textLayerInstance = layer;
        await layer.render();
      }
    })().catch(error => {
      if (!cancelled && error?.name !== 'RenderingCancelledException') {
        console.error(`Page ${pageIndex + 1} render failed`, error);
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayerInstance?.cancel();
      page?.cleanup();
    };
  }, [pdf, pageIndex, scale, rotation, viewportSink]);

  return (
    <div
      ref={wrapperRef}
      className="wz-page"
      data-page-index={pageIndex}
      style={view ? { width: view.viewport.width, height: view.viewport.height } : undefined}
    >
      <canvas ref={canvasRef} />
      <div ref={textLayerRef} className="wz-text-layer" />
      {(areaMode || formulaMode) && (
        <div
          className="wz-area-capture"
          data-testid="area-capture"
          onPointerDown={event => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDraft({ origin: pointerLocal(event), current: pointerLocal(event) });
          }}
          onPointerMove={event => {
            if (!draft) return;
            setDraft(state => (state ? { ...state, current: pointerLocal(event) } : state));
          }}
          onPointerUp={event => {
            if (!draft) return;
            const rect = draftRect(draft);
            setDraft(null);
            if (rect.width >= 8 && rect.height >= 8) {
              if (formulaMode) onFormulaCrop(cropToDataUrl(rect));
              else onAreaSelect(rect, { x: event.clientX, y: event.clientY });
            }
          }}
        >
          {draft && (
            <div className="wz-area-draft" style={(() => {
              const rect = draftRect(draft);
              return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
            })()} />
          )}
        </div>
      )}
      {view && (
        <AnnotationLayer
          viewport={view.viewport}
          annotations={annotations}
          selectedId={selectedId}
          flashId={flashId}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

interface FloatingToolbarProps {
  x: number;
  y: number;
  annotation: PdfAnnotation | null;
  onColor: (color: string) => void;
  onComment: (text: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

function FloatingToolbar({ x, y, annotation, onColor, onComment, onDelete, onClose }: FloatingToolbarProps) {
  const [draftComment, setDraftComment] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraftComment(annotation?.commentText ?? ''), [annotation?.id, annotation?.commentText]);

  const left = Math.min(x, window.innerWidth - 260);
  const top = Math.max(8, y - 52);

  return (
    <div className="wz-floating-toolbar" style={{ left, top }} role="toolbar" aria-label="Annotation actions" data-testid="floating-toolbar">
      {ANNOTATION_COLORS.map(color => (
        <button
          key={color}
          type="button"
          className={annotation?.color === color ? 'wz-active-color' : ''}
          style={{ backgroundColor: color }}
          aria-label={`Color ${color}`}
          onClick={() => onColor(color)}
        />
      ))}
      <button type="button" onClick={() => setEditing(value => !value)} aria-label="Add note">📝</button>
      {editing && (
        <div className="wz-note-editor">
          <textarea
            value={draftComment}
            onChange={event => setDraftComment(event.target.value)}
            placeholder="Note about this highlight…"
            rows={3}
          />
          <button
            type="button"
            onClick={() => {
              onComment(draftComment);
              setEditing(false);
            }}
          >
            Save
          </button>
        </div>
      )}
      <button type="button" onClick={onDelete} aria-label="Delete annotation">🗑</button>
      <button type="button" onClick={onClose} aria-label="Close toolbar">✕</button>
    </div>
  );
}

interface FormulaPanelProps {
  state: FormulaState;
  onChange: (latex: string) => void;
  onCopy: () => void | Promise<void>;
  onClose: () => void;
}

/** Result panel for the ∑ LaTeX mode: recognized LaTeX + one-click copy. */
function FormulaPanel({ state, onChange, onCopy, onClose }: FormulaPanelProps) {
  return (
    <div className="wz-formula-panel" role="dialog" aria-label="Recognized LaTeX" data-testid="formula-panel">
      <header>
        <span>∑ LaTeX</span>
        <button type="button" onClick={onClose} aria-label="Close formula panel">✕</button>
      </header>
      {state.status === 'loading' && <p className="wz-formula-status">Recognizing formula…</p>}
      {state.status === 'error' && <p className="wz-formula-status wz-formula-error" role="alert">{state.message}</p>}
      {state.status === 'done' && (
        <>
          <textarea
            className="wz-formula-latex"
            value={state.latex}
            onChange={event => onChange(event.target.value)}
            rows={4}
            spellCheck={false}
            aria-label="Recognized LaTeX"
          />
          <div className="wz-formula-actions">
            <button type="button" className="wz-formula-copy" onClick={() => void onCopy()}>Copy LaTeX</button>
            <span className="wz-formula-copied" data-testid="formula-copied">
              {state.copied ? '✓ copied' : ''}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
