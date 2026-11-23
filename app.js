/* My Books: a personal EPUB and PDF reader with Google Drive cloud storage.
   - Books live in your Google Drive folder "My Books" (or only on this device if you are not signed in).
   - Reading progress, highlights, notes, bookmarks and PDF markup sync through your Drive (hidden app-data area).
   - Opened books are kept on the device so they can be read offline. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const CFG = window.APP_CONFIG || {};
  const FOLDER_NAME = CFG.FOLDER_NAME || 'My Books';
  const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

  const SCOPES = [
    'https://www.googleapis.com/auth/drive.readonly', // see books you put in the folder from any device
    'https://www.googleapis.com/auth/drive.file',     // create the folder and upload books from this app
    'https://www.googleapis.com/auth/drive.appdata',  // hidden app area for progress, highlights, bookmarks
  ].join(' ');
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const COLORS = { yellow: '#fde047', green: '#86efac', blue: '#93c5fd', pink: '#f9a8d4', orange: '#fdba74' };
  const COLOR_NAMES = Object.keys(COLORS);

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mimeFor = (type) => (type === 'pdf' ? 'application/pdf' : 'application/epub+zip');
  const safeName = (s) => String(s || 'book').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---------- small preferences kept on this device ----------
  const PREF_KEY = 'mybooks-prefs';
  const PREF_DEFAULTS = { fontSize: 100, font: "Georgia, 'Times New Roman', serif", lineHeight: '1.5', theme: 'auto', color: 'yellow' };
  let prefs = { ...PREF_DEFAULTS };
  try { prefs = { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch (_) { /* use defaults */ }
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ } }

  // ---------- local storage (IndexedDB) ----------
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('my-books', 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('progress')) d.createObjectStore('progress', { keyPath: 'bookId' });
          if (!d.objectStoreNames.contains('notes')) {
            const notes = d.createObjectStore('notes', { keyPath: 'id' });
            notes.createIndex('bookId', 'bookId');
          }
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function run(store, mode, fn) {
    return openDb().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const db = {
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    all: (store) => run(store, 'readonly', (s) => s.getAll()),
    byBook: (store, bookId) => run(store, 'readonly', (s) => s.index('bookId').getAll(bookId)),
    put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
    del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  };

  async function getDeleted(bookId) {
    const m = await db.get('meta', `del:${bookId}`);
    return (m && m.value) || [];
  }
  async function markDeleted(bookId, noteId) {
    const list = new Set(await getDeleted(bookId));
    list.add(noteId);
    await db.put('meta', { key: `del:${bookId}`, value: [...list] });
  }

  async function deleteBookCompletely(id) {
    const notes = await db.byBook('notes', id);
    for (const n of notes) await db.del('notes', n.id);
    await db.del('progress', id);
    await db.del('books', id);
  }

  // ---------- small UI helpers ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === name));
  }
  function setProgress(pct) {
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    $('#progress-fill').style.width = `${p}%`;
    $('#progress-text').textContent = `${p}%`;
  }
  function showLoading(text) {
    $('#loading-text').textContent = text;
    $('#loading').hidden = false;
  }
  function hideLoading() { $('#loading').hidden = true; }
  function showError(err) {
    console.error(err);
    alert(`Something went wrong: ${err && err.message ? err.message : err}`);
  }

  let toastTimer = null;
  function toast(text, actionLabel, onAction) {
    clearTimeout(toastTimer);
    $('#toast-text').textContent = text;
    const btn = $('#toast-action');
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || '';
    btn.onclick = actionLabel ? () => { $('#toast').hidden = true; onAction(); } : null;
    $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, actionLabel ? 7000 : 3500);
  }

  // ---------- Google sign-in and Drive ----------
  const cloud = {
    token: null,
    expires: 0,
    email: '',
    folderId: null,
    client: null,
    get enabled() { return !!CFG.GOOGLE_CLIENT_ID; },
    get signedIn() { return !!this.token && Date.now() < this.expires - 30000; },
  };

  function restoreToken() {
    try {
      const s = JSON.parse(localStorage.getItem('mybooks-google') || 'null');
      if (s && s.t && s.e > Date.now() + 60000) {
        cloud.token = s.t;
        cloud.expires = s.e;
        cloud.email = s.email || '';
      }
    } catch (_) { /* ignore */ }
  }
  function saveToken() {
    try {
      localStorage.setItem('mybooks-google', JSON.stringify({ t: cloud.token, e: cloud.expires, email: cloud.email }));
    } catch (_) { /* ignore */ }
  }
  function clearToken() {
    cloud.token = null; cloud.expires = 0; cloud.email = ''; cloud.folderId = null;
    try { localStorage.removeItem('mybooks-google'); } catch (_) { /* ignore */ }
  }

  function updateCloudUi(message) {
    const status = $('#cloud-status');
    const inBtn = $('#signin-btn');
    const outBtn = $('#signout-btn');
    const sync = $('#sync-btn');
    if (!cloud.enabled) {
      status.textContent = 'Cloud sync is not set up yet. Books are saved on this device only.';
      inBtn.hidden = true; outBtn.hidden = true; sync.hidden = true;
      $('#storage-note').textContent = 'Books and notes are stored in this browser on this device.';
      return;
    }
    if (cloud.signedIn) {
      status.textContent = message || `Cloud on · ${cloud.email || 'signed in'} · books are in Google Drive › ${FOLDER_NAME}`;
      inBtn.hidden = true; outBtn.hidden = false; sync.hidden = false;
      $('#storage-note').textContent = 'Books sit in your Google Drive. Opened books are also kept on this device for offline reading.';
    } else {
      status.textContent = message || 'Sign in with Google to see your cloud library on any device.';
      inBtn.hidden = false; outBtn.hidden = true; sync.hidden = true;
      $('#storage-note').textContent = 'Not signed in: books you add are saved on this device only.';
    }
  }

  function initAuth() {
    if (!cloud.enabled || !(window.google && google.accounts && google.accounts.oauth2)) return false;
    cloud.client = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: onToken,
      error_callback: (e) => updateCloudUi(`Sign-in did not finish (${(e && (e.type || e.message)) || 'cancelled'}).`),
    });
    return true;
  }

  async function onToken(resp) {
    if (!resp || resp.error) {
      updateCloudUi(`Sign-in failed: ${resp && resp.error ? resp.error : 'unknown error'}`);
      return;
    }
    cloud.token = resp.access_token;
    cloud.expires = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
    try {
      const me = await (await gapi(`${API}/about?fields=user(emailAddress)`)).json();
      cloud.email = (me.user && me.user.emailAddress) || '';
    } catch (_) { /* email is only for display */ }
    saveToken();
    updateCloudUi();
    await refreshFromDrive();
  }

  async function gapi(url, opts = {}) {
    if (!cloud.token) throw new Error('Not signed in to Google.');
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${cloud.token}` } });
    if (res.status === 401) {
      clearToken();
      updateCloudUi('Your Google session ended. Tap Sign in to continue.');
      throw new Error('Your Google session ended. Please sign in again.');
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Drive error ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  }

  async function ensureFolder() {
    if (cloud.folderId) return cloud.folderId;
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await (await gapi(`${API}/files?q=${q}&fields=files(id,name)&pageSize=10`)).json();
    if (found.files && found.files.length) {
      cloud.folderId = found.files[0].id;
    } else {
      const created = await (await gapi(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      })).json();
      cloud.folderId = created.id;
    }
    return cloud.folderId;
  }

  async function listDriveBooks() {
    const folder = await ensureFolder();
    let files = [];
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${folder}' in parents and trashed=false and (mimeType='application/pdf' or mimeType='application/epub+zip' or name contains '.epub' or name contains '.pdf')`);
      const url = `${API}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await (await gapi(url)).json();
      files = files.concat(r.files || []);
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  async function uploadToDrive(blob, name, mime) {
    const folder = await ensureFolder();
    const init = await gapi(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify({ name, parents: [folder] }),
    });
    const location = init.headers.get('Location');
    if (!location) throw new Error('Google Drive did not return an upload address.');
    const put = await fetch(location, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob });
    if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
    return (await put.json()).id;
  }

  async function multipartCreate(meta, jsonBody) {
    const boundary = `bnd${Math.random().toString(36).slice(2)}`;
    const body = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonBody}\r\n`,
      `--${boundary}--`,
    ].join('');
    return (await gapi(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })).json();
  }

  // Sync the list of books in the Drive folder into the local library.
  async function syncLibrary() {
    const files = await listDriveBooks();
    const local = await db.all('books');
    const byDrive = new Map(local.filter((b) => b.driveId).map((b) => [b.driveId, b]));
    const present = new Set(files.map((f) => f.id));

    for (const f of files) {
      if (byDrive.has(f.id)) continue;
      const isPdf = f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name);
      await db.put('books', {
        id: f.id,
        driveId: f.id,
        type: isPdf ? 'pdf' : 'epub',
        title: f.name.replace(/\.(epub|pdf)$/i, ''),
        author: '',
        cover: null,
        file: null,
        size: Number(f.size) || 0,
        addedAt: Date.parse(f.modifiedTime) || Date.now(),
      });
    }
    // Books removed from Drive: forget the entry unless a copy is stored on this device.
    for (const b of local) {
      if (b.driveId && !present.has(b.driveId) && !b.file) await deleteBookCompletely(b.id);
    }
  }

  async function refreshFromDrive() {
    if (!cloud.signedIn) { await renderLibrary(); return; }
    try {
      showLoading('Syncing your Drive library…');
      await syncLibrary();
    } catch (err) {
      showError(err);
    } finally {
      hideLoading();
      await renderLibrary();
    }
  }

  // ---------- per-book state in Drive (progress, highlights, bookmarks, markup) ----------
  const stateFileIds = new Map();

  async function findStateFile(bookId) {
    if (stateFileIds.has(bookId)) return stateFileIds.get(bookId);
    const q = encodeURIComponent(`name='state-${bookId}.json' and 'appDataFolder' in parents and trashed=false`);
    const r = await (await gapi(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id)&pageSize=1`)).json();
    const id = r.files && r.files[0] ? r.files[0].id : null;
    if (id) stateFileIds.set(bookId, id);
    return id;
  }

  async function pullRemoteState(bookId) {
    const id = await findStateFile(bookId);
    if (!id) return null;
    return (await gapi(`${API}/files/${id}?alt=media`)).json();
  }

  async function pushLocalState(bookId) {
    if (!cloud.signedIn) return;
    const prog = (await db.get('progress', bookId)) || {};
    const notes = await db.byBook('notes', bookId);
    const deleted = await getDeleted(bookId);
    const json = JSON.stringify({
      pct: prog.pct || 0, cfi: prog.cfi || null, page: prog.page || null,
      progressUpdated: prog.updated || 0, notes, deleted,
    });
    const id = await findStateFile(bookId);
    if (id) {
      await gapi(`${UPLOAD}/files/${id}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json,
      });
    } else {
      const created = await multipartCreate({ name: `state-${bookId}.json`, parents: ['appDataFolder'] }, json);
      stateFileIds.set(bookId, created.id);
    }
  }

  async function mergeRemoteState(bookId, remote) {
    if (!remote) return;
    const prog = (await db.get('progress', bookId)) || { bookId };
    if ((remote.progressUpdated || 0) > (prog.updated || 0)) {
      prog.pct = remote.pct; prog.cfi = remote.cfi; prog.page = remote.page; prog.updated = remote.progressUpdated;
      await db.put('progress', prog);
    }
    const del = new Set([...(remote.deleted || []), ...(await getDeleted(bookId))]);
    await db.put('meta', { key: `del:${bookId}`, value: [...del] });
    const local = await db.byBook('notes', bookId);
    for (const n of local) if (del.has(n.id)) await db.del('notes', n.id);
    for (const n of [...(remote.notes || []), ...local]) {
      if (!del.has(n.id)) await db.put('notes', { ...n, bookId });
    }
  }

  const pushTimers = new Map();
  function schedulePush(bookId) {
    if (!cloud.signedIn || !bookId) return;
    clearTimeout(pushTimers.get(bookId));
    pushTimers.set(bookId, setTimeout(() => {
      pushTimers.delete(bookId);
      pushLocalState(bookId).catch((e) => console.warn('Sync of reading state failed', e));
    }, 3000));
  }
  async function flushPush(bookId) {
    if (!pushTimers.has(bookId)) return;
    clearTimeout(pushTimers.get(bookId));
    pushTimers.delete(bookId);
    try { await pushLocalState(bookId); } catch (e) { console.warn('Sync of reading state failed', e); }
  }
  function syncSoon() { if (current && current.rec.driveId) schedulePush(current.id); }

  // ---------- reading local files: titles, authors, covers ----------
  async function epubMeta(buf) {
    const book = ePub(buf.slice(0));
    await book.ready;
    const md = book.packaging.metadata || {};
    let cover = null;
    try {
      const url = await book.coverUrl();
      if (url) cover = await (await fetch(url)).blob();
    } catch (_) { /* no cover is fine */ }
    book.destroy();
    return { title: md.title || '', author: md.creator || '', cover };
  }

  async function pdfMeta(buf) {
    const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    const info = (await doc.getMetadata()).info || {};
    let cover = null;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 300 / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      cover = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    } catch (_) { /* no cover is fine */ }
    doc.destroy();
    return { title: info.Title || '', author: info.Author || '', cover };
  }

  // ---------- library ----------
  async function renderLibrary() {
    const [books, progress] = await Promise.all([db.all('books'), db.all('progress')]);
    books.sort((a, b) => b.addedAt - a.addedAt);
    const prog = Object.fromEntries(progress.map((p) => [p.bookId, p]));
    $('#empty-msg').hidden = books.length > 0;

    const shelf = $('#shelf');
    shelf.textContent = '';
    for (const b of books) {
      const pct = Math.round((prog[b.id] && prog[b.id].pct) || 0);
      const li = h('li', 'book');

      const cover = h('div', 'cover');
      if (b.cover) {
        const img = new Image();
        img.alt = '';
        img.src = URL.createObjectURL(b.cover);
        cover.appendChild(img);
      } else {
        cover.textContent = b.title || (b.type === 'pdf' ? 'PDF' : 'EPUB');
      }

      const meta = h('div', 'book-meta');
      const title = h('div', 'book-title', b.title);
      const chip = h('span', 'chip');
      if (b.driveId && b.file) { chip.textContent = '☁ Saved offline'; chip.classList.add('ok'); }
      else if (b.driveId) { chip.textContent = '☁ In Drive'; }
      else { chip.textContent = 'This device only'; }
      const pctEl = h('div', 'book-pct', `${pct}% read`);
      const bar = h('div', 'bar');
      const fill = document.createElement('div');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);

      const actions = h('div', 'book-actions');
      if (!b.driveId && cloud.signedIn) {
        const up = h('button', 'up', 'Upload to Drive');
        up.addEventListener('click', async (e) => {
          e.stopPropagation();
          try { await uploadLocalBook(b); } catch (err) { showError(err); }
          renderLibrary();
        });
        actions.appendChild(up);
      }
      if (!b.driveId) {
        const del = h('button', '', 'Remove');
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`Remove "${b.title}" and its notes from this device? It is not in Google Drive, so this cannot be undone.`)) {
            await deleteBookCompletely(b.id);
            renderLibrary();
          }
        });
        actions.appendChild(del);
      } else if (b.file) {
        const rm = h('button', '', 'Free up space');
        rm.addEventListener('click', async (e) => {
          e.stopPropagation();
          await db.put('books', { ...b, file: null });
          renderLibrary();
        });
        actions.appendChild(rm);
      }

      meta.append(title, chip, pctEl, bar, actions);
      li.append(cover, meta);
      li.addEventListener('click', () => openBook(b.id).catch(showError));
      shelf.appendChild(li);
    }
  }

  // ---------- adding books ----------
  async function uploadLocalBook(rec) {
    showLoading(`Uploading "${rec.title}" to Google Drive…`);
    try {
      const ext = rec.type === 'pdf' ? '.pdf' : '.epub';
      const name = rec.origName || `${safeName(rec.title)}${ext}`;
      const driveId = await uploadToDrive(rec.file, name, mimeFor(rec.type));
      const oldId = rec.id;
      const prog = await db.get('progress', oldId);
      const notes = await db.byBook('notes', oldId);
      await db.put('books', { ...rec, id: driveId, driveId });
      if (prog) await db.put('progress', { ...prog, bookId: driveId });
      for (const n of notes) await db.put('notes', { ...n, bookId: driveId });
      await db.del('progress', oldId);
      await db.del('books', oldId);
      await pushLocalState(driveId).catch(() => {});
    } finally {
      hideLoading();
    }
  }

  async function addBook(file) {
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    const buf = await file.arrayBuffer();
    const meta = isPdf ? await pdfMeta(buf) : await epubMeta(buf);
    const rec = {
      id: uid(),
      type: isPdf ? 'pdf' : 'epub',
      title: meta.title || file.name.replace(/\.(epub|pdf)$/i, ''),
      author: meta.author,
      cover: meta.cover,
      file: new Blob([buf], { type: mimeFor(isPdf ? 'pdf' : 'epub') }),
      origName: file.name,
      addedAt: Date.now(),
    };
    await db.put('books', rec);
    if (cloud.signedIn) {
      try {
        await uploadLocalBook(rec);
      } catch (err) {
        alert(`"${rec.title}" was saved on this device, but the upload to Google Drive failed: ${err.message}`);
      }
    }
  }

  $('#file-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      try {
        await addBook(f);
      } catch (err) {
        alert(`Could not add "${f.name}": ${err.message || err}`);
      }
    }
    renderLibrary();
  });

  // ---------- reader state ----------
  let current = null;       // { id, type, rec, pct }
  let pendingSelection = null;
  let epubBook = null;
  let rendition = null;
  let epubNotes = new Map(); // id -> highlight note
  let pdfDoc = null;
  let pdfObserver = null;
  let pdfPageEls = [];
  let pdfScale = 1;
  let pdfRendered = new Set();
  let currentPdfPage = 1;
  let pdfTool = 'select';
  let markColor = COLORS[prefs.color] ? prefs.color : 'yellow';
  const annByPage = new Map(); // page -> [pdf-mark | pdf-ink notes]
  let undoStack = [];

  async function saveProgress(patch) {
    if (!current) return;
    const cur = (await db.get('progress', current.id)) || { bookId: current.id };
    Object.assign(cur, patch, { updated: Date.now() });
    await db.put('progress', cur);
    syncSoon();
  }

  async function downloadBook(rec) {
    if (!cloud.signedIn) throw new Error('This book is in Google Drive. Sign in (and go online) to open it the first time.');
    showLoading(`Downloading "${rec.title}" from Google Drive…`);
    try {
      const blob = await (await gapi(`${API}/files/${rec.driveId}?alt=media`)).blob();
      const buf = await blob.arrayBuffer();
      let meta = { title: '', author: '', cover: null };
      try { meta = rec.type === 'pdf' ? await pdfMeta(buf) : await epubMeta(buf); } catch (_) { /* keep file name as title */ }
      const updated = {
        ...rec,
        file: new Blob([buf], { type: mimeFor(rec.type) }),
        title: meta.title || rec.title,
        author: meta.author || rec.author,
        cover: meta.cover || rec.cover,
      };
      await db.put('books', updated);
      return updated;
    } finally {
      hideLoading();
    }
  }

  async function openBook(id) {
    let rec = await db.get('books', id);
    if (!rec) return;
    if (!rec.file) rec = await downloadBook(rec);

    if (rec.driveId && cloud.signedIn) {
      try { await mergeRemoteState(rec.id, await pullRemoteState(rec.id)); } catch (e) { console.warn('Could not fetch synced notes', e); }
    }
    const prog = (await db.get('progress', id)) || {};
    cleanupReader();
    current = { id, type: rec.type, rec, pct: prog.pct || 0 };
    $('#reader-title').textContent = rec.title;
    setProgress(current.pct);
    showView('reader');
    $('#aa-btn').hidden = rec.type !== 'epub';
    $('#pdf-tools').hidden = rec.type !== 'pdf';
    if (rec.type === 'epub') await openEpub(rec, prog);
    else await openPdf(rec, prog);
  }

  function cleanupReader() {
    if (epubBook) { try { epubBook.destroy(); } catch (_) { /* ignore */ } }
    epubBook = null;
    rendition = null;
    epubNotes = new Map();
    $('#epub-view').textContent = '';
    if (pdfObserver) pdfObserver.disconnect();
    pdfObserver = null;
    if (pdfDoc) { try { pdfDoc.destroy(); } catch (_) { /* ignore */ } }
    pdfDoc = null;
    pdfPageEls = [];
    pdfRendered = new Set();
    annByPage.clear();
    undoStack = [];
    $('#pdf-pages').textContent = '';
    $('#pdf-view').removeEventListener('scroll', onPdfScroll);
    hideMenu();
    pendingSelection = null;
    $('#pdf-tools').hidden = true;
    $('#aa-btn').hidden = true;
    current = null;
  }

  // ---------- selection menu (highlight colours, note, dictionary, Gemini) ----------
  function hideMenu() { $('#hl-menu').hidden = true; }

  function showMenu({ colors, activeColor, onColor, actions }) {
    const m = $('#hl-menu');
    m.textContent = '';
    if (colors) {
      const row = h('div', 'hl-colors');
      for (const name of COLOR_NAMES) {
        const b = h('button', 'dot');
        b.style.background = COLORS[name];
        b.setAttribute('aria-label', `${name} highlight`);
        if (name === activeColor) b.classList.add('on');
        b.addEventListener('click', () => onColor(name));
        row.appendChild(b);
      }
      m.appendChild(row);
    }
    const row2 = h('div', 'hl-actions');
    for (const a of actions) {
      const b = h('button', `btn${a.danger ? ' danger' : ''}`, a.label);
      b.addEventListener('click', a.fn);
      row2.appendChild(b);
    }
    m.appendChild(row2);
    m.hidden = false;
  }

  function selectedText() {
    return (pendingSelection && pendingSelection.text) || '';
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    return Promise.resolve(false);
  }

  function askGemini(text) {
    const title = current ? current.rec.title : 'a book';
    const prompt = `I am reading "${title}". Please explain this passage in simple words, then go deeper: the meaning, the context, and a real-life example.\n\n"${text}"`;
    // Open Gemini straight away (must happen inside the tap), and put the question on the clipboard.
    window.open('https://gemini.google.com/app', '_blank', 'noopener');
    copyText(prompt).then((ok) => {
      if (ok) toast('Question copied. Paste it into Gemini.');
      else window.prompt('Copy this and paste it into Gemini:', prompt);
    });
  }

  // ---------- dictionary ----------
  const dictBody = () => $('#dict-body');

  async function openDictionary(text) {
    const words = [...new Set((text.match(/[\p{L}'’-]+/gu) || []).map((w) => w.replace(/^['’-]+|['’-]+$/g, '').toLowerCase()).filter(Boolean))];
    $('#dict-panel').hidden = false;
    if (!words.length) {
      $('#dict-title').textContent = 'Dictionary';
      dictBody().textContent = 'Select a word to look it up.';
      return;
    }
    if (words.length === 1) { await lookupWord(words[0]); return; }
    $('#dict-title').textContent = 'Dictionary';
    dictBody().textContent = '';
    dictBody().appendChild(h('p', '', 'You selected a phrase. Pick a word to look up, or use Gemini for the whole phrase.'));
    const chips = h('div', 'chips');
    for (const w of words.slice(0, 12)) {
      const b = h('button', 'btn', w);
      b.addEventListener('click', () => lookupWord(w));
      chips.appendChild(b);
    }
    dictBody().appendChild(chips);
  }

  async function lookupWord(word) {
    $('#dict-title').textContent = word;
    const body = dictBody();
    body.textContent = 'Looking it up…';
    const googleLink = () => {
      const p = h('p');
      const a = h('a', '', 'Search this word on Google');
      a.href = `https://www.google.com/search?q=${encodeURIComponent(`define ${word}`)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      p.appendChild(a);
      return p;
    };
    try {
      // Wiktionary's free definition service (works from the browser, no key needed).
      const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`);
      if (res.status === 404) {
        body.textContent = '';
        body.appendChild(h('p', '', 'No definition found for this word.'));
        body.appendChild(googleLink());
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const plain = (html) => new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.trim();
      const entries = (data.en || []).slice(0, 5);
      body.textContent = '';
      if (!entries.length) {
        body.appendChild(h('p', '', 'No English definition found for this word.'));
        body.appendChild(googleLink());
        return;
      }
      for (const entry of entries) {
        body.appendChild(h('h3', '', entry.partOfSpeech || ''));
        const ol = document.createElement('ol');
        for (const d of (entry.definitions || []).slice(0, 4)) {
          const text = plain(d.definition);
          if (!text) continue;
          const li = h('li', '', text);
          const ex = (d.examples || [])[0];
          if (ex) li.appendChild(h('div', 'ex', `“${plain(ex)}”`));
          ol.appendChild(li);
        }
        body.appendChild(ol);
      }
      body.appendChild(googleLink());
    } catch (err) {
      body.textContent = '';
      body.appendChild(h('p', '', 'Could not reach the dictionary. Check your internet connection.'));
      body.appendChild(googleLink());
    }
  }
  $('#dict-close').addEventListener('click', () => { $('#dict-panel').hidden = true; });
  $('#dict-panel').addEventListener('click', (e) => { if (e.target.id === 'dict-panel') $('#dict-panel').hidden = true; });

  // ---------- removing and restoring notes, highlights and markup ----------
  async function unmarkDeleted(bookId, noteId) {
    const list = (await getDeleted(bookId)).filter((x) => x !== noteId);
    await db.put('meta', { key: `del:${bookId}`, value: list });
  }

  async function removeNote(n, { offerUndo = true } = {}) {
    await db.del('notes', n.id);
    await markDeleted(n.bookId, n.id);
    if (n.kind === 'highlight') {
      epubNotes.delete(n.id);
      if (rendition && n.cfi) { try { rendition.annotations.remove(n.cfi, 'highlight'); } catch (_) { /* ignore */ } }
    } else if (n.kind === 'pdf-mark' || n.kind === 'pdf-ink') {
      const list = (annByPage.get(n.page) || []).filter((x) => x.id !== n.id);
      annByPage.set(n.page, list);
      drawPageAnnotations(n.page);
    }
    syncSoon();
    refreshNotes();
    if (offerUndo) toast('Removed.', 'Undo', () => restoreNote(n));
  }

  async function restoreNote(n) {
    const copy = { ...n, id: uid() };
    await db.put('notes', copy);
    if (copy.kind === 'highlight') { epubNotes.set(copy.id, copy); if (rendition) drawHighlight(copy); }
    else if (copy.kind === 'pdf-mark' || copy.kind === 'pdf-ink') { addToPage(copy); drawPageAnnotations(copy.page); }
    syncSoon();
    refreshNotes();
    return copy;
  }

  // ---------- EPUB ----------
  function themeColours() {
    let t = prefs.theme;
    if (t === 'auto') t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    return {
      light: { bg: '#ffffff', fg: '#1f2328', dark: false },
      sepia: { bg: '#f4ecd8', fg: '#433422', dark: false },
      dark: { bg: '#161a1f', fg: '#e8e6e1', dark: true },
    }[t];
  }

  function applyEpubPrefs() {
    const t = themeColours();
    $('#reader-body').style.setProperty('--reader-bg', t.bg);
    if (!rendition) return;
    rendition.themes.fontSize(`${prefs.fontSize}%`);
    rendition.themes.font(prefs.font);
    rendition.themes.override('line-height', String(prefs.lineHeight), true);
    rendition.themes.override('color', t.fg, true);
    rendition.themes.override('background', t.bg, true);
  }

  function highlightStyles(color) {
    const dark = themeColours().dark;
    return {
      fill: COLORS[color] || COLORS.yellow,
      'fill-opacity': dark ? '0.4' : '0.5',
      'mix-blend-mode': dark ? 'normal' : 'multiply',
    };
  }

  function drawHighlight(n) {
    rendition.annotations.highlight(n.cfi, { id: n.id }, () => openHighlightMenu(n.id), 'hl', highlightStyles(n.color));
  }

  function redrawHighlights() {
    if (!rendition) return;
    for (const n of epubNotes.values()) {
      try { rendition.annotations.remove(n.cfi, 'highlight'); } catch (_) { /* ignore */ }
      drawHighlight(n);
    }
  }

  async function openEpub(rec, prog) {
    $('#epub-view').hidden = false;
    $('#pdf-view').hidden = true;
    const buf = await rec.file.arrayBuffer();
    epubBook = ePub(buf);
    rendition = epubBook.renderTo('epub-view', { width: '100%', height: '100%', flow: 'paginated', spread: 'none' });
    rendition.themes.default({ body: { padding: '0 16px' } });
    applyEpubPrefs();

    rendition.on('relocated', (loc) => {
      if (!current) return;
      hideMenu();
      const cfi = loc.start.cfi;
      const pct = epubBook.locations.length()
        ? Math.round(epubBook.locations.percentageFromCfi(cfi) * 100)
        : current.pct;
      current.pct = pct;
      setProgress(pct);
      saveProgress({ pct, cfi });
    });
    rendition.on('selected', onEpubSelected);
    rendition.on('keyup', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') rendition.next();
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') rendition.prev();
    });

    await rendition.display(prog.cfi || undefined);
    await loadEpubHighlights();

    // Page percentages need a one-time scan of the book; run it in the background.
    epubBook.locations.generate(1600).then(() => {
      if (!current || !rendition) return;
      const loc = rendition.currentLocation();
      if (loc && loc.start) {
        const pct = Math.round(epubBook.locations.percentageFromCfi(loc.start.cfi) * 100);
        current.pct = pct;
        setProgress(pct);
        saveProgress({ pct });
      }
    }).catch(() => {});
  }

  async function loadEpubHighlights() {
    if (!rendition || !current) return;
    const notes = await db.byBook('notes', current.id);
    epubNotes = new Map();
    for (const n of notes) {
      if (n.kind === 'highlight' && n.cfi) { epubNotes.set(n.id, n); drawHighlight(n); }
    }
  }

  function clearEpubSelection(contents) {
    try { contents.window.getSelection().removeAllRanges(); } catch (_) { /* ignore */ }
  }

  function onEpubSelected(cfiRange, contents) {
    if (!epubBook) return;
    epubBook.getRange(cfiRange).then((range) => {
      const text = range ? range.toString().trim() : '';
      if (!text) return;
      pendingSelection = { kind: 'epub', cfi: cfiRange, text, contents };
      showMenu({
        colors: true,
        activeColor: markColor,
        onColor: (c) => addHighlight(c, ''),
        actions: [
          { label: 'Note', fn: () => { const t = prompt('Note for this highlight:'); if (t !== null) addHighlight(markColor, t.trim()); } },
          { label: 'Define', fn: () => openDictionary(text) },
          { label: 'Ask Gemini', fn: () => askGemini(text) },
          { label: 'Copy', fn: async () => { toast((await copyText(text)) ? 'Copied.' : 'Could not copy.'); } },
          { label: '✕', fn: () => { clearEpubSelection(contents); hideMenu(); } },
        ],
      });
    });
  }

  async function addHighlight(color, note) {
    if (!pendingSelection || pendingSelection.kind !== 'epub' || !current) return;
    markColor = color;
    prefs.color = color; savePrefs();
    const n = {
      id: uid(), bookId: current.id, kind: 'highlight', color,
      cfi: pendingSelection.cfi, text: pendingSelection.text, note: note || '', created: Date.now(),
    };
    await db.put('notes', n);
    epubNotes.set(n.id, n);
    if (rendition) drawHighlight(n);
    clearEpubSelection(pendingSelection.contents);
    pendingSelection = null;
    hideMenu();
    syncSoon();
    refreshNotes();
  }

  // Tap an existing highlight to change its colour, edit its note, look up words, or remove it.
  function openHighlightMenu(id) {
    const n = epubNotes.get(id);
    if (!n) return;
    pendingSelection = { kind: 'edit', text: n.text, id };
    showMenu({
      colors: true,
      activeColor: n.color || 'yellow',
      onColor: async (c) => {
        const cur = epubNotes.get(id);
        if (!cur) return;
        try { rendition.annotations.remove(cur.cfi, 'highlight'); } catch (_) { /* ignore */ }
        const next = { ...cur, color: c };
        epubNotes.set(id, next);
        await db.put('notes', next);
        drawHighlight(next);
        markColor = c; prefs.color = c; savePrefs();
        syncSoon();
        refreshNotes();
        openHighlightMenu(id);
      },
      actions: [
        { label: n.note ? 'Edit note' : 'Add note', fn: async () => {
          const t = prompt('Note for this highlight:', n.note || '');
          if (t === null) return;
          const next = { ...epubNotes.get(id), note: t.trim() };
          epubNotes.set(id, next);
          await db.put('notes', next);
          syncSoon(); refreshNotes(); hideMenu();
        } },
        { label: 'Define', fn: () => openDictionary(n.text) },
        { label: 'Ask Gemini', fn: () => askGemini(n.text) },
        { label: 'Remove highlight', danger: true, fn: async () => { hideMenu(); await removeNote(epubNotes.get(id)); } },
        { label: '✕', fn: hideMenu },
      ],
    });
  }

  // Reading settings: text size, font, line spacing and page colour
  function syncSettingsUi() {
    $('#fs-val').textContent = `${prefs.fontSize}%`;
    $('#font-select').value = prefs.font;
    if ($('#font-select').value !== prefs.font) $('#font-select').selectedIndex = 0;
    $('#lh-select').value = String(prefs.lineHeight);
    document.querySelectorAll('#theme-row .theme').forEach((b) => b.classList.toggle('on', b.dataset.theme === prefs.theme));
  }
  $('#aa-btn').addEventListener('click', () => { syncSettingsUi(); $('#settings-panel').hidden = false; });
  $('#settings-close').addEventListener('click', () => { $('#settings-panel').hidden = true; });
  $('#settings-panel').addEventListener('click', (e) => { if (e.target.id === 'settings-panel') $('#settings-panel').hidden = true; });
  $('#fs-minus').addEventListener('click', () => { prefs.fontSize = Math.max(70, prefs.fontSize - 10); savePrefs(); syncSettingsUi(); applyEpubPrefs(); });
  $('#fs-plus').addEventListener('click', () => { prefs.fontSize = Math.min(240, prefs.fontSize + 10); savePrefs(); syncSettingsUi(); applyEpubPrefs(); });
  $('#font-select').addEventListener('change', (e) => { prefs.font = e.target.value; savePrefs(); applyEpubPrefs(); });
  $('#lh-select').addEventListener('change', (e) => { prefs.lineHeight = e.target.value; savePrefs(); applyEpubPrefs(); });
  $('#theme-row').addEventListener('click', (e) => {
    const b = e.target.closest('.theme');
    if (!b) return;
    prefs.theme = b.dataset.theme; savePrefs(); syncSettingsUi(); applyEpubPrefs(); redrawHighlights();
  });

  // ---------- PDF ----------
  function svgEl(name, attrs) {
    const e = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    return e;
  }

  function addToPage(a) {
    const list = annByPage.get(a.page) || [];
    list.push(a);
    annByPage.set(a.page, list);
  }

  function annToSvg(a) {
    const g = svgEl('g', { 'data-id': a.id });
    const color = COLORS[a.color] || COLORS.yellow;
    if (a.kind === 'pdf-mark') {
      for (const r of a.rects) {
        if (a.type === 'underline') {
          g.appendChild(svgEl('line', {
            x1: r.x, x2: r.x + r.w, y1: r.y + r.h * 0.94, y2: r.y + r.h * 0.94,
            stroke: color, 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round',
          }));
        } else {
          g.appendChild(svgEl('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: color, 'fill-opacity': 0.55 }));
        }
      }
    } else {
      g.appendChild(svgEl('polyline', {
        points: a.points.map((p) => `${p[0]},${p[1]}`).join(' '),
        fill: 'none', stroke: color,
        'stroke-width': a.tool === 'marker' ? 14 : 2.5,
        'stroke-opacity': a.tool === 'marker' ? 0.4 : 1,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
      }));
    }
    return g;
  }

  function drawPageAnnotations(n) {
    const el = pdfPageEls[n - 1];
    if (!el) return;
    const svg = el.querySelector('svg.ann');
    svg.textContent = '';
    for (const a of annByPage.get(n) || []) svg.appendChild(annToSvg(a));
  }

  async function openPdf(rec, prog) {
    $('#pdf-view').hidden = false;
    $('#epub-view').hidden = true;
    const view = $('#pdf-view');
    const wrap = $('#pdf-pages');
    wrap.textContent = '';
    $('#reader-body').style.removeProperty('--reader-bg');

    pdfDoc = await pdfjsLib.getDocument({ data: await rec.file.arrayBuffer() }).promise;
    const first = await pdfDoc.getPage(1);
    const base = first.getViewport({ scale: 1 });
    pdfScale = (view.clientWidth - 24) / base.width;
    const vp = first.getViewport({ scale: pdfScale });

    annByPage.clear();
    undoStack = [];
    for (const n of await db.byBook('notes', rec.id)) {
      if (n.kind === 'pdf-mark' || n.kind === 'pdf-ink') addToPage(n);
    }

    pdfPageEls = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const el = h('div', 'pdf-page');
      el.dataset.page = String(i);
      el.style.width = `${vp.width}px`;
      el.style.height = `${vp.height}px`;
      const svg = svgEl('svg', { class: 'ann', viewBox: '0 0 1 1', preserveAspectRatio: 'none' });
      el.append(svg, h('div', 'textLayer'), h('div', 'surface'));
      wrap.appendChild(el);
      pdfPageEls.push(el);
      bindSurface(el, i);
      drawPageAnnotations(i);
    }

    pdfObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) renderPdfPage(Number(en.target.dataset.page));
      }
    }, { root: view, rootMargin: '900px 0px' });
    pdfPageEls.forEach((el) => pdfObserver.observe(el));

    view.addEventListener('scroll', onPdfScroll, { passive: true });
    setTool('select');
    renderPdfColors();
    scrollToPdfPage(prog.page || 1);
    currentPdfPage = prog.page || 1;
    setProgress(prog.pct || 0);
  }

  async function renderPdfPage(n) {
    if (!pdfDoc || pdfRendered.has(n)) return;
    pdfRendered.add(n);
    const page = await pdfDoc.getPage(n);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: pdfScale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.style.width = `${vp.width / dpr}px`;
    canvas.style.height = `${vp.height / dpr}px`;
    const el = pdfPageEls[n - 1];
    if (!el) return;
    el.insertBefore(canvas, el.firstChild);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    // Invisible text on top of the page so words can be selected, highlighted and looked up.
    try {
      const textContent = await page.getTextContent();
      const layer = el.querySelector('.textLayer');
      layer.textContent = '';
      layer.style.setProperty('--scale-factor', String(pdfScale));
      await pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: layer,
        viewport: page.getViewport({ scale: pdfScale }),
        textDivs: [],
      }).promise;
    } catch (err) {
      console.warn('Could not build the text layer for page', n, err);
    }
  }

  function onPdfScroll() {
    if (!pdfDoc) return;
    const view = $('#pdf-view');
    const line = view.scrollTop + view.clientHeight * 0.3;
    let page = 1;
    for (const el of pdfPageEls) {
      if (el.offsetTop <= line) page = Number(el.dataset.page);
      else break;
    }
    if (page !== currentPdfPage) {
      currentPdfPage = page;
      const pct = Math.round((page / pdfDoc.numPages) * 100);
      if (current) current.pct = pct;
      setProgress(pct);
      saveProgress({ pct, page });
    }
  }

  function scrollToPdfPage(n) {
    const el = pdfPageEls[Math.max(0, Math.min(pdfPageEls.length - 1, n - 1))];
    if (el) $('#pdf-view').scrollTop = el.offsetTop - 8;
  }

  // PDF tools: Read, Highlight, Underline, Pen, Marker, Eraser
  function setTool(name) {
    pdfTool = name;
    document.querySelectorAll('#pdf-tools .tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === name));
    $('#pdf-pages').className = `pdf-pages tool-${name}`;
    hideMenu();
  }
  document.querySelectorAll('#pdf-tools .tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  function renderPdfColors() {
    const box = $('#pdf-colors');
    box.textContent = '';
    for (const name of COLOR_NAMES) {
      const b = h('button', 'dot');
      b.style.background = COLORS[name];
      b.setAttribute('aria-label', `${name} colour`);
      if (name === markColor) b.classList.add('on');
      b.addEventListener('click', () => { markColor = name; prefs.color = name; savePrefs(); renderPdfColors(); });
      box.appendChild(b);
    }
  }

  async function saveAnnotation(a) {
    await db.put('notes', a);
    addToPage(a);
    drawPageAnnotations(a.page);
    undoStack.push({ type: 'add', id: a.id });
    if (undoStack.length > 40) undoStack.shift();
    syncSoon();
    refreshNotes();
  }

  async function undoLast() {
    const step = undoStack.pop();
    if (!step) { toast('Nothing to undo.'); return; }
    if (step.type === 'add') {
      for (const list of annByPage.values()) {
        const a = list.find((x) => x.id === step.id);
        if (a) { await removeNote(a, { offerUndo: false }); return; }
      }
    } else {
      const copy = await restoreNote(step.note);
      // keep the restored item undoable
      undoStack.push({ type: 'add', id: copy.id });
    }
  }
  $('#pdf-undo').addEventListener('click', undoLast);

  // Freehand drawing and erasing on a page
  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function hitAnnotation(n, p) {
    const el = pdfPageEls[n - 1];
    const W = el.clientWidth;
    const H = el.clientHeight;
    const list = annByPage.get(n) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      if (a.kind === 'pdf-mark') {
        for (const r of a.rects) {
          if (p[0] >= r.x - 0.004 && p[0] <= r.x + r.w + 0.004 && p[1] >= r.y - 0.004 && p[1] <= r.y + r.h + 0.004) return a;
        }
      } else {
        const tol = a.tool === 'marker' ? 14 : 10;
        const px = p[0] * W;
        const py = p[1] * H;
        for (let j = 1; j < a.points.length; j++) {
          const A = a.points[j - 1];
          const B = a.points[j];
          if (distToSegment(px, py, A[0] * W, A[1] * H, B[0] * W, B[1] * H) <= tol) return a;
        }
      }
    }
    return null;
  }

  function bindSurface(el, n) {
    const surface = el.querySelector('.surface');
    let stroke = null;
    let erasing = false;
    const pos = (e) => {
      const b = el.getBoundingClientRect();
      return [Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)), Math.max(0, Math.min(1, (e.clientY - b.top) / b.height))];
    };
    const eraseAt = async (p) => {
      const a = hitAnnotation(n, p);
      if (a) {
        undoStack.push({ type: 'del', note: a });
        await removeNote(a, { offerUndo: false });
      }
    };

    surface.addEventListener('pointerdown', (e) => {
      if (pdfTool === 'pen' || pdfTool === 'marker') {
        e.preventDefault();
        surface.setPointerCapture(e.pointerId);
        const color = COLORS[markColor];
        const poly = svgEl('polyline', {
          fill: 'none', stroke: color, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
          'stroke-width': pdfTool === 'marker' ? 14 : 2.5, 'stroke-opacity': pdfTool === 'marker' ? 0.4 : 1,
        });
        el.querySelector('svg.ann').appendChild(poly);
        stroke = { tool: pdfTool, points: [pos(e)], poly };
      } else if (pdfTool === 'eraser') {
        e.preventDefault();
        surface.setPointerCapture(e.pointerId);
        erasing = true;
        eraseAt(pos(e));
      }
    });
    surface.addEventListener('pointermove', (e) => {
      if (stroke) {
        const p = pos(e);
        const last = stroke.points[stroke.points.length - 1];
        if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.0012) return;
        stroke.points.push(p);
        stroke.poly.setAttribute('points', stroke.points.map((q) => `${q[0]},${q[1]}`).join(' '));
      } else if (erasing) {
        eraseAt(pos(e));
      }
    });
    const finish = async () => {
      erasing = false;
      if (!stroke) return;
      const s = stroke;
      stroke = null;
      s.poly.remove();
      if (s.points.length < 2) return;
      await saveAnnotation({
        id: uid(), bookId: current.id, kind: 'pdf-ink', tool: s.tool, color: markColor, page: n,
        points: s.points.map((q) => [Math.round(q[0] * 10000) / 10000, Math.round(q[1] * 10000) / 10000]),
        created: Date.now(),
      });
    };
    surface.addEventListener('pointerup', finish);
    surface.addEventListener('pointercancel', finish);
  }

  // Text selection in a PDF: highlight, underline, look up, ask Gemini
  function selectionToMarks() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const container = $('#pdf-pages');
    if (!container.contains(range.commonAncestorContainer)) return null;
    const byPage = new Map();
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const el = pdfPageEls.find((e) => {
        const b = e.getBoundingClientRect();
        return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
      });
      if (!el) continue;
      const b = el.getBoundingClientRect();
      if (r.width > b.width * 0.98 && r.height > b.height * 0.2) continue; // ignore container boxes
      const page = Number(el.dataset.page);
      const arr = byPage.get(page) || [];
      arr.push({ x: (r.left - b.left) / b.width, y: (r.top - b.top) / b.height, w: r.width / b.width, h: r.height / b.height });
      byPage.set(page, arr);
    }
    if (!byPage.size) return null;
    return { text: sel.toString().trim(), byPage };
  }

  async function createMarks(type, color, note, sel) {
    let first = true;
    for (const [page, rects] of sel.byPage) {
      await saveAnnotation({
        id: uid(), bookId: current.id, kind: 'pdf-mark', type, color, page, rects,
        text: first ? sel.text : '', note: first ? (note || '') : '', created: Date.now(),
      });
      first = false;
    }
    markColor = color; prefs.color = color; savePrefs(); renderPdfColors();
    try { window.getSelection().removeAllRanges(); } catch (_) { /* ignore */ }
    pendingSelection = null;
    hideMenu();
  }

  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    if (!current || current.type !== 'pdf') return;
    clearTimeout(selTimer);
    selTimer = setTimeout(onPdfSelection, 450);
  });

  function onPdfSelection() {
    if (!current || current.type !== 'pdf') return;
    if (pdfTool !== 'select' && pdfTool !== 'highlight' && pdfTool !== 'underline') return;
    const sel = selectionToMarks();
    if (!sel) return;
    if (pdfTool === 'highlight') { createMarks('highlight', markColor, '', sel); return; }
    if (pdfTool === 'underline') { createMarks('underline', markColor, '', sel); return; }
    pendingSelection = { kind: 'pdf', text: sel.text, sel };
    showMenu({
      colors: true,
      activeColor: markColor,
      onColor: (c) => createMarks('highlight', c, '', sel),
      actions: [
        { label: 'Underline', fn: () => createMarks('underline', markColor, '', sel) },
        { label: 'Note', fn: () => { const t = prompt('Note for this highlight:'); if (t !== null) createMarks('highlight', markColor, t.trim(), sel); } },
        { label: 'Define', fn: () => openDictionary(sel.text) },
        { label: 'Ask Gemini', fn: () => askGemini(sel.text) },
        { label: 'Copy', fn: async () => { toast((await copyText(sel.text)) ? 'Copied.' : 'Could not copy.'); } },
        { label: '✕', fn: () => { try { window.getSelection().removeAllRanges(); } catch (_) { /* ignore */ } hideMenu(); } },
      ],
    });
  }

  // ---------- reader controls ----------
  function goNext() {
    if (!current) return;
    if (current.type === 'epub') { if (rendition) rendition.next(); }
    else scrollToPdfPage(currentPdfPage + 1);
  }
  function goPrev() {
    if (!current) return;
    if (current.type === 'epub') { if (rendition) rendition.prev(); }
    else scrollToPdfPage(currentPdfPage - 1);
  }

  $('#next-btn').addEventListener('click', goNext);
  $('#prev-btn').addEventListener('click', goPrev);
  $('#back-btn').addEventListener('click', async () => {
    const id = current && current.rec.driveId ? current.id : null;
    cleanupReader();
    showView('library');
    if (id) flushPush(id);
    renderLibrary();
  });

  window.addEventListener('keydown', (e) => {
    if (!current || !$('#reader').classList.contains('active')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') goNext();
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') goPrev();
  });

  $('#bookmark-btn').addEventListener('click', async () => {
    if (!current) return;
    const n = { id: uid(), bookId: current.id, kind: 'bookmark', created: Date.now() };
    if (current.type === 'epub') {
      const loc = rendition && rendition.currentLocation();
      if (!loc || !loc.start) return;
      n.cfi = loc.start.cfi;
      n.text = `${current.pct}% through the book`;
    } else {
      n.page = currentPdfPage;
      n.text = `Page ${currentPdfPage}`;
    }
    await db.put('notes', n);
    syncSoon();
    toast('Bookmark added.');
    refreshNotes();
  });

  // ---------- notes panel ----------
  async function refreshNotes() {
    const list = $('#notes-list');
    list.textContent = '';
    if (!current) return;
    const notes = (await db.byBook('notes', current.id)).sort((a, b) => b.created - a.created);
    if (!notes.length) {
      list.appendChild(h('li', '', 'Nothing here yet. Select text to highlight it, or tap Bookmark.'));
      return;
    }
    for (const n of notes) {
      const li = document.createElement('li');
      if (n.kind === 'highlight' || n.kind === 'pdf-mark') {
        const t = h('span', 'hl-text', n.text ? `“${n.text}”` : (n.kind === 'pdf-mark' ? `${n.type === 'underline' ? 'Underline' : 'Highlight'} (page ${n.page})` : ''));
        t.style.background = COLORS[n.color] || COLORS.yellow;
        t.style.color = '#1f2328';
        if (n.type === 'underline') { t.style.background = 'transparent'; t.style.color = 'inherit'; t.style.borderBottom = `3px solid ${COLORS[n.color] || COLORS.yellow}`; }
        li.appendChild(t);
        if (n.note) li.appendChild(h('div', '', n.note));
      } else if (n.kind === 'pdf-ink') {
        li.appendChild(document.createTextNode(`${n.tool === 'marker' ? 'Marker' : 'Pen'} drawing · page ${n.page}`));
      } else {
        li.appendChild(document.createTextNode(`Bookmark: ${n.text || ''}`));
      }
      li.appendChild(h('div', 'when', new Date(n.created).toLocaleString()));

      const go = h('button', 'go', 'Go to');
      go.addEventListener('click', () => {
        if (current.type === 'epub') { if (n.cfi && rendition) rendition.display(n.cfi); }
        else if (n.page) scrollToPdfPage(n.page);
        $('#notes-panel').hidden = true;
      });
      li.appendChild(go);

      if (n.kind === 'highlight' || n.kind === 'pdf-mark') {
        const edit = h('button', 'go', n.note ? 'Edit note' : 'Add note');
        edit.addEventListener('click', async () => {
          const t = prompt('Note:', n.note || '');
          if (t === null) return;
          const next = { ...n, note: t.trim() };
          await db.put('notes', next);
          if (n.kind === 'highlight') epubNotes.set(n.id, next);
          else { const l = annByPage.get(n.page) || []; const i = l.findIndex((x) => x.id === n.id); if (i >= 0) l[i] = next; }
          syncSoon(); refreshNotes();
        });
        li.appendChild(edit);
      }

      const del = h('button', 'go', 'Delete');
      del.addEventListener('click', () => removeNote(n));
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  $('#notes-btn').addEventListener('click', () => {
    refreshNotes();
    $('#notes-panel').hidden = false;
  });
  $('#notes-close').addEventListener('click', () => { $('#notes-panel').hidden = true; });
  $('#notes-panel').addEventListener('click', (e) => {
    if (e.target.id === 'notes-panel') $('#notes-panel').hidden = true;
  });

  // ---------- cloud buttons ----------
  $('#signin-btn').addEventListener('click', () => {
    if (!cloud.client && !initAuth()) {
      updateCloudUi('Google sign-in is still loading. Check your connection and try again in a moment.');
      return;
    }
    cloud.client.requestAccessToken({ prompt: '' });
  });
  $('#signout-btn').addEventListener('click', () => {
    const t = cloud.token;
    if (t && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(t, () => {}); } catch (_) { /* ignore */ }
    }
    clearToken();
    updateCloudUi('Signed out. Books already opened stay on this device.');
    renderLibrary();
  });
  $('#sync-btn').addEventListener('click', () => refreshFromDrive());

  // Push any pending notes when the tab is hidden or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && current && current.rec.driveId) flushPush(current.id);
  });

  // ---------- start ----------
  async function start() {
    restoreToken();
    updateCloudUi();
    await renderLibrary();
    if (!cloud.enabled) return;
    // The Google sign-in script loads asynchronously; wait for it briefly.
    for (let i = 0; i < 40 && !initAuth(); i++) await new Promise((r) => setTimeout(r, 250));
    if (cloud.signedIn) refreshFromDrive();
  }
  start().catch(showError);
})();
