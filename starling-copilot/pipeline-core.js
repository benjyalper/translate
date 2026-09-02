/* pipeline-core.js — PURE, side-effect-free translation-pipeline logic.
 *
 * No DOM, no chrome.*, no network. Everything here is deterministic and unit-testable in
 * Node (see tests/pipeline.test.js) and is also loaded in the browser BEFORE panel.js,
 * exposing itself as the global `PC`. panel.js delegates the semantic/mechanical decisions
 * here so the same code that ships is the code the tests exercise.
 *
 * Design notes:
 *  - Callers pass their own `fold` (panel.js uses wbFold) so memory keys stay identical to
 *    the existing store — this module never re-keys or re-folds behind the caller's back.
 *  - Memory supports MULTIPLE contextual variants per English source, and reads legacy
 *    single-entry data unchanged (see memVariants / memPut).
 *  - "Confidence" is an explicit tier (UNKNOWN < LOW < MEDIUM < HIGH) with reasons.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PC = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---- small helpers --------------------------------------------------------
  const CONF = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  const confName = (n) => (['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH'][n] || 'UNKNOWN');
  const idFold = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();   // fallback fold for tests

  // Word count of a source (short UI strings are context-sensitive). 1–4 words = short (#2).
  function wordCount(src, fold) { const f = fold || idFold; return f(String(src == null ? '' : src)).split(/\s+/).filter(Boolean).length; }
  function isShort(src, fold) { return wordCount(src, fold) <= 4; }

  // Coarse UI role from a resource key suffix (…_button / _title / _toast / a list namespace…).
  function uiRole(key) {
    const k = String(key || '').toLowerCase();
    if (!k) return '';
    if (/(_|\.|-)(btn|button|cta)\b|(_|\.|-)(btn|button|cta)$/.test(k)) return 'button';
    if (/(_|\.|-)(title|heading|header|subtitle|label|name)$/.test(k)) return 'title';
    if (/(_|\.|-)(desc|description|body|subtitle|text|caption)$/.test(k)) return 'body';
    if (/(_|\.|-)(toast|tip|tooltip|hint|placeholder|instruction|action)$/.test(k)) return 'instruction';
    if (/(reason|option|enum|list|type|status|category|menu)/.test(k)) return 'option';
    return '';
  }
  // Key namespace/module = everything before the last key segment.
  function keyNs(key) { const k = String(key || ''); return k ? k.replace(/[._\-\/][^._\-\/]*$/, '') : ''; }
  // Legacy context signature (namespace + folded note) — kept for backward-compatible reads.
  function ctxSig(p, fold) { const f = fold || idFold; return keyNs(p && p.key) + '|' + f((p && p.context) || ''); }

  // ---- context confidence (#2) ----------------------------------------------
  // Compare two occurrences' contexts and return an explicit tier + reasons. Two MISSING
  // contexts are UNKNOWN (never auto-compatible); a shared empty signature or a broad shared
  // namespace alone is never enough to auto-apply/deduplicate a short string.
  function ctxConfidence(a, b, fold) {
    const f = fold || idFold;
    const ka = String((a && a.key) || ''), kb = String((b && b.key) || '');
    const na = f((a && a.context) || ''), nb = f((b && b.context) || '');
    const ra = uiRole(ka), rb = uiRole(kb);
    const nsa = keyNs(ka), nsb = keyNs(kb);
    const noteCompat = (na && nb) ? (na === nb) : true;           // one empty note doesn't conflict
    const reasons = [];
    // Conflicts first — they cap confidence low.
    if (ra && rb && ra !== rb) { reasons.push('ROLE_CONFLICT'); return { level: CONF.LOW, name: 'LOW', reasons }; }
    if (na && nb && na !== nb) { reasons.push('NOTE_CONFLICT'); return { level: CONF.LOW, name: 'LOW', reasons }; }
    // Strong positives.
    if (ka && kb && ka === kb && noteCompat) { reasons.push('EXACT_KEY'); return { level: CONF.HIGH, name: 'HIGH', reasons }; }
    if (ra && rb && ra === rb && na && nb && na === nb) { reasons.push('ROLE_AND_NOTE'); return { level: CONF.HIGH, name: 'HIGH', reasons }; }
    // Medium positives (useful, but not enough to force a short string).
    if (ra && rb && ra === rb) { reasons.push('ROLE_MATCH'); return { level: CONF.MEDIUM, name: 'MEDIUM', reasons }; }
    if (na && nb && na === nb) { reasons.push('NOTE_MATCH'); return { level: CONF.MEDIUM, name: 'MEDIUM', reasons }; }
    // Weak / unknown.
    const anySignalA = !!(ka || na), anySignalB = !!(kb || nb);
    if (!anySignalA && !anySignalB) { reasons.push('BOTH_EMPTY'); return { level: CONF.UNKNOWN, name: 'UNKNOWN', reasons }; }
    if (nsa && nsb && nsa === nsb) { reasons.push('NAMESPACE_ONLY'); return { level: CONF.LOW, name: 'LOW', reasons }; }
    reasons.push('ONE_SIDED');
    return { level: CONF.LOW, name: 'LOW', reasons };
  }

  // ---- memory schema (multi-variant, backward compatible) (#1) --------------
  // A map value is EITHER a legacy single entry {src,tgt,ts,n,key?,ctx?} OR a new
  // {src, variants:[{tgt,key,ctx,uiRole,ts,n}]}. memVariants normalises both to an array.
  function memVariants(entry) {
    if (!entry) return [];
    if (Array.isArray(entry.variants)) return entry.variants.filter((v) => v && v.tgt);
    if (entry.tgt) return [{ tgt: entry.tgt, key: entry.key || '', ctx: entry.ctx != null ? entry.ctx : null, uiRole: uiRole(entry.key), ts: entry.ts || 0, n: entry.n || 1, legacy: true }];
    return [];
  }
  // Add/merge a written pair into the map. Upgrades a legacy entry to variants form on first
  // write (preserving the old target as a variant), and merges into the variant that shares a
  // context signature (incrementing n) rather than overwriting a different-context sibling.
  // meta.ctxKnown=false stores the variant as context-unknown (imports / corpus).
  function memPut(map, key, src, tgt, meta, fold) {
    const f = fold || idFold;
    const t = String(tgt == null ? '' : tgt).trim(); if (!key || !t) return false;
    meta = meta || {};
    const vKey = String(meta.key || '');
    const vCtx = meta.ctxKnown === false ? null : String(meta.context || meta.ctx || '');
    const nv = { tgt: t, key: vKey, ctx: vCtx, uiRole: uiRole(vKey), ts: meta.ts || Date.now(), n: 1 };
    const existing = map[key];
    const variants = memVariants(existing);
    if (!variants.length) { map[key] = { src: String(src), variants: [nv] }; return true; }
    // find a variant whose context is HIGH-compatible with the new one → merge; else push.
    const sigOf = (v) => ctxSig({ key: v.key, context: v.ctx || '' }, f);
    const newSig = ctxSig({ key: vKey, context: vCtx || '' }, f);
    let hit = null;
    for (const v of variants) { if (sigOf(v) === newSig && (v.ctx == null) === (vCtx == null)) { hit = v; break; } }
    if (hit) { hit.tgt = t; hit.ts = nv.ts; hit.n = (hit.n || 1) + 1; hit.uiRole = nv.uiRole; }
    else variants.push(nv);
    map[key] = { src: String(existing.src || src), variants };
    return true;
  }
  // Choose the best variant for a given segment: highest context confidence, tie → higher n,
  // then newer. Returns { variant, confidence, reasons } or null. For a LONG source with no
  // conflicting context, source identity alone is strong (bumped to at least MEDIUM/HIGH).
  function memBest(entry, seg, fold) {
    const f = fold || idFold;
    const variants = memVariants(entry); if (!variants.length) return null;
    const segRole = uiRole(seg && seg.key);
    // Rank each variant by [confidence, UI-role match, times-written, recency] so that when the
    // confidence ties (e.g. every variant is LOW because the note differs) the variant whose UI
    // role matches the segment still wins — a button segment prefers the button variant.
    const score = (v, c) => [c.level, (segRole && v.uiRole === segRole) ? 1 : 0, v.n || 1, v.ts || 0];
    const gt = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return false; };
    let best = null;
    for (const v of variants) {
      let c = ctxConfidence({ key: v.key, context: v.ctx || '' }, seg, f);
      // legacy / context-unknown variant → cap at LOW so it stays suggestion-only for short strings.
      if (v.ctx == null && c.level > CONF.LOW) c = { level: CONF.LOW, name: 'LOW', reasons: c.reasons.concat('LEGACY_NO_CONTEXT') };
      if (!best || gt(score(v, c), score(best.variant, best.confidence))) best = { variant: v, confidence: c, reasons: c.reasons };
    }
    // Long, unambiguous source: identical text is itself strong evidence unless a note/role conflicts.
    if (best && !isShort(seg.src, f) && best.confidence.level < CONF.HIGH && best.confidence.reasons.indexOf('ROLE_CONFLICT') < 0 && best.confidence.reasons.indexOf('NOTE_CONFLICT') < 0) {
      best = { variant: best.variant, confidence: { level: CONF.HIGH, name: 'HIGH', reasons: best.confidence.reasons.concat('LONG_SOURCE_EXACT') }, reasons: best.reasons };
    }
    return best;
  }
  // How the caller should use a memory hit for a segment: 'apply' (auto), 'suggest' (review-only),
  // or 'none'. Short strings require HIGH to auto-apply; long strings apply at MEDIUM+.
  function memDecision(entry, seg, fold) {
    const best = memBest(entry, seg, fold); if (!best) return { action: 'none' };
    const short = isShort(seg.src, fold);
    const min = short ? CONF.HIGH : CONF.MEDIUM;
    return { action: best.confidence.level >= min ? 'apply' : 'suggest', best };
  }

  // ---- same-source deduplication grouping (#3) ------------------------------
  // Given items [{i, src, key, context}], return an array of index-arrays to align. Long
  // sources: one group per folded source. Short sources: only cluster occurrences that are
  // HIGH-compatible (same exact key(+note), or same role+note); no-signal members stay solo,
  // so two empty-context "Save" strings are never auto-aligned.
  function clusterKey(seg, fold) {
    const f = fold || idFold;
    const key = String(seg.key || ''), note = f(seg.context || ''), role = uiRole(key);
    if (key) return 'K:' + key + '|' + note;
    if (role && note) return 'R:' + role + '|' + note;
    return null;   // no reliable signal → solo (never auto-aligned)
  }
  function planDedupe(items, fold) {
    const f = fold || idFold;
    const bySrc = new Map();
    for (const it of items) { const k = f(it.src); if (!bySrc.has(k)) bySrc.set(k, []); bySrc.get(k).push(it); }
    const groups = [];
    for (const arr of bySrc.values()) {
      if (arr.length < 2) continue;
      if (!isShort(arr[0].src, f)) { groups.push(arr.map((x) => x.i)); continue; }   // long: align all
      const sub = new Map();
      for (const it of arr) { const ck = clusterKey(it, f); if (ck == null) continue; if (!sub.has(ck)) sub.set(ck, []); sub.get(ck).push(it.i); }
      for (const idxs of sub.values()) if (idxs.length >= 2) groups.push(idxs);
    }
    return groups;
  }

  // ---- terminology applicability + overlap + semantic risk (#7) -------------
  // Boundary match of an English term inside a source (case-insensitive, ASCII-aware).
  function termSpans(src, en) {
    const s = String(src || ''), e = String(en || '').trim(); if (!e) return [];
    const spans = [];
    let re; try { re = new RegExp('(?<![A-Za-z0-9])' + e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'gi'); }
    catch (_) { return []; }
    let m; while ((m = re.exec(s)) !== null) { spans.push([m.index, m.index + m[0].length]); if (m.index === re.lastIndex) re.lastIndex++; }
    return spans;
  }
  const FUNC_WORDS = ['to', 'of', 'for', 'with', 'by', 'from', 'on', 'in', 'as', 'at'];
  // Classify each supplied term for THIS source. Returns terms with a `status`:
  //  CANDIDATE                        — send to GPT with definition/POS, let it decide.
  //  OVERLAPPED_BY_MORE_SPECIFIC_TERM — a longer term covers the same span → drop for this span.
  //  POSSIBLY_INAPPLICABLE            — evidence the sense/POS likely differs (collocation / POS).
  // `senses` = count of term-base entries sharing this English surface form (multiple senses).
  function classifyTerms(src, terms, senseCounts) {
    const s = String(src || '');
    const withSpans = (terms || []).map((t) => ({ t, spans: termSpans(s, t.en), words: String(t.en).trim().split(/\s+/).length }))
      .filter((x) => x.spans.length);
    const out = [];
    for (const x of withSpans) {
      const reasons = [];
      // Overlap: a longer (more words) term covers one of this term's spans.
      let overlapped = false;
      if (x.words === 1) {
        for (const y of withSpans) {
          if (y === x || y.words <= x.words) continue;
          for (const [ax, ay] of x.spans) for (const [bx, by] of y.spans) { if (ax >= bx && ay <= by) { overlapped = true; break; } }
          if (overlapped) break;
        }
      }
      // Collocation: a single common word immediately followed by a function word often shifts sense
      // (e.g. "due to", "based on"). English-side signal only — never a Hebrew mapping.
      let colloc = false;
      if (x.words === 1) {
        for (const [, ay] of x.spans) { const rest = s.slice(ay).replace(/^[\s]+/, ''); const nextWord = (rest.match(/^([A-Za-z']+)/) || [])[1]; if (nextWord && FUNC_WORDS.indexOf(nextWord.toLowerCase()) >= 0) { colloc = true; break; } }
      }
      const senses = senseCounts ? (senseCounts[String(x.t.en).toLowerCase()] || 1) : 1;
      let status = 'CANDIDATE';
      if (overlapped) { status = 'OVERLAPPED_BY_MORE_SPECIFIC_TERM'; reasons.push('OVERLAP'); }
      else if (colloc) { status = 'POSSIBLY_INAPPLICABLE'; reasons.push('COLLOCATION'); }
      if (senses > 1) reasons.push('MULTIPLE_SENSES');
      if (!x.t.definition) reasons.push('NO_DEFINITION');
      out.push({ term: x.t, status, reasons, words: x.words });
    }
    return out;
  }
  // The terms actually worth sending to GPT for a segment: drop spans overlapped by a longer
  // term (they only distract). Keeps CANDIDATE + POSSIBLY_INAPPLICABLE (with definition/POS so
  // the model can judge). Preserves the multi-word-first order the caller passed in.
  function filterTermsForPrompt(classified) {
    return classified.filter((c) => c.status !== 'OVERLAPPED_BY_MORE_SPECIFIC_TERM').map((c) => c.term);
  }
  // Per-segment semantic risk (#7/#13). Reasons drive extra context / review, never text edits.
  function segRisk(src, classified, opts) {
    opts = opts || {};
    const reasons = [];
    if (isShort(src, opts.fold)) reasons.push('SHORT_AMBIGUOUS_SOURCE');
    if ((classified || []).some((c) => c.reasons.indexOf('MULTIPLE_SENSES') >= 0)) reasons.push('MULTIPLE_TERM_SENSES');
    if ((classified || []).some((c) => c.status === 'OVERLAPPED_BY_MORE_SPECIFIC_TERM')) reasons.push('OVERLAPPING_TERMS');
    if ((classified || []).some((c) => c.status === 'POSSIBLY_INAPPLICABLE')) reasons.push('TERM_POS_RISK');
    if (!opts.hasKey && !opts.hasContext) reasons.push('CONTEXT_MISSING');
    if (opts.memConflict) reasons.push('MEMORY_CONTEXT_CONFLICT');
    return reasons;
  }
  // tbCheck applicability (#8): given the source, a term, and the produced target, decide whether
  // a "term HE missing" observation is a DEFINITE deviation ('warn'), merely 'uncertain', or
  // should be suppressed. Non-mutating — the caller only changes the badge, never the text.
  function tbApplicability(src, term, hasHe) {
    if (hasHe) return 'ok';
    const classified = classifyTerms(src, [term], null)[0];
    if (!classified) return 'ok';                                   // term not actually present
    if (classified.status === 'OVERLAPPED_BY_MORE_SPECIFIC_TERM') return 'suppress';
    if (classified.status === 'POSSIBLY_INAPPLICABLE') return 'uncertain';
    if (isShort(src) && classified.reasons.indexOf('MULTIPLE_SENSES') >= 0) return 'uncertain';
    return 'warn';
  }

  // ---- compact task-wide context (#6) ---------------------------------------
  // Deterministic, capped, relevance-filtered. NEVER invents Hebrew — every line comes from a
  // locked term, a harvested term, or the user's own high-confidence memory. Returns { text,
  // terms, features } — text is what gets prepended to every translation/review batch.
  function buildTaskContext(segments, opts) {
    opts = opts || {};
    const fold = opts.fold || idFold;
    const caps = Object.assign({ locked: 20, terms: 30, memory: 20, features: 15, chars: 2600 }, opts.caps || {});
    const srcs = (segments || []).map((s) => String(s.src || '')).filter(Boolean);
    const occurs = (en) => srcs.some((s) => termSpans(s, en).length);
    const occurCount = (en) => srcs.reduce((a, s) => a + (termSpans(s, en).length ? 1 : 0), 0);
    const lockedT = (opts.lockTerms || []).filter((t) => t.en && t.he && occurs(t.en)).slice(0, caps.locked);
    let tbT = (opts.tbTerms || []).filter((t) => t.en && t.he && occurs(t.en));
    tbT.sort((a, b) => (String(b.en).trim().split(/\s+/).length - String(a.en).trim().split(/\s+/).length) || (occurCount(b.en) - occurCount(a.en)));
    tbT = tbT.slice(0, caps.terms);
    // High-confidence memory: sources present in the task whose remembered variant is reliable (n≥2).
    const mem = [];
    const map = opts.memMap || {};
    for (const s of segments || []) {
      const k = fold(s.src); const entry = map[k]; if (!entry) continue;
      const v = memVariants(entry).slice().sort((a, b) => (b.n || 1) - (a.n || 1))[0];
      if (v && (v.n || 1) >= 2 && !isShort(s.src, fold)) mem.push({ en: String(s.src), he: v.tgt });
      if (mem.length >= caps.memory) break;
    }
    // Repeated multi-word English expressions (feature-name candidates) — English only.
    const features = tbT.filter((t) => String(t.en).trim().split(/\s+/).length >= 2 && occurCount(t.en) >= 2).map((t) => t.en).slice(0, caps.features);
    const lines = [];
    if (lockedT.length || tbT.length || mem.length) {
      lines.push('TASK GLOSSARY — render these consistently across the whole task, but each still applies ONLY when its sense/POS fits the occurrence:');
      for (const t of lockedT) lines.push(`  • "${t.en}" → "${t.he}" (locked)`);
      for (const t of tbT) lines.push(`  • "${t.en}" → "${t.he}"${t.pos ? ' [' + t.pos + ']' : ''}`);
      for (const m of mem) lines.push(`  • "${m.en}" → "${m.he}" (your prior)`);
    }
    if (features.length) lines.push('REPEATED FEATURE/EXPRESSIONS (keep one consistent Hebrew rendering): ' + features.join(', '));
    let text = lines.join('\n');
    if (text.length > caps.chars) text = text.slice(0, caps.chars) + '…';
    return { text, terms: tbT, locked: lockedT, memory: mem, features };
  }

  // ---- placeholder / markup guard (#12, single source of truth) -------------
  function phTokens(s) {
    const str = String(s == null ? '' : s), out = [];
    const grab = (re) => { let m; while ((m = re.exec(str)) !== null) out.push(m[0]); };
    grab(/\{\{[^{}]+\}\}/g); grab(/\{[^{}]+\}/g); grab(/%\d*\$?[sd]/g); grab(/<[^<>]+>/g); grab(/[①-⑳]/g);
    return out;
  }
  function phDiff(src, tgt) {
    const count = (arr) => { const m = new Map(); for (const t of arr) m.set(t, (m.get(t) || 0) + 1); return m; };
    const a = count(phTokens(src)), b = count(phTokens(tgt)), keys = new Set([...a.keys(), ...b.keys()]), out = [];
    for (const k of keys) { const x = a.get(k) || 0, y = b.get(k) || 0; if (x !== y) out.push(`${k}: ${x} → ${y}`); }
    return out;
  }

  return {
    CONF, confName, idFold, wordCount, isShort, uiRole, keyNs, ctxSig, ctxConfidence,
    memVariants, memPut, memBest, memDecision, clusterKey, planDedupe,
    termSpans, classifyTerms, filterTermsForPrompt, segRisk, tbApplicability,
    buildTaskContext, phTokens, phDiff
  };
});
