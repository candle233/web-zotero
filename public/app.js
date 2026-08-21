'use strict';

const state = {
  token: localStorage.getItem('web-zotero-token') || '',
  items: [],
  collections: [],
  activeKey: null,
  activeAttachment: '',
  view: 'detail',
  searchMode: false
};

const elements = {};
['searchInput','searchButton','reindexButton','status','library','detailTitle','detailBody','readerView','pdfFrame','aiResult','summarizeButton','extractTextButton','searchResults','resultCount','resultList','toast','backButton','closeSearch']
  .forEach(id => { elements[id] = document.getElementById(id); });

function authHeaders(extra = {}) {
  return state.token ? { authorization: `Bearer ${state.token}`, ...extra } : extra;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.auth) {
    const password = prompt('Enter the remote access password:') || '';
    await fetch('/api/auth', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({password}) }).then(async result => {
      if (!result.ok) throw new Error('Invalid password');
      state.token = password;
      localStorage.setItem('web-zotero-token', password);
    });
    return request(path, options);
  }
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
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

async function loadItems() {
  const query = encodeURIComponent(elements.searchInput.value.trim());
  const collection = document.getElementById('collectionSelect').value;
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (collection) params.set('collection', collection);
  const data = await request(`/api/items?${params}`);
  state.items = data.items;
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
    actionButton('CSV metadata', () => exportItem(item, 'csv')),
    actionButton('JSON metadata', () => exportItem(item, 'json'))
  );
  card.append(exportPanel);

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
  notePanel.append(noteArea, saveNote, noteStatus);
  request(`/api/items/${item.key}/notes`).then(note => {
    noteArea.value = note.content || '';
    if (note.updatedAt) noteStatus.textContent = `Saved ${new Date(note.updatedAt).toLocaleString()}`;
  }).catch(error => setStatus(error.message, true));
  card.append(notePanel);

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
      const button = document.createElement('button');
      button.className = 'ghost';
      button.style.marginBottom = '7px';
      button.textContent = file.fileName;
      button.addEventListener('click', () => openReader(item.key, file.key, file.fileName));
      panel.append(button);
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
  }
}

async function openReader(key, attachmentKey, fileName = '') {
  try {
    state.activeKey = key;
    state.activeAttachment = attachmentKey;
    state.view = 'reader';
    showView('reader');
    elements.backButton.hidden = false;
    elements.pdfFrame.src = `/api/items/${encodeURIComponent(key)}/files/${encodeURIComponent(attachmentKey)}#view=FitH`;
    elements.detailTitle.textContent = fileName || 'PDF reader';
    elements.aiResult.innerHTML = '<span class="muted">Open a paper and run AI reading to extract its main argument.</span>';
    await restoreProgress(key);
    elements.summarizeButton.hidden = false;
    elements.extractTextButton.hidden = false;
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
  elements.resultCount.textContent = `${data.results.length} results · indexed ${data.index.indexed} documents`;
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

elements.searchInput.addEventListener('input', debounce(async () => {
  const value = elements.searchInput.value.trim();
  if (!value) {
    state.searchMode = false;
    elements.searchResults.classList.remove('active');
    await loadItems();
    return;
  }
  try { renderSearch(await request(`/api/search?q=${encodeURIComponent(value)}`)); }
  catch (error) { setStatus(error.message, true); }
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

(async function init() {
  try {
    await Promise.all([loadCollections(), loadItems()]);
    renderCollections();
    await loadItems();
    const index = await request('/api/search?q=');
    setStatus(`Ready · ${zoteroCount()} library items · index ${index.index.indexed}`);
  } catch (error) {
    setStatus(error.message, true);
  }
})();

function zoteroCount() { return state.items.length; }
