/* My Books: a personal EPUB and PDF reader. Everything is stored in this browser (IndexedDB). */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // ---------- storage ----------
  const DB_NAME = 'my-books';
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('books', { keyPath: 'id' });
          d.createObjectStore('progress', { keyPath: 'bookId' });
          const notes = d.createObjectStore('notes', { keyPath: 'id' });
          notes.createIndex('bookId', 'bookId');
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

  async function deleteBook(id) {
    const notes = await db.byBook('notes', id);
    for (const n of notes) await db.del('notes', n.id);
    await db.del('progress', id);
    await db.del('books', id);
  }

  // ---------- views ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === name));
  }

  function setProgress(pct) {
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    $('#progress-fill').style.width = `${p}%`;
    $('#progress-text').textContent = `${p}%`;
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
      const pct = Math.round(prog[b.id]?.pct || 0);
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
        cover.textContent = b.type === 'pdf' ? 'PDF' : 'EPUB';
      }

      const meta = document.createElement('div');
      meta.className = 'book-meta';
      const title = document.createElement('div');
      title.className = 'book-title';
      title.textContent = b.title;
      const pctEl = document.createElement('div');
      pctEl.className = 'book-pct';
      pctEl.textContent = `${pct}% read`;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      const del = document.createElement('button');
      del.className = 'book-del';
      del.textContent = 'Remove';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Remove "${b.title}" and its notes from this browser? This cannot be undone.`)) {
          await deleteBook(b.id);
          renderLibrary();
        }
      });

      meta.append(title, pctEl, bar, del);
      li.append(cover, meta);
      li.addEventListener('click', () => openBook(b.id).catch(showError));
      shelf.appendChild(li);
    }
  }

  function showError(err) {
    console.error(err);
    alert(`Something went wrong: ${err && err.message ? err.message : err}`);
  }

  // ---------- adding books ----------
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
      const scale = 300 / base.width;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      cover = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    } catch (_) { /* no cover is fine */ }
    doc.destroy();
    return { title: info.Title || '', author: info.Author || '', cover };
  }

  async function addBook(file) {
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    const buf = await file.arrayBuffer();
    const meta = isPdf ? await pdfMeta(buf) : await epubMeta(buf);
    const fallbackTitle = file.name.replace(/\.(epub|pdf)$/i, '');
    await db.put('books', {
      id: uid(),
      type: isPdf ? 'pdf' : 'epub',
      title: meta.title || fallbackTitle,
      author: meta.author,
      cover: meta.cover,
      file: new Blob([buf], { type: isPdf ? 'application/pdf' : 'application/epub+zip' }),
      addedAt: Date.now(),
    });
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
  }

  async function openBook(id) {
    const rec = await db.get('books', id);
    if (!rec) return;
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
    if (epubBook) { try { epubBook.destroy(); } catch (_) {} }
    epubBook = null;
    rendition = null;
    $('#epub-view').textContent = '';
    if (pdfObserver) pdfObserver.disconnect();
    pdfObserver = null;
    if (pdfDoc) { try { pdfDoc.destroy(); } catch (_) {} }
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
  $('#back-btn').addEventListener('click', () => {
    cleanupReader();
    showView('library');
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
        if (rendition && n.kind === 'highlight' && n.cfi) {
          rendition.annotations.remove(n.cfi, 'highlight');
        }
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

  // ---------- start ----------
  renderLibrary().catch(showError);
})();
