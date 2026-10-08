/* lqa-core.js — PURE logic for the LQA round-trip (build plan 2026-09-30, phases 0–1).
 *
 * No DOM, no chrome.*, no network. Loaded by Node (starling-eval/lqa-judge.mjs, tests/lqa.test.js)
 * and, from M2 on, by the panel as the global `LQC`. It never rewrites a translation: the pre-pass
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
  else root.LQC = api;   // LQC, not LQ: panel.js already has a `const LQ` (the ⚖️ adjudicator state)
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const VERDICTS = ['agree', 'agree-modified', 'disagree'];
  const str = (v) => String(v == null ? '' : v);
  // Invisible direction marks never count as a difference: LRM/RLM, embeddings (U+202A–202E) and the
  // isolates Starling adds around numbers (U+2066–2069, e.g. ⁦{s_num}%⁩).
  const norm = (s) => str(s).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();

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

  // ---- Phase 2: locate every judged row in Starling (READ-ONLY planning) ---------------------
  // Input: lqa-judged.json rows {n, xlRow, key, src, before, final, verdict, reason, problems}.
  // The panel fetches, per key, the tasks that carry it (getAllTasks?textKeys=) and each task's
  // segments (getSourceTextListWithTargetText), then calls resolveRow. Nothing here writes.
  const BUCKETS = ['ready', 'several', 'untranslated', 'drifted', 'not-editable', 'already', 'not-found', 'conflict', 'hand-edit', 'no-write'];
  // Does this judged row change Starling at all? (disagree keeps Before; a final equal to Before is a no-op;
  // a final that failed the checks is never planned.)
  function needsWrite(j) {
    if (!j || !j.verdict || j.verdict === 'disagree') return false;
    if (j.problems && j.problems.length) return false;
    return str(j.final).trim() !== '' && str(j.final).trim() !== str(j.before).trim();
  }
  // Rows kept off the automatic write until a tag-safe API write is proven (plan, phase 3).
  function handEditReason(j) {
    const s = str(j.src);
    if (/<\/?[A-Za-z][^<>]*>|[①-⑳]|\*\*/.test(s)) return 'tags or bold markers';
    if (isIcu(s)) return 'ICU plural';
    if (/\S[\r\n]+\S/.test(s)) return 'line breaks inside the source';
    return '';
  }
  // Unique keys that need a lookup, in report order.
  function lookupKeys(judged) {
    const seen = new Set(), out = [];
    for (const j of judged || []) if (needsWrite(j) && j.key && !seen.has(j.key)) { seen.add(j.key); out.push(j.key); }
    return out;
  }
  // Same key + source judged twice with different finals → the plan cannot choose; flag both.
  function conflicts(judged) {
    const by = new Map(), bad = new Set();
    for (const j of judged || []) {
      if (!needsWrite(j)) continue;
      const id = j.key + '\u0001' + norm(j.src);
      if (!by.has(id)) by.set(id, norm(j.final));
      else if (by.get(id) !== norm(j.final)) bad.add(id);
    }
    return bad;
  }
  // Is this live segment editable? A closed task, a segment not modifiable by the user, or an editor
  // lock all block writing. getMyTasks taskStatus (confirmed live 2026-10-06): 1 = in progress,
  // 2 = Submitted, 3 = Closed (cancelled). Submitted stays editable: confirmTextTaskTargetV2 writes
  // and confirms a segment in a submitted task, which stays Submitted with nothing left to re-submit
  // (verified live 2026-10-08 on 12 tasks). blockedStatus overrides the defaults.
  const BLOCKED_STATUS = { 3: 'task closed' };
  function segEditable(task, seg, blockedStatus) {
    const blocked = blockedStatus == null ? BLOCKED_STATUS : [].concat(blockedStatus).reduce((m, c) => (m[Number(c)] = 'task status ' + c, m), {});
    if (task && blocked[Number(task.taskStatus)]) return { ok: false, why: blocked[Number(task.taskStatus)] };
    if (seg && seg.modifiable === false) return { ok: false, why: 'not modifiable by you' };
    if (seg && seg.lock) return { ok: false, why: 'editor lock ' + seg.lock };
    return { ok: true, why: '' };
  }
  // tasks: [{subtaskId, taskName, status, taskStatus, segs: [slimRow with this key]}]
  // Returns {bucket, why, placements:[{taskId, taskName, taskStatus, sourceTextId, rank, live, bucket, why}]}.
  function resolveRow(j, tasks, opts) {
    const o = opts || {};
    if (!needsWrite(j)) return { bucket: 'no-write', why: j && j.verdict === 'disagree' ? 'disagree — nothing to write' : 'final equals Before or failed the checks', placements: [] };
    if (o.conflict) return { bucket: 'conflict', why: 'the same key and source were judged with different finals — fix in the report', placements: [] };
    const he = handEditReason(j);
    const list = tasks || [];
    if (!list.length) return { bucket: 'not-found', why: 'no en→he task carries this key', placements: [] };
    const want = norm(j.src), fin = norm(j.final), bef = norm(j.before);
    const placements = [];
    let keySegs = 0;
    for (const t of list) {
      for (const s of t.segs || []) {
        if (s.key !== j.key) continue;
        keySegs++;
        if (norm(s.source) !== want) continue;              // another revision of the string — never written
        const live = norm(s.target), ed = segEditable(t, s, o.blockedStatus);
        let bucket, why;
        if (live === fin) { bucket = 'already'; why = 'live text already equals the final'; }
        else if (!live && bef) { bucket = ed.ok ? 'untranslated' : 'not-editable'; why = ed.ok ? 'the live segment is empty (not translated yet) — the final can fill it' : ed.why; }
        else if (!ed.ok) { bucket = 'not-editable'; why = ed.why; }
        else if (live !== bef) { bucket = 'drifted'; why = 'live text differs from the report\'s Before and from the final — left for review'; }
        else { bucket = 'ready'; why = 'source matches exactly; live text equals Before'; }
        placements.push({ taskId: String(t.subtaskId), taskName: t.taskName || '', taskStatus: t.taskStatus, status: t.status,
          sourceTextId: s.sourceTextId, rank: s.rank, live: s.target, bucket, why });
      }
    }
    if (!placements.length) return { bucket: 'not-found', why: keySegs ? `key found in ${keySegs} segment(s), but none has this exact source (another revision)` : `key not present in its ${list.length} task(s)`, placements };
    const n = (b) => placements.filter((p) => p.bucket === b).length;
    let bucket;
    if (n('ready')) bucket = n('ready') > 1 ? 'several' : 'ready';
    else if (n('untranslated')) bucket = 'untranslated';
    else if (n('drifted')) bucket = 'drifted';
    else if (n('not-editable')) bucket = 'not-editable';
    else bucket = 'already';
    if (he && (bucket === 'ready' || bucket === 'several')) return { bucket: 'hand-edit', why: he + ' — kept off the automatic write', placements };
    const why = bucket === 'several' ? `ready in ${n('ready')} tasks — all get fixed` : placements.find((p) => p.bucket === (bucket === 'several' ? 'ready' : bucket)).why;
    return { bucket, why, placements };
  }
  // Group a resolved plan by task for the review card. plan: [{j, res}]
  function planByTask(plan) {
    const by = new Map();
    const seen = new Map();   // taskId:sourceTextId → row (a report can list the same key + source twice)
    for (const { j, res } of plan || []) for (const p of res.placements) {
      if (!by.has(p.taskId)) by.set(p.taskId, { taskId: p.taskId, taskName: p.taskName, taskStatus: p.taskStatus, rows: [] });
      const id = p.taskId + ':' + p.sourceTextId;
      if (seen.has(id)) { const r = seen.get(id); if (!r.xlRows.includes(j.xlRow)) r.xlRows.push(j.xlRow); continue; }
      const row = { n: j.n, xlRow: j.xlRow, xlRows: [j.xlRow], key: j.key, src: j.src, before: j.before, final: j.final, verdict: j.verdict, reason: j.reason,
        sourceTextId: p.sourceTextId, rank: p.rank, live: p.live, bucket: res.bucket === 'hand-edit' ? 'hand-edit' : p.bucket, why: p.why };
      seen.set(id, row); by.get(p.taskId).rows.push(row);
    }
    return [...by.values()].sort((a, b) => b.rows.filter((r) => r.bucket === 'ready').length - a.rows.filter((r) => r.bucket === 'ready').length || a.taskId.localeCompare(b.taskId));
  }
  // ---- Phase 4 (M3): write + confirm the approved rows -------------------------------------------
  // Only rows you approved, in a bucket that can be written (ready, or untranslated = empty live),
  // and not already in the ledger. approved: {"<taskId>:<sourceTextId>": true}. groups: planByTask().
  const WRITABLE = { ready: 1, untranslated: 1 };
  function writeQueue(groups, approved, ledger) {
    const out = [];
    for (const g of groups || []) for (const r of g.rows) {
      if (!WRITABLE[r.bucket] || !(approved && approved[g.taskId + ':' + r.sourceTextId])) continue;
      if (ledgerIsDone(ledger, g.taskId, r.sourceTextId)) continue;
      out.push({ taskId: g.taskId, taskName: g.taskName, sourceTextId: r.sourceTextId, rank: r.rank, key: r.key, src: r.src,
        live: r.live, final: r.final, bucket: r.bucket, xlRows: r.xlRows });
    }
    return out;
  }
  // The exact text to write: the final with its trailing spaces/newlines replaced by the live
  // source's (spreadsheets drop or mangle them; Starling QA compares them with the source).
  function writeText(final, liveSource) {
    const tail = (str(liveSource).match(/[ \t\r\n ]*$/) || [''])[0];
    return str(final).replace(/[ \t\r\n ]+$/, '') + tail;
  }
  // Fresh read of the task just before writing: is it still the segment Locate planned for?
  // seg = slimRow found by sourceTextId (or undefined). Returns {ok, skip, why}.
  function preWriteCheck(seg, item, task) {
    if (!seg) return { ok: false, why: 'segment no longer in the task' };
    if (seg.key !== item.key || norm(seg.source) !== norm(item.src)) return { ok: false, why: 'the source changed since Locate' };
    if (norm(seg.target) === norm(item.final)) return { ok: false, skip: 'already', why: 'live text already equals the final' };
    if (norm(seg.target) !== norm(item.live)) return { ok: false, why: 'the live text changed since Locate — run Locate again' };
    const ed = segEditable(task, seg);
    if (!ed.ok) return { ok: false, why: ed.why };
    return { ok: true, why: '' };
  }
  // Read-back after the write: exact text, proofread-confirmed (status 3).
  function verifyWrite(seg, text) {
    if (!seg) return { ok: false, why: 'segment missing on read-back' };
    if (str(seg.target) !== str(text)) return { ok: false, why: 'read-back text differs' };
    if (Number(seg.status) !== 3) return { ok: false, why: 'written but not confirmed (status ' + seg.status + ')' };
    return { ok: true, why: '' };
  }

  // Stable id for a judged report (storage key for the plan and your approvals).
  function planSig(judged) {
    let h = 5381; const s = (judged || []).map((j) => j.key + '|' + norm(j.final)).join('\n');
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    return 'lqa#' + (judged || []).length + '#' + h.toString(36);
  }

  return {
    VERDICTS, norm, mapHeader, readRows, icuBlocks, isIcu, tokens, tokenDiff, prepass, commentKey, clusters,
    postcheck, normalizeVerdict, columnI,
    ledgerNew, ledgerMarkDone, ledgerIsDone, ledgerMarkSubmitted, ledgerIsSubmitted, writeAllowed,
    BUCKETS, needsWrite, handEditReason, lookupKeys, conflicts, segEditable, resolveRow, planByTask, planSig,
    WRITABLE, writeQueue, writeText, preWriteCheck, verifyWrite
  };
});
