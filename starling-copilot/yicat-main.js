/* Starling Copilot — YiCAT MAIN-world bridge.
 *
 * Runs in the PAGE's JS context (manifest content_scripts "world":"MAIN") so it can reach
 * each target cell's Tiptap/ProseMirror editor instance (`p[segid].__vue__.editor`), which
 * the isolated content script (yicat.js) cannot touch. It writes a proposal by driving the
 * editor's OWN Tiptap commands — the same path a human keystroke takes — so YiCAT's normal
 * onUpdate → WebSocket save fires. Every write is READ-BACK VERIFIED: it only reports
 * success if the cell's text ends up exactly the intended text (YiCAT is a track-changes
 * editor, where a naive insert can append rather than replace). It never confirms/delivers.
 *
 * Protocol (same-window postMessage):
 *   in : { __ycmain:'req', op:'write', reqId, segId, text }
 *   out: { __ycmain:'res', reqId, res:{ ok, error?, got? } }
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

  function writeSeg(segId, text) {
    const ed = editorFor(segId);
    if (!ed) return { ok: false, error: 'segment not rendered on screen — scroll to it in YiCAT, then retry' };
    if (ed.isDestroyed) return { ok: false, error: 'cell editor not live — scroll the segment into view and retry' };
    if (ed.isEditable === false) return { ok: false, error: 'cell is not editable (locked / read-only)' };
    const want = norm(text);

    // YiCAT target cells run in track-changes mode, whose schema rejects a plain-text
    // insert (it requires text wrapped in <track-change> nodes). So we DISABLE tracking
    // for the write (making a clean plain-text replace valid, exactly like a source cell),
    // then restore the prior tracking state. The write goes in as an untracked draft.
    const tc = trackChangeExt(ed);
    const priorDisabled = (tc && tc.options) ? tc.options.disabled : null;
    const canToggle = typeof ed.commands.setTrackChangeDisableStatus === 'function';
    const restoreTracking = () => { if (canToggle) { try { ed.commands.setTrackChangeDisableStatus(priorDisabled == null ? false : priorDisabled); } catch (e) {} } };

    try {
      if (canToggle) ed.commands.setTrackChangeDisableStatus(true);
      // clearContent empties the doc first (so insertContent can't "append"), then
      // insertContent adds the proposal — a real ProseMirror transaction that triggers
      // the editor's own save. focus() so the caret/commands apply to this cell.
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
    return { ok: true };
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__ycmain !== 'req') return;
    let res;
    try {
      res = (d.op === 'write') ? writeSeg(d.segId, d.text) : { ok: false, error: 'unknown op' };
    } catch (e) {
      res = { ok: false, error: String(e && e.message || e) };
    }
    window.postMessage({ __ycmain: 'res', reqId: d.reqId, res }, '*');
  });
})();
