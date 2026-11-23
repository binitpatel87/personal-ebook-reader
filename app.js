/* My Books: a personal EPUB and PDF reader with Google Drive cloud storage.
   - Books live in your Google Drive folder "My Books" (or only on this device if you are not signed in).
   - Reading progress, highlights and bookmarks sync through your Drive (hidden app-data area).
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

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mimeFor = (type) => (type === 'pdf' ? 'application/pdf' : 'application/epub+zip');
  const safeName = (s) => String(s || 'book').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);

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

  // ---------- per-book state in Drive (progress, highlights, bookmarks) ----------
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
      const li = document.createElement('li');
      li.className = 'book';

      const cover = document.createElement('div');
      cover.className = 'cover';
      if (b.cover) {
        const img = new Image();
        img.alt = '';
        img.src = URL.createObjectURL(b.cover);
        cover.appendChild(img);
      } else {
        cover.textContent = b.title || (b.type === 'pdf' ? 'PDF' : 'EPUB');
      }

      const meta = document.createElement('div');
      meta.className = 'book-meta';
      const title = document.createElement('div');
      title.className = 'book-title';
      title.textContent = b.title;
      const chip = document.createElement('span');
      chip.className = 'chip';
      if (b.driveId && b.file) { chip.textContent = '☁ Saved offline'; chip.classList.add('ok'); }
      else if (b.driveId) { chip.textContent = '☁ In Drive'; }
      else { chip.textContent = 'This device only'; }
      const pctEl = document.createElement('div');
      pctEl.className = 'book-pct';
      pctEl.textContent = `${pct}% read`;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);

      const actions = document.createElement('div');
      actions.className = 'book-actions';
      if (!b.driveId && cloud.signedIn) {
        const up = document.createElement('button');
        up.className = 'up';
        up.textContent = 'Upload to Drive';
        up.addEventListener('click', async (e) => {
          e.stopPropagation();
          try { await uploadLocalBook(b); } catch (err) { showError(err); }
          renderLibrary();
        });
        actions.appendChild(up);
      }
      if (!b.driveId) {
        const del = document.createElement('button');
        del.textContent = 'Remove';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`Remove "${b.title}" and its notes from this device? It is not in Google Drive, so this cannot be undone.`)) {
            await deleteBookCompletely(b.id);
            renderLibrary();
          }
        });
        actions.appendChild(del);
      } else if (b.file) {
        const rm = document.createElement('button');
        rm.textContent = 'Free up space';
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
  let pdfDoc = null;
  let pdfObserver = null;
  let pdfPageEls = [];
  let pdfScale = 1;
  let pdfRendered = new Set();
  let currentPdfPage = 1;

  async function saveProgress(patch) {
    if (!current) return;
    const cur = (await db.get('progress', current.id)) || { bookId: current.id };
    Object.assign(cur, patch, { updated: Date.now() });
    await db.put('progress', cur);
    if (current.rec.driveId) schedulePush(current.id);
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
    if (rec.type === 'epub') await openEpub(rec, prog);
    else await openPdf(rec, prog);
  }

  function cleanupReader() {
    if (epubBook) { try { epubBook.destroy(); } catch (_) { /* ignore */ } }
    epubBook = null;
    rendition = null;
    $('#epub-view').textContent = '';
    if (pdfObserver) pdfObserver.disconnect();
    pdfObserver = null;
    if (pdfDoc) { try { pdfDoc.destroy(); } catch (_) { /* ignore */ } }
    pdfDoc = null;
    pdfPageEls = [];
    pdfRendered = new Set();
    $('#pdf-pages').textContent = '';
    $('#pdf-view').removeEventListener('scroll', onPdfScroll);
    pendingSelection = null;
    $('#hl-menu').hidden = true;
    current = null;
  }

  // ---------- EPUB ----------
  async function openEpub(rec, prog) {
    $('#epub-view').hidden = false;
    $('#pdf-view').hidden = true;
    const buf = await rec.file.arrayBuffer();
    epubBook = ePub(buf);
    rendition = epubBook.renderTo('epub-view', { width: '100%', height: '100%', flow: 'paginated', spread: 'none' });

    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    rendition.themes.default({
      body: {
        color: dark ? '#e8e6e1' : '#1f2328',
        background: dark ? '#161a1f' : '#ffffff',
        'line-height': '1.5',
        padding: '0 16px',
      },
    });

    rendition.on('relocated', (loc) => {
      if (!current) return;
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
    await applyEpubHighlights();

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

  function onEpubSelected(cfiRange) {
    if (!epubBook) return;
    epubBook.getRange(cfiRange).then((range) => {
      const text = range ? range.toString().trim() : '';
      if (!text) return;
      pendingSelection = { cfi: cfiRange, text };
      $('#hl-menu').hidden = false;
    });
  }

  async function applyEpubHighlights() {
    if (!rendition || !current) return;
    const notes = await db.byBook('notes', current.id);
    for (const n of notes) {
      if (n.kind === 'highlight' && n.cfi) drawHighlight(n);
    }
  }

  function drawHighlight(n) {
    rendition.annotations.highlight(n.cfi, { id: n.id }, () => {}, 'hl', {
      fill: '#fde68a',
      'fill-opacity': '0.5',
      'mix-blend-mode': 'multiply',
    });
  }

  async function addHighlight(note) {
    if (!pendingSelection || !current) return;
    const n = {
      id: uid(),
      bookId: current.id,
      kind: 'highlight',
      cfi: pendingSelection.cfi,
      text: pendingSelection.text,
      note: note || '',
      created: Date.now(),
    };
    await db.put('notes', n);
    if (rendition) drawHighlight(n);
    pendingSelection = null;
    $('#hl-menu').hidden = true;
    if (current.rec.driveId) schedulePush(current.id);
    refreshNotes();
  }

  $('#hl-add').addEventListener('click', () => addHighlight(''));
  $('#hl-note').addEventListener('click', () => {
    const text = prompt('Note for this highlight:');
    if (text === null) return;
    addHighlight(text.trim());
  });

  // ---------- PDF ----------
  async function openPdf(rec, prog) {
    $('#pdf-view').hidden = false;
    $('#epub-view').hidden = true;
    const view = $('#pdf-view');
    const wrap = $('#pdf-pages');
    wrap.textContent = '';

    pdfDoc = await pdfjsLib.getDocument({ data: await rec.file.arrayBuffer() }).promise;
    const first = await pdfDoc.getPage(1);
    const base = first.getViewport({ scale: 1 });
    pdfScale = (view.clientWidth - 24) / base.width;
    const vp = first.getViewport({ scale: pdfScale });

    pdfPageEls = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const el = document.createElement('div');
      el.dataset.page = String(i);
      el.style.width = `${vp.width}px`;
      el.style.height = `${vp.height}px`;
      wrap.appendChild(el);
      pdfPageEls.push(el);
    }

    pdfObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) renderPdfPage(Number(en.target.dataset.page));
      }
    }, { root: view, rootMargin: '900px 0px' });
    pdfPageEls.forEach((el) => pdfObserver.observe(el));

    view.addEventListener('scroll', onPdfScroll, { passive: true });
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
    if (el) { el.textContent = ''; el.appendChild(canvas); }
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
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
    if (current.rec.driveId) schedulePush(current.id);
    alert('Bookmark added.');
    refreshNotes();
  });

  // ---------- notes panel ----------
  async function refreshNotes() {
    const list = $('#notes-list');
    list.textContent = '';
    if (!current) return;
    const notes = (await db.byBook('notes', current.id)).sort((a, b) => b.created - a.created);
    if (!notes.length) {
      const li = document.createElement('li');
      li.textContent = 'No highlights or bookmarks yet. Select text in an EPUB to highlight it, or tap Bookmark.';
      list.appendChild(li);
      return;
    }
    for (const n of notes) {
      const li = document.createElement('li');
      if (n.kind === 'highlight') {
        const t = document.createElement('span');
        t.className = 'hl-text';
        t.textContent = `“${n.text}”`;
        li.appendChild(t);
        if (n.note) {
          const note = document.createElement('div');
          note.textContent = n.note;
          li.appendChild(note);
        }
      } else {
        li.appendChild(document.createTextNode(`Bookmark: ${n.text || ''}`));
      }
      const when = document.createElement('div');
      when.className = 'when';
      when.textContent = new Date(n.created).toLocaleString();
      const go = document.createElement('button');
      go.className = 'go';
      go.textContent = 'Go to';
      go.addEventListener('click', () => {
        if (current.type === 'epub') {
          if (n.cfi && rendition) rendition.display(n.cfi);
        } else if (n.page) {
          scrollToPdfPage(n.page);
        }
        $('#notes-panel').hidden = true;
      });
      const del = document.createElement('button');
      del.className = 'go';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        await db.del('notes', n.id);
        await markDeleted(current.id, n.id);
        if (rendition && n.kind === 'highlight' && n.cfi) {
          rendition.annotations.remove(n.cfi, 'highlight');
        }
        if (current.rec.driveId) schedulePush(current.id);
        refreshNotes();
      });
      li.append(when, go, del);
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
