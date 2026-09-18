/* Starling Copilot — YiCAT (self-hosted Tmxmall) content script (isolated world).
 *
 * Harvest is a clean same-origin REST GET the editor itself uses:
 *   GET /yizhe/cat/segment?group_id={g}&document_id=&task_id={t}&seg_range=1-{N}
 *   → { segment:[ { _id, seqNum, hasConfirmed, lockStatus, matchingRate,
 *                   srcSegmentAtoms, tgtSegmentAtoms, editTgtSegmentAtoms, … } ], status }
 *
 * A "segment atom" is { data, textStyle:"regular"|"tag", tag, tagType, placeholder, … }.
 * A regular atom is a run of text; a tag atom is either:
 *   • a whole-segment STYLE wrapper — a <gN>…</gN> pair (styleContent like
 *     "color:#000000;font-size:12.0px") wrapping the entire segment. This is cosmetic,
 *     NOT a real placeholder, so we strip it and treat the segment as untagged; or
 *   • a real inline PLACEHOLDER (placeholder:true, e.g. <Xpt1/>) or a mid-text tag —
 *     surfaced to the panel as a circled marker ①②③ and the segment flagged ⚑ tags.
 *
 * WRITING: YiCAT commits over a WebSocket (no REST write), and each target cell is its
 * own Tiptap/ProseMirror editor. A content script (isolated world) can't reach that
 * editor object, so the actual write runs in the MAIN world (yicat-main.js) through the
 * editor's own Tiptap commands (clearContent + insertContent) and is read-back VERIFIED
 * — it never claims success unless the cell ends up exactly right. Writes are drafts
 * only; a human confirms each segment. The default workflow is still COPY (safe).
 */
(() => {
  'use strict';
  const CS_VERSION = 4;

  // ---- context: group / task / project / doc from the URL ------------------
  function ctx() {
    const gm = location.pathname.match(/\/yizhe\/yicat\/group\/([^/]+)\//);
    const q = new URLSearchParams(location.search);
    const groupId = gm ? gm[1] : (q.get('groupId') || '');
    const taskId = q.get('taskId') || '';
    if (!groupId || !taskId) return null;
    return { groupId, taskId, projectId: q.get('projectId') || '', docId: q.get('docId') || '' };
  }

  function segUrl(range) {
    const c = ctx();
    if (!c) return null;
    return `/yizhe/cat/segment?group_id=${encodeURIComponent(c.groupId)}` +
      `&document_id=&task_id=${encodeURIComponent(c.taskId)}` +
      `&seg_range=${range}&_u=${Date.now()}`;
  }

  async function apiGet(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) {
      let body = '';
      try { body = (await r.text()).slice(0, 300); } catch (e) {}
      throw new Error(`YiCAT API GET → HTTP ${r.status}${body ? ' · ' + body : ''}`);
    }
    return r.json();
  }

  // ---- tag markers <-> string (same scheme as memoq.js) --------------------
  function tagMarker(i) {                       // i is 0-based
    if (i < 20) return String.fromCodePoint(0x2460 + i);        // ①..⑳
    if (i < 35) return String.fromCodePoint(0x3251 + (i - 20)); // ㉑..㉟
    return String.fromCodePoint(0xE000 + (i - 35));             // PUA, still one char
  }

  const isTagAtom = (a) => !!(a && (a.tag === true || a.textStyle === 'tag'));

  // A <gN>…</gN> pair wrapping the WHOLE segment (opening first, closing last, no tag
  // atoms strictly between) is a cosmetic style wrapper — not a real placeholder.
  function isWholeWrap(atoms) {
    if (!Array.isArray(atoms) || atoms.length < 2) return false;
    const f = atoms[0], l = atoms[atoms.length - 1];
    if (!(f.openingTag && l.closingTag)) return false;
    for (let i = 1; i < atoms.length - 1; i++) if (isTagAtom(atoms[i])) return false;
    return true;
  }

  // Decode one atom array → { text: string with ①-markers for REAL tags, realTags: n }.
  // A whole-segment style wrapper is stripped (its inner text is emitted verbatim, no marker).
  function decodeSide(atoms) {
    const out = { text: '', realTags: 0 };
    if (!Array.isArray(atoms)) return out;
    const list = isWholeWrap(atoms) ? atoms.slice(1, -1) : atoms;
    for (const a of list) {
      if (isTagAtom(a)) {
        out.text += tagMarker(out.realTags);
        out.realTags++;
      } else {
        out.text += (a && a.data != null) ? String(a.data) : '';
      }
    }
    return out;
  }

  // Strip ①-markers → plain text (what you paste / write into a cell).
  function stripMarkers(text) {
    let out = '';
    for (const ch of Array.from(String(text || ''))) {
      const cp = ch.codePointAt(0);
      const isMarker = (cp >= 0x2460 && cp <= 0x2473) || (cp >= 0x3251 && cp <= 0x325f) || (cp >= 0xE000 && cp <= 0xF8FF);
      if (!isMarker) out += ch;
    }
    return out;
  }

  // ---- harvest -------------------------------------------------------------
  async function harvest() {
    if (!ctx()) throw new Error('Not a YiCAT editor URL (open a task in the editor).');
    // The segment API's range END is EXCLUSIVE: seg_range=1-500 returns 499 rows (segs 1-499),
    // 1-200 returns 199, etc. So we CANNOT decide "last page" from rows.length < CHUNK (it's
    // always short by one and would stop after the very first chunk — the old bug that capped a
    // 45-page task at ~499 segments). Instead advance past the HIGHEST seqNum actually returned
    // and keep going until a page comes back empty; dedupe by _id so any overlap is harmless.
    const CHUNK = 500;
    const all = [], seen = new Set();
    let start = 1;
    for (let guard = 0; guard < 4000; guard++) {          // hard safety cap (≈2M segments)
      const end = start + CHUNK - 1;
      let rows;
      try {
        const j = await apiGet(segUrl(`${start}-${end}`));
        rows = (j && Array.isArray(j.segment)) ? j.segment : [];
      } catch (e) {
        if (start === 1) throw e;               // genuine failure on the first page
        break;                                  // a later over-range page just means we're done
      }
      if (!rows.length) break;                  // no more segments → done
      let maxSeq = start - 1, added = 0;
      for (const row of rows) {
        if (row && row._id != null && !seen.has(row._id)) { seen.add(row._id); all.push(row); added++; }
        const sn = row && +row.seqNum; if (!isNaN(sn) && sn > maxSeq) maxSeq = sn;
      }
      const next = Math.max(maxSeq + 1, start + 1);   // step to just past the highest seq we got (no boundary gap)
      if (next <= start || added === 0) break;         // no forward progress → stop (avoids an infinite loop)
      start = next;
    }
    const segs = all.map((row) => {
      const src = decodeSide(row.srcSegmentAtoms);
      const tgtAtoms = (row.tgtSegmentAtoms && row.tgtSegmentAtoms.length)
        ? row.tgtSegmentAtoms : row.editTgtSegmentAtoms;
      const tgt = decodeSide(tgtAtoms);
      return {
        segId: row._id,
        seq: row.seqNum,
        src: src.text, tgt: tgt.text,
        // only REAL inline tags (placeholders / mid-text) count — not the cosmetic
        // whole-segment <g1> style wrapper that wraps ~60% of segments.
        tagged: src.realTags > 0 || tgt.realTags > 0,
        confirmed: !!row.hasConfirmed,
        locked: !!row.lockStatus,
        matchRate: row.matchingRate
      };
    }).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    return segs;
  }

  // ---- pagination (the editor shows PAGE_SIZE segments per page) -------------
  // YiCAT's editor paginates the segment table (a custom pager: ".page-postion" with an
  // "N/M" label, prev/next arrows, and a "Go to page" number input). A cell's Tiptap editor
  // only exists while its page is shown, so writing / scrolling to a segment on another page
  // first needs to navigate there. Harvest already reads EVERY page through the REST API, so
  // only write/scroll are page-bound. Page size is a fixed 100 (verified: p1=1-100, p2=101-200).
  const PAGE_SIZE = 100;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function rowFor(segId) {
    try {
      const esc = (window.CSS && CSS.escape) ? CSS.escape(segId) : String(segId).replace(/["\\]/g, '\\$&');
      const p = document.querySelector('.tgt-table-cell [contenteditable] p[segid="' + esc + '"]');
      return p && p.closest('tr.el-table__row, tr, [role="row"]');
    } catch (e) { return null; }
  }
  function pagerInfo() {
    const el = document.querySelector('.page-postion .page-text');
    const m = (el && el.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
    return { cur: m ? +m[1] : 1, total: m ? +m[2] : 1, hasPager: !!m };
  }
  // Jump to page p by driving the "Go to page" number input (set value + Enter), then wait for
  // the pager's own "N/M" label to read p. Bounded so a stuck render can't hang the write loop.
  async function gotoPage(p) {
    const info = pagerInfo();
    if (!info.hasPager || info.cur === p) return info.cur === p || !info.hasPager;
    const jump = document.querySelector('.page-postion .el-input__inner');
    if (!jump) return false;
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      jump.focus(); setter.call(jump, String(p));
      jump.dispatchEvent(new Event('input', { bubbles: true }));
      jump.dispatchEvent(new Event('change', { bubbles: true }));
      jump.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      jump.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } catch (e) { return false; }
    for (let i = 0; i < 50; i++) { await sleep(300); if (pagerInfo().cur === p) return true; }
    return pagerInfo().cur === p;
  }
  // Make sure a segment's row is mounted: if it's not in the DOM, navigate to its page (seq→page)
  // and wait for the row to render. Returns true once the row exists.
  async function ensureSeg(segId, seq) {
    if (rowFor(segId)) return true;
    if (!seq || !pagerInfo().hasPager) return !!rowFor(segId);
    const page = Math.ceil(seq / PAGE_SIZE);
    await gotoPage(page);
    for (let i = 0; i < 30; i++) { if (rowFor(segId)) return true; await sleep(200); }
    return !!rowFor(segId);
  }

  // ---- scroll a segment into view (isolated world — pure DOM, no Tiptap) ----
  // YiCAT is an Element-UI table (rows in .el-table__body-wrapper). Bringing the row
  // into view lets the human watch each write land, and helps YiCAT mount the cell's
  // editor for a row that was scrolled far off. Located by the target cell's p[segid].
  // If seq is given and the row isn't on the current page, it navigates to that page first.
  async function scrollToSeg(segId, seq) {
    await ensureSeg(segId, seq);
    const row = rowFor(segId);
    if (row && row.scrollIntoView) { row.scrollIntoView({ block: 'center' }); return true; }
    return false;
  }

  // ---- write: bridge to the MAIN world (yicat-main.js drives Tiptap) --------
  function mainWrite(segId, text, tracked) {
    return new Promise((resolve) => {
      const reqId = 'yc' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { cleanup(); resolve({ ok: false, segId, error: 'no response from the page bridge — reload the YiCAT page' }); }, 6000);
      function onMsg(ev) {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.__ycmain !== 'res' || d.reqId !== reqId) return;
        cleanup();
        const res = d.res || { ok: false, error: 'no result' };
        res.segId = segId;
        resolve(res);
      }
      function cleanup() { clearTimeout(timer); window.removeEventListener('message', onMsg); }
      window.addEventListener('message', onMsg);
      window.postMessage({ __ycmain: 'req', op: 'write', reqId, segId, text: String(text || ''), tracked }, '*');
    });
  }
  // Write each edit, navigating across pages as needed. Edits are written in segment order so
  // the pager advances forward one page at a time (cheapest) instead of thrashing back and forth.
  async function writeAll(edits, tracked) {
    const list = (edits || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const results = [];
    for (const e of list) {
      const onPage = await ensureSeg(e.segId, e.seq);  // navigate to the segment's page if it isn't mounted
      if (!onPage) { results.push({ ok: false, segId: e.segId, error: 'could not reach segment #' + (e.seq || '?') + ' (page not found)' }); continue; }
      await scrollToSeg(e.segId, e.seq);               // bring the row into view (visible + mounts the editor)
      await sleep(240);                                // let the scroll + editor mount settle
      results.push(await mainWrite(e.segId, stripMarkers(e.text), tracked));
      await sleep(180);                                // gentle; let the WS save settle
    }
    return results;
  }

  // ---- message router ------------------------------------------------------
  const onMessage = (msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case 'YC_PING': {
            const c = ctx();
            // ask the MAIN bridge whether it's alive (so the panel can warn if not)
            sendResponse({ ok: !!c, ver: CS_VERSION, url: location.href, group: c && c.groupId, task: c && c.taskId, doc: c && c.docId });
            break;
          }
          case 'YC_HARVEST': sendResponse({ ok: true, segments: await harvest() }); break;
          case 'YC_WRITE': sendResponse({ ok: true, results: await writeAll(msg.edits || [], msg.tracked) }); break;
          case 'YC_SCROLL': sendResponse({ ok: true, found: await scrollToSeg(msg.segId, msg.seq) }); break;
          case 'YC_PAGEINFO': sendResponse({ ok: true, pageSize: PAGE_SIZE, page: pagerInfo() }); break;
          default: sendResponse({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;   // async sendResponse
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.__yc = { ver: CS_VERSION, ctx, harvest, stripMarkers, write: writeAll, scrollToSeg };
})();
