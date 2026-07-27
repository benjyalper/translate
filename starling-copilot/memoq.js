/* Starling Copilot — memoQ web editor content script.
 *
 * memoQ's newer web editor (memoQweb / React + ProseMirror) virtualizes its
 * segment grid, so DOM scraping is unreliable. Instead this talks to the SAME
 * internal REST API the editor itself uses — same-origin, so the session cookie
 * rides along; we only add memoQ's X-CSRF-TOKEN header (mirrored from its cookie).
 *
 *   Harvest : POST …/docs/{doc}/rows      { rowIds:[…], scope:"entireRow" }
 *   Write   : PUT  …/docs/{doc}/rows/{id} { side:"target", symbols:[…], trackChanges:[] }
 *
 * A "symbol" is { type:1, value:<unicode code point> } for a text char; any other
 * type is an inline tag / structural marker, which we round-trip opaquely (we never
 * need to understand a tag's internals — we keep the raw object and re-emit it).
 * Tags are surfaced to the panel as circled markers ①②③… (same convention as
 * Starling), which the GPT prompt already preserves byte-for-byte.
 *
 * The tool writes the target as an UNCONFIRMED draft only — it never confirms,
 * rejects, or delivers. A human confirms each segment.
 */
(() => {
  'use strict';
  const CS_VERSION = 1;

  // ---- context: project / doc ids from the URL -----------------------------
  function ctx() {
    const m = location.pathname.match(/\/memoqweb\/editor\/projects\/([^/]+)\/docs\/([^/]+)/);
    return m ? { projectId: m[1], docId: m[2] } : null;
  }
  function apiBase() {
    const c = ctx();
    if (!c) return null;
    return `/memoqweb/editor/api/editor/projects/${c.projectId}/docs/${c.docId}`;
  }

  // ---- CSRF: memoQ echoes its X-CSRF-TOKEN cookie back as a request header --
  function csrf() {
    const m = document.cookie.match(/(?:^|;\s*)X-CSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function apiHeaders(json) {
    const h = { 'X-Requested-With': 'XMLHttpRequest' };
    const t = csrf();
    if (t) h['X-CSRF-TOKEN'] = t;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  async function apiFetch(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
    if (!r.ok) {
      let body = '';
      try { body = (await r.text()).slice(0, 300); } catch (e) {}
      throw new Error(`memoQ API ${opts && opts.method || 'GET'} ${path.split('/docs/')[1] || path} → HTTP ${r.status}${body ? ' · ' + body : ''}`);
    }
    return r;
  }

  // ---- total segment count -------------------------------------------------
  function rowCount() {
    const el = document.querySelector('[aria-rowcount]');
    const n = el ? parseInt(el.getAttribute('aria-rowcount'), 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // ---- symbol <-> string codecs -------------------------------------------
  // A tag is surfaced as a single-char marker so it survives GPT and string edits:
  // ①..⑳ (U+2460), then ㉑..㉟ (U+3251), then Private-Use chars for the rare >35 case.
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
  // Decode one side (source/target) → { text: string with ①-markers, tags: [rawSymbol,…] }
  function decodeSide(side) {
    const out = { text: '', tags: [] };
    if (!side || !Array.isArray(side.symbols)) return out;
    for (const s of side.symbols) {
      if (s && s.type === 1 && typeof s.value === 'number') {
        out.text += String.fromCodePoint(s.value);
      } else {
        out.text += tagMarker(out.tags.length);
        out.tags.push(s);
      }
    }
    return out;
  }
  // Encode edited target text (with ①-markers) back into a symbols array, using the
  // ordered `tags` captured at harvest. Returns { symbols } or { error } if a tag is
  // missing/duplicated (never silently drop a tag → refuse the write instead).
  function encodeTarget(text, tags) {
    const symbols = [];
    const used = new Array(tags.length).fill(0);
    for (const ch of Array.from(String(text))) {
      const mi = markerIndex(ch);
      if (mi >= 0) {
        if (mi >= tags.length || used[mi]) return { error: `tag marker ${mi + 1} missing/duplicated` };
        used[mi] = 1;
        symbols.push(tags[mi]);
      } else {
        symbols.push({ type: 1, value: ch.codePointAt(0) });
      }
    }
    const missing = used.reduce((a, v) => a + (v ? 0 : 1), 0);
    if (missing) return { error: `${missing} tag(s) dropped from the translation` };
    return { symbols };
  }

  // ---- harvest -------------------------------------------------------------
  async function apiRows(rowIds) {
    const r = await apiFetch(`${apiBase()}/rows`, {
      method: 'POST', headers: apiHeaders(true),
      body: JSON.stringify({ rowIds, scope: 'entireRow' })
    });
    return r.json();
  }
  async function harvest() {
    if (!apiBase()) throw new Error('Not a memoQ document URL (open the editor on a doc).');
    const total = rowCount();
    if (!total) throw new Error('Could not read the segment count from the page — is the editor fully loaded?');
    const ids = []; for (let i = 0; i < total; i++) ids.push(i);   // rowIds are 0-based
    const rows = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = await apiRows(ids.slice(i, i + 100));
      if (Array.isArray(chunk)) rows.push(...chunk);
    }
    const segs = rows.map((row) => {
      const src = decodeSide(row.source);
      const tgt = decodeSide(row.target);
      const meta = row.meta || {};
      return {
        rowId: row.id,                    // 0-based (what the write endpoint wants)
        seg: (row.id + 1),                // 1-based, matches the editor's segment number
        src: src.text, srcTags: src.tags,
        tgt: tgt.text, tgtTags: tgt.tags,
        tagged: src.tags.length > 0 || tgt.tags.length > 0,
        status: meta.status || '',        // manuallyConfirmed / partiallyEdited / …
        matchRate: meta.matchRate,
        locked: !!meta.isLocked, readonly: !!meta.isReadonly
      };
    }).sort((a, b) => a.rowId - b.rowId);
    return segs;
  }

  // ---- write (unconfirmed draft only) --------------------------------------
  async function writeOne(edit) {
    // edit: { rowId, text (with ①-markers), tags: [rawSymbol,…] }
    if (typeof edit.rowId !== 'number') return { ok: false, error: 'no rowId' };
    const enc = encodeTarget(edit.text, edit.tags || []);
    if (enc.error) return { ok: false, error: enc.error, rowId: edit.rowId };
    try {
      const r = await apiFetch(`${apiBase()}/rows/${edit.rowId}`, {
        method: 'PUT', headers: apiHeaders(true),
        body: JSON.stringify({ side: 'target', symbols: enc.symbols, trackChanges: [] })
      });
      const j = await r.json().catch(() => null);
      return { ok: true, rowId: edit.rowId, status: j && j.meta && j.meta.status };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), rowId: edit.rowId };
    }
  }
  async function writeAll(edits) {
    const results = [];
    for (const e of edits || []) {
      results.push(await writeOne(e));
      await new Promise((r) => setTimeout(r, 120));   // gentle; let memoQ's autosave settle
    }
    return results;
  }

  // ---- message router ------------------------------------------------------
  const onMessage = (msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case 'MQ_PING': {
            const c = ctx();
            sendResponse({ ok: true, ver: CS_VERSION, url: location.href, project: c && c.projectId, doc: c && c.docId, rows: rowCount(), csrf: !!csrf() });
            break;
          }
          case 'MQ_HARVEST': sendResponse({ ok: true, segments: await harvest() }); break;
          case 'MQ_WRITE': sendResponse({ ok: true, results: await writeAll(msg.edits || []) }); break;
          default: sendResponse({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;   // async sendResponse
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.__mq = { ver: CS_VERSION, ctx, harvest, write: writeAll };
})();
