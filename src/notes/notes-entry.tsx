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

interface Collaborator {
  email: string;
  displayName: string;
  color: string;
  lastSeen: number;
}

function userColor(name: string): string {
  const colors = ['#e11d48', '#d97706', '#059669', '#2563eb', '#7c3aed', '#db2777', '#0891b2', '#4f46e5'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
  return colors[Math.abs(hash) % colors.length];
}

function NotesApp() {
  const params = new URLSearchParams(window.location.search);
  const itemKey = params.get('item') || '';
  const title = params.get('title') || itemKey;
  const token = localStorage.getItem('web-zotero-token') || '';
  const [status, setStatus] = React.useState('Loading…');
  const [saving, setSaving] = React.useState(false);
  const [noteVersion, setNoteVersion] = React.useState<number | null>(null);
  const [conflict, setConflict] = React.useState<{ serverHtml: string; serverText: string; author?: string; version?: number } | null>(null);
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [versions, setVersions] = React.useState<{ id: number; version: number; createdAt: string }[]>([]);
  const [wordCount, setWordCount] = React.useState(0);
  const [linkPickerOpen, setLinkPickerOpen] = React.useState(false);
  const [collaborators, setCollaborators] = React.useState<Map<string, Collaborator>>(new Map());

  const lastSavedHtmlRef = React.useRef<string>('');

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

  const saveNote = React.useCallback(async ({ force = false } = {}) => {
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
        // Keep the local edits in the editor; show what the server holds.
        setConflict({ serverHtml: payload.current.html || '', serverText: payload.current.content || '' });
        setNoteVersion(payload.current.version ?? null);
        setStatus('Conflict: someone saved a newer version. Compare below, then overwrite or load theirs.');
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

  React.useEffect(() => {
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
        setWordCount(editor.getText().trim().split(/\s+/).filter(Boolean).length);
        setNoteVersion(note.version ?? null);
        setConflict(null);
        setStatus(note.updatedAt ? `Saved v${note.version ?? '?'} · ${new Date(note.updatedAt).toLocaleString()}` : 'New note');
      } catch {
        if (!cancelled) setStatus('Could not load this note.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, itemKey, authHeaders]);

  // Real-time SSE Live Collaboration & Remote Save Event Subscription
  React.useEffect(() => {
    if (!itemKey) return;
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const es = new EventSource(`/api/events${tokenParam}`);

    es.addEventListener('note_presence', (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.itemKey === itemKey && data.user) {
          setCollaborators(prev => {
            const next = new Map(prev);
            next.set(data.user.email, {
              email: data.user.email,
              displayName: data.user.displayName || data.user.email,
              color: data.user.color || userColor(data.user.email),
              lastSeen: Date.now(),
            });
            return next;
          });
        }
      } catch {}
    });

    es.addEventListener('note', (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.itemKey === itemKey && data.action === 'saved') {
          const currentHtml = editor ? editor.getHTML() : '';
          const isDirty = currentHtml !== lastSavedHtmlRef.current;
          if (!isDirty && editor) {
            const nextHtml = data.html || legacyTextToHtml(data.content || '');
            editor.commands.setContent(nextHtml, { emitUpdate: true });
            lastSavedHtmlRef.current = nextHtml;
            setNoteVersion(data.version ?? null);
            setConflict(null);
            setStatus(`📝 ${data.by || 'Someone'} 更新了笔记至 v${data.version ?? '?'}`);
          } else if (editor) {
            setConflict({
              serverHtml: data.html || '',
              serverText: data.content || '',
              author: data.by,
              version: data.version,
            });
            setStatus(`⚠️ ${data.by || 'Someone'} 保存了新版本 (v${data.version ?? '?'})。`);
          }
        }
      } catch {}
    });

    return () => {
      es.close();
    };
  }, [itemKey, token, editor]);

  // Presence heartbeat & prune inactive collaborators
  React.useEffect(() => {
    if (!itemKey) return;
    const sendHeartbeat = () => {
      fetch(`/api/items/${encodeURIComponent(itemKey)}/presence`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ state: 'editing', color: userColor(token || 'local') }),
      }).catch(() => {});
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 15000);

    const prune = setInterval(() => {
      const now = Date.now();
      setCollaborators(prev => {
        let changed = false;
        const next = new Map();
        for (const [k, v] of prev.entries()) {
          if (now - v.lastSeen < 45000) {
            next.set(k, v);
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 10000);

    return () => {
      clearInterval(interval);
      clearInterval(prune);
    };
  }, [itemKey, authHeaders, token]);

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
        {collaborators.size > 0 && (
          <div className="notes-collaborators" data-testid="notes-collaborators" title="当前在线协作者">
            {Array.from(collaborators.values()).map(c => (
              <span
                key={c.email}
                className="notes-avatar"
                style={{ backgroundColor: c.color }}
                title={`${c.displayName} (${c.email})`}
              >
                {c.displayName.charAt(0).toUpperCase()}
              </span>
            ))}
          </div>
        )}
        <span className="notes-status" data-testid="notes-status">{status}</span>
        <button type="button" className="notes-save" onClick={() => void saveNote()} disabled={saving || !editor}>
          {saving ? 'Saving…' : 'Save (Ctrl+S)'}
        </button>
      </header>
      {conflict && (
        <div className="notes-conflict" data-testid="notes-conflict">
          <p>⚠️ {conflict.author ? `${conflict.author} ` : ''}在服务器上保存了新版本{conflict.version ? ` (v${conflict.version})` : ''}。你的未保存修改仍在编辑器中。</p>
          <button type="button" onClick={() => void saveNote({ force: true })}>
            用我的版本覆盖
          </button>
          <button type="button" onClick={() => {
            if (!editor) return;
            editor.commands.setContent(conflict.serverHtml || '', { emitUpdate: true });
            lastSavedHtmlRef.current = conflict.serverHtml || '';
            setConflict(null);
            setStatus('Loaded the server version into the editor.');
          }}>
            加载服务器版本（丢弃我的修改）
          </button>
        </div>
      )}
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
      <footer className="notes-footer">
        {wordCount} words · rich text autosanitized on save
        <button
          type="button"
          className="notes-versions-toggle"
          onClick={async () => {
            const next = !versionsOpen;
            setVersionsOpen(next);
            if (next) {
              try {
                const response = await fetch(`/api/items/${encodeURIComponent(itemKey)}/note-versions`, { headers: authHeaders });
                const payload = await response.json().catch(() => ({ versions: [] }));
                setVersions((payload.versions || []) as { id: number; version: number; createdAt: string }[]);
              } catch {
                setVersions([]);
              }
            }
          }}
        >
          🕘 历史版本
        </button>
      </footer>
      {versionsOpen && (
        <div className="notes-versions" data-testid="notes-versions">
          {versions.length === 0 && <p className="notes-status">还没有历史版本——每次保存都会自动留档。</p>}
          {versions.map(entry => (
            <div key={entry.id} className="notes-version-row">
              <span>v{entry.version} · {new Date(entry.createdAt).toLocaleString()}</span>
              <button
                type="button"
                onClick={async () => {
                  const detailResponse = await fetch(
                    `/api/items/${encodeURIComponent(itemKey)}/note-versions`,
                    { headers: authHeaders },
                  ).then(r => r.json()).catch(() => ({ versions: [] }));
                  const match = (detailResponse.versions || []).find((v: { id: number }) => v.id === entry.id);
                  if (!editor || !match) return;
                  editor.commands.setContent(match.html || legacyTextToHtml(match.content || ''), { emitUpdate: true });
                  setStatus(`Restored v${entry.version} into the editor — save to keep it.`);
                }}
              >
                恢复到编辑器
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const container = document.getElementById('notes-root');
if (container) {
  createRoot(container).render(<NotesApp />);
}
