/* lqa-core.js — PURE logic for the LQA round-trip (build plan 2026-09-30, phases 0–1).
 *
 * No DOM, no chrome.*, no network. Loaded by Node (starling-eval/lqa-judge.mjs, tests/lqa.test.js)
 * and, from M2 on, by the panel as the global `LQ`. It never rewrites a translation: the pre-pass
 * only reports, the judge (a model or a Claude chat) decides, and Benjy answers pattern questions.
 *
 *   readRows(header, records)   → normalized LQA rows (same column names the panel's wbAutoMap uses)
 *   prepass(row, RB)            → deterministic findings on the reviewer's Suggested text
 *   clusters(rows)              → rows grouped by normalized reviewer comment (one decision each)
 *   postcheck(row, final, RB)   → hard problems in a judged final (placeholders, ICU, rulebook)
 *   columnI(verdict)            → the text stamped into "Validation feedback (from proofreader)"
 *   ledger*                     → Phase 0 record of finished segments / submitted tasks
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LQ = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const VERDICTS = ['agree', 'agree-modified', 'disagree'];
  const str = (v) => String(v == null ? '' : v);
  const norm = (s) => str(s).replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();

  // ---- reading the workbook ----------------------------------------------------------------
  // Column indexes for the TikTok LQA template (sheet "All"). The FIRST "Source" wins (col B; the
  // template repeats "Source" far right). Same patterns as panel.js wbAutoMap's old-LQA branch.
  function mapHeader(header) {
    const h = header.map((x) => str(x).trim()), used = new Set();
    const find = (re) => { for (let i = 0; i < h.length; i++) { if (!used.has(i) && re.test(h[i])) { used.add(i); return i; } } return -1; };
    return {
      key: find(/^key$|\bkey\b/i), src: find(/^source$|source/i), before: find(/before translation|^before/i),
      suggested: find(/suggested translation|suggest/i), cat: find(/^error category/i), sub: find(/sub ?category/i),
      severity: find(/severity/i), comment: find(/^lqa comments?$/i), colI: find(/validation feedback \(from proofreader\)|^validation feedback$/i)
    };
  }
  // records: array of row arrays (header excluded). `n` is the 1-based data-row number and `xlRow`
  // the worksheet row (header row + n) used when stamping Column I.
  function readRows(header, records, headerRow) {
    const m = mapHeader(header), g = (r, i) => (i >= 0 && i < r.length ? str(r[i]) : '');
    const hr = headerRow || 1;
    return records.map((r, i) => ({
      n: i + 1, xlRow: hr + i + 1, key: g(r, m.key).trim(), src: g(r, m.src), before: g(r, m.before), suggested: g(r, m.suggested),
      sub: g(r, m.sub).trim(), severity: g(r, m.severity).trim(), comment: g(r, m.comment).trim(), colI: g(r, m.colI).trim()
    })).filter((r) => r.key || r.src || r.suggested);
  }

  // ---- placeholders, tags and ICU ------------------------------------------------------------
  // Top-level ICU blocks: {var, plural|select|selectordinal, k1 {…} k2 {…}} → [{name, type, keys[]}].
  function icuBlocks(s) {
    const t = str(s), out = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== '{') continue;
      const head = t.slice(i + 1).match(/^\s*([\w.]+)\s*,\s*(plural|select|selectordinal)\s*,/);
      if (!head) continue;
      let depth = 0, j = i, keys = [], k = i + 1 + head[0].length;
      for (; j < t.length; j++) { if (t[j] === '{') depth++; else if (t[j] === '}') { depth--; if (!depth) break; } }
      // branch keys sit at depth 1 directly before an opening brace
      let d = 1, buf = '';
      for (; k < j; k++) {
        const c = t[k];
        if (c === '{') { if (d === 1 && buf.trim()) keys.push(buf.trim().split(/\s+/).pop()); d++; buf = ''; }
        else if (c === '}') { d--; buf = ''; }
        else if (d === 1) buf += c;
      }
      out.push({ name: head[1], type: head[2], keys: keys.sort() });
      i = j;
    }
    return out;
  }
  const isIcu = (s) => icuBlocks(s).length > 0;
  // Tokens that must survive translation. Outside ICU: exact multiset. When the source has ICU
  // blocks, the branch bodies repeat placeholders per branch and Hebrew may add "two"/"many"
  // branches, so placeholders compare as a SET and each ICU block by variable + type, requiring
  // every source branch (other than "=N" literals) to still exist.
  function rawTokens(s) {
    let t = str(s); const out = [];
    const grab = (re) => { let m; while ((m = re.exec(t)) !== null) out.push(m[0]); };
    grab(/\{\{[^{}]+\}\}/g); t = t.replace(/\{\{[^{}]+\}\}/g, ' '); grab(/\{[A-Za-z_$][\w.$]*\}/g); grab(/%\d*\$?[sd@]/g); grab(/<\/?[A-Za-z][^<>]*>/g); grab(/[①-⑳]/g); grab(/\*\*/g);
    return out;
  }
  function tokens(s) { return rawTokens(s).sort(); }
  function tokenDiff(a, b) {
    const out = [];
    if (isIcu(a)) {
      const A = new Set(rawTokens(a)), B = new Set(rawTokens(b));
      for (const k of A) if (!B.has(k)) out.push(k + ' missing');
      for (const k of B) if (!A.has(k)) out.push(k + ' added');
      const bb = icuBlocks(b);
      for (const blk of icuBlocks(a)) {
        const m = bb.find((x) => x.name === blk.name && x.type === blk.type);
        if (!m) { out.push(`ICU {${blk.name}, ${blk.type}} missing`); continue; }
        for (const k of blk.keys) if (!/^=/.test(k) && !m.keys.includes(k)) out.push(`ICU {${blk.name}} branch "${k}" missing`);
      }
      return out;
    }
    const count = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
    const A = count(rawTokens(a)), B = count(rawTokens(b));
    for (const k of new Set([...A.keys(), ...B.keys()])) { const x = A.get(k) || 0, y = B.get(k) || 0; if (x !== y) out.push(`${k}: ${x} → ${y}`); }
    return out;
  }
  // Line breaks inside the text. Trailing whitespace is ignored: the write step copies the live
  // source's trailing newlines and spaces onto the final (plan, phase 4).
  const newlines = (s) => (str(s).replace(/\s+$/, '').match(/\r\n|\n|\r/g) || []).length;

  // ---- deterministic pre-pass on the reviewer's Suggested text ---------------------------------
  // Returns { flags: [{id, msg}], introduced: [rulebook findings new in Suggested], fixed: [findings
  // in Before that Suggested removes] }. RB is rulebook.js (optional — tests can pass null).
  function prepass(row, RB) {
    const flags = [], add = (id, msg) => flags.push({ id, msg });
    const src = row.src, before = row.before, sug = row.suggested;
    if (!norm(sug)) add('no-suggestion', 'Suggested translation is empty');
    else if (str(sug).trim() === str(before).trim()) add('no-change', 'Suggested equals Before — nothing to do');
    else if (norm(sug) === norm(before)) add('bidi-only', 'Suggested differs from Before only in invisible direction marks (ruling 15)');
    if (norm(sug)) {
      const d = tokenDiff(src, sug);
      if (d.length) add('placeholders', 'Suggested does not mirror the source tokens: ' + d.join('; '));
      if (newlines(src) !== newlines(sug)) add('newlines', `Line breaks: source ${newlines(src)}, Suggested ${newlines(sug)}`);
      if (norm(before).length > 24 && norm(sug).length < norm(before).length * 0.5) add('partial', 'Suggested is much shorter than Before — may be a fragment, not the full segment');
    }
    let introduced = [], fixed = [];
    if (RB && norm(sug)) {
      const sig = (f) => f.rule + '|' + f.msg;
      const b = RB.checkSegment(src, before, { key: row.key }), s = RB.checkSegment(src, sug, { key: row.key });
      const bs = new Set(b.map(sig)), ss = new Set(s.map(sig));
      introduced = s.filter((f) => !bs.has(sig(f)));
      fixed = b.filter((f) => !ss.has(sig(f)));
    }
    return { flags, introduced, fixed };
  }

  // ---- clustering by reviewer comment ------------------------------------------------------------
  // Light normalization only: case, whitespace, quotes and trailing punctuation. Comments that quote
  // the specific words ("translated \"recently updated\"") stay separate clusters, which is correct.
  function commentKey(c) {
    return norm(c).toLowerCase().replace(/[“”״]/g, '"').replace(/[‘’׳]/g, "'").replace(/[\s.!,;:]+$/, '') || '(no comment)';
  }
  function clusters(rows) {
    const by = new Map();
    for (const r of rows) {
      const k = commentKey(r.comment);
      if (!by.has(k)) by.set(k, { id: '', comment: r.comment || '(no comment)', key: k, rows: [] });
      by.get(k).rows.push(r.n);
    }
    const list = [...by.values()].sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
    list.forEach((c, i) => { c.id = 'c' + (i + 1); });
    return list;
  }

  // ---- checking a judged final -------------------------------------------------------------------
  function postcheck(row, final, RB) {
    const out = [], f = str(final);
    if (!norm(f)) return [{ id: 'empty', msg: 'final is empty' }];
    const d = tokenDiff(row.src, f);
    if (d.length) out.push({ id: 'placeholders', msg: d.join('; ') });
    if (newlines(row.src) !== newlines(f)) out.push({ id: 'newlines', msg: `source ${newlines(row.src)}, final ${newlines(f)}` });
    if (/[“”]/.test(f)) out.push({ id: 'quotes', msg: 'curly quotes in final' });
    if (RB) for (const x of RB.checkSegment(row.src, f, { key: row.key })) if (x.severity === 'error') out.push({ id: 'RB:' + x.rule, msg: x.msg });
    return out;
  }
  // Validates one judge answer. Returns a normalized verdict or throws with a reason.
  function normalizeVerdict(row, v) {
    const verdict = str(v && v.verdict).trim().toLowerCase();
    if (!VERDICTS.includes(verdict)) throw new Error('bad verdict "' + verdict + '"');
    let final = str(v.final);
    if (verdict === 'agree') final = row.suggested;
    if (verdict === 'disagree' && !norm(final)) final = row.before;
    return { verdict, final, reason: norm(v.reason), ask: norm(v.ask || '') };
  }

  // ---- Column I wording (decision 1, default) ------------------------------------------------------
  function columnI(j) {
    if (!j) return '';
    if (j.verdict === 'agree') return 'agree';
    if (j.verdict === 'agree-modified') return 'agree (modified): ' + str(j.final).trim();
    return 'Disagree. ' + str(j.reason).trim();
  }

  // ---- Phase 0: ledger ---------------------------------------------------------------------------
  // Plain JSON so it can live in chrome.storage.local: { done: {"<taskId>:<sourceTextId>": iso},
  // submitted: {"<taskId>": iso} }. A rerun skips done segments and never submits a task twice.
  function ledgerNew() { return { v: 1, done: {}, submitted: {} }; }
  const segKey = (taskId, sourceTextId) => str(taskId) + ':' + str(sourceTextId);
  function ledgerMarkDone(L, taskId, sourceTextId, when) { L.done[segKey(taskId, sourceTextId)] = when || new Date().toISOString(); return L; }
  function ledgerIsDone(L, taskId, sourceTextId) { return !!(L && L.done && L.done[segKey(taskId, sourceTextId)]); }
  function ledgerMarkSubmitted(L, taskId, when) {
    if (L.submitted[str(taskId)]) throw new Error('task ' + taskId + ' is already recorded as submitted');
    L.submitted[str(taskId)] = when || new Date().toISOString(); return L;
  }
  function ledgerIsSubmitted(L, taskId) { return !!(L && L.submitted && L.submitted[str(taskId)]); }
  // Writes are refused unless armed in THIS session (Phase 0: dry run by default).
  function writeAllowed(arm, sessionId) { return !!(arm && arm.armed && arm.session && arm.session === sessionId); }

  return {
    VERDICTS, norm, mapHeader, readRows, icuBlocks, isIcu, tokens, tokenDiff, prepass, commentKey, clusters,
    postcheck, normalizeVerdict, columnI,
    ledgerNew, ledgerMarkDone, ledgerIsDone, ledgerMarkSubmitted, ledgerIsSubmitted, writeAllowed
  };
});
