/* Starling Copilot — YiCAT (self-hosted Tmxmall) content script.
 *
 * YiCAT exposes the SAME internal REST endpoint the editor uses to READ segments,
 * so harvest is a clean same-origin GET (session cookie rides along):
 *
 *   Harvest : GET /yizhe/cat/segment?group_id={g}&document_id=&task_id={t}&seg_range=1-{N}
 *             → { segment:[ { _id, seqNum, hasConfirmed, lockStatus, matchingRate,
 *                             srcSegmentAtoms, tgtSegmentAtoms, editTgtSegmentAtoms, … } ], status }
 *
 * A "segment atom" is { data, textStyle:"regular"|"tag", tag, tagType, … }. A regular
 * atom is one run of text; a tag atom (e.g. data "<g1>" / "</g1>") is an inline tag,
 * surfaced to the panel as a circled marker ①②③… (same convention as Starling/memoQ,
 * which the GPT prompt already preserves) and round-tripped opaquely.
 *
 * ⚠ WRITING is different from memoQ/Crowdin: YiCAT commits target edits over a
 * WebSocket (ws://{host}/yizhe/editMessageWs{group}), NOT a REST endpoint — there is
 * no REST "save" to call. So the default workflow is COPY-ONLY (the panel copies each
 * proposal; the human pastes it into the target cell). An experimental DOM write path
 * (types into the cell's contenteditable so YiCAT's own code fires the WS save) is
 * included but stays OFF until calibrated. It never confirms/delivers — a human does.
 */
(() => {
  'use strict';
  const CS_VERSION = 1;

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
  function markerIndex(ch) {                    // -1 if ch is not a tag marker
    const cp = ch.codePointAt(0);
    if (cp >= 0x2460 && cp <= 0x2473) return cp - 0x2460;
    if (cp >= 0x3251 && cp <= 0x325f) return cp - 0x3251 + 20;
    if (cp >= 0xE000 && cp <= 0xF8FF) return cp - 0xE000 + 35;
    return -1;
  }

  const isTagAtom = (a) => !!(a && (a.tag === true || a.textStyle === 'tag'));

  // Decode one atom array → { text: string with ①-markers, tags: [rawAtom,…] }
  function decodeAtoms(atoms) {
    const out = { text: '', tags: [] };
    if (!Array.isArray(atoms)) return out;
    for (const a of atoms) {
      if (isTagAtom(a)) {
        out.text += tagMarker(out.tags.length);
        out.tags.push(a);
      } else {
        out.text += (a && a.data != null) ? String(a.data) : '';
      }
    }
    return out;
  }

  // Strip ①-markers → plain text (what a human pastes into the cell). Used for Copy.
  function stripMarkers(text) {
    let out = '';
    for (const ch of Array.from(String(text || ''))) {
      if (markerIndex(ch) < 0) out += ch;
    }
    return out;
  }

  // ---- harvest -------------------------------------------------------------
  // Fetch in chunks so arbitrarily large docs are safe; stop when a chunk is short.
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
      const src = decodeAtoms(row.srcSegmentAtoms);
      // current target lives in tgtSegmentAtoms; fall back to the draft buffer
      const tgtAtoms = (row.tgtSegmentAtoms && row.tgtSegmentAtoms.length)
        ? row.tgtSegmentAtoms : row.editTgtSegmentAtoms;
      const tgt = decodeAtoms(tgtAtoms);
      return {
        segId: row._id,
        seq: row.seqNum,
        src: src.text, srcTags: src.tags,
        tgt: tgt.text, tgtTags: tgt.tags,
        tagged: src.tags.length > 0 || tgt.tags.length > 0,
        confirmed: !!row.hasConfirmed,
        locked: !!row.lockStatus,
        matchRate: row.matchingRate
      };
    }).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    return segs;
  }

  // ---- experimental DOM write (behind a panel flag; OFF until calibrated) --
  // Locate a segment's target editor by its _id (robust vs. the el-table paging),
  // then simulate typing so YiCAT's own editor fires the WebSocket save.
  function findTargetEditor(segId) {
    const p = document.querySelector(`p[segid="${segId}"]`);
    if (!p) return null;
    return p.closest('.atoms-editor-inner[contenteditable], [contenteditable="true"]') || p.parentElement;
  }
  async function writeOneDom(edit) {
    // edit: { segId, text (plain, markers already stripped by the panel) }
    const ed = findTargetEditor(edit.segId);
    if (!ed) return { ok: false, segId: edit.segId, error: 'segment not on screen — scroll to it / go to its page, then retry' };
    try {
      ed.focus();
      // select all existing content, then insert the new text as if typed
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ed);
      sel.removeAllRanges(); sel.addRange(range);
      const ok = document.execCommand('insertText', false, String(edit.text || ''));
      if (!ok) return { ok: false, segId: edit.segId, error: 'execCommand insertText refused (uncalibrated)' };
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      ed.blur();
      return { ok: true, segId: edit.segId };
    } catch (e) {
      return { ok: false, segId: edit.segId, error: String(e && e.message || e) };
    }
  }
  async function writeAllDom(edits) {
    const results = [];
    for (const e of edits || []) {
      results.push(await writeOneDom(e));
      await new Promise((r) => setTimeout(r, 150));
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
            sendResponse({ ok: !!c, ver: CS_VERSION, url: location.href, group: c && c.groupId, task: c && c.taskId, doc: c && c.docId });
            break;
          }
          case 'YC_HARVEST': sendResponse({ ok: true, segments: await harvest() }); break;
          case 'YC_WRITE': sendResponse({ ok: true, results: await writeAllDom(msg.edits || []) }); break;
          default: sendResponse({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;   // async sendResponse
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.__yc = { ver: CS_VERSION, ctx, harvest, stripMarkers, write: writeAllDom };
})();
