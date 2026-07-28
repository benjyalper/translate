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
  const CS_VERSION = 2;

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
    const CHUNK = 500;
    const all = [];
    for (let start = 1; ; start += CHUNK) {
      const end = start + CHUNK - 1;
      let rows;
      try {
        const j = await apiGet(segUrl(`${start}-${end}`));
        rows = (j && Array.isArray(j.segment)) ? j.segment : [];
      } catch (e) {
        if (start === 1) throw e;               // genuine failure on the first page
        break;                                  // a later over-range page just means we're done
      }
      all.push(...rows);
      if (rows.length < CHUNK) break;           // reached the end
      if (start > 200000) break;                // hard safety cap
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

  // ---- write: bridge to the MAIN world (yicat-main.js drives Tiptap) --------
  function mainWrite(segId, text) {
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
      window.postMessage({ __ycmain: 'req', op: 'write', reqId, segId, text: String(text || '') }, '*');
    });
  }
  async function writeAll(edits) {
    const results = [];
    for (const e of edits || []) {
      results.push(await mainWrite(e.segId, stripMarkers(e.text)));
      await new Promise((r) => setTimeout(r, 180));   // gentle; let the WS save settle
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
          case 'YC_WRITE': sendResponse({ ok: true, results: await writeAll(msg.edits || []) }); break;
          default: sendResponse({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;   // async sendResponse
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.__yc = { ver: CS_VERSION, ctx, harvest, stripMarkers, write: writeAll };
})();
