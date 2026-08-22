import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

/**
 * Rich-text note editor page (/notes?item=KEY&title=...).
 *
 * TipTap (ProseMirror) WYSIWYG backed by the sanitized HTML column of
 * POST /api/items/:key/notes; Ctrl/Cmd+S saves. Falls back to the legacy
 * plain-text note (one paragraph per line) when no HTML exists yet.
 */

interface NotePayload {
  itemKey: string;
  content: string;
  html: string | null;
  updatedAt: string | null;
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

function ToolbarButton(props: {
  label: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={props.active ? 'ntb active' : 'ntb'}
      title={props.title}
      disabled={props.disabled}
      onMouseDown={event => event.preventDefault()}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

interface LibraryItem {
  key: string;
  title: string;
  creators: string[];
}

function LinkPicker(props: { onClose: () => void; onPick: (title: string) => void }) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<LibraryItem[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const token = localStorage.getItem('web-zotero-token') || '';
        const response = await fetch(`/api/items?q=${encodeURIComponent(term)}&limit=8`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        const payload = await response.json().catch(() => ({ items: [] }));
        if (!cancelled) setResults(payload.items || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="link-picker" data-testid="link-picker">
      <input
        type="search"
        autoFocus
        placeholder="Search your library…"
        value={query}
        onChange={event => setQuery(event.target.value)}
      />
      {loading && <div className="link-picker-status">Searching…</div>}
      {!loading && query && results.length === 0 && <div className="link-picker-status">No matching items.</div>}
      <ul>
        {results.map(item => (
          <li key={item.key}>
            <button type="button" onClick={() => props.onPick(item.title)}>
              <span className="link-picker-title">{item.title}</span>
              <span className="link-picker-meta">{item.creators.join(', ')}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="link-picker-close" onClick={props.onClose}>Close</button>
    </div>
  );
}

function NotesApp() {
  const params = new URLSearchParams(window.location.search);
  const itemKey = params.get('item') || '';
  const title = params.get('title') || itemKey;
  const token = localStorage.getItem('web-zotero-token') || '';
  const [status, setStatus] = React.useState('Loading…');
  const [saving, setSaving] = React.useState(false);
  const [wordCount, setWordCount] = React.useState(0);
  const [linkPickerOpen, setLinkPickerOpen] = React.useState(false);

  const editor = useEditor({
    extensions: [StarterKit.configure({
      heading: { levels: [2, 3] },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener' } },
    })],
    content: '',
    editorProps: {
      attributes: { class: 'notes-document', 'data-testid': 'notes-document' },
    },
    onUpdate: ({ editor: current }) => setWordCount(current.getText().trim().split(/\s+/).filter(Boolean).length),
  });

  const authHeaders = React.useMemo(
    () => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }),
    [token],
  );

  const saveNote = React.useCallback(async () => {
    if (!editor || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/items/${encodeURIComponent(itemKey)}/notes`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ html: editor.getHTML() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
      setStatus(`Saved ${new Date(payload.updatedAt || Date.now()).toLocaleString()}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [editor, itemKey, authHeaders, saving]);

  React.useEffect(() => {
    if (!editor || !itemKey) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/items/${encodeURIComponent(itemKey)}/notes`, { headers: authHeaders });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const note = (await response.json()) as NotePayload;
        if (cancelled) return;
        editor.commands.setContent(note.html || legacyTextToHtml(note.content || ''), { emitUpdate: true });
        setWordCount(editor.getText().trim().split(/\s+/).filter(Boolean).length);
        setStatus(note.updatedAt ? `Saved ${new Date(note.updatedAt).toLocaleString()}` : 'New note');
      } catch {
        if (!cancelled) setStatus('Could not load this note.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, itemKey, authHeaders]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveNote();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveNote]);

  if (!itemKey) {
    return <p className="notes-error">Missing ?item=KEY query parameter.</p>;
  }

  return (
    <div className="notes-app">
      <header className="notes-header">
        <a href="/" className="notes-back">← Library</a>
        <h1 className="notes-title">{title}</h1>
        <span className="notes-status" data-testid="notes-status">{status}</span>
        <button type="button" className="notes-save" onClick={() => void saveNote()} disabled={saving || !editor}>
          {saving ? 'Saving…' : 'Save (Ctrl+S)'}
        </button>
      </header>
      {linkPickerOpen && editor && (
        <LinkPicker
          onClose={() => setLinkPickerOpen(false)}
          onPick={title => {
            editor.chain().focus().insertContentAt(editor.state.selection.to, { type: 'text', text: ` [[${title}]] ` }).run();
            setLinkPickerOpen(false);
          }}
        />
      )}
      {editor && (
        <div className="notes-toolbar" role="toolbar" aria-label="Formatting">
          <ToolbarButton label="B" title="Bold" active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()} />
          <ToolbarButton label="I" title="Italic" active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()} />
          <ToolbarButton label="S" title="Strikethrough" active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()} />
          <ToolbarButton label="H2" title="Heading 2" active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
          <ToolbarButton label="H3" title="Heading 3" active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
          <ToolbarButton label="•" title="Bullet list" active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <ToolbarButton label="1." title="Numbered list" active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()} />
          <ToolbarButton label="❝" title="Blockquote" active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()} />
          <ToolbarButton label="</>" title="Code block" active={editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
          <ToolbarButton label="🔗" title="Add link"
            onClick={() => {
              const href = window.prompt('Link URL (https://…)') || '';
              if (href) editor.chain().focus().setLink({ href }).run();
              else editor.chain().focus().unsetLink().run();
            }} />
          <ToolbarButton label="🔗" title="Insert link to a library item ([[title]])"
            onClick={() => setLinkPickerOpen(open => !open)} />
          <ToolbarButton label="↺" title="Undo" disabled={!editor.can().undo()}
            onClick={() => editor.chain().focus().undo().run()} />
          <ToolbarButton label="↻" title="Redo" disabled={!editor.can().redo()}
            onClick={() => editor.chain().focus().redo().run()} />
        </div>
      )}
      <main className="notes-body">
        <EditorContent editor={editor} />
      </main>
      <footer className="notes-footer">{wordCount} words · rich text autosanitized on save</footer>
    </div>
  );
}

const container = document.getElementById('notes-root');
if (container) {
  createRoot(container).render(<NotesApp />);
}
