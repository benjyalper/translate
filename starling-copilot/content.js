/* ============================================================================
 * Starling Copilot — content script (runs inside starling.bytedance.com)
 * Does all DOM work: harvest segments, write targets back, confirm-all, diag.
 * The side panel (panel.js) talks to this via chrome.runtime messages.
 *
 * NOTE ON SELECTORS: Starling's DOM is a React app and is NOT a stable API.
 * Defaults below come from observed class names; every one is overridable from
 * the panel's Advanced → Selectors box and auto-detection fills the gaps.
 * Run "Diagnostics" in the panel after any Starling update to recalibrate.
 * ==========================================================================*/
(function () {
  // Bump on any content.js change the panel depends on. The panel PINGs for this and, if a
  // tab is running an older version, re-injects this file via chrome.scripting so stale tabs
  // self-heal (no page reload needed). Re-injection tears down the previous version's message
  // listener first (below) so there's never a double-listener race.
  const CS_VERSION = 35;
  if (window.__scVer === CS_VERSION) return;                         // this exact version already live here
  if (typeof window.__scCleanup === 'function') { try { window.__scCleanup(); } catch (e) {} }  // remove an older/stale one
  window.__scVer = CS_VERSION;
  window.__starlingCopilot = true;

  // Real inline TAG OBJECTS that won't survive a text paste/insert:
  // XLIFF inline elements + circled markers ①②… (same rule as the Copy Deck tool).
  const UNSAFE = /<\/?(?:g|x|bpt|ept|ph|it|mrk|sub)\b[^>]*>|[①-⑳❶-➓⓪]/;

  // Selectors are UNIONS covering both Starling editors (a single querySelectorAll
  // matches whichever is present):
  //   • String editor:   .render-text-target / .render-text-source / .item-no
  //   • Document editor:  .cat-content__target / .cat-content__source / .cat-content__number
  //     (list is a Semi virtual table inside .cat-content__virtual; #No. col = .sentenceKey)
  const DEFAULTS = {
    targetCell: '.render-text-target, .cat-content__target',
    sourceCell: '.render-text-source, .cat-content__source, .source-text-select-area .render-text',
    editor: '[contenteditable="true"]',
    segNo: '.item-no, .cat-content__number, .sentenceKey.semi-table-row-cell',
    // rowAncestor: how far up from a target cell the "row" element sits (auto if empty)
    confirmAllText: 'confirm proofreading for all|proofreading for all segment|confirm all',
    ignoreNormalText: 'ignore normal qa',
    yesText: '\\b(yes|confirm|ok|sure|submit|确定|确认|אישור|כן)\\b',
    // QA panel issue rows + its scroll container (best-effort; calibrate via QA_DIAG)
    qaRow: '[class*="qa"] [class*="item"],[class*="qa-list"] [class*="row"],[class*="check-item"],[class*="issue-item"]',
    qaScroll: '[class*="qa"] [class*="list"],[class*="qa-panel"] [class*="scroll"]'
  };
  let CFG = Object.assign({}, DEFAULTS);
  chrome.storage.local.get('selectors', (d) => { if (d && d.selectors) CFG = Object.assign(CFG, d.selectors); });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\s+$/g, '').trim();

  function taskId() {
    const m = location.href.match(/(?:task[_-]?id=|\/task\/|taskId[=/])(\d{6,})/i) || location.href.match(/(\d{9,})/);
    return m ? m[1] : 'starling';
  }

  // ---- element helpers -----------------------------------------------------
  function rowFor(cell) {
    // Walk up until we find an ancestor that also contains a seg-number element.
    let el = cell;
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      if (el.querySelector && el.querySelector(CFG.segNo)) return el;
      el = el.parentElement;
    }
    return cell.closest('[data-row-key],[data-index],[role="row"],li,tr') || cell.parentElement;
  }
  function segOf(row) {
    if (!row) return null;
    const n = row.querySelector && row.querySelector(CFG.segNo);
    if (!n) return null;
    const t = (n.textContent || '').replace(/[^\d]/g, '');
    return t || null;
  }
  function srcOf(row) {
    if (!row) return '';
    const s = row.querySelector && row.querySelector(CFG.sourceCell);
    return s ? readCell(s) : '';
  }
  // Reconstruct text from a cell, turning placeholder/tag "chips" back into text
  // where possible (chips usually carry their token in text/title/data-*).
  function readCell(cell) {
    if (!cell) return '';
    const parts = [];
    const walk = (node) => {
      node.childNodes.forEach((c) => {
        if (c.nodeType === 3) { parts.push(c.nodeValue); return; }
        if (c.nodeType !== 1) return;
        const chip = c.getAttribute && (c.getAttribute('data-token') || c.getAttribute('data-tag') || c.getAttribute('data-value'));
        if (chip) { parts.push(chip); return; }
        const ph = c.classList && (c.className.toString().match(/placeholder|tag|chip|token/i));
        if (ph && !c.querySelector('*')) { parts.push(c.getAttribute('title') || c.textContent || ''); return; }
        walk(c);
      });
    };
    walk(cell);
    return norm(parts.join(''));
  }

  function findScroll() {
    const c = document.querySelector(CFG.targetCell);
    let el = c;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    let best = null, bestH = 0;
    document.querySelectorAll('div,section,main,ul').forEach((e) => {
      const s = getComputedStyle(e);
      const slack = e.scrollHeight - e.clientHeight;
      if (/(auto|scroll)/.test(s.overflowY) && slack > bestH) { bestH = slack; best = e; }
    });
    return best;
  }

  // The Document editor keeps hidden measurement clones of each row (offsetParent
  // null, not rendered). Skip them so we don't harvest/write phantom duplicates.
  function shown(el) { return !!(el && el.offsetParent !== null && el.getClientRects().length); }

  // A cell holds a real inline-tag OBJECT if it renders a chip element (Document
  // editor) OR its text carries an XLIFF tag / circled marker (String editor).
  function cellHasTagEl(cell) {
    return !!(cell && cell.querySelector('[class*="tag"],[class*="placeholder"],[class*="chip"],[data-tag],[data-token],[class*="inline-code"],img'));
  }

  function collectVisible(map) {
    document.querySelectorAll(CFG.targetCell).forEach((cell) => {
      if (!shown(cell)) return;
      const row = rowFor(cell);
      const seg = segOf(row);
      if (seg == null) return;
      // Plural (one/two/many/other) segment: its cell renders ALL sub-forms, so
      // readCell would return a garbled blob ("oneHEone otherHEother…") and the
      // regular proofread/write would dump that back into the single mounted box.
      // Skip it here — plural segments are handled ONLY by the Plural card.
      if (cell.querySelector('.plural-wrapper, .plural-no')) return;
      const tgt = readCell(cell);
      const srcCell = row && row.querySelector(CFG.sourceCell);
      let src = srcCell ? readCell(srcCell) : '';
      // readCell trims edge whitespace, but Starling's blue "·" (trailing space) and
      // "↵" (trailing newline) live in the source and MUST be mirrored onto the target,
      // or Starling flags a Punctuation/Space QA error. Re-attach the source's real edge
      // whitespace so the panel carries it onto the proposal for COPY/display too — not
      // only the DOM-write path (which re-reads the raw source at write time).
      if (src && row) {
        const raw = rawSrcOfRow(row);
        const lead  = (raw.match(/^\s*/) || [''])[0];
        const trail = (raw.match(/\s*$/) || [''])[0];
        if (lead || trail) src = lead + src + trail;
      }
      const tagEl = cellHasTagEl(cell) || cellHasTagEl(srcCell);
      const prev = map.get(seg);
      if (!prev || (tgt && tgt.length > (prev.tgt || '').length) || (src && !prev.src)) {
        map.set(seg, { seg, src: src || (prev && prev.src) || '', tgt, tagEl: tagEl || (prev && prev.tagEl) });
      }
    });
  }

  // ---- HARVEST -------------------------------------------------------------
  async function harvest() {
    const map = new Map();
    const scroll = findScroll();
    if (!scroll) { collectVisible(map); return await enrichSegs(finalize(map)); }
    scroll.scrollTop = 0; await sleep(200);
    const step = Math.max(120, scroll.clientHeight * 0.7);
    let guard = 0, atBottom = 0, lastCount = -1, samePos = 0, prevTop = -1;
    while (guard++ < 400 && atBottom < 2) {
      collectVisible(map);
      prevTop = scroll.scrollTop;
      scroll.scrollTop = Math.min(scroll.scrollTop + step, scroll.scrollHeight);
      await sleep(180);
      collectVisible(map);
      if (scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2) atBottom++;
      if (scroll.scrollTop === prevTop) { if (++samePos > 3) break; } else samePos = 0;
      if (map.size === lastCount) { /* no growth this pass */ } lastCount = map.size;
    }
    collectVisible(map);
    return await enrichSegs(finalize(map));
  }
  function finalize(map) {
    const segs = [...map.values()].map((s) => ({
      seg: s.seg, src: s.src, tgt: s.tgt,
      // `chip` = a REAL inline-tag object rendered in the cell — typing over it
      // clobbers the object, so these stay copy-by-hand. `tagged` also covers
      // string placeholders ({0}, %s, <g id>…) which are plain text and SAFE to
      // auto-write (GPT preserves them byte-for-byte) — those get the ⚠ badge only.
      chip: !!s.tagEl,
      tagged: !!s.tagEl || UNSAFE.test(s.src || '') || UNSAFE.test(s.tgt || '')
    }));
    segs.sort((a, b) => (parseInt(a.seg, 10) || 0) - (parseInt(b.seg, 10) || 0));
    return segs;
  }
  // Enrich the DOM-harvested segments with per-segment metadata from the JSON API —
  // key (role hint), context (the string owner's translator note = sourceText.textComment),
  // fullSource (the complete string when this seg is a split fragment) and screenshots.
  // The API RankNo is a contiguous integer that matches the editor's displayed segment
  // number, so we join on seg === rank. Best-effort: if the API is unavailable (other
  // editor, network), the segments are returned unchanged — GPT just falls back to
  // src-only heuristics as before.
  async function enrichSegs(segs) {
    try {
      const t = taskId(); if (!t) return segs;
      const res = await apiTask(t);
      if (!res || !res.ok || !res.rows) return segs;
      const byRank = new Map(res.rows.map((r) => [String(r.rank), r]));
      for (const seg of segs) {
        const m = byRank.get(String(seg.seg));
        if (!m) continue;
        seg.key = m.key || '';
        seg.context = m.comment || '';
        seg.fullSrc = m.fullSource || '';
        seg.shots = m.shots || [];
      }
    } catch (e) { /* keep the plain DOM segments */ }
    return segs;
  }

  // ---- WRITE-BACK ----------------------------------------------------------
  function cellForSeg(seg) {
    let found = null;
    document.querySelectorAll(CFG.targetCell).forEach((cell) => {
      if (found || !shown(cell)) return;
      if (segOf(rowFor(cell)) === String(seg)) found = cell;
    });
    return found;
  }
  // Edits are written top→bottom, so on a miss we RESUME the scan from where the last
  // segment was found (forward only) instead of jumping back to scrollTop=0 every time —
  // this stops the "restart from the top after every fix" behaviour on the virtualized list.
  // Persists across writeOne/chunk calls; only a full top pass is used as a fallback.
  let lastFindTop = 0;
  async function scanFrom(seg, scroll, startTop) {
    const step = Math.max(120, scroll.clientHeight * 0.65);
    for (let pos = Math.max(0, startTop), guard = 0; guard < 500; pos += step, guard++) {
      scroll.scrollTop = pos; await sleep(170);
      const cell = cellForSeg(seg);
      if (cell) { cell.scrollIntoView({ block: 'center' }); await sleep(140); lastFindTop = scroll.scrollTop; return cellForSeg(seg) || cell; }
      if (scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2) break;   // reached the bottom
    }
    return null;
  }
  // Seg numbers (.item-no) currently rendered in the list — used to STEER the fast seek.
  function visibleSegNums() {
    const out = [];
    document.querySelectorAll(CFG.targetCell).forEach((cell) => {
      if (!shown(cell)) return;
      const n = parseInt(segOf(rowFor(cell)), 10);
      if (!isNaN(n)) out.push(n);
    });
    return out;
  }
  // FAST PATH: binary-search the scroll position by seg number instead of stepping one screen
  // at a time. Seg numbers increase top→bottom, so we read what's on screen and halve the range
  // toward the target — ~log2(rows) jumps vs a linear scan. Wrapped so ANY problem (non-monotonic
  // numbers, throw, can't converge) returns null and the proven scanFrom() takes over unchanged.
  async function seekSeg(seg, scroll) {
    try {
      const target = parseInt(seg, 10);
      if (isNaN(target)) return null;
      let lo = 0, hi = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      for (let iter = 0; iter < 14; iter++) {
        let cell = cellForSeg(seg);
        if (cell) { cell.scrollIntoView({ block: 'center' }); await sleep(120); lastFindTop = scroll.scrollTop; return cellForSeg(seg) || cell; }
        const nums = visibleSegNums();
        if (!nums.length) return null;                                  // can't steer → fall back
        const minN = Math.min(...nums), maxN = Math.max(...nums);
        if (target >= minN && target <= maxN) {                        // in the rendered band but not matched yet
          scroll.scrollTop = Math.min(hi, scroll.scrollTop + Math.max(60, scroll.clientHeight * 0.25));
          await sleep(150); continue;                                  // nudge to render it, then retry
        }
        if (target < minN) hi = scroll.scrollTop; else lo = scroll.scrollTop;
        if (hi - lo < 4) return null;                                  // converged without a hit → fall back
        scroll.scrollTop = Math.round((lo + hi) / 2);
        await sleep(150);
      }
    } catch (e) { /* fall back to scanFrom */ }
    return null;
  }
  async function scrollToSeg(seg) {
    let cell = cellForSeg(seg);
    if (cell) { cell.scrollIntoView({ block: 'center' }); await sleep(120); const s = findScroll(); if (s) lastFindTop = s.scrollTop; return cellForSeg(seg) || cell; }
    const scroll = findScroll();
    if (!scroll) return null;
    cell = await seekSeg(seg, scroll);                 // FAST: binary search by seg number
    if (cell) return cell;
    cell = await scanFrom(seg, scroll, lastFindTop);   // reliable fallback: forward from last found
    if (cell) return cell;
    return await scanFrom(seg, scroll, 0);             // last resort: full pass from the top
  }
  // Press Enter the way a human does. This LIGHT-EDITOR is a controlled React editor:
  // a trailing "\n" fed to execCommand('insertText') becomes a <div><br></div> that the
  // editor trims on save, so the source's blue "↵" never persisted. An Enter KEYDOWN makes
  // the editor insert a real newline token (<span data-other-key="\n">) that DOES save.
  function pressEnter(editor) {
    const opt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent('keydown', opt));
    try { editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })); } catch (e) {}
    editor.dispatchEvent(new KeyboardEvent('keypress', opt));
    try { editor.dispatchEvent(new InputEvent('input', { inputType: 'insertLineBreak', bubbles: true })); } catch (e) {}
    editor.dispatchEvent(new KeyboardEvent('keyup', opt));
  }
  function caretToEnd(editor) {
    const sel = window.getSelection(), r = document.createRange();
    r.selectNodeContents(editor); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
  }
  function insertText(editor, text) {
    editor.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(editor);
    sel.removeAllRanges(); sel.addRange(r);
    // Newlines can't ride along in execCommand('insertText') — the browser turns each one
    // into a <div><br></div> block that this editor drops (losing the source's ↵). So split
    // on "\n" and press Enter between parts, which the editor stores as a real newline token.
    // No-newline text (the vast majority) takes the identical single-insertText path as before.
    const parts = String(text == null ? '' : text).split('\n');
    // execCommand insertText auto-converts typed {tokens}/<tags> into protected chips
    if (parts[0]) document.execCommand('insertText', false, parts[0]);
    else document.execCommand('delete', false);   // clear the (fully-selected) editor for a leading newline
    let ok = true;
    for (let i = 1; i < parts.length; i++) {
      caretToEnd(editor);
      pressEnter(editor);
      if (parts[i]) { caretToEnd(editor); ok = document.execCommand('insertText', false, parts[i]) && ok; }
    }
    return ok;
  }
  // The target must carry the SAME leading/trailing whitespace as the source — a trailing
  // space (Starling's blue "·") or a trailing newline (the blue "↵") in the source has to be
  // in the target too, or Starling flags a Punctuation/Space QA error. GPT (and sheet finals)
  // routinely drop them. So at write time we read the source row's RAW text (no norm/trim,
  // so newlines survive) and mirror its exact edges onto what we type. Safe by construction:
  // if the DOM has no real edge whitespace, `lead`/`trail` are empty and nothing changes.
  function rawSrcOfRow(row) {
    if (!row) return '';
    const area = row.querySelector && (row.querySelector('.source-text-select-area') || row.querySelector(CFG.sourceCell));
    const inner = area && (area.querySelector('.render-text') || area);
    return inner ? (inner.textContent || '') : '';
  }
  function mirrorRowEdges(row, text) {
    const raw = rawSrcOfRow(row);
    if (!raw) return text;
    const lead = (raw.match(/^\s*/) || [''])[0];
    const trail = (raw.match(/\s*$/) || [''])[0];
    if (!lead && !trail) return text;
    const core = String(text == null ? '' : text).replace(/^\s+/, '').replace(/\s+$/, '');
    return lead + core + trail;
  }
  async function writeOne(edit) {
    const { seg, text } = edit;
    try {
      const cell = await scrollToSeg(seg);
      if (!cell) return { seg, ok: false, reason: 'row not found (virtualized/out of range)' };
      cell.click();
      await sleep(140);
      // Document editor: the target cell IS the contenteditable. String editor:
      // clicking mounts a descendant [contenteditable]. Handle both.
      const rowScope = cell.closest('.cat-content__row,[data-row-key],[role="row"],tr') || cell;
      let ed = (cell.matches && cell.matches(CFG.editor)) ? cell : (cell.querySelector(CFG.editor) || rowScope.querySelector(CFG.editor));
      for (let i = 0; i < 4 && !ed; i++) {
        await sleep(120);
        ed = (document.activeElement && document.activeElement.isContentEditable) ? document.activeElement
           : ((cell.matches && cell.matches(CFG.editor)) ? cell : cell.querySelector(CFG.editor));
      }
      if (!ed) return { seg, ok: false, reason: 'editor did not mount on click' };
      const before = ed.textContent;
      insertText(ed, mirrorRowEdges(rowScope, text));   // preserve the source's edge whitespace
      await sleep(160);
      const after = ed.textContent;
      ed.blur();
      await sleep(120);
      const chips = (ed.querySelectorAll('[class*="placeholder"],[class*="tag"],[class*="chip"],[data-token],[data-tag]') || []).length;
      return { seg, ok: true, before, after, chips };
    } catch (e) {
      return { seg, ok: false, reason: String(e && e.message || e) };
    }
  }
  async function writeAll(edits) {
    const results = [];
    for (const e of edits) {
      results.push(await writeOne(e));
      await sleep(120);
    }
    return results;
  }
  // Reveal a segment for the human: scroll it into view, click to mount the editor, and
  // place the caret in it — the old Check behaviour. Writes nothing. Returns true if the
  // cell was found (caret placement is best-effort).
  async function revealSeg(seg) {
    const cell = await scrollToSeg(seg);
    if (!cell) return false;
    try {
      cell.click();
      await sleep(120);
      const rowScope = cell.closest('.cat-content__row,[data-row-key],[role="row"],tr') || cell;
      let ed = (cell.matches && cell.matches(CFG.editor)) ? cell : (cell.querySelector(CFG.editor) || rowScope.querySelector(CFG.editor));
      for (let i = 0; i < 4 && !ed; i++) {
        await sleep(120);
        ed = (document.activeElement && document.activeElement.isContentEditable) ? document.activeElement
           : ((cell.matches && cell.matches(CFG.editor)) ? cell : cell.querySelector(CFG.editor));
      }
      if (ed && ed.focus) {
        ed.focus();
        try { const sel = window.getSelection(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); } catch (e) {}
      }
    } catch (e) {}
    return true;
  }
  // Read the SOURCE text of the row that holds a given target cell (for a pre-write sanity check).
  function srcAtCell(cell) {
    const row = rowFor(cell) || cell;
    const area = row.querySelector && row.querySelector('.source-text-select-area');
    if (area) return wbSrcOf(area);
    const sc = row.querySelector && row.querySelector(CFG.sourceCell);
    return sc ? norm(sc.textContent) : '';
  }
  // HYBRID WRITE: the API Check already pinned the exact segment by its rank/seg-number, so we
  // address the row by seg (reliable — reveal proves it lands correctly) and TYPE into the
  // editor like the old DOM engine — visible, editor-state-correct, safe to resubmit. Before
  // typing we verify the row's source still matches what the API resolved, so a rank drift can
  // never write into the wrong row. Optionally proofread-confirms. NEVER submits.
  async function wbWriteBySeg(edit) {
    const { seg, text, confirm, expectSource } = edit || {};
    try {
      const cell = await scrollToSeg(seg);
      if (!cell) return { ok: false, reason: 'row #' + seg + ' not found (virtualized / out of range)' };
      const sawSource = srcAtCell(cell);
      if (expectSource != null && String(expectSource) && srcNorm(sawSource) !== srcNorm(expectSource)) {
        return { ok: false, reason: 'source at seg #' + seg + ' no longer matches — aborted to avoid a wrong-row write', sawSource, expectSource };
      }
      cell.click(); await sleep(150);
      let ed = (cell.matches && cell.matches(CFG.editor)) ? cell : cell.querySelector(CFG.editor);
      for (let i = 0; i < 5 && !ed; i++) {
        await sleep(120);
        ed = (document.activeElement && document.activeElement.isContentEditable) ? document.activeElement
          : ((cell.matches && cell.matches(CFG.editor)) ? cell : cell.querySelector(CFG.editor));
      }
      if (!ed) return { ok: false, reason: 'editor did not mount on click' };
      const before = ed.textContent;
      insertText(ed, mirrorRowEdges(rowFor(cell) || cell, text));   // preserve the source's edge whitespace
      await sleep(180);
      const after = ed.textContent;
      ed.blur(); await sleep(180);
      let confirmed = false;
      // Confirm the row WE wrote — not firstShownTarget() (that was only correct when the old
      // engine had filtered the list to a single segment; here the list is unfiltered).
      if (confirm) confirmed = await clickRowConfirm(cell);
      return { ok: true, seg, before, after, confirmed, wrote: norm(after) === norm(text), sawSource };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  // ---- MODE 3: SHEET → STARLING WRITE-BACK (drive by KEY) ------------------
  // Panel orchestrates page navigation (all-task URL + hard reload); the content
  // script does the on-page work: filter to a key via the Search box, read the one
  // matched segment (source + current target), write the Final Translation, and
  // proofread-confirm that single row. NEVER submits the task.

  // React-controlled inputs ignore a plain `.value =` — set through the native
  // setter and dispatch 'input' so the SPA's state updates, then press Enter.
  function nativeSet(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function searchBox() {
    return document.querySelector('input[placeholder*="Search"],input[placeholder*="Ctrl"],textarea[placeholder*="Search"],input[placeholder*="搜索"]')
      || document.querySelector('.semi-input input,input[type="text"]');
  }
  function visTargets() { return [...document.querySelectorAll(CFG.targetCell)].filter(shown); }
  async function searchForKey(key) {
    const box = searchBox();
    if (!box) return false;
    const pre = visTargets().map((c) => c.textContent).join('|');
    box.focus();
    nativeSet(box, '');
    await sleep(90);
    nativeSet(box, String(key));
    await sleep(150);
    for (const t of ['keydown', 'keyup']) box.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    // Semi's list filters asynchronously — POLL until the visible target set has
    // CHANGED from before the search AND stabilised (two equal reads). Without this we
    // read the still-unfiltered row 1 (the "מכונית/Car" bug). ~3s ceiling.
    let last = null;
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const cur = visTargets().map((c) => c.textContent).join('|');
      if (cur !== pre && cur === last) return true;
      last = cur;
    }
    return true;
  }
  function firstShownTarget() { return visTargets()[0] || null; }
  // Source lives in a SEPARATE block from the target in the String editor
  // (`.source-text-select-area` wraps an `.item-no` + a `.render-text`), so read the
  // inner `.render-text` to skip the seg-number. Falls back to the other editors.
  function wbReadSource() {
    const sels = ['.source-text-select-area .render-text', '.render-text-source', '.cat-content__source', '.source_text'];
    for (const s of sels) { const e = [...document.querySelectorAll(s)].filter(shown)[0]; if (e && (e.textContent || '').trim()) return norm(e.textContent); }
    return '';
  }
  // Best-effort: does this row still carry a QA highlight (the flagged error)?
  function rowHasQaFlag(cell) {
    const row = rowFor(cell);
    const q = '[class*="error"],[class*="warning"],[class*="warn"],[class*="highlight"],[class*="wrong"],mark';
    return !!((cell && cell.querySelector(q)) || (row && row.querySelector(q)));
  }
  // Which page are we on? Lets the panel decide whether to open a task or read a segment.
  function wbCtx() {
    const url = location.href;
    let page = 'other';
    if (/#\/outside\/translate|\/translate\?/.test(url)) page = 'editor';
    else if (/#\/all-task|\/all-task/.test(url)) page = 'all-task';
    const out = { ok: true, ver: CS_VERSION, page, url, taskId: taskId() };
    if (page === 'all-task') {
      const rows = wbTaskRows();
      out.matchCount = rows.length;
      out.tasks = rows;
    }
    return out;
  }
  // Read the all-task list's Task IDs. The Task ID is the FIRST column and is marked
  // with a "T" type badge; Request ID (2nd col) is also long, so we take the first
  // long number in each row and de-dupe. Best-effort — the panel shows the count.
  function wbTaskRows() {
    const seen = new Set(), rows = [];
    const rowEls = document.querySelectorAll('[class*="table"] [class*="row"],[role="row"],tr,[class*="list-item"]');
    rowEls.forEach((r) => {
      if (r.querySelector && r.querySelector('th')) return;               // header
      const m = (r.textContent || '').match(/\b(\d{9,})\b/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return; seen.add(id);
      rows.push({ taskId: id });
    });
    return rows;
  }
  // The all-task list's "eye" action (svg.semi-icons-eye_opened, wrapped in a semi button)
  // opens the task's editor via window.open(url, '_blank'). Work button-first: there's exactly
  // one eye svg per task row, so we take each unique VISIBLE eye button (offsetParent != null)
  // and pair it with its Task ID by row position — the Task ID lives in .copy-icon-wrapper, and
  // matching on the nearest vertical top avoids Semi's duplicated fixed-column row containers.
  function wbEyeRows() {
    const btns = [...document.querySelectorAll('svg.semi-icons-eye_opened')]
      .map((s) => s.closest('button,[role="button"]'))
      .filter((b, i, a) => b && b.offsetParent !== null && a.indexOf(b) === i);
    const ids = [...document.querySelectorAll('.copy-icon-wrapper')]
      .map((w) => ({ top: w.getBoundingClientRect().top, id: (w.textContent || '').replace(/\D/g, '').slice(0, 15) }))
      .filter((c) => c.id.length >= 9);
    return btns.map((btn) => {
      const top = btn.getBoundingClientRect().top;
      let id = '', best = 40;                                           // pair with the id cell in the same row (±40px)
      for (const c of ids) { const d = Math.abs(c.top - top); if (d < best) { best = d; id = c.id; } }
      return { id, btn };
    });
  }
  // Click the eye for the matching task and hand the editor URL back to the panel, which
  // navigates the SAME tab into it (so Check/Write keep talking to one tab). We intercept
  // window.open so the eye doesn't spawn a background tab that a popup blocker might eat.
  // taskId given → open that exact row; otherwise auto-open only when there's a single row.
  function wbOpen(taskId) {
    if (!/#\/all-task|\/all-task/.test(location.href)) return { ok: false, error: 'not on the All tasks list' };
    const rows = wbEyeRows();
    if (!rows.length) return { ok: false, error: 'no task rows with an eye icon (is the list still loading?)' };
    // One eye per task is enough — if several rows match the key, just open the TOP one
    // (rows are in list order). A specific taskId, if given, still wins.
    const pick = (taskId && rows.find((r) => r.id === String(taskId))) || rows[0];
    let captured = null; const orig = window.open;
    window.open = function (u) { captured = u == null ? '' : String(u); return { closed: false, focus() {}, close() {} }; };
    try { pick.btn.click(); } finally { window.open = orig; }                 // onClick→window.open is synchronous
    if (!captured) return { ok: false, error: 'the eye click did not open a URL' };
    let url; try { url = new URL(captured, location.href).href; } catch (e) { url = captured; }
    return { ok: true, url, taskId: pick.id, count: rows.length };
  }
  // Starling's key search is a PREFIX/substring match, so filtering by one key can leave
  // several sibling segments visible (e.g. ..._title + ..._subtitle_paypal). Reading "the
  // first visible" then grabs the WRONG one. So we pair each visible target with its source
  // (both lists are in document order) and pick the pair whose SOURCE matches the sheet's
  // source — the reliable disambiguator, since we always know the source from the sheet.
  function wbShownSources() { return [...document.querySelectorAll('.source-text-select-area, .render-text-source, .cat-content__source')].filter(shown); }
  function wbSrcOf(container) {
    if (!container) return '';
    // .source-text-select-area wraps .item-no (seg number) + .render-text (the real source).
    // When we can read .render-text, the text is already clean — NEVER strip digits from it:
    // plenty of sources legitimately start with one ("3 payments of ${x} at 0% interest with").
    const inner = container.querySelector('.render-text');
    if (inner) return norm(inner.textContent);
    // Fallback: reading the wrapper, so the seg number is glued on the front. Strip the EXACT
    // seg-no text rather than any leading digits, so a real leading number survives.
    let t = norm(container.textContent);
    const no = container.querySelector('.item-no') || container.querySelector(CFG.segNo);
    const n = no ? norm(no.textContent) : '';
    if (n && t.startsWith(n)) t = norm(t.slice(n.length));
    return t;
  }
  function wbPairs() {
    const targets = visTargets(), sources = wbShownSources();
    return targets.map((t, i) => ({ target: t, source: sources[i] || null }));
  }
  // Tolerant source comparison. The sheet source and the live DOM source are the SAME
  // string, but often differ in ways that break an exact compare: smart vs straight
  // quotes/apostrophes ("wasn't"), dash variants, flag emoji / regional indicators that
  // render as image chips, and placeholders that render as chips. So we match in tiers,
  // each still requiring a UNIQUE hit among the visible rows (so we can never grab the
  // wrong sibling): exact → quote/emoji-normalized → placeholder-stripped.
  function srcNorm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[‘’ʼ′`´]/g, "'")                                   // apostrophes → '
      .replace(/[“”″«»]/g, '"')                                          // quotes → "
      .replace(/[‐-―−]/g, '-')                                                     // dashes → -
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{E0020}-\u{E007F}‍]/gu, '') // emoji/flags/VS
      .replace(/\s+/g, ' ').trim();
  }
  function srcBare(s) {
    let x = String(s == null ? '' : s);
    for (let i = 0; i < 4; i++) x = x.replace(/\{[^{}]*\}/g, ' ');                                // strip nested {ICU}/{placeholders}
    x = x.replace(/%(\d+\$)?[a-z]/gi, ' ').replace(/<[^>]+>/g, ' ');                              // %s %1$s <tags>
    return srcNorm(x).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();              // keep letters/digits only
  }
  // Smallest differing chunk between two strings (common prefix/suffix trimmed off).
  // Catches the very common "same key, new revision" edit — e.g. a currency symbol
  // swap "$" → "£" buried mid-string, which is otherwise near-impossible to eyeball.
  function miniDiff(a, b) {
    a = String(a == null ? '' : a); b = String(b == null ? '' : b);
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return { sheet: a.slice(p, a.length - s), live: b.slice(p, b.length - s) };
  }
  let wbChosenIdx = -1;
  async function wbFind(key, expectSource) {
    await searchForKey(key);
    // settle: wait until every visible target has a paired source rendered
    for (let i = 0; i < 8; i++) { const p = wbPairs(); if (p.length && p.every((x) => x.source)) break; await sleep(150); }
    const pairs = wbPairs();
    const base = { ok: true, url: location.href, taskId: taskId() };
    if (!pairs.length) return Object.assign(base, { found: false, visible: 0 });
    const liveSrcs = pairs.map((p) => wbSrcOf(p.source));
    const want = norm(expectSource == null ? '' : expectSource);
    // Unique-hit matcher for one normalization tier.
    const uniq = (fn) => { const w = fn(expectSource); if (!w) return -1; const h = []; liveSrcs.forEach((s, i) => { if (fn(s) === w) h.push(i); }); return h.length === 1 ? h[0] : -1; };
    let chosen = -1, matchTier = 'exact';
    if (want) {
      chosen = liveSrcs.findIndex((s) => s === want);
      if (chosen < 0) { chosen = uniq(srcNorm); if (chosen >= 0) matchTier = 'normalized'; }
      if (chosen < 0) { chosen = uniq(srcBare); if (chosen >= 0) matchTier = 'placeholder-stripped'; }
    } else if (pairs.length === 1) { chosen = 0; }                     // no sheet source given → only safe if unique
    if (chosen < 0) {
      wbChosenIdx = -1;
      if (want) {
        // Diagnose the COMMON near-miss: the same key exists here at a different revision,
        // where the live source is the sheet source plus extra text (or a fragment of it).
        // Writing would truncate/overreach, so we still refuse — but say exactly why.
        const w = srcNorm(expectSource);
        let rel = null;
        if (w) {
          for (let i = 0; i < liveSrcs.length; i++) {
            const l = srcNorm(liveSrcs[i]);
            if (!l || l === w) continue;
            if (l.includes(w)) { rel = { kind: 'expanded', idx: i, live: liveSrcs[i] }; break; }
            if (w.includes(l)) { rel = { kind: 'shortened', idx: i, live: liveSrcs[i] }; break; }
          }
        }
        // Nearest live source + the minimal differing chunk. Only meaningful when the two
        // strings are mostly identical (a revision edit), not two unrelated strings.
        let near = null;
        const sheetRaw = norm(expectSource == null ? '' : expectSource);
        for (let i = 0; i < liveSrcs.length; i++) {
          const d = miniDiff(sheetRaw, liveSrcs[i]);
          const size = d.sheet.length + d.live.length;
          if (!near || size < near.size) near = { idx: i, size, sheet: d.sheet, live: d.live };
        }
        if (near && near.size > 60) near = null;                      // too different to call a small edit
        return Object.assign(base, { found: false, visible: pairs.length, noSourceMatch: true, sources: liveSrcs, rel, near });
      }
      return Object.assign(base, { found: false, visible: pairs.length, ambiguous: true });
    }
    wbChosenIdx = chosen;
    const p = pairs[chosen];
    return Object.assign(base, {
      found: true, visible: pairs.length, chosen, matchTier,
      seg: segOf(p.target.closest('.segment-item') || rowFor(p.target)),
      source: wbSrcOf(p.source), target: readCell(p.target), qaFlag: rowHasQaFlag(p.target)
    });
  }
  // Proofread-confirm the row's ✓✓. Starling gives the control a stable class
  // (`text-action-confirm-icon`), so prefer that; fall back to a tooltip-hover scan
  // (labels are Semi tooltips, not text). Only ever clicks the matched control.
  async function clickRowConfirm(cell) {
    const row = cell.closest('.segment-item') || rowFor(cell); if (!row) return false;
    const isDisabled = (b) => /disabled/.test((b.className || '').toString()) || b.disabled || b.getAttribute('aria-disabled') === 'true';
    // preferred: the confirm-icon button by class (last enabled = proofread ✓✓)
    const icons = [...row.querySelectorAll('[class*="text-action-confirm"],[class*="confirm-icon"]')].filter((b) => b.offsetParent !== null && !isDisabled(b));
    if (icons.length) { icons[icons.length - 1].click(); await sleep(320); return true; }
    // 2) no-hover: match by class/aria-label/title/text (generates NO tooltips).
    const rx = /proofread|confirm|已确认|确认|確認|אישור|אשר/i;
    const btns = [...row.querySelectorAll('button,[role="button"],[class*="btn"],[class*="check"],[class*="confirm"]')].filter((e) => e.offsetParent !== null && !isDisabled(e));
    for (const b of btns) { if (rx.test(labelOf(b))) { b.click(); await sleep(300); return true; } }
    // 3) LAST resort: hover to reveal the Semi tooltip label — the ONLY branch that can pop
    // tooltips. Hover one at a time, dismiss each immediately, and in a finally force-hide any
    // tooltip Semi is still animating out, so nothing piles up on screen.
    const hovered = [];
    try {
      for (const b of btns) {
        b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        hovered.push(b);
        await sleep(150);
        const match = rx.test(labelOf(b) + ' ' + currentTooltipText());
        b.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        b.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        if (match) { b.click(); await sleep(300); return true; }
      }
    } finally {
      for (const b of hovered) { b.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })); b.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); }
      const kill = document.createElement('style');
      kill.textContent = '.semi-tooltip,.semi-popover{display:none!important}';
      document.documentElement.appendChild(kill);
      setTimeout(() => { try { kill.remove(); } catch (e) {} }, 450);
    }
    return false;
  }
  // Write one key's Final Translation, then (optionally) proofread-confirm the row.
  async function wbWrite(edit) {
    const { key, text, confirm, expectSource } = edit;
    try {
      const f = await wbFind(key, expectSource);
      if (!f.found) {
        const reason = f.noSourceMatch ? ('no visible segment matches the sheet source (search returned ' + f.visible + ' by key)')
          : f.ambiguous ? ('key matched ' + f.visible + ' segments and no sheet source to disambiguate')
            : 'segment not found via search';
        return { key, ok: false, reason, source: f.source };
      }
      // We picked BY source, so it matches; double-check defensively.
      if (expectSource != null && norm(expectSource) && norm(f.source) !== norm(expectSource)) {
        return { key, ok: false, reason: 'source mismatch — sheet source ≠ task source', source: f.source };
      }
      const cell = (wbPairs()[f.chosen] || {}).target;
      if (!cell) return { key, ok: false, reason: 'row vanished after search' };
      cell.click(); await sleep(150);
      let ed = (cell.matches && cell.matches(CFG.editor)) ? cell : cell.querySelector(CFG.editor);
      for (let i = 0; i < 5 && !ed; i++) {
        await sleep(120);
        ed = (document.activeElement && document.activeElement.isContentEditable) ? document.activeElement
          : ((cell.matches && cell.matches(CFG.editor)) ? cell : cell.querySelector(CFG.editor));
      }
      if (!ed) return { key, ok: false, reason: 'editor did not mount on click' };
      const before = ed.textContent;
      insertText(ed, text);
      await sleep(180);
      const after = ed.textContent;
      ed.blur(); await sleep(180);
      let confirmed = false;
      if (confirm) { const c2 = firstShownTarget() || cell; confirmed = await clickRowConfirm(c2); }
      return { key, ok: true, before, after, confirmed, wrote: norm(after) === norm(text) };
    } catch (e) {
      return { key, ok: false, reason: String(e && e.message || e) };
    }
  }

  // ---- CONFIRM ALL ---------------------------------------------------------
  // Icon buttons carry their label in title/aria-label or a hover Semi tooltip —
  // NOT in textContent. Match all of them.
  function labelOf(el) {
    const t = (el.textContent || '');
    const a = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip'))) || '';
    return (t + ' ' + a).replace(/\s+/g, ' ').trim();
  }
  function elByText(re, root) {
    const rx = (re instanceof RegExp) ? re : new RegExp(re, 'i');
    const sel = 'button,[role="button"],[role="menuitem"],.semi-button,.semi-dropdown-item,.semi-dropdown-item__content,.semi-select-option,.arco-btn,a,li';
    const nodes = [...(root || document).querySelectorAll(sel)];
    return nodes.find((b) => b.offsetParent !== null && rx.test(labelOf(b))) || nodes.find((b) => rx.test(labelOf(b))) || null;
  }
  function btnByText(re) { return elByText(re); }
  function currentTooltipText() {
    const tips = document.querySelectorAll('.semi-tooltip-content,.semi-popover-content,[class*="tooltip"] [class*="content"]');
    for (const t of tips) { if (t.offsetParent !== null) return t.textContent || ''; }
    return '';
  }
  function checkboxByLabel(re) {
    const rx = new RegExp(re, 'i');
    const labels = document.querySelectorAll('label,.semi-checkbox,.arco-checkbox,[role="checkbox"]');
    for (const l of labels) {
      if (rx.test((l.textContent || '').trim())) return l.querySelector('input[type="checkbox"]') || l;
    }
    return null;
  }
  async function confirmAll(ignoreNormal) {
    const rx = new RegExp(CFG.confirmAllText, 'i');
    let item = elByText(rx), triggered = false;
    // Not directly present → label is a hover tooltip and/or the action lives in a
    // dropdown. SAFELY hover toolbar buttons (hover triggers nothing) to find the
    // confirm control, then open ITS dropdown. We never blind-click other icons.
    if (!item) {
      const bar = document.querySelector('.cat-content__operate,[class*="toolbar"],[class*="tool-bar"],[class*="operate"]') || document;
      const btns = [...bar.querySelectorAll('button,.semi-button,[role="button"]')].filter((e) => e.offsetParent !== null).slice(0, 14);
      for (const b of btns) {
        b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await sleep(220);
        const isConfirm = rx.test(labelOf(b)) || rx.test(currentTooltipText());
        if (!isConfirm) { b.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })); continue; }
        // Found the confirm control. Prefer opening its dropdown caret over clicking
        // the button itself (the bare ✓ may only confirm the current segment).
        const sib = b.nextElementSibling;
        const caret = (sib && /dropdown|caret|arrow|split|trigger/i.test((sib.className || '').toString() + (sib.getAttribute && sib.getAttribute('aria-haspopup') || ''))) ? sib
          : (b.parentElement && b.parentElement.querySelector('[aria-haspopup="true"],[class*="dropdown-trigger"]'));
        if (caret && caret !== b) { caret.click(); await sleep(350); item = elByText(rx); if (item) break; }
        b.click(); await sleep(400);
        item = elByText(rx); if (item) break;
        if (checkboxByLabel(CFG.ignoreNormalText) || elByText(new RegExp(CFG.yesText, 'i'))) { triggered = true; break; }
        break; // identified the control but couldn't reveal the item — stop, don't touch other icons
      }
    }
    if (!triggered) {
      if (!item) return { ok: false, error: 'Confirm-all control not found. Its label is a Semi tooltip ("Confirm proofreading for all segments") — open the ✓ dropdown once and tell me the exact menu text, or set "confirmAllText" in Selectors.' };
      item.click(); await sleep(500);
    }
    if (ignoreNormal) {
      const cb = checkboxByLabel(CFG.ignoreNormalText);
      if (cb) { const on = cb.checked != null ? cb.checked : cb.getAttribute('aria-checked') === 'true'; if (!on) { cb.click(); await sleep(200); } }
    }
    // Scope the confirm button to the modal so we don't re-hit the toolbar control.
    const modal = document.querySelector('.semi-modal-content,.semi-modal,.semi-dialog,[role="dialog"]') || document;
    const yes = elByText(new RegExp(CFG.yesText, 'i'), modal);
    if (!yes) return { ok: false, error: 'Modal "Yes/Confirm" button not found', opened: true };
    yes.click();
    await sleep(400);
    return { ok: true };
  }

  // ---- DIAGNOSTICS ---------------------------------------------------------
  async function diag() {
    const cells = document.querySelectorAll(CFG.targetCell);
    const scroll = findScroll();
    const sampleRows = [];
    let count = 0;
    for (const cell of cells) {
      if (count++ >= 5) break;
      const row = rowFor(cell);
      sampleRows.push({ seg: segOf(row), tgt: readCell(cell).slice(0, 60), src: srcOf(row).slice(0, 60) });
    }
    // Hover each toolbar button to reveal its Semi tooltip label — use this to
    // calibrate confirmAllText when the confirm control isn't auto-found.
    const bar = document.querySelector('.cat-content__operate,[class*="toolbar"],[class*="tool-bar"],[class*="operate"]') || document.body;
    const barBtns = [...bar.querySelectorAll('button,.semi-button,[role="button"]')].filter((e) => e.offsetParent !== null).slice(0, 14);
    const toolbar = [];
    for (const b of barBtns) {
      b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(140);
      toolbar.push((labelOf(b) || currentTooltipText() || '(no label)').slice(0, 50));
      b.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    }
    return {
      ok: true,
      url: location.href,
      taskId: taskId(),
      cfg: CFG,
      found: {
        targetCells: cells.length,
        editorNow: !!document.querySelector(CFG.editor),
        segNo: document.querySelectorAll(CFG.segNo).length,
        sourceCells: document.querySelectorAll(CFG.sourceCell).length,
        confirmAllBtn: !!elByText(new RegExp(CFG.confirmAllText, 'i')),
        scrollContainer: scroll ? (scroll.className || scroll.tagName) + ' (slack ' + (scroll.scrollHeight - scroll.clientHeight) + 'px)' : null
      },
      toolbarButtons: toolbar,
      sampleRows
    };
  }

  // ---- TASK STATUS ---------------------------------------------------------
  // Read the header's progress %. Best-effort: the header shows e.g. "100%".
  function taskStatus() {
    let pct = null;
    const hdr = document.querySelector('[class*="header"],[class*="task-info"],[class*="progress"]') || document.body;
    const m = (hdr.innerText || '').match(/(\d{1,3})\s*%/);
    if (m) pct = parseInt(m[1], 10);
    return { ok: true, taskId: taskId(), percent: pct };
  }

  // ---- QA READER -----------------------------------------------------------
  // Reads the QA panel's issue list into rows {seg, level, type, desc}. The panel
  // is virtualized, so we scroll it. Selectors are best-effort + overridable via
  // CFG.qaRow / CFG.qaScroll — run QA_DIAG to calibrate against the live panel.
  const QA_LEVEL = /critical|error|严重|错误/i;
  function parseQaRow(el) {
    const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!txt) return null;
    // Prefer explicit sub-cells if present; else parse the flat row text.
    const cell = (s) => { const n = el.querySelector(s); return n ? (n.innerText || '').trim() : ''; };
    const seg = cell(CFG.segNo) || (txt.match(/#?\s*(\d{1,4})/) || [])[1] || '';
    const level = QA_LEVEL.test(txt) ? 'Critical' : 'Regular';
    return { seg: String(seg), level, type: '', desc: txt.slice(0, 160) };
  }
  async function readQA() {
    const rowSel = CFG.qaRow;
    const scroll = document.querySelector(CFG.qaScroll) || (document.querySelector(rowSel) && findScrollOf(document.querySelector(rowSel)));
    const map = new Map();
    const collect = () => document.querySelectorAll(rowSel).forEach((el) => {
      if (el.offsetParent === null) return;
      const r = parseQaRow(el); if (!r) return;
      map.set((r.seg || '') + '|' + r.desc, r);
    });
    if (scroll && scroll.scrollHeight > scroll.clientHeight + 4) {
      scroll.scrollTop = 0; await sleep(150);
      const step = Math.max(120, scroll.clientHeight * 0.7);
      for (let g = 0; g < 200; g++) { collect(); const p = scroll.scrollTop; scroll.scrollTop = Math.min(p + step, scroll.scrollHeight); await sleep(140); collect(); if (scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2 || scroll.scrollTop === p) break; }
    }
    collect();
    const rows = [...map.values()];
    return { ok: true, rows, count: rows.length, note: rows.length ? '' : 'No QA rows matched — open the QA panel and run QA diagnostics to calibrate qaRow.' };
  }
  function findScrollOf(el) {
    let n = el;
    while (n && n !== document.body) { const s = getComputedStyle(n); if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n; n = n.parentElement; }
    return null;
  }
  async function qaDiag() {
    // Dump candidate QA containers + a few sample rows for calibration.
    const cands = [];
    document.querySelectorAll('[class*="qa"],[class*="check"],[class*="issue"],[class*="error-list"]').forEach((e) => {
      const cls = (e.className || '').toString();
      if (/qa|check|issue|error/i.test(cls)) cands.push({ cls: cls.slice(0, 55), children: e.children.length, txt: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 70) });
    });
    const matched = document.querySelectorAll(CFG.qaRow);
    return { ok: true, qaRowMatches: matched.length, sample: [...matched].slice(0, 6).map((e) => (e.innerText || '').replace(/\s+/g, ' ').slice(0, 90)), candidates: cands.slice(0, 12) };
  }

  // ---- Starling JSON API ---------------------------------------------------
  // Runs INSIDE the page, so these are same-origin requests carrying the session
  // cookie exactly like Starling's own calls. Far more reliable than DOM reading:
  // exact strings (fullwidth ｜, trailing spaces, placeholders) and a stable
  // segment identity (sourceText.id) to address writes by.
  const API = 'https://starling.bytedance.com/api/text/';
  function slimRow(r) {
    const s = (r && r.sourceText) || {};
    const t = (r && r.targetText) || (s.targetTexts && s.targetTexts[0]) || {};
    return {
      rank: r && r.RankNo, sourceTextId: s.id, key: s.key, source: s.content == null ? '' : s.content,
      target: t.content == null ? '' : t.content, status: t.status, translated: t.translated,
      flowSequence: t.flowSequence, modifiable: t.isModifiableByUser !== false,
      lock: t.editorLockStatus, hasComment: !!s.hasComment, comment: s.textComment || '',
      placeholders: (s.placeholders || []).length,
      // fullSource = the COMPLETE original string when this row is only a split fragment
      // of it (splitRankNo / originalContent differ from content); '' otherwise.
      fullSource: (s.originalContent != null && s.originalContent !== s.content) ? s.originalContent : '',
      // screenshots: [{uri, rect}] — the string owner's UI screenshot(s); rect is the
      // highlighted crop {x,y,width,height} of THIS segment within the shot.
      shots: (s.screenshots || []).map((sh) => {
        let rect = null; try { rect = JSON.parse((sh.ScreenshotsInfos || [])[0] || 'null'); } catch (e) {}
        return { uri: sh.Uri || '', rect };
      }).filter((x) => x.uri),
      errs: ((t.errors || (r && r.errors) || []).length) || 0
    };
  }
  async function apiTask(taskId) {
    try {
      const u = API + 'getSourceTextListWithTargetText?limit=10000&sortType=1&offset=0&editMode=dual&taskId=' + encodeURIComponent(taskId);
      const r = await fetch(u, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
      const j = await r.json();
      if (!j || j.status_code !== 1000) return { ok: false, error: 'status_code ' + (j && j.status_code) };
      const rows = (j.data && j.data.rows) || [];
      return { ok: true, taskId: String(taskId), count: (j.data && j.data.count) || rows.length, rows: rows.map(slimRow) };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  // Enumerate the en→he tasks that contain a key. NOTE: the editor's `taskid=` URL param
  // is the row's **subtaskId** — the sibling `taskId` field is a different id and is often
  // "0". Always drive reads/writes off subtaskId.
  async function apiTasks(key) {
    try {
      const qs = 'offset=0&limit=100&progress=all&sortType=1&order=0&sourceLocales=en&targetLocales=he-IL'
        + '&locales%5BsourceLocals%5D%5B0%5D%5Bvalue%5D=en&locales%5BtargetLocals%5D%5B0%5D%5Bvalue%5D=he-IL'
        + (key ? '&textKeys=' + encodeURIComponent(key) : '');
      const r = await fetch('https://starling.bytedance.com/api/task/getAllTasks?' + qs, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
      const j = await r.json();
      if (!j || j.status_code !== 1000) return { ok: false, error: 'status_code ' + (j && j.status_code) };
      const rows = ((j.data && j.data.rows) || []).map((t) => ({
        subtaskId: String(t.subtaskId || ''), taskName: t.taskName || '',
        status: t.status, taskStatus: t.taskStatus, keys: t.numberOfTextKeys,
        src: t.sourceLocale, tgt: t.targetLocale
      })).filter((t) => t.subtaskId && t.subtaskId !== '0');
      return { ok: true, total: j.data && j.data.count, rows };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  // Atomic write + proofread-confirm (this endpoint carries the Content itself, so
  // there's no "write resets status, then re-confirm" window). Never submits.
  async function apiConfirm(p) {
    try {
      const body = {
        SubTaskID: String(p.taskId), TextKey: p.key, sourceTextId: p.sourceTextId,
        FlowSequence: p.flowSequence == null ? 2 : p.flowSequence,
        IgnoreQa: !!p.ignoreQa, TMScore: '0', PreTranslationType: 0,
        targetText: { Content: p.text, OrderSourceID: p.sourceTextId, TextKey: p.key }
      };
      const r = await fetch(API + 'confirmTextTaskTargetV2', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      let j = null; try { j = await r.json(); } catch (e) {}
      const ok = r.ok && (!j || j.status_code === 1000);
      return { ok, http: r.status, status_code: j && j.status_code, msg: (j && (j.status_message || j.message)) || '' };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // ---- CONFIRM ALL (API) ---------------------------------------------------
  // The toolbar ✓ "confirm proofreading for all" is a Semi split-button with no text
  // label and a portal dropdown — brittle to click and it breaks under page zoom. But
  // its per-segment effect is a plain POST to confirmTextTaskTargetV2 (proven: that's
  // exactly what a single ✓ click fires). So confirm-all = iterate that endpoint over
  // every not-yet-confirmed segment. Zero DOM, zoom-proof, and it re-reads to verify.
  // targetText.status === 3 means proofread-confirmed; 1 means edited/unconfirmed.
  async function confirmOne(row, ignoreQa) {
    const body = {
      SubTaskID: String(row.subtaskId), TextKey: row.key, sourceTextId: row.sourceTextId,
      FlowSequence: row.flowSequence == null ? 2 : row.flowSequence,
      IgnoreQa: !!ignoreQa, TMScore: '0', PreTranslationType: 0,
      targetText: { Content: row.target, OrderSourceID: row.sourceTextId, TextKey: row.key }
    };
    const r = await fetch(API + 'confirmTextTaskTargetV2', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { ok: r.ok && (!j || j.status_code === 1000), http: r.status, status_code: j && j.status_code, msg: (j && (j.status_message || j.message)) || '' };
  }
  function pendingConfirmRows(rows, tid) {
    const out = [];
    for (const row of rows) {
      const s = row.sourceText || {}, t = row.targetText || {};
      const target = t.content == null ? '' : String(t.content);
      // needs confirm = has a real target, not already confirmed (status 3), still editable by us
      if (t.status !== 3 && target.trim() && t.isModifiableByUser !== false) {
        out.push({ rank: row.RankNo, subtaskId: tid, key: s.key, sourceTextId: s.id, target, flowSequence: t.flowSequence });
      }
    }
    return out;
  }
  async function apiConfirmAll(p) {
    p = p || {};
    const tid = p.taskId || taskId();
    const ignoreQa = p.ignoreQa !== false;   // default true — mirrors "ignore normal QA errors"
    try {
      const u = API + 'getSourceTextListWithTargetText?limit=10000&sortType=1&offset=0&editMode=dual&taskId=' + encodeURIComponent(tid);
      const j = await fetch(u, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then((r) => r.json());
      if (!j || j.status_code !== 1000) return { ok: false, error: 'read failed (status_code ' + (j && j.status_code) + ')' };
      const pending = pendingConfirmRows((j.data && j.data.rows) || [], tid);
      if (p.dryRun) return { ok: true, taskId: String(tid), count: pending.length, pending: pending.map((x) => x.rank) };
      if (!pending.length) return { ok: true, taskId: String(tid), attempted: 0, confirmed: 0, failed: [], note: 'Nothing to confirm — all segments already confirmed.' };
      const failed = [];
      let done = 0;
      for (const row of pending) {
        const res = await confirmOne(row, ignoreQa);
        if (res.ok) done++;
        else failed.push({ rank: row.rank, msg: res.msg || ('status_code ' + res.status_code) || ('HTTP ' + res.http) });
        await sleep(60);   // gentle pacing so we don't hammer the endpoint
      }
      // verify: re-read and see what (if anything) is still unconfirmed
      let remaining = null;
      const v = await fetch(u, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then((r) => r.json()).catch(() => null);
      if (v && v.status_code === 1000) remaining = pendingConfirmRows((v.data && v.data.rows) || [], tid).map((x) => x.rank);
      return { ok: failed.length === 0 && (!remaining || remaining.length === 0), taskId: String(tid), attempted: pending.length, confirmed: done, failed, remaining };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // Atomic WRITE + proofread-confirm for a set of edits, straight through the API —
  // no DOM typing, so it can't race Starling's autosave-on-blur. confirmTextTaskTargetV2
  // carries the Content itself, so one call both writes the target and confirms it. We
  // look up each segment's identity (sourceTextId / key / flowSequence) from the task JSON
  // by its rank (= the editor's segment number). edits: [{ seg, text }].
  async function apiWriteConfirm(edits, ignoreQa) {
    try {
      const tid = taskId();
      const res = await apiTask(tid);
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'could not read the task' };
      const byRank = new Map(res.rows.map((r) => [String(r.rank), r]));
      const results = [];
      for (const e of (edits || [])) {
        const row = byRank.get(String(e.seg));
        if (!row) { results.push({ seg: e.seg, ok: false, reason: 'segment #' + e.seg + ' not found in task' }); continue; }
        if (!row.sourceTextId) { results.push({ seg: e.seg, ok: false, reason: 'no sourceTextId for #' + e.seg }); continue; }
        const body = {
          SubTaskID: String(tid), TextKey: row.key, sourceTextId: row.sourceTextId,
          FlowSequence: row.flowSequence == null ? 2 : row.flowSequence,
          IgnoreQa: ignoreQa !== false, TMScore: '0', PreTranslationType: 0,
          targetText: { Content: String(e.text == null ? '' : e.text), OrderSourceID: row.sourceTextId, TextKey: row.key }
        };
        try {
          const r = await fetch(API + 'confirmTextTaskTargetV2', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
          });
          let j = null; try { j = await r.json(); } catch (er) {}
          results.push({ seg: e.seg, ok: r.ok && (!j || j.status_code === 1000), status_code: j && j.status_code, msg: (j && (j.status_message || j.message)) || '' });
        } catch (err) { results.push({ seg: e.seg, ok: false, reason: String(err && err.message || err) }); }
        await sleep(60);
      }
      return { ok: results.length > 0 && results.every((x) => x.ok), attempted: results.length, confirmed: results.filter((x) => x.ok).length, results };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // ---- SUBMIT TASK (DOM) ---------------------------------------------------
  // Unlike confirm, the final submit fires over a non-HTTP channel (WebSocket/internal) —
  // there's no endpoint to replay. But its whole flow is TEXT-LABELLED, so a text-matched
  // DOM walk is reliable and zoom-proof (no coordinates): the "Submit task" split-button →
  // "Submit all translations" menu item → a confirm modal whose primary button also reads
  // "Submit task" (Cancel is the other). We scope the confirm to the modal so we don't
  // re-hit the toolbar trigger, and verify by watching the trigger flip to "Task submitted".
  function submitTrigger() {
    // Tolerate a trailing dropdown caret / whitespace on the label (▾▼▽⌄∨ …),
    // so "Submit task ▾" still matches as well as a bare "Submit task".
    const clean = (s) => (s || '').replace(/[▲▼▴▾▸◂∨⌄﹀˅ˇ]/g, '').replace(/\s+/g, ' ').trim();
    const rx = /^(submit task|task submitted|提交任务|已提交)$/i;
    const scope = document.querySelector('.text-editor-header-right') || document;
    return [...scope.querySelectorAll('button,.semi-button')].find((b) => b.offsetParent !== null && rx.test(clean(b.textContent)))
      || [...document.querySelectorAll('button,.semi-button')].find((b) => b.offsetParent !== null && rx.test(clean(b.textContent))) || null;
  }
  async function domSubmit() {
    try {
      // After a page reload the content script pings ready BEFORE the SPA has
      // re-rendered the header, so the button often isn't there for the first
      // second or two. Poll for it instead of failing on the first miss.
      let trigger = null;
      for (let i = 0; i < 30; i++) { trigger = submitTrigger(); if (trigger) break; await sleep(300); }
      if (!trigger) return { ok: false, error: 'Submit-task button not found in the header (page may still be loading — try ➤ Submit task again).' };
      const before = (trigger.textContent || '').trim();
      // Already submitted (button reads "Task submitted") → nothing to do, report success.
      if (/task submitted|已提交/i.test(before)) return { ok: true, submitted: true, already: true, before };
      trigger.click(); await sleep(400);
      const itemRx = /submit all translations|提交全部翻译|提交所有/i;
      let item = [...document.querySelectorAll('.semi-dropdown-item')].find((e) => e.offsetParent !== null && itemRx.test(e.textContent || ''));
      if (!item) { trigger.click(); await sleep(450); item = [...document.querySelectorAll('.semi-dropdown-item')].find((e) => e.offsetParent !== null && itemRx.test(e.textContent || '')); }
      if (!item) return { ok: false, error: 'The "Submit all translations" menu item did not appear.' };
      if (/disable/.test((item.className || '').toString()) || item.getAttribute('aria-disabled') === 'true') {
        document.body.click();
        return { ok: false, disabled: true, error: 'The "Submit all translations" option is disabled — nothing to submit (task already submitted with no pending changes). Edit/confirm a segment first.' };
      }
      item.click(); await sleep(550);
      // Confirm modal: primary button reads "Submit task"; Cancel is the other. Scope to the modal.
      const modal = [...document.querySelectorAll('.semi-modal-content,.semi-modal,.semi-dialog,[role="dialog"]')].find((m) => m.offsetParent !== null);
      if (!modal) return { ok: false, error: 'The submit confirmation popup did not appear.' };
      const mbtns = [...modal.querySelectorAll('button,.semi-button')].filter((b) => b.offsetParent !== null && !/cancel|取消/i.test(b.textContent || ''));
      const confirm = mbtns.find((b) => /semi-button-primary/.test((b.className || '').toString()))
        || mbtns.find((b) => /^\s*(submit task|submit|提交|确定|确认)\s*$/i.test((b.textContent || '').trim()))
        || mbtns[0];
      if (!confirm) return { ok: false, error: 'Could not find the confirm button in the submit popup.', modalText: (modal.innerText || '').replace(/\s+/g, ' ').slice(0, 120) };
      confirm.click();
      // Verify by the RESULT, not the modal: a brief success dialog can keep a modal on screen
      // (that was the false "Submit failed"). The real signal is the trigger flipping
      // "Submit task" → "Task submitted". Poll up to ~6s; it usually lands in <1s.
      let now = before, submitted = false;
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        const t = submitTrigger();
        now = t ? (t.textContent || '').trim() : now;
        if (/submitted|已提交/i.test(now)) { submitted = true; break; }
      }
      return { ok: submitted, submitted, before, buttonNow: now };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // ---- PLURAL (ICU one/two/many/other) support -----------------------------
  // A plural segment is ONE data-API row whose source/target `textExtra` =
  // {zero,one,two,few,many,other}. The editor renders 4 TARGET `.plural-wrapper`
  // blocks (label `.plural-no`); only the focused form has a live `.dual-editor-
  // content` (LIGHT-EDITOR) — the rest are `.dual-editor-content-div` placeholders
  // that mount on click. READS come from the API (all forms, no lazy problem);
  // WRITES filter the segment into view, then mount+insertText each form (auto-saves).
  const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
  function nonEmptyForms(obj) {
    const o = {};
    if (obj) PLURAL_FORMS.forEach((f) => { const v = obj[f]; if (v != null && String(v).trim() !== '') o[f] = String(v); });
    return o;
  }
  async function apiPlurals(id) {
    try {
      const tid = id || taskId();
      const u = API + 'getSourceTextListWithTargetText?limit=10000&sortType=1&offset=0&editMode=dual&taskId=' + encodeURIComponent(tid);
      const r = await fetch(u, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
      const j = await r.json();
      if (!j || j.status_code !== 1000) return { ok: false, error: 'status_code ' + (j && j.status_code) };
      const rows = (j.data && j.data.rows) || [];
      const plurals = [];
      for (const row of rows) {
        const s = row.sourceText || {}, t = row.targetText || {};
        const srcForms = nonEmptyForms(s.textExtra), tgtForms = nonEmptyForms(t.textExtra);
        const isPlural = Object.keys(srcForms).length || Object.keys(tgtForms).length || /,\s*plural\s*,/.test(String(t.content || s.content || ''));
        if (!isPlural) continue;
        plurals.push({ rank: row.RankNo, key: s.key, srcForms, tgtForms });
      }
      return { ok: true, taskId: String(tid), count: plurals.length, plurals };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  function targetPluralWrappers() { return [...document.querySelectorAll('.plural-wrapper')].filter((w) => w.closest('[class*="target"]')); }
  function pluralWrapperFor(form) {
    return targetPluralWrappers().find((w) => { const l = w.querySelector('.plural-no'); return l && l.textContent.trim() === form; });
  }
  // Write ONE plural form: mount its (lazy) editor, replace all, settle, verify;
  // retry once on mismatch. Generous waits — a too-fast write races the filter/mount
  // re-render and silently leaves the box unchanged (the v23 bug).
  async function writeOnePluralForm(form, text) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const w = pluralWrapperFor(form);
      if (!w) { await sleep(350); continue; }
      let ce = w.querySelector('[contenteditable="true"]');
      if (!ce) {
        const ph = w.querySelector('.dual-editor-content-div') || w;
        ['mousedown', 'mouseup', 'click'].forEach((t) => ph.dispatchEvent(new MouseEvent(t, { bubbles: true })));
        for (let i = 0; i < 25 && !ce; i++) { await sleep(100); ce = w.querySelector('[contenteditable="true"]'); }
      }
      if (!ce) { await sleep(300); continue; }
      insertText(ce, String(text));
      await sleep(500);
      if (norm(ce.innerText) === norm(String(text))) return { ok: true, got: ce.innerText.slice(0, 60) };
    }
    const w2 = pluralWrapperFor(form), ce2 = w2 && w2.querySelector('[contenteditable="true"]');
    return { ok: false, reason: 'mount/verify failed', got: ce2 ? ce2.innerText.slice(0, 60) : '' };
  }
  // Distinctive English chunk for the search box: strip {placeholders}/ICU braces.
  function pluralSearchStr(edit) {
    const s = (edit.srcForms && (edit.srcForms.other || edit.srcForms.one)) || (edit.tgtForms && (edit.tgtForms.other || edit.tgtForms.one)) || '';
    // Search a CONTIGUOUS literal run of the form — NOT the placeholders stripped-and-collapsed.
    // Stripping "({num} rooms)" → "( rooms)" spans the placeholder gap and matches nothing in
    // Starling's search (its source still contains "{num}"), so the segment never comes into view.
    // Split on {placeholders}, drop surrounding punctuation, and take the longest remaining chunk
    // (e.g. "rooms", "Redeem this voucher within") — that substring really exists in the source.
    const chunks = String(s).split(/\{[^}]*\}/)
      .map((x) => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim())
      .filter((x) => x.length >= 2);
    chunks.sort((a, b) => b.length - a.length);
    return (chunks[0] || String(s).replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 40);
  }
  function searchClear() {
    const b = searchBox();
    if (b) { nativeSet(b, ''); for (const t of ['keydown', 'keyup']) b.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); }
  }
  // edit = { rank, key, srcForms, forms:{one:he,two:he,...} }. Writes each provided form.
  async function writePlural(edit) {
    const results = {};
    const q = pluralSearchStr(edit);
    if (q) await searchForKey(q);
    // Wait for the filtered segment's plural wrappers to appear AND stop changing —
    // writing before the list settles is what corrupted the first form(s) in v23.
    let n = -1;
    for (let i = 0; i < 30; i++) { await sleep(120); const c = targetPluralWrappers().length; if (c > 0 && c === n) break; n = c; }
    if (!targetPluralWrappers().length) { searchClear(); return { ok: false, rank: edit.rank, error: 'plural segment not in view (search "' + q + '")' }; }
    for (const form of PLURAL_FORMS) {
      const text = edit.forms && edit.forms[form];
      if (text == null) continue;
      results[form] = await writeOnePluralForm(form, String(text));
    }
    searchClear();
    return { ok: Object.keys(results).length > 0 && Object.values(results).every((r) => r.ok), rank: edit.rank, results };
  }

  // ---- message router ------------------------------------------------------
  const __onMessage = (msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case 'PING':
            sendResponse({ ok: true, ver: CS_VERSION, url: location.href, taskId: taskId(), cells: document.querySelectorAll(CFG.targetCell).length });
            break;
          case 'DIAG': sendResponse(await diag()); break;
          case 'HARVEST': sendResponse({ ok: true, segments: await harvest() }); break;
          case 'WRITE': sendResponse({ ok: true, results: await writeAll(msg.edits || []) }); break;
          case 'HARVEST_PLURALS': sendResponse(await apiPlurals(msg.taskId)); break;
          case 'WRITE_PLURAL': sendResponse(await writePlural(msg.edit || {})); break;
          case 'CONFIRM_ALL': sendResponse(await confirmAll(msg.ignoreNormal !== false)); break;
          case 'API_CONFIRM_ALL': sendResponse(await apiConfirmAll(msg.opts || {})); break;
          case 'API_WRITE_CONFIRM': sendResponse(await apiWriteConfirm(msg.edits || [], msg.ignoreQa)); break;
          case 'SUBMIT_TASK': sendResponse(await domSubmit()); break;
          case 'WB_CTX': sendResponse(wbCtx()); break;
          case 'WB_OPEN': sendResponse(wbOpen(msg.taskId)); break;
          case 'WB_FIND': sendResponse(await wbFind(msg.key, msg.expectSource)); break;
          case 'WB_WRITE': sendResponse(await wbWrite(msg.edit || {})); break;
          case 'TASK_STATUS': sendResponse(taskStatus()); break;
          case 'READ_QA': sendResponse(await readQA()); break;
          case 'QA_DIAG': sendResponse(await qaDiag()); break;
          case 'SET_SELECTORS': CFG = Object.assign({}, DEFAULTS, msg.selectors || {}); sendResponse({ ok: true, cfg: CFG }); break;
          default: sendResponse({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // keep the message channel open for async sendResponse
  };
  chrome.runtime.onMessage.addListener(__onMessage);
  // Direct call surface for the panel via chrome.scripting.executeScript — bypasses the
  // message channel entirely, so it can't be hijacked/masked by a stale listener. Always
  // reflects THIS (latest-loaded) version's functions.
  window.__wb = {
    ver: CS_VERSION, ctx: () => wbCtx(), find: (k, s) => wbFind(k, s), write: (e) => wbWrite(e || {}),
    apiTask: (id) => apiTask(id), apiConfirm: (p) => apiConfirm(p || {}), apiTasks: (k) => apiTasks(k),
    apiConfirmAll: (p) => apiConfirmAll(p || {}), apiWriteConfirm: (e, q) => apiWriteConfirm(e || [], q), submitTask: () => domSubmit(),
    reveal: (seg) => revealSeg(seg).then((c) => !!c).catch(() => false),
    writeSeg: (e) => wbWriteBySeg(e || {}),
    eyeRows: () => wbEyeRows().map((r) => r.id), open: (id) => wbOpen(id)
  };
  // Let a newer re-injection of this file cleanly replace us (no double-listener race).
  window.__scCleanup = () => { try { chrome.runtime.onMessage.removeListener(__onMessage); } catch (e) {} };
})();
