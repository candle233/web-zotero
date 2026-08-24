'use strict';

const state = {
  token: localStorage.getItem('web-zotero-token') || '',
  items: [],
  collections: [],
  activeKey: null,
  activeAttachment: '',
  view: 'detail',
  searchMode: false,
  total: 0,
  hasMore: false,
  loadingMore: false
};

const elements = {};
['searchInput','semanticToggle','searchButton','reindexButton','status','library','detailTitle','detailBody','readerView','pdfFrame','pdfFallback','fallbackAnnotatorButton','fallbackNewTabButton','openAnnotatorButton','newTabButton','aiResult','askInput','askButton','summarizeButton','extractTextButton','searchResults','resultCount','resultList','toast','backButton','closeSearch','lookupInput','lookupButton','lookupBody','closeLookup','logoutButton','loginPanel','loginForm','loginEmailRow','loginEmail','loginPassword','loginError','loginCancel']
  .forEach(id => { elements[id] = document.getElementById(id); });

function authHeaders(extra = {}) {
  return state.token ? { authorization: `Bearer ${state.token}`, ...extra } : extra;
}

async function request(path, options = {}, { retried = false } = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.auth) {
    // One retry only: a stale token prompts once, a rejected login surfaces as an error.
    if (retried) throw new Error(payload.error || 'Login failed');
    await login(payload.mode || 'legacy');
    return request(path, options, { retried: true });
  }
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

/**
 * Shows the sign-in overlay and resolves with the stored token once
 * authenticated; rejects when the user cancels.
 */
function showLogin(mode) {
  return new Promise((resolve, reject) => {
    const panel = elements.loginPanel;
    if (!panel) { reject(new Error('Login cancelled')); return; }
    elements.loginEmailRow.hidden = mode !== 'users';
    elements.loginError.textContent = '';
    panel.hidden = false;
    (mode === 'users' ? elements.loginEmail : elements.loginPassword).focus();

    const close = () => {
      panel.hidden = true;
      elements.loginForm.removeEventListener('submit', onSubmit);
      elements.loginCancel.removeEventListener('click', onCancel);
    };
    const fail = message => { elements.loginError.textContent = message; };

    async function onSubmit(event) {
      event.preventDefault();
      const email = elements.loginEmail.value.trim();
      const password = elements.loginPassword.value;
      if (!password) { fail('Password is required.'); return; }
      try {
        const result = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(mode === 'users' ? { email, password } : { password })
        });
        const payload = await result.json().catch(() => ({}));
        if (!result.ok) { fail(payload.error || 'Invalid credentials'); return; }
        state.token = payload.token || password;
        localStorage.setItem('web-zotero-token', state.token);
        if (elements.logoutButton) elements.logoutButton.hidden = false;
        close();
        resolve(state.token);
      } catch {
        fail('Network error — is the server running?');
      }
    }
    function onCancel() { close(); reject(new Error('Login cancelled')); }

    elements.loginForm.addEventListener('submit', onSubmit);
    elements.loginCancel.addEventListener('click', onCancel);
  });
}

async function login(mode) {
  return showLogin(mode);
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

let toastTimer;
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 4000);
}

function debounce(callback, delay = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

async function loadCollections() {
  state.collections = (await request('/api/collections')).collections;
}

const PAGE_SIZE = 200;

async function logout() {
  try { await request('/api/auth/logout', { method: 'POST' }); } catch {}
  state.token = '';
  localStorage.removeItem('web-zotero-token');
  window.location.reload();
}

async function loadItems({ append = false } = {}) {
  const query = encodeURIComponent(elements.searchInput.value.trim());
  const collection = document.getElementById('collectionSelect').value;
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (collection) params.set('collection', collection);
  if (append) params.set('offset', String(state.items.length));
  params.set('limit', String(PAGE_SIZE));
  const data = await request(`/api/items?${params}`);
  state.items = append ? state.items.concat(data.items) : data.items;
  state.total = data.total ?? data.count;
  state.hasMore = data.hasMore;
  renderLibrary();
  setStatus(`${data.count} items`);
}

function renderLibrary() {
  elements.library.innerHTML = '';
  if (!state.items.length) {
    elements.library.innerHTML = '<div class="empty">No matching items.</div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of state.items) {
    const button = document.createElement('button');
    button.className = `item${item.key === state.activeKey ? ' active' : ''}`;
    button.dataset.key = item.key;
    const top = document.createElement('div');
    top.className = 'item-top';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = item.title;
    const pill = document.createElement('span');
    pill.className = `pill${item.pdfCount ? ' pdf' : ''}`;
    pill.textContent = item.pdfCount ? 'PDF' : item.itemType;
    top.append(title, pill);
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = item.creators.join(', ') || item.itemType;
    button.append(top, meta);
    button.addEventListener('click', () => openItem(item.key));
    fragment.append(button);
  }
  if (state.hasMore !== false && state.items.length < state.total) {
    const more = document.createElement('button');
    more.className = 'ghost load-more';
    more.textContent = `Load more (${state.total - state.items.length} remaining)`;
    more.disabled = state.loadingMore;
    more.addEventListener('click', async () => {
      state.loadingMore = true;
      more.disabled = true;
      try { await loadItems({ append: true }); } catch (error) { setStatus(error.message, true); }
      finally { state.loadingMore = false; }
    });
    fragment.append(more);
  }
  elements.library.append(fragment);
}

function renderCollections() {
  const select = document.getElementById('collectionSelect');
  select.innerHTML = '<option value="">All collections</option>';
  for (const collection of state.collections) {
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = `${collection.name} (${collection.itemCount})`;
    select.append(option);
  }
}

function metaCard(label, value) {
  const card = document.createElement('div');
  card.className = 'meta-card';
  const heading = document.createElement('h3');
  heading.textContent = label;
  const body = document.createElement('div');
  body.textContent = value || '—';
  card.append(heading, body);
  return card;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportItem(item, format) {
  try {
    const endpoint = format === 'annotations'
      ? `/api/items/${encodeURIComponent(item.key)}/annotations?format=md`
      : `/api/items/${encodeURIComponent(item.key)}/export.${format}`;
    const response = await fetch(endpoint, { headers: authHeaders() });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const extension = format === 'annotations' ? 'md' : format;
    downloadText(`${item.key}.${extension}`, await response.text());
    showToast(`Exported ${format.toUpperCase()}`);
  } catch (error) { setStatus(error.message, true); }
}

function actionButton(label, onClick, className = 'ghost') {
  const button = document.createElement('button');
  button.className = className;
  button.textContent = label;
  button.style.marginBottom = '7px';
  button.addEventListener('click', onClick);
  return button;
}

function renderWikiNoteHtml(container, html) {
  container.replaceChildren(sanitizeZoteroNoteHtml(html));
  const wikiPattern = /\[\[([^\[\]]{2,300})\]\]/;
  const convert = textNode => {
    const value = String(textNode.nodeValue || '');
    const match = value.match(wikiPattern);
    if (!match) return null;
    const title = match[1].trim();
    const target = state.items.find(candidate => candidate.title === title);
    const link = document.createElement(target ? 'button' : 'span');
    link.className = target ? 'wiki-link' : 'wiki-link missing';
    link.textContent = title;
    if (target) link.addEventListener('click', () => openItem(target.key));
    const after = document.createTextNode(value.slice(match.index + match[0].length));
    textNode.replaceWith(document.createTextNode(value.slice(0, match.index)), link, after);
    return after;
  };
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    let next = convert(node);
    while (next) next = convert(next);
  }
}

function renderDetail(item) {
  elements.detailTitle.textContent = item.title;
  elements.detailBody.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'detail-card';
  const authors = document.createElement('p');
  authors.className = 'authors';
  authors.textContent = item.creators.map(person => [person.firstName, person.lastName].filter(Boolean).join(' ')).join(', ') || 'No authors recorded';
  const grid = document.createElement('div');
  grid.className = 'meta-grid';
  grid.append(
    metaCard('Type', item.itemType),
    metaCard('Date', item.fields.date || item.dateAdded?.slice(0, 10)),
    metaCard('Publication', item.fields.publicationTitle || item.fields.publisher),
    metaCard('DOI', item.fields.DOI),
    metaCard('URL', item.fields.url),
    metaCard('Zotero key', item.key)
  );
  card.append(authors, grid);

  const exportPanel = document.createElement('section');
  exportPanel.className = 'panel';
  exportPanel.innerHTML = '<h3>Export</h3>';
  exportPanel.append(
    actionButton('APA citation', () => exportItem(item, 'txt')),
    actionButton('BibTeX', () => exportItem(item, 'bib')),
    actionButton('RIS', () => exportItem(item, 'ris')),
    actionButton('CSV metadata', () => exportItem(item, 'csv')),
    actionButton('JSON metadata', () => exportItem(item, 'json'))
  );
  card.append(exportPanel);
  card.append(buildCitationPanel({ itemKey: item.key }));

  if (item.tags.length) {
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = '<h3>Tags</h3>';
    const row = document.createElement('div');
    row.className = 'tag-row';
    for (const tag of item.tags) {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = tag;
      row.append(span);
    }
    panel.append(row);
    card.append(panel);
  }

  const notePanel = document.createElement('section');
  notePanel.className = 'panel';
  notePanel.innerHTML = '<h3>Web notes</h3>';
  const noteView = document.createElement('div');
  noteView.className = 'note-html';
  noteView.hidden = true;
  const noteArea = document.createElement('textarea');
  noteArea.className = 'note-area';
  noteArea.placeholder = 'Write reading notes. Saved on this server.';
  const noteStatus = document.createElement('p');
  noteStatus.className = 'saved-note';
  const saveNote = document.createElement('button');
  saveNote.textContent = 'Save note';
  saveNote.addEventListener('click', async () => {
    saveNote.disabled = true;
    try {
      const saved = await request(`/api/items/${item.key}/notes`, { method: 'POST', body: JSON.stringify({ content: noteArea.value }) });
      noteStatus.textContent = saved.updatedAt ? `Saved ${new Date(saved.updatedAt).toLocaleString()}` : '';
      showToast('Note saved');
    } catch (error) {
      setStatus(error.message, true);
    } finally { saveNote.disabled = false; }
  });
  notePanel.append(noteView, noteArea, saveNote, noteStatus);
  const deleteNote = document.createElement('button');
  deleteNote.className = 'ghost';
  deleteNote.textContent = '🗑 Delete note';
  deleteNote.title = 'Remove the saved web note for this item';
  deleteNote.hidden = true;
  deleteNote.style.marginLeft = '7px';
  deleteNote.addEventListener('click', async () => {
    if (!window.confirm('Delete this web note?')) return;
    try {
      await request(`/api/items/${encodeURIComponent(item.key)}/notes`, { method: 'DELETE' });
      noteView.hidden = true;
      noteView.replaceChildren();
      noteArea.hidden = false;
      noteArea.value = '';
      saveNote.hidden = false;
      deleteNote.hidden = true;
      noteStatus.textContent = '';
      showToast('Note deleted');
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  notePanel.append(deleteNote);
  const richText = document.createElement('button');
  richText.className = 'ghost';
  richText.textContent = '✍️ Rich text editor';
  richText.title = 'Open the TipTap rich-text note editor';
  richText.style.marginLeft = '7px';
  richText.addEventListener('click', () => {
    const url = `/notes?item=${encodeURIComponent(item.key)}&title=${encodeURIComponent(item.title || item.key)}`;
    window.open(url, '_blank', 'noopener');
  });
  notePanel.append(richText);
  request(`/api/items/${item.key}/notes`).then(note => {
    if (note.updatedAt) {
      noteStatus.textContent = `Saved ${new Date(note.updatedAt).toLocaleString()}`;
      deleteNote.hidden = false;
    }
    if (note.html) {
      noteView.hidden = false;
      noteArea.hidden = true;
      saveNote.hidden = true;
      renderWikiNoteHtml(noteView, note.html);
    } else {
      noteArea.value = note.content || '';
    }
  }).catch(error => setStatus(error.message, true));
  card.append(notePanel);

  const mentionsPanel = document.createElement('section');
  mentionsPanel.className = 'panel';
  mentionsPanel.innerHTML = '<h3>Mentioned in</h3><div class="muted">Loading…</div>';
  request(`/api/items/${encodeURIComponent(item.key)}/mentions`).then(data => {
    mentionsPanel.innerHTML = '<h3>Mentioned in</h3>';
    if (!data.mentions.length) {
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.textContent = `No notes link here yet — reference this paper as [[${data.title}]] in any note.`;
      mentionsPanel.append(hint);
      return;
    }
    for (const mention of data.mentions) {
      const button = document.createElement('button');
      button.className = 'item';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = mention.title;
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      meta.textContent = mention.updatedAt ? new Date(mention.updatedAt).toLocaleString() : '';
      button.append(title, meta);
      button.addEventListener('click', () => openItem(mention.itemKey));
      mentionsPanel.append(button);
    }
  }).catch(() => { mentionsPanel.innerHTML = '<h3>Mentioned in</h3>'; });
  card.append(mentionsPanel);

  if (item.notes.length) {
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = `<h3>Zotero notes (${item.notes.length})</h3>`;
    for (const note of item.notes.slice(0, 8)) {
      const div = document.createElement('div');
      div.className = 'note-html';
      div.append(sanitizeZoteroNoteHtml(note.note));
      panel.append(div);
    }
    card.append(panel);
  }

  if (item.annotations?.length) {
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = `<h3>Desktop annotations (${item.annotations.length})</h3>`;
    for (const annotation of item.annotations.slice(0, 20)) {
      const div = document.createElement('div');
      div.className = 'annotation';
      div.style.borderLeftColor = annotation.color || '#6aa5ff';
      const text = document.createElement('div');
      text.textContent = annotation.text || '(no highlighted text)';
      const meta = document.createElement('div');
      meta.className = 'muted';
      meta.textContent = [annotation.pageLabel ? `Page ${annotation.pageLabel}` : '', annotation.comment].filter(Boolean).join(' · ');
      div.append(text, meta);
      panel.append(div);
    }
    panel.append(actionButton('Export annotations', () => exportItem(item, 'annotations')));
    card.append(panel);
  }

  if (item.attachments.length) {
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = `<h3>Available PDFs (${item.attachments.filter(file => file.exists).length})</h3>`;
    for (const file of item.attachments.filter(candidate => candidate.exists)) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '7px';
      row.style.marginBottom = '7px';
      const read = document.createElement('button');
      read.className = 'ghost';
      read.style.flex = '1';
      read.textContent = file.fileName;
      read.addEventListener('click', () => openReader(item.key, file.key, file.fileName));
      const annotate = document.createElement('button');
      annotate.className = 'ghost';
      annotate.textContent = '✏️ Annotate';
      annotate.title = 'Open in interactive annotator (highlight & note)';
      annotate.addEventListener('click', () => {
        const url = `/annotator?item=${encodeURIComponent(item.key)}&file=${encodeURIComponent(file.key)}&title=${encodeURIComponent(item.title || file.fileName)}`;
        window.open(url, '_blank', 'noopener');
      });
      row.append(read, annotate);
      panel.append(row);
    }
    card.append(panel);
  } else {
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = '<h3>Files</h3><div>No available local PDF attachment.</div>';
    card.append(panel);
  }

  const relatedPanel = document.createElement('section');
  relatedPanel.className = 'panel';
  relatedPanel.innerHTML = '<h3>Related papers</h3><div class="muted">Loading…</div>';
  card.append(relatedPanel);
  request(`/api/items/${encodeURIComponent(item.key)}/related`).then(data => {
    relatedPanel.innerHTML = '<h3>Related papers</h3>';
    if (!data.related.length) {
      relatedPanel.innerHTML += '<div class="muted">No lexical matches yet.</div>';
      return;
    }
    for (const related of data.related) {
      const button = document.createElement('button');
      button.className = 'item';
      button.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = related.title;
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      meta.textContent = related.creators.join(', ') || related.itemType;
      button.append(title, meta);
      button.addEventListener('click', () => openItem(related.key));
      relatedPanel.append(button);
    }
  }).catch(error => { relatedPanel.innerHTML = '<h3>Related papers</h3>'; relatedPanel.append(Object.assign(document.createElement('div'), { className: 'muted', textContent: error.message })); });

  elements.detailBody.append(card);
}

async function openItem(key) {
  try {
    state.activeKey = key;
    state.view = 'detail';
    showView('detail');
    elements.backButton.hidden = true;
    renderLibrary();
    const detail = await request(`/api/items/${encodeURIComponent(key)}/detail`);
    renderDetail(detail);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function showView(view) {
  for (const element of document.querySelectorAll('.view')) element.classList.remove('active');
  document.getElementById(`${view}View`).classList.add('active');
  if (view !== 'reader') {
    elements.summarizeButton.hidden = true;
    elements.extractTextButton.hidden = true;
    elements.askButton.hidden = true;
    elements.askInput.hidden = true;
    elements.openAnnotatorButton.hidden = true;
    elements.newTabButton.hidden = true;
    elements.pdfFallback.hidden = true;
  }
}

// Some browsers never render PDFs inside an iframe: iOS Safari and most in-app
// browsers (WeChat, DingTalk) ignore the PDF plugin, headless kernels ship
// without one. Detect that and route the user to guaranteed-working options.
function nativePdfViewerSupported() {
  return typeof navigator === 'object' && navigator.pdfViewerEnabled === true;
}

function annotatorUrl(key, attachmentKey, title = '') {
  const params = new URLSearchParams({ item: key, file: attachmentKey });
  if (title) params.set('title', title);
  return `/annotator?${params}`;
}

let pdfFailureTimer = null;
function detectIframePdfFailure() {
  clearTimeout(pdfFailureTimer);
  pdfFailureTimer = setTimeout(() => {
    try {
      const doc = elements.pdfFrame.contentDocument;
      if (!doc) return; // no access = plugin document = PDF rendered natively
      const rendered = doc.body && (doc.body.querySelector('embed[type="application/pdf"], object[type="application/pdf"]') || doc.body.textContent.trim());
      if (!rendered) showPdfFallback();
    } catch {
      // Cross-origin/block = plugin viewer handled it.
    }
  }, 2200);
}

function showPdfFallback() {
  elements.pdfFrame.src = 'about:blank';
  elements.pdfFallback.hidden = false;
}

async function openReader(key, attachmentKey, fileName = '') {
  try {
    state.activeKey = key;
    state.activeAttachment = attachmentKey;
    state.view = 'reader';
    showView('reader');
    elements.backButton.hidden = false;
    elements.pdfFallback.hidden = true;
    let pdfUrl = `/api/items/${encodeURIComponent(key)}/files/${encodeURIComponent(attachmentKey)}#view=FitH`;
    if (state.token) pdfUrl = pdfUrl.replace('#', `?token=${encodeURIComponent(state.token)}#`);
    if (nativePdfViewerSupported()) {
      elements.pdfFrame.src = pdfUrl;
      detectIframePdfFailure();
    } else {
      // No native in-frame PDF rendering on this browser: show the escape
      // hatch immediately instead of a blank black pane.
      elements.pdfFrame.src = 'about:blank';
      showPdfFallback();
    }
    elements.detailTitle.textContent = fileName || 'PDF reader';
    elements.aiResult.innerHTML = '<span class="muted">Open a paper and run AI reading to extract its main argument.</span>';
    await restoreProgress(key);
    elements.summarizeButton.hidden = false;
    elements.extractTextButton.hidden = false;
    elements.askButton.hidden = false;
    elements.askInput.hidden = false;
    elements.openAnnotatorButton.hidden = false;
    elements.newTabButton.hidden = false;
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function restoreProgress(key) {
  try {
    const progress = await request(`/api/items/${encodeURIComponent(key)}/progress`);
    setTimeout(() => { try { elements.pdfFrame.contentWindow?.scrollTo(0, Number(progress.scrollPercent || 0)); } catch {} }, 700);
  } catch {}
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[character]);
}

function sanitizeZoteroNoteHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  for (const element of [...template.content.querySelectorAll('script,style,iframe,object,embed,form,input,button,link,meta')]) element.remove();
  for (const element of [...template.content.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attribute.value))) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return template.content;
}

// Defense in depth for citation preview HTML (citeproc escapes its input, but
// the lookup flow feeds third-party metadata through it): parse, drop
// disallowed tags/attributes, then re-serialize.
function sanitizeCslHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const allowedTags = new Set(['DIV','SPAN','P','I','EM','B','STRONG','SUP','SUB','A','UL','OL','LI','BR','SMALL','CODE']);
  for (const element of [...template.content.querySelectorAll('*')]) {
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const safeHref = name === 'href' && /^(https?:|mailto:)/i.test(attribute.value.trim());
      if (name.startsWith('on') || name === 'style' || name === 'class' || (name === 'href' && !safeHref)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return template.innerHTML;
}

function markdownToHtml(markdown) {
  return String(markdown)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>')
    .replace(/^\* (.*)$/gm,'<li>$1</li>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
}

async function summarize() {
  if (!state.activeKey) return;
  elements.summarizeButton.disabled = true;
  elements.aiResult.innerHTML = '<span class="muted">Analyzing paper…</span>';
  try {
    const summary = await request('/api/ai/summarize', { method:'POST', body: JSON.stringify({ itemKey: state.activeKey }) });
    elements.aiResult.innerHTML = summary.markdown
      ? markdownToHtml(summary.markdown)
      : `<h3>Summary</h3><p>${escapeHtml(summary.summary)}</p>
         <h3>Key points</h3><ul>${summary.keyPoints.map(point => `<li>${escapeHtml(point)}</li>`).join('')}</ul>
         <h3>Keywords</h3><p>${escapeHtml(summary.keywords.join(', '))}</p>
         <h3>Suggested questions</h3><ul>${summary.suggestedQuestions.map(question => `<li>${escapeHtml(question)}</li>`).join('')}</ul>`;
    if (summary.warning) showToast(summary.warning);
  } catch (error) {
    elements.aiResult.textContent = error.message;
  } finally { elements.summarizeButton.disabled = false; }
}

async function askQuestion() {
  const question = elements.askInput.value.trim();
  if (!state.activeKey || !question) return;
  elements.askButton.disabled = true;
  elements.aiResult.innerHTML = '<span class="muted">检索相关段落并作答…</span>';
  try {
    const result = await request('/api/ai/ask', { method: 'POST', body: JSON.stringify({ itemKey: state.activeKey, question }) });
    const passages = result.passages.map((passage, index) =>
      `<li>[${index + 1}] ${escapeHtml(passage.title || passage.itemKey)} · score ${passage.score}</li>`).join('');
    elements.aiResult.innerHTML = `
      <h3>Answer <span class="muted">(${escapeHtml(result.provider)})</span></h3>
      <p>${escapeHtml(result.answer).replace(/\[(\d+)\]/g, '<span class="muted">[$1]</span>')}</p>
      ${result.passages.length ? `<h3>Passages</h3><ul>${passages}</ul>` : ''}
      ${result.warning ? `<p class="muted">${escapeHtml(result.warning)}</p>` : ''}`;
  } catch (error) {
    elements.aiResult.textContent = error.message;
  } finally {
    elements.askButton.disabled = false;
  }
}

elements.askButton.addEventListener('click', askQuestion);
elements.askInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') askQuestion();
});

async function extractText() {
  if (!state.activeKey || !state.activeAttachment) return;
  elements.extractTextButton.disabled = true;
  try {
    const result = await request(`/api/items/${encodeURIComponent(state.activeKey)}/files/${encodeURIComponent(state.activeAttachment)}/text`);
    elements.aiResult.innerHTML = `<h3>Extracted text</h3><div class="muted">${result.text.length.toLocaleString()} characters</div><pre>${escapeHtml(result.text.slice(0, 30000))}</pre>`;
  } catch (error) {
    elements.aiResult.textContent = error.message;
  } finally { elements.extractTextButton.disabled = false; }
}

function renderSearch(data) {
  state.searchMode = Boolean(data.query);
  elements.searchResults.classList.toggle('active', state.searchMode);
  const modeLabel = { lexical: 'phrase', semantic: 'semantic', hybrid: 'hybrid' }[data.mode] || data.mode;
  elements.resultCount.textContent = `${data.results.length} results · ${modeLabel} search · indexed ${data.index.indexed} documents`;
  elements.resultList.innerHTML = '';
  for (const result of data.results) {
    const button = document.createElement('button');
    button.className = 'result';
    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = result.title;
    const snippet = document.createElement('div');
    snippet.className = 'result-snippet';
    snippet.innerHTML = result.snippet;
    button.append(title, snippet);
    button.addEventListener('click', () => openReader(result.itemKey, result.attachmentKey, result.title));
    elements.resultList.append(button);
  }
  if (!data.results.length) elements.resultList.innerHTML = '<div class="empty">No indexed PDF matches this phrase.</div>';
}

let searchRequestId = 0;
elements.searchInput.addEventListener('input', debounce(async () => {
  const value = elements.searchInput.value.trim();
  const currentRequestId = ++searchRequestId;
  if (!value) {
    state.searchMode = false;
    elements.searchResults.classList.remove('active');
    await loadItems();
    return;
  }
  const mode = elements.semanticToggle.checked ? 'hybrid' : 'lexical';
  try {
    const data = await request(`/api/search?q=${encodeURIComponent(value)}&mode=${mode}`);
    if (currentRequestId === searchRequestId) renderSearch(data); // drop stale responses
  }
  catch (error) { if (currentRequestId === searchRequestId) setStatus(error.message, true); }
}, 280));

document.getElementById('collectionSelect').addEventListener('change', loadItems);
elements.searchButton.addEventListener('click', async () => {
  elements.searchButton.disabled = true;
  try { await loadItems(); } catch (error) { setStatus(error.message, true); } finally { elements.searchButton.disabled = false; }
});
elements.reindexButton.addEventListener('click', async () => {
  elements.reindexButton.disabled = true;
  setStatus('Rebuilding full-text index…');
  try {
    const result = await request('/api/index/rebuild', { method: 'POST' });
    await loadItems();
    setStatus(`Indexed ${result.indexed} PDFs (${result.skipped} skipped)`);
  }
  catch (error) { setStatus(error.message, true); } finally { elements.reindexButton.disabled = false; }
});
elements.backButton.addEventListener('click', () => { state.view='detail'; showView('detail'); });
elements.closeSearch.addEventListener('click', () => { elements.searchInput.value=''; state.searchMode=false; elements.searchResults.classList.remove('active'); });
elements.summarizeButton.addEventListener('click', summarize);
elements.extractTextButton.addEventListener('click', extractText);
elements.lookupButton.addEventListener('click', runLookup);
elements.lookupInput.addEventListener('keydown', event => { if (event.key === 'Enter') runLookup(); });
elements.closeLookup.addEventListener('click', () => { state.view = 'detail'; showView('detail'); });

function openAnnotatorForCurrent() {
  if (!state.activeKey || !state.activeAttachment) return;
  window.open(annotatorUrl(state.activeKey, state.activeAttachment, elements.detailTitle.textContent), '_blank', 'noopener');
}

function openPdfInNewTab() {
  if (!state.activeKey || !state.activeAttachment) return;
  const base = `/api/items/${encodeURIComponent(state.activeKey)}/files/${encodeURIComponent(state.activeAttachment)}`;
  const url = state.token ? `${base}?token=${encodeURIComponent(state.token)}` : base;
  window.open(url, '_blank', 'noopener');
}

elements.openAnnotatorButton.addEventListener('click', openAnnotatorForCurrent);
elements.newTabButton.addEventListener('click', openPdfInNewTab);
elements.fallbackAnnotatorButton.addEventListener('click', openAnnotatorForCurrent);
elements.fallbackNewTabButton.addEventListener('click', openPdfInNewTab);
if (elements.logoutButton) {
  elements.logoutButton.hidden = !state.token;
  elements.logoutButton.addEventListener('click', logout);
}

// ---------------------------------------------------------------------------
// Metadata lookup by identifier (DOI / arXiv / ISBN / BibTeX)
// ---------------------------------------------------------------------------
let citationStylesCache = null;
function citationStyles() {
  if (!citationStylesCache) citationStylesCache = request('/api/citations/styles').catch(() => null);
  return citationStylesCache;
}

async function runLookup() {
  const input = elements.lookupInput.value.trim();
  if (!input) { showToast('Paste a DOI, arXiv ID, ISBN or BibTeX first.'); return; }
  elements.lookupButton.disabled = true;
  elements.lookupBody.innerHTML = '<p class="muted">Resolving identifier…</p>';
  state.view = 'lookup';
  showView('lookup');
  elements.detailTitle.textContent = 'Metadata lookup';
  try {
    const result = await request('/api/metadata/resolve', { method: 'POST', body: JSON.stringify({ input }) });
    renderLookupResult(result);
  } catch (error) {
    elements.lookupBody.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  } finally {
    elements.lookupButton.disabled = false;
  }
}

function renderLookupResult(result) {
  const item = result.item;
  const body = document.createElement('div');
  body.className = 'detail-card';
  const source = document.createElement('p');
  source.className = 'muted';
  source.textContent = `Source: ${result.source}${result.identifier ? ` · ${result.identifierType}: ${result.identifier}` : ''}`;
  const title = document.createElement('h2');
  title.textContent = item.title || '(untitled)';
  const authors = document.createElement('p');
  authors.className = 'authors';
  authors.textContent = item.creators.map(person =>
    [person.firstName, person.lastName].filter(Boolean).join(' ') || person.name).join(', ') || 'No authors listed';
  const grid = document.createElement('div');
  grid.className = 'meta-grid';
  const fieldLabels = [
    ['Type', item.itemType], ['Publication', item.fields.publicationTitle], ['Publisher', item.fields.publisher],
    ['Date', item.fields.date], ['Volume', item.fields.volume], ['Issue', item.fields.issue],
    ['Pages', item.fields.pages], ['DOI', item.fields.DOI], ['URL', item.fields.url],
    ['ISSN', item.fields.ISSN], ['ISBN', item.fields.ISBN], ['Language', item.fields.language]
  ];
  for (const [label, value] of fieldLabels) if (value) grid.append(metaCard(label, value));
  body.append(source, title, authors, grid);

  const records = result.cslRecords && result.cslRecords.length > 1 ? result.cslRecords : [result.csl];
  if (records.length > 1) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = `${records.length} BibTeX entries parsed — showing the first below; the citation panel formats all of them.`;
    body.append(note);
  }
  if (item.fields.abstractNote) {
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = '<h3>Abstract</h3>';
    const text = document.createElement('p');
    text.textContent = item.fields.abstractNote.slice(0, 4000);
    panel.append(text);
    body.append(panel);
  }
  body.append(buildCitationPanel({ cslItems: records }));
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = 'This library is a read-only companion to desktop Zotero — resolved metadata is shown here for reference and citation.';
  body.append(hint);
  elements.lookupBody.innerHTML = '';
  elements.lookupBody.append(body);
}

// ---------------------------------------------------------------------------
// Shared CSL citation preview panel (used by item detail and lookup)
// ---------------------------------------------------------------------------
function buildCitationPanel({ itemKey = null, cslItems = null }) {
  const panel = document.createElement('section');
  panel.className = 'panel citation-panel';
  panel.innerHTML = '<h3>Citation preview</h3>';
  const controls = document.createElement('div');
  controls.className = 'citation-controls';
  const styleSelect = document.createElement('select');
  styleSelect.className = 'citation-style';
  const langSelect = document.createElement('select');
  langSelect.className = 'citation-lang';
  for (const [value, label] of [['en-US', 'English (en-US)'], ['zh-CN', '中文 (zh-CN)']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    langSelect.append(option);
  }
  const modeSelect = document.createElement('select');
  modeSelect.className = 'citation-mode';
  for (const [value, label] of [['bibliography', 'Bibliography'], ['in-text', 'In-text']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    modeSelect.append(option);
  }
  const copyButton = document.createElement('button');
  copyButton.className = 'ghost';
  copyButton.textContent = 'Copy';
  controls.append(styleSelect, langSelect, modeSelect, copyButton);
  const preview = document.createElement('div');
  preview.className = 'csl-preview';
  preview.innerHTML = '<span class="muted">Loading styles…</span>';
  const warning = document.createElement('p');
  warning.className = 'muted citation-warning';
  warning.hidden = true;
  panel.append(controls, preview, warning);

  let lastPlain = '';
  let requestId = 0;
  async function refresh() {
    const payload = {
      style: styleSelect.value || 'apa',
      lang: langSelect.value,
      mode: modeSelect.value
    };
    if (itemKey) payload.itemKey = itemKey;
    else payload.items = cslItems;
    const currentRequestId = ++requestId;
    try {
      const result = await request('/api/citations/format', { method: 'POST', body: JSON.stringify(payload) });
      if (currentRequestId !== requestId) return; // a newer request superseded this one
      preview.innerHTML = sanitizeCslHtml(result.entries.map(entry => entry.html).join(''));
      lastPlain = result.entries.map(entry => entry.html.replace(/<[^>]+>/g, '')).join('\n\n');
      warning.textContent = result.warning || (result.engine === 'fallback' ? 'Using the simplified fallback formatter.' : '');
      warning.hidden = !warning.textContent;
    } catch (error) {
      if (currentRequestId !== requestId) return;
      preview.innerHTML = `<span class="muted">${escapeHtml(error.message)}</span>`;
      lastPlain = '';
    }
  }

  copyButton.addEventListener('click', async () => {
    if (!lastPlain) { showToast('Nothing to copy yet.'); return; }
    try {
      await navigator.clipboard.writeText(lastPlain);
      showToast('Citation copied');
    } catch {
      const helper = document.createElement('textarea');
      helper.value = lastPlain;
      document.body.append(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
      showToast('Citation copied');
    }
  });

  citationStyles().then(styles => {
    if (!styles || !styles.styles.length) {
      styleSelect.innerHTML = '<option value="apa">APA</option>';
    } else {
      styleSelect.innerHTML = '';
      for (const style of styles.styles) {
        const option = document.createElement('option');
        option.value = style.id;
        option.textContent = style.title;
        if (style.id === 'apa') option.selected = true;
        styleSelect.append(option);
      }
    }
    refresh();
  });
  for (const control of [styleSelect, langSelect, modeSelect]) control.addEventListener('change', refresh);
  return panel;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts: "/" focuses search, Esc backs out of overlays,
// ArrowUp/ArrowDown walk the library list.
// ---------------------------------------------------------------------------
document.addEventListener('keydown', event => {
  const typing = event.target instanceof Element
    && event.target.matches('input, textarea, select');
  if (event.key === 'Escape') {
    if (elements.searchResults.classList.contains('active')) {
      elements.closeSearch.click();
    } else if (state.view === 'reader') {
      elements.backButton.click();
    } else if (typing) {
      event.target.blur();
    }
    return;
  }
  if (typing) return;
  if (event.key === '/') {
    event.preventDefault();
    elements.searchInput.focus();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (!state.items.length) return;
  event.preventDefault();
  const currentIndex = state.items.findIndex(item => item.key === state.activeKey);
  const nextIndex = event.key === 'ArrowDown'
    ? Math.min(state.items.length - 1, currentIndex + 1)
    : Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1);
  const target = state.items[nextIndex];
  if (target && target.key !== state.activeKey) {
    openItem(target.key);
    elements.library.querySelector(`[data-key="${target.key}"]`)?.scrollIntoView({ block: 'nearest' });
  }
});

(async function init() {
  try {
    await Promise.all([loadCollections(), loadItems()]);
    renderCollections();
    const index = await request('/api/search?q=');
    setStatus(`Ready · ${state.total} library items · index ${index.index.indexed}`);
  } catch (error) {
    setStatus(error.message, true);
  }
})();

function zoteroCount() { return state.items.length; }
