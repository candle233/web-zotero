import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { formatQuoteHtml } from './outline.ts';

export interface EmbeddedNoteEditorHandle {
  insertQuote: (quoteText: string, pageIndex: number) => void;
}

export interface EmbeddedNoteEditorProps {
  itemKey: string;
  token?: string;
  onJumpPage?: (pageIndex: number) => void;
  onClose?: () => void;
}

interface NotePayload {
  itemKey: string;
  content: string;
  html: string | null;
  updatedAt: string | null;
  version?: number;
}

function legacyTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  if (!escaped.trim()) return '';
  return escaped
    .split(/\n{2,}/)
    .map(paragraph => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export const EmbeddedNoteEditor = forwardRef<EmbeddedNoteEditorHandle, EmbeddedNoteEditorProps>((props, ref) => {
  const { itemKey, token, onJumpPage, onClose } = props;
  const [status, setStatus] = useState('Loading…');
  const [saving, setSaving] = useState(false);
  const [noteVersion, setNoteVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState<{ serverHtml: string; serverText: string; author?: string; version?: number } | null>(null);
  const lastSavedHtmlRef = useRef<string>('');

  const authHeaders = useMemo(
    () => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }),
    [token],
  );

  const editor = useEditor({
    extensions: [StarterKit.configure({
      heading: { levels: [2, 3] },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener' } },
    })],
    content: '',
    editorProps: {
      attributes: { class: 'wz-embedded-note-doc', 'data-testid': 'embedded-notes-document' },
      handleClick: (view, pos, event) => {
        const target = event.target as HTMLElement;
        const pageAttr = target.getAttribute('data-page') || target.closest('[data-page]')?.getAttribute('data-page');
        if (pageAttr && onJumpPage) {
          const pageNum = parseInt(pageAttr, 10);
          if (!isNaN(pageNum) && pageNum > 0) {
            event.preventDefault();
            onJumpPage(pageNum - 1);
            return true;
          }
        }
        return false;
      },
    },
  });

  useImperativeHandle(ref, () => ({
    insertQuote: (quoteText: string, pageIndex: number) => {
      if (!editor) return;
      const quoteHtml = formatQuoteHtml(quoteText, pageIndex);
      editor.chain().focus().insertContent(quoteHtml).run();
      setStatus(`📌 插入第 ${pageIndex + 1} 页引文`);
    },
  }), [editor]);

  const saveNote = useCallback(async ({ force = false } = {}) => {
    if (!editor || saving) return;
    setSaving(true);
    try {
      const html = editor.getHTML();
      const response = await fetch(`/api/items/${encodeURIComponent(itemKey)}/notes`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ html, version: force ? null : noteVersion }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && payload.conflict && payload.current) {
        setConflict({ serverHtml: payload.current.html || '', serverText: payload.current.content || '' });
        setNoteVersion(payload.current.version ?? null);
        setStatus('Conflict: someone saved a newer version.');
        return;
      }
      if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
      setConflict(null);
      setNoteVersion(payload.version ?? null);
      lastSavedHtmlRef.current = html;
      setStatus(`Saved v${payload.version ?? '?'} · ${new Date(payload.updatedAt || Date.now()).toLocaleTimeString()}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [editor, itemKey, authHeaders, saving, noteVersion]);

  // Load note
  useEffect(() => {
    if (!editor || !itemKey) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/items/${encodeURIComponent(itemKey)}/notes`, { headers: authHeaders });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const note = (await response.json()) as NotePayload;
        if (cancelled) return;
        const initialHtml = note.html || legacyTextToHtml(note.content || '');
        editor.commands.setContent(initialHtml, { emitUpdate: true });
        lastSavedHtmlRef.current = initialHtml;
        setNoteVersion(note.version ?? null);
        setConflict(null);
        setStatus(note.updatedAt ? `Saved v${note.version ?? '?'}` : 'New note');
      } catch {
        if (!cancelled) setStatus('Could not load note.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, itemKey, authHeaders]);

  // Keydown shortcut Ctrl+S
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveNote();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveNote]);

  return (
    <aside className="wz-embedded-notes" data-testid="embedded-notes-pane">
      <header className="wz-embedded-notes-header">
        <div className="wz-embedded-notes-title">
          <span>📝 笔记 (Notes)</span>
          <span className="wz-embedded-notes-status">{status}</span>
        </div>
        <div className="wz-embedded-notes-actions">
          <button type="button" className="wz-note-save-btn" onClick={() => void saveNote()} disabled={saving || !editor}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {onClose && (
            <button type="button" className="wz-note-close-btn" onClick={onClose} title="Close Split View">
              ✕
            </button>
          )}
        </div>
      </header>

      {conflict && (
        <div className="wz-note-conflict-bar">
          <span>⚠️ 远端有新版本</span>
          <button type="button" onClick={() => void saveNote({ force: true })}>用我的覆盖</button>
          <button type="button" onClick={() => {
            if (!editor) return;
            editor.commands.setContent(conflict.serverHtml || '', { emitUpdate: true });
            lastSavedHtmlRef.current = conflict.serverHtml || '';
            setConflict(null);
            setStatus('Loaded server version.');
          }}>加载远端</button>
        </div>
      )}

      {editor && (
        <div className="wz-embedded-toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" className={editor.isActive('bold') ? 'active' : ''} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">B</button>
          <button type="button" className={editor.isActive('italic') ? 'active' : ''} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">I</button>
          <button type="button" className={editor.isActive('strike') ? 'active' : ''} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">S</button>
          <button type="button" className={editor.isActive('heading', { level: 2 }) ? 'active' : ''} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">H2</button>
          <button type="button" className={editor.isActive('heading', { level: 3 }) ? 'active' : ''} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">H3</button>
          <button type="button" className={editor.isActive('bulletList') ? 'active' : ''} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet List">•</button>
          <button type="button" className={editor.isActive('orderedList') ? 'active' : ''} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered List">1.</button>
          <button type="button" className={editor.isActive('blockquote') ? 'active' : ''} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Blockquote">❝</button>
          <button type="button" className={editor.isActive('codeBlock') ? 'active' : ''} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Code block">&lt;/&gt;</button>
          <button type="button" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} title="Undo">↺</button>
          <button type="button" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} title="Redo">↻</button>
        </div>
      )}

      <main className="wz-embedded-notes-body">
        <EditorContent editor={editor} />
      </main>
    </aside>
  );
});

EmbeddedNoteEditor.displayName = 'EmbeddedNoteEditor';
