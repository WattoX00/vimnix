(() => {
  'use strict';

  const KEY = 'vnotes.cfg', LAST = 'vnotes.last';
  const $ = s => document.querySelector(s);
  const S = { cfg: null, files: [], current: null };

  const ed = VimEditor.createEditor({
    onDirty: () => { updateHeader(); renderList(); },
    onMessage: (t, k) => msg(t, k),
    onEx,
    onYank: t => { try { navigator.clipboard && navigator.clipboard.writeText(t).catch(() => {}); } catch {} },
  });

  // ---- elements ----------------------------------------------------------
  const login = $('#login'), app = $('#app');
  const fRepo = $('#fRepo'), fToken = $('#fToken'), fBranch = $('#fBranch'), fFolder = $('#fFolder');
  const loginErr = $('#loginErr'), loginBtn = $('#loginBtn');
  const fileList = $('#fileList'), repoLabel = $('#repoLabel');
  const fileName = $('#fileName'), dirtyDot = $('#dirtyDot'), btnSave = $('#btnSave');
  const editor = $('#editor'), scroll = $('#scroll'), doc = $('#doc'), sink = $('#sink'), emptyEl = $('#empty');
  const modeBadge = $('#modeBadge'), fileBadge = $('#fileBadge'), msgEl = $('#msg'), posEl = $('#pos'), pendEl = $('#pend');
  const dlg = $('#modal');

  // ---- GitHub ------------------------------------------------------------
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  const repoPath = () => `/repos/${S.cfg.repo}`;
  const contentsUrl = name => `${repoPath()}/contents/${enc([S.cfg.folder, name].filter(Boolean).join('/'))}`;
  const refQ = () => `?ref=${encodeURIComponent(S.cfg.branch)}`;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  function b64enc(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64dec(b) {
    const bin = atob(b.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
  }

  async function gh(path, opts = {}, cfg = S.cfg) {
    const res = await fetch('https://api.github.com' + path, {
      ...opts,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: 'Bearer ' + cfg.token,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!res.ok) {
      let m = res.statusText;
      try { m = (await res.json()).message || m; } catch {}
      const e = new Error(m); e.status = res.status; throw e;
    }
    return res.status === 204 ? null : res.json();
  }

  function explain(e) {
    if (e instanceof TypeError) return 'Network error — could not reach GitHub.';
    switch (e.status) {
      case 401: return 'GitHub rejected the token (expired or revoked).';
      case 403: return /rate limit/i.test(e.message) ? 'GitHub rate limit hit — try again in a bit.' : 'The token lacks permission — it needs Contents: Read and write.';
      case 404: return 'Not found — check the repo name and the token’s repository access.';
      case 409: case 422: return 'The file changed on GitHub since you opened it. Use :e! to reload it (your edits are discarded).';
      default: return e.message || 'Something went wrong.';
    }
  }

  // ---- messages / status -------------------------------------------------
  let curMsg = null, msgTimer = 0;
  function msg(text, kind = 'info') {
    curMsg = { text, kind };
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { curMsg = null; paintMsg(); }, kind === 'error' ? 6500 : 3500);
    paintMsg();
  }
  function paintMsg() {
    if (ed.mode === 'cmd') { msgEl.className = 'msg cmd'; msgEl.textContent = ed.cmdline(); }
    else { msgEl.className = 'msg ' + (curMsg ? curMsg.kind : ''); msgEl.textContent = curMsg ? curMsg.text : ''; }
  }

  // ---- editor rendering --------------------------------------------------
  const rows = [];
  let hereRow = -1;
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const MODES = { normal: 'NORMAL', insert: 'INSERT', visual: 'VISUAL', vline: 'V-LINE', cmd: 'COMMAND' };

  function mkRow(i) {
    const el = document.createElement('div'); el.className = 'line'; el._i = i;
    const ln = document.createElement('span'); ln.className = 'ln'; ln.textContent = i + 1;
    const tx = document.createElement('span'); tx.className = 'tx';
    el.append(ln, tx); doc.appendChild(el);
    return { el, tx, s: null, k: null };
  }

  function lineHtml(s, i, sel, cur) {
    let sa = -1, sb = -1;
    if (sel && i >= sel.s.r && i <= sel.e.r) {
      if (sel.linewise) { sa = 0; sb = s.length + 1; }
      else { sa = i === sel.s.r ? sel.s.c : 0; sb = i === sel.e.r ? sel.e.c + 1 : s.length + 1; }
    }
    let out = '', rc = null, rt = '';
    const flush = () => { if (rt) out += rc ? `<span class="${rc}">${esc(rt)}</span>` : esc(rt); rt = ''; };
    for (let p = 0; p < s.length; p++) {
      let k = (sa >= 0 && p >= sa && p < sb) ? 'sel' : '';
      if (p === cur) k += ' cur';
      k = k.trim();
      if (k !== rc) { flush(); rc = k; }
      rt += s[p];
    }
    flush();
    let k = '';
    if (sa >= 0 && sb > s.length) k = 'sel';
    if (cur >= 0 && cur >= s.length) k += ' cur';
    k = k.trim();
    if (k) out += `<span class="${k}">&nbsp;</span>`;
    return out;
  }

  function render() {
    const lines = ed.lines, sel = ed.selection(), r = ed.r, c = ed.c;
    while (rows.length < lines.length) rows.push(mkRow(rows.length));
    while (rows.length > lines.length) rows.pop().el.remove();
    for (let i = 0; i < lines.length; i++) {
      const cur = i === r ? c : -1;
      let sa = -1, sb = -1;
      if (sel && i >= sel.s.r && i <= sel.e.r) { sa = sel.linewise ? 0 : (i === sel.s.r ? sel.s.c : 0); sb = sel.linewise || i !== sel.e.r ? lines[i].length + 1 : sel.e.c + 1; }
      const k = `${sa},${sb},${cur}`, row = rows[i];
      if (row.s === lines[i] && row.k === k) continue;
      row.tx.innerHTML = lineHtml(lines[i], i, sel, cur);
      row.s = lines[i]; row.k = k;
    }
    if (hereRow !== r) {
      if (rows[hereRow]) rows[hereRow].el.classList.remove('here');
      rows[r].el.classList.add('here'); hereRow = r;
    }
    editor.className = 'mode-' + ed.mode;
    modeBadge.textContent = MODES[ed.mode]; modeBadge.dataset.mode = ed.mode;
    posEl.textContent = `${r + 1}:${c + 1}`;
    pendEl.textContent = ed.pending();
    paintMsg();
    ensureVisible();
  }

  function ensureVisible() {
    const row = rows[ed.r]; if (!row) return;
    const top = row.el.offsetTop, bot = top + row.el.offsetHeight, pad = 48;
    if (top < scroll.scrollTop + pad) scroll.scrollTop = Math.max(0, top - pad);
    else if (bot > scroll.scrollTop + scroll.clientHeight - pad) scroll.scrollTop = bot - scroll.clientHeight + pad;
  }

  function resetRows() { rows.length = 0; doc.replaceChildren(); hereRow = -1; }

  function updateHeader() {
    const f = S.current;
    fileName.textContent = f ? f.name : 'No note open';
    dirtyDot.hidden = !(f && ed.dirty);
    fileBadge.textContent = f ? f.name + (ed.dirty ? ' [+]' : '') : '';
    emptyEl.hidden = !!f;
    doc.hidden = !f;
    btnSave.disabled = !f;
    document.title = (f ? (ed.dirty ? '● ' : '') + f.name + ' — ' : '') + 'vnotes';
  }

  // ---- input -------------------------------------------------------------
  const NAMED = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

  sink.addEventListener('keydown', e => {
    if (e.isComposing || e.key === 'Dead' || e.key === 'Process') return;
    const mod = (e.ctrlKey && !e.altKey) || e.metaKey;
    let k = e.key;
    if (mod) {
      const l = k.toLowerCase();
      if (l === 's') { e.preventDefault(); save(); return; }
      if (e.metaKey || !S.current) return;
      if (l === '[') k = 'Esc';
      else if (l.length === 1 && 'rdu'.includes(l)) k = 'C-' + l;
      else return;
    } else if (k === 'Escape') k = 'Esc';
    else if (k.length > 1 && !NAMED.has(k)) return;
    if (!S.current) return;
    e.preventDefault();
    ed.key(k); render();
  });
  sink.addEventListener('input', () => {
    const v = sink.value; sink.value = '';
    if (v && S.current && ed.mode === 'insert') { ed.insertText(v); render(); }
  });
  sink.addEventListener('paste', e => {
    e.preventDefault();
    if (!S.current) return;
    ed.paste(e.clipboardData.getData('text') || ''); render();
  });

  function colAt(x, y, tx) {
    let node, off;
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
    else if (document.caretRangeFromPoint) { const g = document.caretRangeFromPoint(x, y); if (g) { node = g.startContainer; off = g.startOffset; } }
    if (!node || !tx.contains(node)) return null;
    const rg = document.createRange(); rg.selectNodeContents(tx); rg.setEnd(node, off);
    return rg.toString().length;
  }
  scroll.addEventListener('mousedown', e => {
    if (!S.current) return;
    e.preventDefault(); focusEditor();
    const lineEl = e.target.closest('.line');
    if (!lineEl) { ed.setCursor(rows.length - 1, Infinity); render(); return; }
    const tx = lineEl.querySelector('.tx');
    const col = e.target.closest('.ln') ? 0 : colAt(e.clientX, e.clientY, tx);
    ed.setCursor(lineEl._i, col == null ? Infinity : col); render();
  });
  const focusEditor = () => { if (S.current) sink.focus({ preventScroll: true }); };

  window.addEventListener('beforeunload', e => { if (S.current && ed.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---- dialog ------------------------------------------------------------
  function ask({ title, text, content, buttons }) {
    return new Promise(res => {
      $('#dlgTitle').textContent = title;
      const body = $('#dlgBody'); body.replaceChildren();
      if (text) { const p = document.createElement('p'); p.textContent = text; body.append(p); }
      if (content) body.append(content);
      const bar = $('#dlgBtns'); bar.replaceChildren();
      buttons.forEach(b => {
        const bt = document.createElement('button');
        bt.className = 'btn ' + (b.cls || ''); bt.textContent = b.label;
        bt.addEventListener('click', () => dlg.close(b.value));
        bar.append(bt);
      });
      dlg.returnValue = 'cancel';
      dlg.addEventListener('close', () => { res(dlg.returnValue); focusEditor(); }, { once: true });
      dlg.showModal();
      const prim = bar.querySelector('.primary, .danger') || bar.lastChild; prim && prim.focus();
    });
  }

  const HELP = [
    ['h j k l', 'move (arrow keys too)'], ['w b e', 'word forward / back / end'],
    ['0 ^ $', 'line start / first char / end'], ['gg G  12G', 'top / bottom / line 12'],
    ['{ }', 'previous / next blank line'], ['Ctrl-d  Ctrl-u', 'half page down / up'],
    ['i a I A o O', 'enter insert mode (Esc leaves)'], ['x X D C s S', 'delete / change shortcuts'],
    ['d y c + motion', 'dw  d$  yy  cw  ciw  3dd …'], ['p P', 'paste after / before'],
    ['u  Ctrl-r', 'undo / redo'], ['J  r', 'join lines / replace char'],
    ['v V', 'visual char / line, then d y c'], ['/text  n N', 'search'],
    [':w :q :wq :q! :e!', 'save / close / save+close / discard+close / reload'],
    [':12', 'jump to line 12'], ['Ctrl-s', 'save, from any mode'],
  ];
  function showHelp() {
    const g = document.createElement('div'); g.className = 'keys';
    HELP.forEach(([k, d]) => {
      const a = document.createElement('code'); a.textContent = k;
      const b = document.createElement('span'); b.textContent = d;
      g.append(a, b);
    });
    ask({ title: 'Keys', content: g, buttons: [{ label: 'Close', value: 'ok', cls: 'primary' }] });
  }

  // ---- notes -------------------------------------------------------------
  let loadId = 0, saving = false;

  function renderList() {
    fileList.replaceChildren();
    if (!S.files.length) {
      const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'No .txt notes yet';
      fileList.append(li); return;
    }
    for (const f of S.files) {
      const li = document.createElement('li');
      li.className = 'item' + (f === S.current ? ' active' : '');
      const m = f.name.match(/^(.*?)(\.txt)$/i);
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = m ? m[1] : f.name;
      if (m) { const x = document.createElement('span'); x.className = 'ext'; x.textContent = m[2]; nm.append(x); }
      li.append(nm);
      if (f.isNew) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'new'; li.append(t); }
      if (f === S.current && ed.dirty) { const d = document.createElement('span'); d.className = 'dot'; li.append(d); }
      const del = document.createElement('button'); del.className = 'del'; del.title = 'Delete'; del.textContent = '×';
      del.addEventListener('click', e => { e.stopPropagation(); deleteNote(f); });
      li.append(del);
      li.addEventListener('click', () => openFile(f));
      fileList.append(li);
    }
  }

  async function loadList() {
    const dir = S.cfg.folder ? '/' + enc(S.cfg.folder) : '';
    let items = [];
    try { items = await gh(`${repoPath()}/contents${dir}${refQ()}`); }
    catch (e) { if (e.status !== 404) throw e; }
    const remote = (Array.isArray(items) ? items : []).filter(i => i.type === 'file' && /\.txt$/i.test(i.name));
    const old = new Map(S.files.map(f => [f.name, f]));
    let reloadCur = false;
    const next = remote.map(i => {
      const f = old.get(i.name);
      if (!f) return { name: i.name, sha: i.sha, content: null, isNew: false };
      if (f.sha !== i.sha) {
        if (f !== S.current) { f.sha = i.sha; f.content = null; }
        else if (!ed.dirty) { f.sha = i.sha; f.content = null; reloadCur = true; }
      }
      return f;
    });
    S.files.filter(f => f.isNew).forEach(f => next.push(f));
    next.sort(byName);
    S.files = next;
    renderList();
    if (reloadCur) await showFile(S.current);
  }

  async function fetchFile(f) {
    const d = await gh(contentsUrl(f.name) + refQ());
    if (d.encoding !== 'base64') throw new Error('This file is too large to open here (over 1 MB).');
    f.sha = d.sha; f.content = b64dec(d.content);
  }

  async function showFile(f) {
    const id = ++loadId;
    S.current = f; renderList(); updateHeader();
    if (f.content === null) {
      try { msg('Loading…'); await fetchFile(f); }
      catch (e) {
        if (id !== loadId) return false;
        S.current = null; ed.load(''); resetRows(); render(); renderList(); updateHeader();
        msg(explain(e), 'error'); return false;
      }
      if (id !== loadId) return false;
    }
    ed.load(f.content);
    try { localStorage.setItem(LAST, f.name); } catch {}
    updateHeader(); renderList(); render(); focusEditor();
    msg('');
    return true;
  }

  async function leaveCurrent() {
    const f = S.current; if (!f) return true;
    if (ed.dirty) {
      const ch = await ask({
        title: 'Unsaved changes',
        text: `"${f.name}" has changes that haven't been saved to GitHub.`,
        buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard', value: 'discard', cls: 'danger' }, { label: 'Save', value: 'save', cls: 'primary' }],
      });
      if (ch === 'cancel') return false;
      if (ch === 'save' && !(await save())) return false;
    }
    if (f.isNew) S.files = S.files.filter(x => x !== f);
    return true;
  }

  async function openFile(f) {
    if (f === S.current) { focusEditor(); return true; }
    if (!(await leaveCurrent())) return false;
    return showFile(f);
  }

  function closeCurrent() {
    const f = S.current; if (!f) return;
    if (f.isNew) S.files = S.files.filter(x => x !== f);
    S.current = null; ed.load(''); resetRows(); render();
    try { localStorage.removeItem(LAST); } catch {}
    updateHeader(); renderList();
  }

  async function reloadCurrent() {
    const f = S.current; if (!f) return;
    if (f.isNew) { ed.load(''); render(); updateHeader(); return; }
    f.content = null; await showFile(f);
  }

  async function save() {
    const f = S.current; if (!f || saving) return false;
    if (!ed.dirty && !f.isNew) { msg('Nothing to save'); return true; }
    saving = true; btnSave.textContent = 'Saving…'; btnSave.disabled = true;
    const snap = ed.snapshot();
    try {
      const body = { message: `${f.isNew ? 'Create' : 'Update'} ${f.name}`, content: b64enc(snap + '\n'), branch: S.cfg.branch };
      if (f.sha) body.sha = f.sha;
      const res = await gh(contentsUrl(f.name), { method: 'PUT', body: JSON.stringify(body) });
      f.sha = res.content.sha; f.isNew = false; f.content = snap;
      ed.markSaved(snap);
      renderList(); updateHeader();
      msg(`"${f.name}" ${snap.split('\n').length}L written`, 'ok');
      return true;
    } catch (e) {
      msg(explain(e), 'error'); return false;
    } finally {
      saving = false; btnSave.innerHTML = 'Save <kbd>Ctrl S</kbd>'; btnSave.disabled = !S.current;
    }
  }

  async function createNote(raw) {
    const base = raw.replace(/\.txt$/i, '').trim();
    if (!base || /[\/\\:*?"<>|]/.test(base) || base.startsWith('.')) { msg('Invalid file name', 'error'); return; }
    const name = base + '.txt';
    if (S.files.some(f => f.name.toLowerCase() === name.toLowerCase())) { msg('A note with that name already exists', 'error'); return; }
    const f = { name, sha: null, content: '', isNew: true };
    S.files.push(f); S.files.sort(byName);
    if (!(await openFile(f))) { S.files = S.files.filter(x => x !== f); renderList(); }
  }

  async function deleteNote(f) {
    const ch = await ask({
      title: 'Delete note?',
      text: f.isNew ? `"${f.name}" hasn't been saved yet and will be discarded.` : `"${f.name}" will be deleted from the repository.`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Delete', value: 'del', cls: 'danger' }],
    });
    if (ch !== 'del') return;
    try {
      if (!f.isNew) await gh(contentsUrl(f.name), { method: 'DELETE', body: JSON.stringify({ message: `Delete ${f.name}`, sha: f.sha, branch: S.cfg.branch }) });
      S.files = S.files.filter(x => x !== f);
      if (S.current === f) { S.current = null; ed.load(''); resetRows(); try { localStorage.removeItem(LAST); } catch {} }
      renderList(); updateHeader(); render();
      msg(`"${f.name}" deleted`, 'ok');
    } catch (e) { msg(explain(e), 'error'); }
  }

  function onEx(s) {
    switch (s) {
      case 'w': case 'write': save(); break;
      case 'q': case 'quit': case 'close':
        if (ed.dirty) msg('E37: No write since last change (add ! to override)', 'error'); else closeCurrent();
        break;
      case 'q!': closeCurrent(); break;
      case 'wq': case 'x': save().then(ok => { if (ok) closeCurrent(); }); break;
      case 'e!': reloadCurrent(); break;
      case 'h': case 'help': showHelp(); break;
      default: msg('E492: Not an editor command: ' + s, 'error');
    }
  }

  // ---- sidebar -----------------------------------------------------------
  $('#btnNew').addEventListener('click', () => {
    if (fileList.querySelector('.newrow')) return;
    const li = document.createElement('li'); li.className = 'newrow';
    const inp = document.createElement('input'); inp.placeholder = 'new-note.txt'; inp.spellcheck = false;
    li.append(inp); fileList.prepend(li); inp.focus();
    let done = false;
    const finish = ok => {
      if (done) return; done = true;
      const v = inp.value.trim(); li.remove();
      if (ok && v) createNote(v); else focusEditor();
    };
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(false));
  });
  $('#btnRefresh').addEventListener('click', async () => {
    try { await loadList(); msg('List refreshed', 'ok'); } catch (e) { msg(explain(e), 'error'); }
    focusEditor();
  });
  btnSave.addEventListener('click', () => { save(); focusEditor(); });
  $('#btnLogout').addEventListener('click', async () => {
    if (!(await leaveCurrent())) return;
    try { localStorage.removeItem(KEY); localStorage.removeItem(LAST); } catch {}
    S.cfg = null; S.files = []; S.current = null; ed.load(''); resetRows();
    fToken.value = ''; showLogin();
  });

  // ---- login -------------------------------------------------------------
  function parseRepo(v) {
    const p = v.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '').split('/');
    return p.length === 2 && /^[\w.-]+$/.test(p[0]) && /^[\w.-]+$/.test(p[1]) ? p.join('/') : null;
  }
  function showLogin(err) {
    app.hidden = true; login.hidden = false;
    loginErr.textContent = err || '';
    (fRepo.value ? fToken : fRepo).focus();
  }
  function showApp() {
    login.hidden = true; app.hidden = false;
    repoLabel.textContent = S.cfg.repo + (S.cfg.folder ? '/' + S.cfg.folder : '') + ' · ' + S.cfg.branch;
    renderList(); updateHeader(); render();
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    loginErr.textContent = ''; loginBtn.disabled = true; loginBtn.textContent = 'Connecting…';
    try {
      const repo = parseRepo(fRepo.value);
      if (!repo) throw new Error('Enter the repository as owner/name.');
      const token = fToken.value.trim();
      if (!token) throw new Error('Paste your fine-grained token.');
      const cfg = { repo, token, branch: fBranch.value.trim(), folder: fFolder.value.trim().replace(/^\/+|\/+$/g, '') };
      const info = await gh(`/repos/${repo}`, {}, cfg);
      if (info.permissions && info.permissions.push === false) throw new Error('This token can only read the repository — give it Contents: Read and write.');
      cfg.branch = cfg.branch || info.default_branch;
      S.cfg = cfg; S.files = [];
      showApp();
      await loadList();
      try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {}
    } catch (err) {
      S.cfg = null;
      showLogin(err.status || err instanceof TypeError ? explain(err) : err.message);
    } finally {
      loginBtn.disabled = false; loginBtn.textContent = 'Connect';
    }
  });

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    try { S.cfg = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { S.cfg = null; }
    if (!S.cfg || !S.cfg.token || !S.cfg.repo) { S.cfg = null; showLogin(); return; }
    fRepo.value = S.cfg.repo; fBranch.value = S.cfg.branch || ''; fFolder.value = S.cfg.folder || '';
    showApp();
    try {
      await loadList();
      const last = localStorage.getItem(LAST);
      const f = S.files.find(x => x.name === last);
      if (f) await showFile(f);
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) {
        try { localStorage.removeItem(KEY); } catch {}
        S.cfg = null; showLogin(explain(e));
      } else msg(explain(e), 'error');
    }
  })();
})();
