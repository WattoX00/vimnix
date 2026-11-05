/* Minimal vim-style modal editor engine. No DOM; the UI feeds it keys and renders its state. */
(function (root) {
  'use strict';

  const WORD = /[\p{L}\p{N}_]/u;
  const cls = ch => (ch === undefined || /\s/.test(ch)) ? 0 : (WORD.test(ch) ? 1 : 2);
  const ALIAS = {
    ArrowLeft: 'h', ArrowRight: 'l', ArrowUp: 'k', ArrowDown: 'j',
    Home: '0', End: '$', PageDown: 'C-d', PageUp: 'C-u',
  };
  const isChar = k => [...k].length === 1;

  function createEditor(host = {}) {
    let lines = [''];
    let r = 0, c = 0, want = 0;
    let mode = 'normal';              // normal | insert | visual | vline | cmd
    let anchor = null;
    let count = '', op = null, opCount = null, pend = '';
    let reg = { text: '', linewise: false };
    let undoS = [], redoS = [], pre = null, preUsed = true;
    let saved = '', dirty = false;
    let cmd = '', cmdType = ':', lastSearch = '', lastDir = 1;

    const say = (t, kind) => host.onMessage && host.onMessage(t, kind || 'info');
    const last = () => lines.length - 1;
    const len = (i = r) => lines[i].length;
    const firstNB = i => { const x = lines[i].search(/\S/); return x < 0 ? Math.max(lines[i].length - 1, 0) : x; };
    const indentOf = s => s.match(/^[ \t]*/)[0];
    const chAt = p => (p.c < len(p.r) ? lines[p.r][p.c] : '\n');

    function clamp() {
      r = Math.max(0, Math.min(r, last()));
      const max = mode === 'insert' ? len() : Math.max(len() - 1, 0);
      c = Math.max(0, Math.min(c, max));
    }
    function setDirty(v) { if (v !== dirty) { dirty = v; host.onDirty && host.onDirty(v); } }
    function clearPending() { count = ''; op = null; opCount = null; pend = ''; }

    // ---- undo -------------------------------------------------------------
    function begin() { pre = { lines: lines.slice(), r, c }; preUsed = false; }
    function mutated() {
      if (!preUsed && pre) {
        undoS.push(pre); if (undoS.length > 500) undoS.shift();
        redoS = []; preUsed = true;
      }
      setDirty(true);
    }
    function undo() {
      const s = undoS.pop();
      if (!s) { say('Already at oldest change'); return false; }
      redoS.push({ lines: lines.slice(), r, c });
      lines = s.lines; r = s.r; c = s.c; clamp();
      setDirty(lines.join('\n') !== saved);
      return true;
    }
    function redo() {
      const s = redoS.pop();
      if (!s) { say('Already at newest change'); return false; }
      undoS.push({ lines: lines.slice(), r, c });
      lines = s.lines; r = s.r; c = s.c; clamp();
      setDirty(lines.join('\n') !== saved);
      return true;
    }

    // ---- text helpers -----------------------------------------------------
    function insertAt(pos, text) {
      const parts = text.split('\n');
      const s = lines[pos.r], head = s.slice(0, pos.c), tail = s.slice(pos.c);
      if (parts.length === 1) { lines[pos.r] = head + text + tail; return { r: pos.r, c: pos.c + text.length }; }
      const mid = parts.slice(1, -1), lastP = parts[parts.length - 1];
      lines[pos.r] = head + parts[0];
      lines.splice(pos.r + 1, 0, ...mid, lastP + tail);
      return { r: pos.r + parts.length - 1, c: lastP.length };
    }
    function textOf(s, e) {
      if (s.r === e.r) return lines[s.r].slice(s.c, e.c);
      return [lines[s.r].slice(s.c), ...lines.slice(s.r + 1, e.r), lines[e.r].slice(0, e.c)].join('\n');
    }
    function delRange(s, e) {
      lines[s.r] = lines[s.r].slice(0, s.c) + lines[e.r].slice(e.c);
      lines.splice(s.r + 1, e.r - s.r);
    }
    function setReg(text, linewise) {
      reg = { text, linewise };
      host.onYank && host.onYank(text, linewise);
    }

    // ---- operators --------------------------------------------------------
    function opLines(o, r1, r2) {
      setReg(lines.slice(r1, r2 + 1).join('\n'), true);
      if (o === 'y') { r = r1; clamp(); if (r2 > r1) say(`${r2 - r1 + 1} lines yanked`); return; }
      mutated();
      if (o === 'd') {
        lines.splice(r1, r2 - r1 + 1);
        if (!lines.length) lines = [''];
        r = Math.min(r1, last()); c = firstNB(r); clamp();
      } else {
        const ind = indentOf(lines[r1]);
        lines.splice(r1, r2 - r1 + 1, ind);
        r = r1; c = ind.length; mode = 'insert'; clamp();
      }
    }
    function opChars(o, s, e) {
      if (s.r === e.r && s.c >= e.c) {
        if (o === 'c') { r = s.r; c = s.c; mode = 'insert'; clamp(); }
        return;
      }
      setReg(textOf(s, e), false);
      if (o === 'y') { r = s.r; c = s.c; clamp(); return; }
      mutated(); delRange(s, e);
      r = s.r; c = s.c;
      if (o === 'c') mode = 'insert';
      clamp();
    }
    function applyMotionOp(o, t) {
      if (!t) return;
      if (t.linewise) { opLines(o, Math.min(r, t.r), Math.max(r, t.r)); return; }
      let a = { r, c }, b = { r: t.r, c: t.c };
      if (b.r < a.r || (b.r === a.r && b.c < a.c)) [a, b] = [b, a];
      if (t.inclusive) b.c = Math.min(b.c + 1, len(b.r));
      opChars(o, a, b);
    }

    // ---- word motions -----------------------------------------------------
    const adv = p => p.c < len(p.r) ? { r: p.r, c: p.c + 1 } : (p.r < last() ? { r: p.r + 1, c: 0 } : null);
    const rev = p => p.c > 0 ? { r: p.r, c: p.c - 1 } : (p.r > 0 ? { r: p.r - 1, c: len(p.r - 1) } : null);

    function wordFwd(p) {
      const cl = cls(chAt(p));
      let q = adv(p);
      if (cl !== 0) while (q && q.c < len(q.r) && cls(chAt(q)) === cl) q = adv(q);
      while (q && cls(chAt(q)) === 0) {
        if (len(q.r) === 0) return q;
        const nq = adv(q); if (!nq) return q; q = nq;
      }
      return q || { r: last(), c: len(last()) };
    }
    function wordBack(p) {
      let q = rev(p); if (!q) return p;
      while (cls(chAt(q)) === 0) {
        if (len(q.r) === 0) return q;
        const nq = rev(q); if (!nq) return { r: 0, c: 0 }; q = nq;
      }
      const cl = cls(chAt(q));
      while (q.c > 0 && cls(lines[q.r][q.c - 1]) === cl) q = { r: q.r, c: q.c - 1 };
      return q;
    }
    function wordEnd(p) {
      let q = adv(p); if (!q) return p;
      while (cls(chAt(q)) === 0) {
        const nq = adv(q);
        if (!nq) return { r: last(), c: Math.max(len(last()) - 1, 0) };
        q = nq;
      }
      const cl = cls(chAt(q));
      while (q.c + 1 < len(q.r) && cls(lines[q.r][q.c + 1]) === cl) q = { r: q.r, c: q.c + 1 };
      return q;
    }
    function wordObj(inner) {
      const s = lines[r]; if (!s.length) return null;
      const cl = cls(s[c]); let a = c, b = c;
      while (a > 0 && cls(s[a - 1]) === cl) a--;
      while (b + 1 < s.length && cls(s[b + 1]) === cl) b++;
      b++;
      if (!inner && cl !== 0) {
        let e = b; while (e < s.length && cls(s[e]) === 0) e++;
        if (e > b) b = e; else while (a > 0 && cls(s[a - 1]) === 0) a--;
      }
      return { s: { r, c: a }, e: { r, c: b } };
    }
    function cwTarget(n) {
      if (cls(chAt({ r, c })) === 0) return motion('w', n, true);
      let p = { r, c };
      for (let i = 0; i < n; i++) {
        const stay = i === 0 && (c + 1 >= len() || cls(lines[r][c + 1]) !== cls(lines[r][c]));
        if (!stay) p = wordEnd(p);
      }
      return { r: p.r, c: p.c, inclusive: true };
    }

    // ---- motions ----------------------------------------------------------
    function motion(k, cnt, forOp) {
      const n = cnt || 1, L = len();
      switch (k) {
        case 'h': return { r, c: Math.max(0, c - n) };
        case 'l': return { r, c: Math.min(c + n, forOp ? L : Math.max(L - 1, 0)) };
        case 'j': case 'k': {
          const nr = Math.max(0, Math.min(r + (k === 'j' ? n : -n), last()));
          if (forOp && nr === r) return null;
          return { r: nr, c: Math.min(want, Math.max(len(nr) - 1, 0)), linewise: true, vert: true };
        }
        case '0': return { r, c: 0 };
        case '^': return { r, c: firstNB(r) };
        case '$': {
          const nr = Math.min(r + n - 1, last());
          return { r: nr, c: Math.max(len(nr) - 1, 0), inclusive: true, eol: true };
        }
        case 'gg': case 'G': {
          const nr = cnt ? Math.min(cnt, lines.length) - 1 : (k === 'gg' ? 0 : last());
          return { r: nr, c: firstNB(nr), linewise: true };
        }
        case 'w': {
          let p = { r, c };
          for (let i = 0; i < n; i++) p = wordFwd(p);
          if (forOp && p.r > r) p = { r: p.r - 1, c: len(p.r - 1) };
          return p;
        }
        case 'b': { let p = { r, c }; for (let i = 0; i < n; i++) p = wordBack(p); return p; }
        case 'e': { let p = { r, c }; for (let i = 0; i < n; i++) p = wordEnd(p); return { r: p.r, c: p.c, inclusive: true }; }
        case '}': {
          let q = r;
          for (let i = 0; i < n; i++) {
            if (q >= last()) break;
            q++;
            while (q < last() && lines[q].trim() !== '') q++;
          }
          return { r: q, c: lines[q].trim() === '' ? 0 : (forOp ? len(q) : Math.max(len(q) - 1, 0)) };
        }
        case '{': {
          let q = r;
          for (let i = 0; i < n; i++) {
            if (q <= 0) break;
            q--;
            while (q > 0 && lines[q].trim() !== '') q--;
          }
          return { r: q, c: 0 };
        }
        case 'C-d': case 'C-u': {
          if (forOp) return null;
          const nr = Math.max(0, Math.min(r + (k === 'C-d' ? 10 : -10), last()));
          return { r: nr, c: Math.min(want, Math.max(len(nr) - 1, 0)), vert: true };
        }
        default: return null;
      }
    }
    function moveBy(k, n) {
      const t = motion(k, n, false);
      if (!t) return;
      r = t.r; c = t.c; clamp();
      want = t.eol ? Infinity : (t.vert ? want : c);
    }

    // ---- edits ------------------------------------------------------------
    function put(after, n) {
      if (reg.text === '' && !reg.linewise) { say('Nothing in the register', 'error'); return; }
      mutated();
      if (reg.linewise) {
        const block = [];
        for (let i = 0; i < n; i++) block.push(...reg.text.split('\n'));
        const at = after ? r + 1 : r;
        lines.splice(at, 0, ...block);
        r = at; c = firstNB(r);
      } else {
        const text = reg.text.repeat(n);
        const pos = { r, c: after && len() ? c + 1 : c };
        const end = insertAt(pos, text);
        if (text.includes('\n')) { r = pos.r; c = pos.c; } else { r = end.r; c = end.c - 1; }
      }
      clamp();
    }
    function joinLines(n) {
      if (r >= last()) return;
      mutated();
      let pos = 0;
      for (let i = 0; i < n - 1 && r < last(); i++) {
        const nxt = lines[r + 1].replace(/^\s+/, ''), cur = lines[r];
        const sep = (cur === '' || nxt === '' || /\s$/.test(cur)) ? '' : ' ';
        pos = cur.length;
        lines[r] = cur + sep + nxt;
        lines.splice(r + 1, 1);
      }
      c = pos; clamp();
    }
    function replaceChars(ch, n) {
      const s = lines[r];
      if (c + n > s.length) return;
      mutated();
      lines[r] = s.slice(0, c) + ch.repeat(n) + s.slice(c + n);
      c += n - 1;
    }
    function openLine(below) {
      mutated();
      const ind = indentOf(lines[r]);
      const at = below ? r + 1 : r;
      lines.splice(at, 0, ind);
      r = at; c = ind.length; mode = 'insert'; clamp();
    }
    function enterInsert() { mode = 'insert'; clamp(); }
    function leaveInsert() { mode = 'normal'; if (c > 0) c--; clamp(); want = c; }
    function insertStr(str) {
      mutated();
      const s = lines[r];
      lines[r] = s.slice(0, c) + str + s.slice(c);
      c += str.length;
    }

    // ---- insert mode ------------------------------------------------------
    function insertKey(k) {
      switch (k) {
        case 'Esc': leaveInsert(); return;
        case 'Enter': {
          mutated();
          const s = lines[r], ind = indentOf(s.slice(0, c));
          lines[r] = s.slice(0, c).trim() === '' ? '' : s.slice(0, c);
          lines.splice(r + 1, 0, ind + s.slice(c));
          r++; c = ind.length; break;
        }
        case 'Backspace':
          if (c > 0) { mutated(); const s = lines[r]; lines[r] = s.slice(0, c - 1) + s.slice(c); c--; }
          else if (r > 0) { mutated(); const pl = len(r - 1); lines[r - 1] += lines[r]; lines.splice(r, 1); r--; c = pl; }
          break;
        case 'Delete':
          if (c < len()) { mutated(); const s = lines[r]; lines[r] = s.slice(0, c) + s.slice(c + 1); }
          else if (r < last()) { mutated(); lines[r] += lines[r + 1]; lines.splice(r + 1, 1); }
          break;
        case 'Tab': insertStr('  '); break;
        case 'ArrowLeft': if (c > 0) c--; else if (r > 0) { r--; c = len(); } break;
        case 'ArrowRight': if (c < len()) c++; else if (r < last()) { r++; c = 0; } break;
        case 'ArrowUp': if (r > 0) { r--; c = Math.min(c, len()); } break;
        case 'ArrowDown': if (r < last()) { r++; c = Math.min(c, len()); } break;
        case 'Home': c = 0; break;
        case 'End': c = len(); break;
        default: if (isChar(k)) insertStr(k); else return;
      }
      clamp(); want = c;
    }

    // ---- normal mode ------------------------------------------------------
    function opKey(k, n) {
      const o = op;
      const total = (opCount || n) ? (opCount || 1) * (n || 1) : null;
      if (k === 'i' || k === 'a') { pend = k; return; }
      if (k === o) {
        const r2 = Math.min(r + (total || 1) - 1, last());
        clearPending(); opLines(o, r, r2); want = c; return;
      }
      const t = (o === 'c' && k === 'w') ? cwTarget(total || 1) : motion(k, total, true);
      clearPending();
      if (t) applyMotionOp(o, t);
      want = c;
    }

    function normalKey(k) {
      begin();
      k = ALIAS[k] || k;
      if (pend === 'r') {
        if (isChar(k)) replaceChars(k, count ? parseInt(count, 10) : 1);
        clearPending(); want = c; return;
      }
      if (k === 'Esc') { clearPending(); return; }
      if (pend === 'i' || pend === 'a') {
        const inner = pend === 'i', o = op; pend = '';
        if (o && k === 'w') { const rg = wordObj(inner); clearPending(); if (rg) opChars(o, rg.s, rg.e); }
        else clearPending();
        want = c; return;
      }
      if (/^[1-9]$/.test(k) || (k === '0' && count !== '')) { count += k; return; }
      if (pend === 'g') { pend = ''; k = 'g' + k; }
      else if (k === 'g') { pend = 'g'; return; }
      const n = count === '' ? null : parseInt(count, 10);
      if (op) { opKey(k, n); return; }
      if (k === 'd' || k === 'y' || k === 'c') { op = k; opCount = n; count = ''; return; }
      if (k === 'r') { pend = 'r'; return; }
      count = '';
      const N = n || 1;
      switch (k) {
        case 'i': enterInsert(); break;
        case 'a': if (len()) c++; enterInsert(); break;
        case 'I': { const x = lines[r].search(/\S/); c = x < 0 ? len() : x; enterInsert(); break; }
        case 'A': c = len(); enterInsert(); break;
        case 'o': openLine(true); break;
        case 'O': openLine(false); break;
        case 'x': opChars('d', { r, c }, { r, c: Math.min(c + N, len()) }); break;
        case 'X': opChars('d', { r, c: Math.max(0, c - N) }, { r, c }); break;
        case 'D': applyMotionOp('d', motion('$', n, true)); break;
        case 'C': applyMotionOp('c', motion('$', n, true)); break;
        case 's': opChars('c', { r, c }, { r, c: Math.min(c + N, len()) }); break;
        case 'S': opLines('c', r, Math.min(r + N - 1, last())); break;
        case 'Y': opLines('y', r, Math.min(r + N - 1, last())); break;
        case 'p': case 'P': put(k === 'p', N); break;
        case 'J': joinLines(Math.max(2, N)); break;
        case 'u': for (let i = 0; i < N; i++) if (!undo()) break; break;
        case 'C-r': for (let i = 0; i < N; i++) if (!redo()) break; break;
        case 'v': anchor = { r, c }; mode = 'visual'; break;
        case 'V': anchor = { r, c }; mode = 'vline'; break;
        case ':': case '/': case '?': startCmd(k); return;
        case 'n': searchNext(lastDir); break;
        case 'N': searchNext(-lastDir); break;
        default: moveBy(k, n); return;
      }
      clamp(); want = c;
    }

    // ---- visual mode ------------------------------------------------------
    function selection() {
      if (mode !== 'visual' && mode !== 'vline') return null;
      let a = anchor, b = { r, c };
      if (a.r > b.r || (a.r === b.r && a.c > b.c)) [a, b] = [b, a];
      return { s: a, e: b, linewise: mode === 'vline' };
    }
    function exitVisual() { mode = 'normal'; anchor = null; clearPending(); clamp(); }
    function selOp(o) {
      const sel = selection();
      mode = 'normal'; anchor = null; clearPending();
      if (!sel) return;
      if (sel.linewise) opLines(o, sel.s.r, sel.e.r);
      else opChars(o, sel.s, { r: sel.e.r, c: Math.min(sel.e.c + 1, len(sel.e.r)) });
      want = c;
    }
    function visualKey(k) {
      begin();
      k = ALIAS[k] || k;
      if (k === 'Esc') { exitVisual(); return; }
      if (/^[1-9]$/.test(k) || (k === '0' && count !== '')) { count += k; return; }
      if (pend === 'g') { pend = ''; k = 'g' + k; }
      else if (k === 'g') { pend = 'g'; return; }
      const n = count === '' ? null : parseInt(count, 10);
      count = '';
      switch (k) {
        case 'v': if (mode === 'visual') exitVisual(); else mode = 'visual'; return;
        case 'V': if (mode === 'vline') exitVisual(); else mode = 'vline'; return;
        case 'o': { const t = { r, c }; r = anchor.r; c = anchor.c; anchor = t; return; }
        case 'd': case 'x': selOp('d'); return;
        case 'y': selOp('y'); return;
        case 'c': case 's': selOp('c'); return;
        case ':': case '/': case '?': startCmd(k); return;
        case 'n': searchNext(lastDir); return;
        case 'N': searchNext(-lastDir); return;
        default: moveBy(k, n);
      }
    }

    // ---- command line & search -------------------------------------------
    function startCmd(t) { anchor = null; mode = 'cmd'; cmdType = t; cmd = ''; clearPending(); }
    function cmdKey(k) {
      if (k === 'Esc') { mode = 'normal'; cmd = ''; clamp(); return; }
      if (k === 'Enter') {
        const t = cmdType, s = cmd.trim();
        mode = 'normal'; cmd = ''; clamp();
        execCmd(t, s); return;
      }
      if (k === 'Backspace') { if (!cmd) { mode = 'normal'; clamp(); } else cmd = cmd.slice(0, -1); return; }
      if (isChar(k)) cmd += k;
    }
    function execCmd(t, s) {
      if (t === '/' || t === '?') {
        if (s) lastSearch = s;
        lastDir = t === '/' ? 1 : -1;
        searchNext(lastDir); return;
      }
      if (/^\d+$/.test(s)) {
        r = Math.min(Math.max(parseInt(s, 10), 1), lines.length) - 1;
        c = firstNB(r); want = c; return;
      }
      if (!s) return;
      if (host.onEx) host.onEx(s); else say('E492: Not an editor command: ' + s, 'error');
    }
    function searchNext(dir) {
      if (!lastSearch) { say('E35: No previous search', 'error'); return; }
      const ic = lastSearch === lastSearch.toLowerCase();
      const N = lines.length;
      for (let i = 0; i <= N; i++) {
        const row = (((r + dir * i) % N) + N) % N;
        const t = ic ? lines[row].toLowerCase() : lines[row];
        let idx;
        if (dir > 0) idx = t.indexOf(lastSearch, i === 0 ? c + 1 : 0);
        else idx = i === 0 ? (c > 0 ? t.lastIndexOf(lastSearch, c - 1) : -1) : t.lastIndexOf(lastSearch);
        if (idx >= 0) { r = row; c = idx; want = c; say((dir > 0 ? '/' : '?') + lastSearch); return; }
      }
      say('E486: Pattern not found: ' + lastSearch, 'error');
    }

    // ---- public api -------------------------------------------------------
    function key(k) {
      switch (mode) {
        case 'insert': insertKey(k); break;
        case 'cmd': cmdKey(k); break;
        case 'visual': case 'vline': visualKey(k); break;
        default: normalKey(k);
      }
    }
    function load(text) {
      let t = String(text).replace(/\r\n?/g, '\n');
      if (t.endsWith('\n')) t = t.slice(0, -1);
      lines = t.split('\n'); saved = t;
      r = c = want = 0; mode = 'normal'; anchor = null; cmd = '';
      clearPending(); undoS = []; redoS = []; pre = null; preUsed = true;
      setDirty(false);
    }
    function markSaved(snapshot) { saved = snapshot; setDirty(lines.join('\n') !== saved); }
    function paste(text) {
      text = String(text).replace(/\r\n?/g, '\n');
      if (!text) return;
      if (mode === 'cmd') { cmd += text.split('\n')[0]; return; }
      if (mode === 'visual' || mode === 'vline') return;
      begin(); mutated();
      const pos = { r, c: mode === 'insert' ? c : (len() ? c + 1 : c) };
      const end = insertAt(pos, text);
      r = end.r; c = end.c;
      if (mode !== 'insert') c = Math.max(0, c - 1);
      clamp(); want = c;
    }
    function insertText(str) { if (mode === 'insert' && str) { insertStr(str); want = c; } }
    function setCursor(row, col) { if (mode === 'cmd') return; r = row; c = col; clamp(); want = c; }

    return {
      key, load, markSaved, paste, insertText, setCursor, selection,
      snapshot: () => lines.join('\n'),
      text: () => lines.join('\n') + '\n',
      pending: () => String(opCount || '') + (op || '') + count + pend,
      cmdline: () => cmdType + cmd,
      get lines() { return lines; },
      get r() { return r; },
      get c() { return c; },
      get mode() { return mode; },
      get dirty() { return dirty; },
      get register() { return reg; },
    };
  }

  const api = { createEditor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VimEditor = api;
})(typeof window !== 'undefined' ? window : globalThis);
