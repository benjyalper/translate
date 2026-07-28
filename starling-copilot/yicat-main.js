/* Starling Copilot — YiCAT MAIN-world bridge.
 *
 * Runs in the PAGE's JS context (manifest content_scripts "world":"MAIN") so it can reach
 * each target cell's Tiptap/ProseMirror editor instance (`p[segid].__vue__.editor`), which
 * the isolated content script (yicat.js) cannot touch. It writes a proposal by driving the
 * editor's OWN Tiptap commands — the same path a human keystroke takes — so YiCAT's normal
 * onUpdate → WebSocket save fires. It never confirms/delivers.
 *
 * Two write modes (YiCAT is a track-changes editor; `track-change` is a MARK with
 * attrs {op-uid, op-date, type:"insert"|"delete", …} — a tracked replacement is the old text
 * marked delete + the new text marked insert):
 *   • TRACKED (default): keep tracking on, replace the whole selection → the editor's plugin
 *     marks old as delete and new as insert, exactly like manual editing. Verified by the
 *     "effective" text (all non-deleted runs) equalling the proposal.
 *   • UNTRACKED: disable tracking, clearContent + insertContent (a plain replace, valid
 *     because tracking-off cells accept bare text). Verified by getText().
 * If a tracked write doesn't verify, it FALLS BACK to the untracked clean write so a cell is
 * never left with half-applied/garbled content. Both are read-back VERIFIED — success is
 * only reported when the cell's effective text is exactly the proposal.
 *
 * Protocol (same-window postMessage):
 *   in : { __ycmain:'req', op:'write', reqId, segId, text, tracked }
 *   out: { __ycmain:'res', reqId, res:{ ok, error?, tracked?, got? } }
 */
(() => {
  'use strict';

  // ⚠ TARGET cell only. YiCAT's SOURCE cells are also editable Tiptap editors with the
  // same p[segid], so a broad selector could write a proposal into the source. Never fall
  // back to a bare p[segid] — scope strictly to .tgt-table-cell.
  function editorFor(segId) {
    let p = null;
    try {
      const esc = (window.CSS && CSS.escape) ? CSS.escape(segId) : String(segId).replace(/["\\]/g, '\\$&');
      p = document.querySelector('.tgt-table-cell [contenteditable] p[segid="' + esc + '"]');
    } catch (e) { p = null; }
    if (!p) return null;
    const td = p.closest('td');
    if (!td || !/tgt-table-cell/.test(td.className)) return null;   // hard guard: target only
    let n = p.closest('[contenteditable]') || p;
    while (n && !n.__vue__) n = n.parentElement;
    return (n && n.__vue__) ? n.__vue__.editor : null;
  }

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function trackChangeExt(ed) {
    try {
      const exts = ed.extensionManager && ed.extensionManager.extensions;
      return exts && exts.find((e) => e.name === 'trackChange' || e.name === 'track-change') || null;
    } catch (e) { return null; }
  }

  // The "effective" text = every text run EXCEPT ones marked as a tracked deletion, i.e. the
  // content as it would read once all changes are accepted. For a correct tracked replace this
  // equals the proposal (old text is delete-marked → excluded; new text is insert-marked → kept).
  function effectiveText(ed) {
    try {
      let s = '';
      const walk = (node) => {
        if (node.type === 'text') {
          const deleted = (node.marks || []).some((m) => m.type === 'track-change' && m.attrs && m.attrs['type'] === 'delete');
          if (!deleted) s += (node.text || '');
        }
        (node.content || []).forEach(walk);
      };
      walk(ed.getJSON());
      return s;
    } catch (e) {
      try { return ed.getText(); } catch (_) { return null; }
    }
  }

  function writeSeg(segId, text, tracked) {
    const ed = editorFor(segId);
    if (!ed) return { ok: false, error: 'segment not rendered on screen — scroll to it in YiCAT, then retry' };
    if (ed.isDestroyed) return { ok: false, error: 'cell editor not live — scroll the segment into view and retry' };
    if (ed.isEditable === false) return { ok: false, error: 'cell is not editable (locked / read-only)' };
    const want = norm(text);

    const canToggle = typeof ed.commands.setTrackChangeDisableStatus === 'function';
    const tc = trackChangeExt(ed);
    const priorDisabled = (tc && tc.options) ? tc.options.disabled : null;
    const setTracking = (on) => { if (canToggle) { try { ed.commands.setTrackChangeDisableStatus(!on); } catch (e) {} } };
    const restoreTracking = () => setTracking(priorDisabled == null ? true : !priorDisabled);

    // ---- attempt 1: TRACKED replace (keep tracking on; select all, insert) ----
    if (tracked !== false) {
      try {
        setTracking(true);
        const end = ed.state.doc.content.size;
        ed.chain().focus().setTextSelection({ from: 0, to: end }).insertContent(String(text || '')).run();
        const eff = norm(effectiveText(ed));
        restoreTracking();
        if (eff === want) { try { ed.commands.blur && ed.commands.blur(); } catch (e) {} return { ok: true, tracked: true }; }
        // didn't verify as a clean tracked replace → fall through to the untracked clean write,
        // whose clearContent wipes any half-applied tracked state first.
      } catch (e) {
        restoreTracking();
        // fall through to untracked
      }
    }

    // ---- attempt 2 / untracked mode: disable tracking, clean replace ----
    try {
      setTracking(false);   // tracking OFF → plain text is schema-valid
      ed.chain().focus().clearContent().insertContent(String(text || '')).run();
    } catch (e) {
      restoreTracking();
      return { ok: false, error: 'write threw: ' + String(e && e.message || e) };
    }
    restoreTracking();

    let got;
    try { got = norm(ed.getText()); } catch (e) { got = null; }
    if (got == null) return { ok: false, error: 'could not read the cell back to verify' };
    if (got !== want) {
      return { ok: false, error: 'verify failed — cell now shows "' + got.slice(0, 50) + '…"; please fix by hand', got: got.slice(0, 120) };
    }
    try { ed.commands.blur && ed.commands.blur(); } catch (e) {}
    return { ok: true, tracked: false };
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__ycmain !== 'req') return;
    let res;
    try {
      res = (d.op === 'write') ? writeSeg(d.segId, d.text, d.tracked) : { ok: false, error: 'unknown op' };
    } catch (e) {
      res = { ok: false, error: String(e && e.message || e) };
    }
    window.postMessage({ __ycmain: 'res', reqId: d.reqId, res }, '*');
  });
})();
