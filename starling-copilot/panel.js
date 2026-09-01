/* Starling Copilot — side panel logic (GPT calls + review + orchestration). */
'use strict';

const $ = (id) => document.getElementById(id);
const state = { segments: [], proposals: [], mode: 'proofread' };

// ---- persisted settings ----------------------------------------------------
const store = {
  get: (k, d) => new Promise((r) => chrome.storage.local.get(k, (o) => r(k in o ? o[k] : d))),
  set: (o) => new Promise((r) => chrome.storage.local.set(o, r))
};

// ---- messaging to the Starling tab -----------------------------------------
async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}
// Try to make the content script answer on this tab. Returns true if a PING
// succeeds (already there, or after a re-inject). Only injects when NOTHING
// responds — a wrong-version reply is left alone (the caller shows Ctrl+R),
// so we never stack a second listener over a live one.
async function ensureContentScript(tabId) {
  try { const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' }); if (r && r.ok) return true; } catch (e) { /* no receiving end */ }
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); }
  catch (e) { return false; }
  for (let i = 0; i < 12; i++) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' }); if (r && r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function send(msg) {
  const t = await activeTab();
  if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) {
    throw new Error('Open a Starling task tab, then click Refresh.');
  }
  try {
    return await chrome.tabs.sendMessage(t.id, msg);
  } catch (e) {
    // Transient "no receiving end" — happens after an extension reload or an
    // SPA task-switch that swapped the document. Re-inject the content script
    // once and retry before giving up, so the user doesn't have to Ctrl+R.
    if (await ensureContentScript(t.id)) {
      try { return await chrome.tabs.sendMessage(t.id, msg); } catch (e2) {}
    }
    throw new Error('Content script not loaded on this tab — reload the Starling page (Ctrl+R).');
  }
}
// ---- messaging to the memoQ tab --------------------------------------------
async function sendMQ(msg) {
  const t = await activeTab();
  if (!t || !/^https:\/\/memoq\.terratranslations\.com\/memoqweb\//.test(t.url || '')) {
    throw new Error('Open a memoQ web editor document tab, then click Detect.');
  }
  try {
    return await chrome.tabs.sendMessage(t.id, msg);
  } catch (e) {
    throw new Error('memoQ content script not loaded — reload the memoQ editor page.');
  }
}
// ---- messaging to the YiCAT tab --------------------------------------------
async function sendYC(msg) {
  const t = await activeTab();
  if (!t || !/^http:\/\/129\.226\.170\.49\/yizhe\/yicat\//.test(t.url || '')) {
    throw new Error('Open a YiCAT editor task tab, then click Detect.');
  }
  try {
    return await chrome.tabs.sendMessage(t.id, msg);
  } catch (e) {
    throw new Error('YiCAT content script not loaded — reload the YiCAT editor page.');
  }
}

// ---- logging ---------------------------------------------------------------
function log(...a) {
  const el = $('log');
  el.textContent += (el.textContent ? '\n' : '') + a.join(' ');
  el.scrollTop = el.scrollHeight;
}
function info(id, msg, cls) { const el = $(id); el.textContent = msg || ''; el.className = 'info' + (cls ? ' ' + cls : ''); }

// ---- token highlighting (same palette as the Copy Deck) --------------------
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function hl(escaped) {
  return escaped
    .replace(/(\{\{[^}]+\}\})/g, '<span class="tok tok-var">$1</span>')
    .replace(/(?<!\{)(\{[^{}]+\})(?!\})/g, '<span class="tok tok-var">$1</span>')
    .replace(/(&lt;\/?[a-zA-Z][^&]*?&gt;)/g, '<span class="tok tok-tag">$1</span>')
    .replace(/([OC]-\d+(?:-\d+)+)/g, '<span class="tok tok-tag">$1</span>')
    .replace(/(%\d?\$?[sd])/g, '<span class="tok tok-pct">$1</span>');
}
// Starling encodes tags as text tokens O-<id>/C-<id> ("O-1-0<text>C-1-0"), and
// the editor may render them as ①②. Strip both so a per-part copy is only the
// inner text you paste BETWEEN the existing tags. Badge uses the tag's own id.
function stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<\/?(?:g|x|bpt|ept|ph|it|mrk|sub)\b[^>]*>/gi, '') // XLIFF inline tag elements
    .replace(/[OC]-\d+(?:-\d+)+/g, '')                          // Starling O-/C- text tokens
    .replace(/[①-⑳❶-➓⓪]/g, '')                                  // circled markers
    .replace(/\s{2,}/g, ' ').trim();
}
function tagId(s) { const m = String(s == null ? '' : s).match(/O-(\d+)/); return m ? m[1] : null; }

// Trailing tokens (tags / placeholders / entities / whitespace) that may sit after the
// last real character — ignored when deciding whether a string "ends with a full stop".
const TRAIL_TOK = /(?:\s+|\\n|<[^>]+>|\{\{[^{}]*\}\}|\{[^{}]*\}|%\d?\$?[sd]|&[a-zA-Z#0-9]+;|[OC]-\d+(?:-\d+)+|[①-⑳❶-➓⓪])+$/;  // \\n = a trailing LITERAL "\n" escape, so a sentence period before it isn't hidden from the full-stop mirror
function coreEnd(x) { return String(x == null ? '' : x).replace(TRAIL_TOK, ''); }
function endsPeriod(x) { return /\.$/.test(x) && !/\.\.$/.test(x) && !/…$/.test(x); }  // single ASCII full stop, not ellipsis
function endsEllipsis(x) { return /\.\.$/.test(x) || /…$/.test(x); }
// MIRROR the source's terminal full stop on the output: if the English source ends with a
// single '.', make sure the Hebrew does too (add it); if the source has no '.', strip a
// stray one. Ellipses (…/..), '?', '!' are left alone and it never double-punctuates.
function matchTrailingPeriod(src, out) {
  const o0 = String(out == null ? '' : out);
  const s = coreEnd(src);
  if (!s || endsEllipsis(s)) return o0;                  // no usable source, or source ends in an ellipsis
  const trail = (o0.match(TRAIL_TOK) || [''])[0];
  const core = o0.slice(0, o0.length - trail.length);
  if (endsPeriod(s)) {                                   // source HAS a full stop → ensure the output does
    if (endsPeriod(core) || endsEllipsis(core)) return o0;         // already ends (before any tags) with . or …
    const oEnd = o0.replace(/\s+$/, '');
    if (!oEnd || /[?!:;׃]$/.test(oEnd)) return o0;                 // don't append after ? ! : ; ׃
    return oEnd + '.';
  }
  // source has NO full stop → remove a stray trailing one (may sit before trailing tags)
  if (endsEllipsis(core)) return o0;
  if (endsPeriod(core)) return core.replace(/\.$/, '') + trail;
  return o0;
}

// Flag when the source and output disagree on their NUMBERS — e.g. a stale TM value like
// "$7,500" kept for a source that actually says "MX$67,000". Only flags when BOTH sides
// have digits, so spelled-out numbers (Hebrew words) don't false-positive.
function numsOf(s) { return (String(s == null ? '' : s).match(/\d[\d.,  ]*\d|\d/g) || []).map((x) => x.replace(/\D/g, '')).filter(Boolean); }
function numMismatch(src, out) {
  const a = new Set(numsOf(src)), b = new Set(numsOf(out));
  if (!a.size || !b.size) return false;
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}
// Currency amounts (symbol + number) are DO-NOT-TRANSLATE — they must appear in the output
// exactly as in the source ("MX$67,000" stays "MX$67,000", never "$7,500" or "$67,000").
const CUR_SYM = '$€£¥₩₪₹₽฿';
function curAmounts(s) { return String(s == null ? '' : s).match(new RegExp('[A-Za-z]{0,3}[' + CUR_SYM + ']\\s?\\d[\\d.,]*\\d?|\\d[\\d.,]*\\d?\\s?[' + CUR_SYM + ']', 'g')) || []; }
// A currency amount = a currency token (symbol, maybe with a 0-3 letter prefix like MX$) + a figure.
// House convention flips the symbol to AFTER the number in Hebrew, so compare order-INSENSITIVELY:
// same figure + same currency token, either side, counts as preserved (not a stale/altered value).
function curSym(a) { return String(a).replace(/[\d.,\s]/g, ''); }        // the currency token ($, MX$, ₩…)
function curFig(a) { return String(a).replace(/[^\d.,]/g, ''); }         // the digits + grouping
function amountIssue(src, out) {
  const o = String(out == null ? '' : out);
  for (const a of curAmounts(src)) {
    if (o.includes(a)) continue;                                          // present verbatim (source order)
    const sym = curSym(a), fig = curFig(a);
    if (sym && fig) {
      const S = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), F = fig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(?:' + S + '\\s?' + F + '|' + F + '\\s?' + S + ')').test(o)) continue;   // present in the other order → fine
    }
    return a;                                                             // genuinely missing / altered figure
  }
  return '';
}
function amountMismatch(src, out) { return numMismatch(src, out) || !!amountIssue(src, out); }
// Auto-fix the common case: exactly one currency amount on each side that differ → drop the
// source's amount verbatim into the target (position preserved). Multiple amounts → review-only.
function fixAmounts(src, out) {
  const o = String(out == null ? '' : out), sa = curAmounts(src), oa = curAmounts(o);
  if (sa.length === 1 && oa.length === 1 && sa[0] !== oa[0]) {
    // Only "restore" a genuinely different figure/currency (stale TM). If it's the SAME currency and
    // figure with the symbol on the other side, that's the intended he-IL order — leave it alone.
    if (curSym(sa[0]) === curSym(oa[0]) && curFig(sa[0]) === curFig(oa[0])) return o;
    return o.replace(oa[0], sa[0]);
  }
  return o;
}
// Normalize spacing — the usual Starling "Punctuation/Space" QA triggers: collapse repeated
// spaces, drop a space sitting BEFORE sentence punctuation ("מנהיג ותיק ." → "מנהיג ותיק."),
// and trim line/string ends. Leaves newlines and single spaces (e.g. around "|") intact.
function fixSpacing(s) {
  return String(s == null ? '' : s)
    .replace(/[^\S\n]{2,}/g, ' ')            // runs of spaces/tabs → one (internal)
    .replace(/[^\S\n]+([.,:;!?])/g, '$1')    // no space before . , : ; ! ?
    .replace(/[^\S\n]+\n/g, '\n')            // no trailing spaces before a newline
    .replace(/\n[^\S\n]+/g, '\n');           // no leading spaces after a newline
}
function hasSpacingIssue(s) { s = String(s == null ? '' : s); return /[^\S\n]{2,}/.test(s) || /[^\S\n]+[.,:;!?]/.test(s); }  // internal only — edges are mirrored from the source
// Leading/trailing whitespace must MATCH the source: a trailing space in the source (the
// "blue dot" in Starling) must appear in the target too, and a target-only edge space is dropped.
// Mirror the source's FULL edge whitespace — trailing space (Starling's blue "·") AND
// trailing newline (the blue "↵") — matching the write-time mirrorRowEdges (\s, not
// [^\S\n]); otherwise a source-final newline is never carried onto the proposal.
function leadWs(s) { return (String(s == null ? '' : s).match(/^\s*/) || [''])[0]; }
function trailWs(s) { return (String(s == null ? '' : s).match(/\s*$/) || [''])[0]; }
function mirrorEdges(src, out) {
  const core = String(out == null ? '' : out).replace(/^\s+/, '').replace(/\s+$/, '');
  return leadWs(src) + core + trailWs(src);
}
function edgeMismatch(src, out) { return leadWs(src) !== leadWs(out) || trailWs(src) !== trailWs(out); }
// Multi-word product names must keep their exact internal spacing — the target often drops
// the space or hyphenates ("TikTok Lite" → "TikTok-Lite"/"TikTokLite"). Extend as needed.
const BRANDS = ['TikTok Lite', 'TikTok LIVE', 'TikTok Shop', 'TikTok Studio', 'TikTok Now', 'TikTok Seller', 'TikTok Ads', 'TikTok Business', 'TikTok Music', 'TikTok Effect House', 'Live Studio'];
function escRe(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fixBrands(s) {
  let o = String(s == null ? '' : s);
  for (const b of BRANDS) {
    const parts = b.split(' '); if (parts.length < 2) continue;
    o = o.replace(new RegExp(parts.map(escRe).join('[-\\u00A0 ]{0,2}'), 'g'), b);  // hyphen/nbsp/none → single space
  }
  return o;
}
function brandIssue(src, out) {
  const s = String(src == null ? '' : src), o = String(out == null ? '' : out);
  for (const b of BRANDS) if (s.includes(b) && !o.includes(b)) return b;   // brand in source but not verbatim in output
  return '';
}
// Markdown emphasis (**bold**, and *italic*) in the source is formatting that must wrap
// the SAME term in the target — the model/TM frequently drops the asterisks. Restore any
// **X** whose inner text appears unwrapped in the target (X is usually a Latin brand kept
// verbatim, so it's found literally). Never touches already-wrapped spans; a term that was
// translated (not found verbatim) is left for the ⚠ bold badge to flag.
function fixBold(src, out) {
  const spans = String(src == null ? '' : src).match(/\*\*[^*]+?\*\*/g);
  if (!spans) return String(out == null ? '' : out);
  let s = String(out == null ? '' : out);
  for (const span of spans) {
    const inner = span.slice(2, -2).trim();
    if (!inner || s.includes('**' + inner + '**')) continue;                  // already wrapped
    const i = s.indexOf(inner);
    if (i < 0) continue;                                                       // not present verbatim → leave for the badge
    if (s[i - 1] === '*' || s[i + inner.length] === '*') continue;            // avoid double-wrapping
    s = s.slice(0, i) + '**' + inner + '**' + s.slice(i + inner.length);
  }
  return s;
}
function boldIssue(src, out) {
  const spans = String(src == null ? '' : src).match(/\*\*[^*]+?\*\*/g) || [];
  const o = String(out == null ? '' : out);
  for (const span of spans) { const inner = span.slice(2, -2).trim(); if (inner && !o.includes('**' + inner + '**')) return inner; }
  return '';
}
// A trailing LITERAL "\n" escape (backslash + the letter n — not a real newline) is a formatting
// token: mirror it from the source. If the source ends with one, keep/add it; if it does NOT, drop a
// target-only trailing "\n" (a common GPT / stale-TM artifact that mirrorEdges can't see, since it's
// text, not whitespace). Interior "\n" is left untouched — only the very end is normalized.
function matchTrailingNL(src, out) {
  const s = String(src == null ? '' : src), o = String(out == null ? '' : out);
  const srcHas = /\\n[ \t]*$/.test(s), outHas = /\\n[ \t]*$/.test(o);
  if (srcHas === outHas) return o;
  if (outHas && !srcHas) return o.replace(/[ \t]*\\n[ \t]*$/, '');   // strip the spurious trailing \n
  return o.replace(/[ \t]*$/, '') + (s.match(/\\n[ \t]*$/) || ['\\n'])[0];   // source has it → append
}
// Full output polish: fix internal spacing, restore brand spacing, restore **bold** markers,
// mirror a trailing literal "\n" escape and the source's full stop, then mirror leading/trailing whitespace.
function polish(src, out) { return mirrorEdges(src, matchTrailingNL(src, matchTrailingPeriod(src, fixBold(src, fixAmounts(src, fixBrands(fixSpacing(out))))))); }
// "Do these two targets render IDENTICALLY to the eye?" Used only to decide whether a proposal
// is a *real* change — never to alter what gets written. Ignores exactly the differences a reader
// can't see: leading/trailing whitespace & newlines (which polish() mirrors from the source), and
// invisible bidi / zero-width control marks (RLM ‏, LRM, isolates, ZWSP, BOM, soft hyphen). So a
// memory-refilled segment whose visible Hebrew already matches the confirmed target — differing
// only by a mirrored trailing space or an inserted ‏ — is NOT flagged as a change. Visible edits
// (a word, a real double-space fix, a curly-vs-straight quote) still differ and stay flagged.
function renderNorm(s) {
  return String(s == null ? '' : s)
    .replace(/[​-‏‪-‮⁠⁦-⁩﻿­]/g, '')  // zero-width + bidi controls + soft hyphen
    .replace(/^[\s ]+|[\s ]+$/g, '');                                    // leading/trailing whitespace (incl. \n, NBSP)
}
function sameRender(a, b) { return renderNorm(a) === renderNorm(b); }

// ---- optional XLIFF source (alternative to DOM harvest) --------------------
const XLIFF_TAGGED = /<\/?(?:g|x|bpt|ept|ph|it|mrk|sub)\b|[OC]-\d+(?:-\d+)+|[①-⑳❶-➓⓪]/;
function xliffUnescape(s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); }
function parseXliff(text) {
  const segs = [];
  const units = String(text).match(/<trans-unit\b[\s\S]*?<\/trans-unit>/gi) || [];
  for (const u of units) {
    const id = (u.match(/\bid="([^"]*)"/) || [])[1] || '';
    const srcRaw = (u.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || '';
    const tgtRaw = (u.match(/<target[^>]*>([\s\S]*?)<\/target>/i) || [])[1] || '';
    const src = xliffUnescape(srcRaw).trim(), tgt = xliffUnescape(tgtRaw).trim();
    const tagged = XLIFF_TAGGED.test(srcRaw) || XLIFF_TAGGED.test(tgtRaw) || XLIFF_TAGGED.test(src) || XLIFF_TAGGED.test(tgt);
    segs.push({ seg: id, src, tgt, tagged });
  }
  return segs;
}
function onXliffFile(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const all = parseXliff(r.result).filter((s) => s.seg !== '' && (s.src || s.tgt));
      if (!all.length) { info('harvest-info', 'No <trans-unit> segments found in that file.', 'err'); return; }
      const sel = parseSegSel($('seg-filter').value);
      const segs = sel ? all.filter((s) => sel(s)) : all;
      if (sel && !segs.length) { info('harvest-info', `No segments matched "${$('seg-filter').value.trim()}" (file has ${all.length}). Clear the box for all.`, 'err'); return; }
      state.segments = segs;
      const filtered = sel && segs.length !== all.length;
      const tagged = segs.filter((s) => s.tagged).length;
      info('harvest-info', `Loaded ${segs.length}${filtered ? ` of ${all.length}` : ''} segments from ${f.name}${filtered ? ' (filtered)' : ''}${tagged ? ` · ⚠ ${tagged} with tags` : ''}.`, 'good');
      log(`xliff: ${segs.length}/${all.length} segments from ${f.name}${sel ? ' (filtered)' : ''}`);
      $('gpt-card').hidden = false;
      runCoverage();
    } catch (e) { info('harvest-info', 'Could not parse XLIFF: ' + e.message, 'err'); }
  };
  r.readAsText(f);
  input.value = ''; // allow re-selecting the same file
}
// Split a bullet-delimited target ("A • B • C") into parts. In Starling each part
// is wrapped in a numbered tag pair ①…①, so copying parts one at a time lets you
// paste between the tags without touching them. null if only one part.
function splitParts(t) {
  const s = String(t == null ? '' : t);
  if (!/[•·]/.test(s)) return null;
  const p = s.split(/\s*[•·]\s*/).map((x) => x.trim()).filter(Boolean);
  return p.length > 1 ? p : null;
}
// Starling's numbered wrapping tags survive in the harvested text as tokens
// O-<id>/C-<id> (and may render as ①②③). Typing them back writes the literal
// "O-1-0" text and DESTROYS the real tag chips — so any segment carrying them is
// copy-by-hand, exactly like a DOM chip. (Not caught by the {x}/%s/<g> detector.)
const TAG_TOK = /[OC]-\d+(?:-\d+)+|[①-⑳❶-➓⓪]/;              // NO /g — used with .test()
function hasTags(s) { return TAG_TOK.test(String(s == null ? '' : s)); }
// Ordered signature of a string's copy-by-hand tag tokens (①…① / O-/C- pairs). Used to guard
// applying Consistency memory to tagged segments: only substitute the stored target when it carries
// the SAME tag tokens in the same order as the source, so the per-part Copy splitter still lines up.
const TAG_TOK_G = /[OC]-\d+(?:-\d+)+|[①-⑳❶-➓⓪]/g;
function tmTagSig(s) { return (String(s == null ? '' : s).match(TAG_TOK_G) || []).join('|'); }
// Split a target into the text runs that sit BETWEEN its tag tokens, so each run
// can be copied and pasted between the matching ①…① without touching the tags.
// Returns [{id, text}] (id = the innermost open-tag number seen before the run),
// or null when there are no O-/C- tokens.
function splitTagRuns(t) {
  const s = String(t == null ? '' : t);
  if (!/[OC]-\d+(?:-\d+)+/.test(s)) return null;
  const re = /([OC])-(\d+)(?:-\d+)+/g;
  const runs = [];
  let last = 0, m, openId = null;
  while ((m = re.exec(s))) {
    const txt = stripTags(s.slice(last, m.index)).trim();
    if (txt) runs.push({ id: openId, text: txt });
    if (m[1] === 'O') openId = m[2];   // track the innermost open tag id
    last = re.lastIndex;
  }
  const tail = stripTags(s.slice(last)).trim();
  if (tail) runs.push({ id: openId, text: tail });
  return runs.length ? runs : null;
}
async function panelCopy(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e2) {}
  }
  const prev = btn.textContent; btn.classList.add('copied'); btn.textContent = ok ? 'Copied ✓' : 'Ctrl+C';
  setTimeout(() => { btn.classList.remove('copied'); btn.textContent = prev; }, 1200);
}

// ---- connection ------------------------------------------------------------
async function refreshConn() {
  const c = $('conn');
  try {
    const r = await send({ type: 'PING' });
    if (r && r.ok) {
      // Surface the LIVE content-script version. A stale tab (extension reloaded but the
      // page not Ctrl+R'd) keeps running old code and silently drops edits like the ↵ —
      // so make the mismatch loud right here instead of letting writes misbehave.
      if (r.ver !== CS_EXPECT) {
        c.textContent = `⚠ page v${r.ver == null ? '—' : r.ver} · need v${CS_EXPECT} — Ctrl+R this page`;
        c.className = 'conn conn-bad';
        info('harvest-info', `This Starling tab is running content-script v${r.ver == null ? '—' : r.ver}, but the panel is v${CS_EXPECT}. Reload the extension, then Ctrl+R (F5) this page so the fix takes effect.`, 'err');
        return false;
      }
      c.textContent = `task ${r.taskId} · ${r.cells} cells · v${r.ver}`;
      c.className = 'conn conn-ok';
      return true;
    }
    throw new Error('no response');
  } catch (e) {
    c.textContent = 'not connected';
    c.className = 'conn conn-bad';
    info('harvest-info', e.message, 'err');
    return false;
  }
}

// TikTok Hebrew Style Guide — injected into the TikTok modes only (🐦 Starling, ⚖️ Feishu LQA).
// NOT applied to memoQ / Crowdin (other clients). Full reference: HEBREW-STYLE-GUIDE.md.
const STYLE_GUIDE =
  '\nTIKTOK HEBREW STYLE GUIDE (he-IL):\n' +
  '- VOICE: inclusive, approachable, conversational, clear and casual — keep it short, natural and consistent; plain everyday Hebrew.\n' +
  '- INTERNAL CONSISTENCY (across the items in THIS batch): if the same word, verb, or fixed collocation recurs in several items, render it with ONE consistent Hebrew choice throughout — do not alternate synonyms arbitrarily. E.g. "take (time)" → pick אורך OR לוקח and use the SAME one wherever it appears ("take so long" and "takes six business days" should both use it); likewise a recurring noun/verb should keep one rendering unless the grammar or sense of a specific item clearly requires another. This applies to FREE lexical choices, not only glossary terms.\n' +
  '- REGISTER: medium-low. Prefer the lower/natural register — use אנחנו (not אנו), עכשיו (not כעת), על (not אודות), ל־ (not עבור).\n' +
  '- UI CONTEXT overrides the address form:\n' +
  '  • Buttons / labels / titles → GERUND (שם פעולה), never the infinitive and never the imperative: "Save" → שמירה (not לשמור, not שמור/שמרי). Titles are short with NO trailing period.\n' +
  '  • Tooltips / inline instructions → a conjugated verb (with the gender slash for 2nd person): "Record your ending" → הקלט/הקליטי את הסיום.\n' +
  '  • When a string names another UI element, keep the name and do NOT wrap it in quotes (the app bolds it).\n' +
  '- ERROR MESSAGES: neutral, helpful tone — no blaming words like "failed"/נכשל; describe the situation without assigning fault.\n' +
  '- AMPERSAND: Hebrew has no "&" — render it as the word ו ("A & B" → "A ו-B").\n' +
  '- QUOTES: straight double quotes " " only — never curly/diagonal “ ” and never single quotes.\n' +
  '- SLASH BETWEEN ALTERNATIVES (not the gender slash): avoid "/" between whole words — use או; a slash is OK only when space is very tight.\n' +
  '- SEMICOLONS: avoid — split into shorter sentences. COMMAS: follow Hebrew grammar, don\'t copy English commas that break it.\n' +
  '- ELLIPSIS "…": for an action in progress ("מתבצעת העלאה…").\n' +
  '- BRACKETS: translate text inside [square brackets]; NEVER translate or alter text inside {curly braces} (code placeholders).\n' +
  '- GLOSSARY (approved terms — TRANSLATE / transliterate these, do NOT keep them in Latin): "LIVE" as the live-streaming feature / badge / action when it stands alone ("Go LIVE", "LIVE now", a "LIVE" label, "watch LIVE") → "שידור חי" (e.g. "Go LIVE" → "התחל/י שידור חי", "LIVE now" → "עכשיו בשידור חי"); "Snap" → "סנאפ"; "Blink" → "בלינק". EXCEPTION: the product name "TikTok LIVE" stays in Latin exactly as "TikTok LIVE".\n' +
  '- APPROVED PHRASINGS (render these source strings with EXACTLY this Hebrew, keeping the {placeholder} in the position shown): "Commented on {s_user}\'s post." → "הגיב/ה על הפוסט של {s_user}." — a possessive "X\'s post" becomes "הפוסט של X", so the {placeholder} moves to the END (right before the final period), NOT the front.\n' +
  '  • "Get funds in 3 simple steps" → "קבל/י מימון ב-3 צעדים פשוטים" — for an ACTION CTA / promo headline led by an imperative verb ("Get…", "Start…", "Claim…"), prefer the IMPERATIVE slash (קבל/י) over the gerund (קבלת מימון). The "titles → gerund" rule is for functional button / menu labels, NOT action headlines urging the user to act.\n' +
  '- HASHTAGS: translate the words of a hashtag and keep it as ONE token — no spaces inside — camel-casing each Hebrew word: "#asktiktok" → "#שאלואתטיקטוק". A brand hashtag stays Latin ("#TikTokTest" stays "#TikTokTest"). Never insert a space inside a hashtag.\n' +
  '- HEBREW DUAL (a count of exactly 2): Hebrew has a real dual form — USE it for 2 and do NOT write "2 <plural>": "2 days" → "יומיים" (not "2 ימים"), "2 years" → "שנתיים", "2 months" → "חודשיים", "2 weeks" → "שבועיים", "2 hours" → "שעתיים", "2 minutes" → "שתי דקות". For 3+ keep the numeral + plural ("{n} ימים").\n' +
  '- NUMBER FORMATTING: use digits, not spelled-out words ("2", not "שתיים"); a space between a number and its unit ("512 KB"); a minus sign for negatives ("–50%"). A price / number RANGE uses an EN-DASH ("$1–$20", "12–15"); a HYPHEN only joins a compound or a Hebrew prefix ("חד-פעמי", "ב-TikTok") — do not swap them.\n' +
  '- TIME-UNIT ABBREVIATIONS: when a letter abbreviates a TIME unit stuck to a number, TRANSLATE the unit to its Hebrew WORD (keep the digit): "20s" → "20 שניות" (seconds), "5s" → "5 שניות", "5min"/"5m" → "5 דקות" (minutes), "2h"/"2hr" → "2 שעות" (hours), "3d" → "3 ימים" (days). Do NOT keep the Latin letter ("20s" must NOT stay "20s" — that is a real error, e.g. when the value fills a {placeholder} inside a Hebrew sentence). This is NOT number-preservation: only the DIGIT is preserved, the unit is localized. EXCEPTION — genuine SYMBOLS stay Latin exactly as source: data sizes "512 KB"/"MB"/"GB"/"TB", "50%", resolutions "1080p"/"4K", "60fps", "Mbps".\n' +
  '- DASHES: hyphen (-) joins compounds/prefixes; an en-dash (–) sets off a clause the way an em-dash would ("הצעה מיוחדת – לא כדאי לפספס").\n' +
  '- EXCLAMATION MARKS: use sparingly — overuse dilutes them; do not add one the source does not have.\n' +
  '- REGISTER DEPENDS ON THE UI ROLE (the SAME English verb maps to different Hebrew depending on where the string sits — this is the #1 recurring dilemma, e.g. "Save" → שמירה as a button but שמור/שמרי as a tooltip). Decide the role FIRST from the item\'s "key" and "context" whenever the item carries them (a "_title"/"_btn" key or a context note usually settles it outright); only when those are absent, fall back to these signals in the source (and, in proofread, the existing target):\n' +
  '  • TITLE / SUBTITLE / BUTTON / LABEL / MENU / TAB / SETTING name → GERUND (שם פעולה): a short Title-Case fragment that NAMES an action or feature, has no object aimed at the user, no "your", no full-sentence punctuation. "Save" → שמירה; "Save new items" → שמירת פריטים חדשים; "Add friends" → הוספת חברים; "Edit profile" → עריכת פרופיל.\n' +
  '  • TOOLTIP / INLINE INSTRUCTION / CTA / BODY sentence telling the user to act NOW → IMPERATIVE slash: it has a direct object (often "your …"), a purpose clause ("… to …"), or is a full imperative sentence. "Save your changes" → שמור/שמרי את השינויים; "Record your ending" → הקלט/הקליטי את הסיום; promo "Get funds…" → קבל/י מימון….\n' +
  '  • BARE VERB with no other signal ("Save" / "Share" / "Follow" alone) → default to the GERUND (it is usually a button/label). BUT in PROOFREAD mode, if the existing target already uses a register that is valid for a plausible role, KEEP it — do NOT flip שמירה↔שמור/שמרי just because the source is a bare verb.\n' +
  '  • FLAG ONLY AS A LAST RESORT: if the item has a "key" or "context", they resolve the role — use them and do NOT set "flag". Only when NO "key" and NO "context" are provided AND the English is genuinely ambiguous AND the existing target does not settle it, return your best-guess Hebrew and set "flag" to a short note of the dilemma so a human can check the real context — e.g. "Save: gerund (שמירה) if a button, imperative (שמור/שמרי) if a tooltip — assumed button". Leave "flag" empty otherwise.\n' +
  '- SLASH FORM (gender-inclusive 2nd person) — short vs long: use the SHORT form (masculine word + "/" + feminine ending) ONLY when both genders share the same written stem: גלה/י, שתף/י, שלם/י, בחר/י, לחץ/י. When the spelling differs (typically a חולם-מלא ו in the masculine that the feminine drops), write BOTH words IN FULL: בדוק/בדקי, אמור/אמרי, שמור/שמרי, כתוב/כתבי. Test: if "masculine + /י" would misread (בדוק/י → "בדוקי"), use the full long form.\n' +
  '- DO NOT TRANSLATE (DNT): "TikTok" is a brand name — always keep it EXACTLY as "TikTok" (Latin, same casing); never translate or transliterate it. A Hebrew prefix attaches with a maqaf: ב-TikTok, ל-TikTok, ה-TikTok, מ-TikTok.\n' +
  '- CURRENCY POSITION: put the currency symbol or code immediately AFTER the number, adjacent, no space, for every currency (symbols and letter codes alike): "$20" → 20$, "£40" → 40£, "Rp1,000" → 1,000Rp, "₪50" → 50₪, "MX$67,000" → 67,000MX$. Keep the digits and the currency identity exactly as the source — only the symbol/code moves after the number.\n';

// ---- STYLE BRAIN: user-fed style docs distilled into extra rules + glossary --
// Kept in chrome.storage as { rules:[{id,cat,text,source,ts}], glossary:[{id,en,he,note,source,ts}], updatedAt }.
// ADDITIVE to STYLE_GUIDE above (the hand-crafted core stays authoritative); brainText()
// appends the ingested rules/terms so every 🐦 Starling + ⚖️ Feishu LQA call sees them.
let BRAIN = { rules: [], glossary: [], updatedAt: 0 };
async function brainLoad() { try { BRAIN = await store.get('styleBrain', { rules: [], glossary: [], updatedAt: 0 }); } catch (e) {} if (!BRAIN.rules) BRAIN.rules = []; if (!BRAIN.glossary) BRAIN.glossary = []; return BRAIN; }
async function brainSave() { BRAIN.updatedAt = Date.now(); try { await store.set({ styleBrain: BRAIN }); } catch (e) {} }
function brainText() {
  let s = STYLE_GUIDE;
  s += lockText();   // MANDATORY locked terms — sit at the top so they outrank the ingested rules/glossary below
  const rules = (BRAIN && BRAIN.rules) || [], gloss = (BRAIN && BRAIN.glossary) || [];
  if (rules.length) {
    s += '- ADDITIONAL HOUSE RULES (distilled from official style docs — follow these too; if one contradicts a rule above, the more specific / more recent one wins):\n';
    for (const r of rules) s += '  • ' + (r.cat ? '[' + r.cat + '] ' : '') + r.text.trim() + '\n';
  }
  if (gloss.length) {
    s += '- ADDITIONAL GLOSSARY (approved EN→HE from official docs — render these consistently; a brand kept inside a translated term still stays Latin):\n';
    for (const g of gloss) s += '  • "' + g.en + '" → "' + g.he + '"' + (g.note ? ' — ' + g.note : '') + '\n';
  }
  return s;
}

// ---- CONSISTENCY MEMORY: self-populating exact-match translation memory -----
// Every segment you WRITE is remembered as source → your target. On the next
// Process, any segment whose source EXACTLY matches (after wbFold normalisation)
// is set back to your previous wording — deterministically, no GPT drift — so
// recurrences stay identical across tasks and sessions. It also aligns repeated
// identical sources WITHIN one task. Grows from your own work; zero upkeep.
let TM = { map: {}, updatedAt: 0 };
async function tmLoad() { try { TM = await store.get('consistencyTM', { map: {}, enabled: true, updatedAt: 0 }); } catch (e) {} if (!TM || !TM.map) TM = { map: {}, enabled: true, updatedAt: 0 }; if (TM.enabled === undefined) TM.enabled = true;
  // One-time: turn Consistency memory OFF by default (user request). The data is kept; re-enable any
  // time with the "Apply remembered wording" toggle. Runs once, then the toggle state is respected.
  if (!TM.defaultOffMigrated) { TM.enabled = false; TM.defaultOffMigrated = true; try { await store.set({ consistencyTM: TM }); } catch (e) {} }
  if (!TM.fuzzy) TM.fuzzy = { enabled: false, threshold: 0.8 };   // near-match suggestions, off until tuned
  return TM; }
async function tmSave() { TM.updatedAt = Date.now(); FZ.dirty = true; try { await store.set({ consistencyTM: TM }); } catch (e) {} }
function tmCount() { return TM && TM.map ? Object.keys(TM.map).length : 0; }
function tmKey(src) { return wbFold(String(src == null ? '' : src)); }   // normalise quotes/dashes/spaces/fullwidth; case kept
function tmLookup(src) { const k = tmKey(src); return (k && TM.map[k]) ? TM.map[k] : null; }
function tmRecordOne(src, tgt) {
  const k = tmKey(src); const t = String(tgt == null ? '' : tgt).trim();
  if (!k || !t) return false;
  const prev = TM.map[k];
  TM.map[k] = { src: String(src), tgt: t, ts: Date.now(), n: (prev ? prev.n || 1 : 0) + 1 };
  return true;
}
// Record every approved, non-manual proposal that was actually written (okSegs = a
// Set of seg numbers that succeeded, or null to record all approved non-manual).
async function tmRecordWritten(okSegs) {
  let n = 0;
  for (const p of state.proposals || []) {
    if (p.manual || !p.approved) continue;
    if (okSegs && !okSegs.has(p.seg)) continue;
    if (tmRecordOne(p.src, p.next)) n++;
  }
  if (n) await tmSave();
  return n;
}
// Enforce memory on a freshly-built proposal list (called before state.proposals=…).
function tmApply(proposals) {
  if (!TM) return;
  const exactOn = !!TM.enabled, fuzzyOn = !!(TM.fuzzy && TM.fuzzy.enabled);
  if (!exactOn && !fuzzyOn) return;   // both switched off in Settings
  // Locked terms OUTRANK memory: don't let a stale remembered target inject a locked-term violation.
  const haveLocks = !!(LOCK && LOCK.terms && LOCK.terms.length);
  const lockClashes = [], parkedLock = new Set(CONF.filter((c) => c.kind === 'lockmem').map((c) => c.srcKey + '⇢' + String(c.lockEn).toLowerCase()));
  // 1) cross-task/session memory — prior wording is offered over a fresh GPT suggestion.
  for (const p of proposals) {
    const hit = exactOn ? tmLookup(p.src) : null;
    if (!hit) { if (fuzzyOn && !p.manual) fzAttach(p); continue; }   // no exact hit → offer near-matches
    // Tagged/chip ("manual") segments are copy-by-hand, never auto-written — but we STILL seed their
    // suggestion from memory so the remembered wording lands in the per-part Copy text. Guard: only when
    // the stored target carries the SAME tag tokens as the source, so the ①…① splitter stays aligned;
    // otherwise (e.g. a plain-text memory for a bullet-list segment) keep GPT's tag-carrying output.
    if (p.manual && tmTagSig(hit.tgt) !== tmTagSig(p.src)) continue;
    // If the remembered target VIOLATES a locked term the source requires, the locked term wins:
    // keep GPT's (locked-compliant) output, do NOT apply the stale memory, and park the clash.
    if (haveLocks) {
      const lv = lockViolations(p.src, hit.tgt);
      if (lv.length) {
        for (const t of lv) { const sig = tmKey(p.src) + '⇢' + String(t.en).toLowerCase(); if (!parkedLock.has(sig)) { parkedLock.add(sig); lockClashes.push({ kind: 'lockmem', label: p.src, srcKey: tmKey(p.src), src: p.src, memVal: hit.tgt, lockEn: t.en, lockHe: t.he }); } }
        p.tmLockBlocked = true;
        continue;   // locked wins — memory not applied
      }
    }
    if (wbFold(hit.tgt) !== wbFold(p.next)) {
      p.tmPrev = p.next;           // what GPT proposed this time
      p.next = hit.tgt;            // your previous, endorsed wording
      p.tm = true; p.tmOverride = true;
      p.approved = false;          // memory DIFFERS from GPT → leave UNCHECKED so you confirm (manual is
                                   // never auto-written regardless); a remembered mistake never re-applies silently.
    } else {
      p.tm = true;                 // GPT already matches memory → badge as consistent
    }
  }
  if (lockClashes.length) confAdd(lockClashes);   // surface stale locked-vs-memory clashes for a one-time decision
  // 2) intra-run alignment — identical sources in THIS task get ONE target.
  //    Canonical wording is chosen by MAJORITY VOTE (the rendering GPT produced most
  //    often for that source), but a remembered wording (p.tm) still outranks the vote.
  //    Ties break to the earliest segment so the pick is stable and predictable.
  if (!exactOn) return;
  const groups = new Map();
  for (const p of proposals) { if (p.manual) continue; const k = tmKey(p.src); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    let canon;
    const memP = arr.find((p) => p.tm);                     // a memory hit is authoritative — it wins outright
    if (memP) { canon = memP.next; }
    else {
      const tally = new Map(), first = new Map();           // fold -> count · fold -> {i, text} of its first occurrence
      arr.forEach((p, i) => { const f = wbFold(p.next); tally.set(f, (tally.get(f) || 0) + 1); if (!first.has(f)) first.set(f, { i, text: p.next }); });
      let best = null;
      for (const [f, n] of tally) { const o = first.get(f); if (!best || n > best.n || (n === best.n && o.i < best.i)) best = { n, i: o.i, text: o.text }; }
      canon = best.text;                                    // most-frequent rendering (earliest on a tie)
    }
    for (const p of arr) {
      if (wbFold(p.next) !== wbFold(canon)) {
        if (!p.tmPrev) p.tmPrev = p.next;
        p.next = canon; p.dedupe = true;
        p.approved = !p.manual && !sameRender(p.next, p.old);
      }
    }
  }
}

// ---- FUZZY MEMORY: near-match suggestions when there's no exact hit --------
// Two DETERMINISTIC, review-only tiers (never auto-applied, never auto-checked):
//  A) TEMPLATE — mask numbers + placeholders; an EXACT match of the masked template
//     surfaces the prior target, with a safe 1:1 literal-number transplant (Option C).
//  B) FUZZY — token Sørensen–Dice similarity ≥ threshold (default 0.8) surfaces the
//     closest prior translation + its source so you can adapt it. Top-3.
// Off by default (TM.fuzzy.enabled). Index built lazily from TM.map, rebuilt when memory changes.
let FZ = { entries: [], templates: null, inverted: null, dirty: true };
const FZ_PLACE = /\{\{[^{}]*\}\}|\{[^{}]*\}|%\d?\$?[sd]|<[^>]+>|\[[^\]]*\]|[①-⑳❶-➓⓪]/g;
const FZ_NUM = /\d[\d.,]*/g;
function fzMask(s) { return wbFold(String(s == null ? '' : s)).replace(FZ_PLACE, '  ').replace(FZ_NUM, '  '); }
function fzTemplate(s) { return fzMask(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function fzTokens(s) { return fzTemplate(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean); }
function fzNumbers(s) { return String(s == null ? '' : s).match(/\d[\d.,]*/g) || []; }
function fzDice(aTokens, bSet, bLen) {
  if (!aTokens.length || !bLen) return 0;
  const aUniq = new Set(aTokens); let inter = 0;
  for (const t of aUniq) if (bSet.has(t)) inter++;
  return (2 * inter) / (aUniq.size + bLen);
}
function fzBuildIndex() {
  const entries = [], templates = new Map(), inverted = new Map();
  for (const k of Object.keys(TM.map || {})) {
    const e = TM.map[k]; if (!e || !e.src || !e.tgt) continue;
    const set = new Set(fzTokens(e.src)); const tmpl = fzTemplate(e.src); const idx = entries.length;
    entries.push({ key: k, src: e.src, tgt: e.tgt, tmpl, set, len: set.size });
    if (!templates.has(tmpl)) templates.set(tmpl, []); templates.get(tmpl).push(idx);
    for (const t of set) { if (!inverted.has(t)) inverted.set(t, []); inverted.get(t).push(idx); }
  }
  FZ = { entries, templates, inverted, dirty: false };
}
// Option C — safe 1:1 literal-number transplant. Only when the new source and the memory
// source each have exactly ONE literal number and that number appears verbatim exactly once
// in the memory target; otherwise return the target unchanged (ranges/reformatting → as-is).
function fzTransplant(newSrc, memSrc, memTgt) {
  const nn = fzNumbers(newSrc), mn = fzNumbers(memSrc);
  if (nn.length !== 1 || mn.length !== 1) return memTgt;
  const esc = mn[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const g = new RegExp('(?<![\\d.,])' + esc + '(?![\\d.,])', 'g');
  if ((memTgt.match(g) || []).length !== 1) return memTgt;
  return memTgt.replace(new RegExp('(?<![\\d.,])' + esc + '(?![\\d.,])'), nn[0]);
}
// Up to 3 near-matches for one source, excluding an exact hit and GPT's own text.
function fzMatch(src, gptTgt) {
  if (FZ.dirty || !FZ.entries) fzBuildIndex();
  if (!FZ.entries.length) return [];
  const th = (TM.fuzzy && TM.fuzzy.threshold) || 0.8;
  const qTmpl = fzTemplate(src), qToks = fzTokens(src), qFold = wbFold(src);
  const out = [], seenTgt = new Set(gptTgt ? [wbFold(gptTgt)] : []);
  for (const idx of (FZ.templates.get(qTmpl) || [])) {   // A) template tier
    const e = FZ.entries[idx]; if (wbFold(e.src) === qFold) continue;   // exact hit — handled elsewhere
    const suggest = fzTransplant(src, e.src, e.tgt); const kt = wbFold(suggest);
    if (seenTgt.has(kt)) continue; seenTgt.add(kt);
    out.push({ tier: 'template', score: 0.99, src: e.src, tgt: e.tgt, suggest });
    if (out.length >= 3) return out;
  }
  const N = FZ.entries.length, cap = Math.max(40, Math.floor(N * 0.05)), tally = new Map();
  for (const t of new Set(qToks)) { const lst = FZ.inverted.get(t); if (!lst || lst.length > cap) continue; for (const i of lst) tally.set(i, (tally.get(i) || 0) + 1); }
  const cands = [...tally.keys()].sort((a, b) => tally.get(b) - tally.get(a)).slice(0, 300);
  const scored = [];
  for (const i of cands) {
    const e = FZ.entries[i];
    if (e.tmpl === qTmpl || wbFold(e.src) === qFold) continue;   // template-tier / exact already handled
    const score = fzDice(qToks, e.set, e.len);
    if (score >= th) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  for (const { e, score } of scored) {
    const kt = wbFold(e.tgt); if (seenTgt.has(kt)) continue; seenTgt.add(kt);
    out.push({ tier: 'fuzzy', score, src: e.src, tgt: e.tgt, suggest: e.tgt });
    if (out.length >= 3) break;
  }
  return out.slice(0, 3);
}
function fzAttach(p) { const m = fzMatch(p.src, p.next); if (m.length) p.fuzzy = { matches: m }; }

// ---- LOCKED TERMS: a "must" glossary (mandatory EN→HE) --------------------
// Two-tier enforcement, chosen by the user as FLAG-ONLY (never auto-edits, so it
// can't corrupt Hebrew inflection):
//   1) PROMPT tier — lockText() injects each term into the GPT system prompt with
//      hard "NON-NEGOTIABLE" wording (reaches 🐦 Starling + ⚖️ Feishu via brainText()).
//   2) POST-CHECK tier — after a Run, lockCheck() scans each proposal: if a locked
//      EN term is in the source but its required HE is missing from the target, the
//      row gets a red "🔒 locked" flag so it can't ship unnoticed. You fix it by hand.
// Stored in chrome.storage as { terms:[{id,en,he,note,ts}], updatedAt }.
let LOCK = { terms: [], updatedAt: 0 };
async function lockLoad() { try { LOCK = await store.get('lockedTerms', { terms: [], updatedAt: 0 }); } catch (e) {} if (!LOCK || !LOCK.terms) LOCK = { terms: [], updatedAt: 0 }; return LOCK; }
async function lockSave() { LOCK.updatedAt = Date.now(); try { await store.set({ lockedTerms: LOCK }); } catch (e) {} }
function lockCount() { return LOCK && LOCK.terms ? LOCK.terms.length : 0; }
function lockEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// The locked block for the GPT prompt (empty when no terms, so it costs nothing).
function lockText() {
  const terms = (LOCK && LOCK.terms) || [];
  if (!terms.length) return '';
  let s = '- LOCKED TERMS (MANDATORY — NON-NEGOTIABLE): each source term below MUST be rendered with EXACTLY the Hebrew given. You may ONLY attach a Hebrew prefix (ב/ל/ה/מ/ו/ש/כ — with a maqaf before a Latin term, e.g. ב-TikTok) and let it inflect for grammar; NEVER substitute a synonym, reorder its words, or reword it. This OVERRIDES any other glossary or house rule.\n';
  for (const t of terms) s += '  • "' + t.en + '" → "' + t.he + '"' + (t.note ? ' — ' + t.note : '') + '\n';
  return s;
}
// Is the locked EN term present in the source (boundary-aware, case-insensitive)?
function lockSrcHas(src, en) {
  const e = String(en == null ? '' : en).trim(); if (!e) return false;
  try { return new RegExp('(?<![A-Za-z0-9])' + lockEsc(e) + '(?![A-Za-z0-9])', 'i').test(String(src == null ? '' : src)); }
  catch (_) { return String(src == null ? '' : src).toLowerCase().includes(e.toLowerCase()); }
}
// Does the target contain the required HE? Allow a fused prefix (the term still appears
// verbatim after ב/ל/מ/ו/ש/כ) and the definite-ה dropping after a prefix (ההגדרות→בהגדרות).
function lockTgtHas(tgt, he) {
  const h = String(he == null ? '' : he).trim(); if (!h) return true;
  const t = wbFold(String(tgt == null ? '' : tgt));
  const cands = [wbFold(h)];
  if (h[0] === 'ה') cands.push(wbFold(h.slice(1)));   // definite article may fuse into a prefix
  return cands.some((c) => c && t.includes(c));
}
// Which locked terms are required by the source but missing from the target.
function lockViolations(src, tgt) {
  const terms = (LOCK && LOCK.terms) || []; if (!terms.length) return [];
  const out = [];
  for (const t of terms) { if (lockSrcHas(src, t.en) && !lockTgtHas(tgt, t.he)) out.push(t); }
  return out;
}
// Tag every proposal with p.lockMiss = ["EN → HE", …] (or null) for the review badge.
function lockCheck(proposals) {
  const terms = (LOCK && LOCK.terms) || [];
  for (const p of proposals) {
    if (!terms.length) { p.lockMiss = null; continue; }
    const v = lockViolations(p.src, p.next);
    p.lockMiss = v.length ? v.map((t) => t.en + ' → ' + t.he) : null;
  }
}

// ---- IN-TASK CONSISTENCY (Case 2): flag-only term drift -------------------
// A DETECT-AND-FLAG sanity check — it NEVER rewrites. Hebrew inflects and fuses
// prefixes (ב/ל/ה/מ/ו/ש), so forcing one rendering onto a term sitting inside a
// sentence could quietly break grammar (that's why LOCKED terms are flag-only too).
// So we only surface the drift and let you decide — with one click to LOCK the term
// so it can't drift again across future tasks.
//
// How it decides a term's "right" wording: it builds an ad-hoc glossary from this
// task's STANDALONE LABEL segments — a short source translated on its own is that
// term's citation form (e.g. a segment whose whole source is "Check status"). It runs
// AFTER the majority-vote alignment above, so identical labels already share one target.
// Then, for each such term, it flags any OTHER segment whose source contains the term
// but whose target is MISSING the label's Hebrew (fused-prefix / definite-ה tolerant —
// the same tolerance lockTgtHas() uses). High-precision by design: only multi-word or
// ≥5-letter terms are scanned inside prose (single short words are too ambiguous).
function consistLabelEn(src) {
  const f = wbFold(String(src == null ? '' : src));
  if (!f || !/[A-Za-z]/.test(f)) return '';               // must carry Latin letters (an English UI term)
  const words = f.split(' ').filter(Boolean);
  if (words.length > 4 || f.length > 40) return '';       // not a short standalone label
  return f;                                               // wbFold'd English = the citation-form key
}
function consistScanable(en) {                            // worth hunting for INSIDE longer sentences?
  const words = en.split(' ').filter(Boolean);
  return words.length >= 2 || (words.length === 1 && en.replace(/[^A-Za-z]/g, '').length >= 5);
}
// Tag every proposal with p.consist = [{en, he, from}] (or null) for the review badge.
function consistCheck(proposals) {
  for (const p of proposals) p.consist = null;
  // 1) Authority glossary from standalone labels: enKey -> { en (original), he (clean), from (first seg) }.
  const gloss = new Map();
  for (const p of proposals) {
    if (p.manual) continue;                               // tagged/chip rows aren't clean citation forms
    const en = consistLabelEn(p.src); if (!en) continue;
    const he = stripTags(String(p.next == null ? '' : p.next)).trim();
    if (!he) continue;
    if (!gloss.has(en)) gloss.set(en, { en: String(p.src).trim(), he, from: p.seg });
  }
  // 2) Flag any OTHER segment that carries the English term but not the label's Hebrew.
  for (const [en, g] of gloss) {
    if (!consistScanable(en)) continue;
    for (const p of proposals) {
      if (p.manual) continue;
      if (consistLabelEn(p.src) === en) continue;         // the label itself / an identical-source repeat
      if (!lockSrcHas(p.src, g.en)) continue;             // English term not present as a whole phrase
      if (lockTgtHas(p.next, g.he)) continue;             // its citation Hebrew IS present → consistent
      (p.consist = p.consist || []).push({ en: g.en, he: g.he, from: g.from });
    }
  }
}
// One-click lock from a ⚖ consistency flag — reuses the LOCKED-terms store so the
// pairing becomes mandatory everywhere (same guard as the Lookup 🔒 lock).
async function consistLock(en, he) {
  en = String(en || '').trim(); he = String(he || '').trim();
  if (!en || !he) return { ok: false, msg: 'Missing term.' };
  const clash = (LOCK.terms || []).find((t) => (t.en || '').toLowerCase() === en.toLowerCase() && wbFold(t.he) !== wbFold(he));
  if (clash) return { ok: false, msg: `“${en}” is already locked to “${clash.he}” — change it in the 🔒 Locked terms card.` };
  LOCK.terms = (LOCK.terms || []).filter((t) => (t.en || '').toLowerCase() !== en.toLowerCase());
  LOCK.terms.push({ id: brainUid(), en, he, note: 'from consistency', ts: Date.now() });
  await lockSave(); lockRefresh();
  return { ok: true, msg: `Locked: “${en}” → “${he}”.` };
}

// ---- ⚖ INTERNAL-CONSISTENCY SWEEP (GPT) -----------------------------------
// The deterministic consistCheck() above catches only DEFINED-label drift (a short standalone
// segment whose Hebrew is missing where its English recurs). It can't see free lexical drift —
// GPT rendering the same verb/collocation two different ways across differently-worded segments
// (e.g. "take (time)" → אורך here, לוקח there). This optional pass sends the whole task's
// source→target pairs to GPT in ONE call and asks it to flag genuine synonym drift and propose a
// unified wording per drifting segment. Review-only: it sets p.icDrift and NEVER auto-applies.
async function icSweepGpt(items, key, model) {
  const sys =
    'You are a he-IL (Hebrew) localization INTERNAL-CONSISTENCY checker for ONE translation task. ' +
    'You receive segments, each {"i":<id>,"src":<English source>,"he":<its Hebrew translation>}. ' +
    'Find GROUPS where the SAME recurring English word or fixed collocation is translated with DIFFERENT Hebrew renderings across segments — avoidable synonym drift, e.g. "information" rendered "מידע" in one segment and "פרטים" in another. ' +
    'For each group return: "concept" (the English word/phrase that drifts); "reason" (short, e.g. "information: מידע vs פרטים"); "renderings" — the competing Hebrew renderings (2–4, most natural first); and "members" — EVERY segment in which the concept appears with one of those renderings. ' +
    'For EACH member return "i" and "rewrites": an array PARALLEL to "renderings", where rewrites[k] is that segment\'s FULL Hebrew rewritten so the concept uses renderings[k] — grammatically correct (adjust only the words the change forces: gender, number, prefixes, the definite ה\"א) and CHANGING NOTHING ELSE (keep the meaning, every placeholder {x}/%s/<g>…, every number/currency, and all punctuation identical). If a rendering already fits a segment as-is, its rewrite is that segment\'s current "he". ' +
    'Do NOT choose a winner — offer the renderings and let the human pick. Only report GENUINE avoidable drift where the SAME meaning is expressed by different words; do NOT report differences the grammar or sense of a segment requires (singular vs plural of a different meaning, a noun vs a verb use), and do NOT report glossary/term choices. ' +
    'Return ONLY JSON: {"groups":[{"concept":"information","reason":"information: מידע vs פרטים","renderings":["מידע","פרטים"],"members":[{"i":3,"rewrites":["…מידע…","…פרטים…"]}]}]}. ' +
    'Return an empty "groups" array if everything is already consistent. No commentary, no markdown, no code fences.';
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Check these segments for internal consistency drift:\n' + JSON.stringify({ items }) }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || ('GPT error ' + r.status));
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  return parsed.groups || [];
}
async function icSweep() {
  const props = (state.proposals || []).filter((p) => !p.manual && String(p.next || '').trim());
  if (props.length < 2) { info('gpt-info', 'Need at least 2 translated (non-tagged) segments to check internal consistency.', 'err'); return; }
  const key = await store.get('key', ''); if (!key) { info('gpt-info', 'Add your OpenAI key in ⚙️ Settings first.', 'err'); return; }
  const model = $('model').value;
  const btn = $('ic-sweep'); const prev = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '🧹 sweeping…'; }
  info('gpt-info', `Checking ${props.length} segment(s) for internal consistency drift…`);
  try {
    for (const p of state.proposals) p.icDrift = null;              // clear any prior sweep
    const items = props.map((p) => ({ i: state.proposals.indexOf(p), src: String(p.src || ''), he: stripTags(String(p.next == null ? '' : p.next)) }));
    const groups = await icSweepGpt(items, key, model);
    let n = 0, gi = 0;
    for (const g of (groups || [])) {
      const renderings = (g.renderings || []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
      if (renderings.length < 2) continue;
      const gid = 'g' + (gi++) + '·' + (g.concept || '');
      // Stage each member with a full rewrite per rendering (grammatically-correct, from GPT).
      const staged = [];
      for (const m of (g.members || [])) {
        const p = state.proposals[Number(m.i)]; if (!p || p.manual) continue;
        const rw = m.rewrites || [];
        const options = renderings.map((he, k) => ({ he, suggest: String(rw[k] == null ? '' : rw[k]).trim() })).filter((o) => o.suggest);
        if (options.length < 2) continue;                            // need a real choice
        if (options.every((o) => sameRender(o.suggest, options[0].suggest))) continue;   // the renderings don't actually differ here
        staged.push({ p, options });
      }
      if (staged.length < 2) continue;                               // a real drift group spans ≥2 segments
      for (const s of staged) {
        s.p.icDrift = { concept: String(g.concept || ''), reason: String(g.reason || g.concept || 'inconsistent wording'), group: gid, options: s.options };
        n++;
      }
    }
    renderReview();
    if (n && $('view-icdrift')) $('view-icdrift').click();          // jump to the drift view
    info('gpt-info', n
      ? `⚖ ${n} segment(s) drift across ${gi} term(s) — pick a rendering below; it standardizes every segment using that term (nothing auto-applied).`
      : '⚖ No internal-consistency drift found — recurring wording is consistent across the task.', n ? '' : 'good');
  } catch (e) { info('gpt-info', 'Consistency sweep failed: ' + (e.message || e), 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = prev || '🧹 Sweep drift'; } }
}

// ---- TERM BASE: Starling's own inline term references ---------------------
// Starling underlines source words that have an approved term entry (span.highlight-text-term);
// hovering shows EN→HE + part-of-speech + a DNT ("do not translate") / Brand-name flag.
// "⬇ Grab term base" reads them straight from the open task (MAIN-world React vnode — the
// popover data is preloaded, no hovering needed) and splits them into two tiers:
//   • DNT / brand terms  → routed into 🔒 Locked terms as keep-as-is (strict; lockCheck enforces).
//   • translatable terms → kept HERE as SOFT hints: injected per-segment into the GPT prompt as a
//     PREFERRED default that may bend when grammar/context requires (a Noun used as a verb,
//     "due to"→עקב, …), and surfaced as a review flag on deviation — never forced.
// The whole thing is gated by TB.enabled (the toggle) — off = the term base is ignored on Run.
let TB = { enabled: true, terms: [], updatedAt: 0 };
async function tbLoad() { try { TB = await store.get('termBase', { enabled: true, terms: [], updatedAt: 0 }); } catch (e) {} if (!TB || !TB.terms) TB = { enabled: true, terms: [], updatedAt: 0 }; if (TB.enabled === undefined) TB.enabled = true; return TB; }
async function tbSave() { TB.updatedAt = Date.now(); try { await store.set({ termBase: TB }); } catch (e) {} }
function tbCount() { return TB && TB.terms ? TB.terms.length : 0; }
function tbUid() { return 'tb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
// Translatable terms whose EN appears in this source (boundary-aware) → the per-segment hint list.
function tbHintsFor(src) {
  if (!TB || !TB.enabled || !(TB.terms || []).length) return [];
  const out = [];
  for (const t of TB.terms) { if (t && t.en && t.he && lockSrcHas(src, t.en)) { const h = { en: t.en, he: t.he }; if (t.pos) h.pos = t.pos; out.push(h); } }
  return out;
}
// Post-run SOFT flag: a term's approved HE is absent from the target. Context may legitimately
// explain it (verb form, different sense) — so this is review-only, never a rewrite.
function tbCheck(proposals) {
  for (const p of proposals) p.termHint = null;
  if (!TB || !TB.enabled || !(TB.terms || []).length) return;
  for (const p of proposals) {
    if (p.manual) continue;
    const miss = [];
    for (const t of TB.terms) {
      if (!t.en || !t.he) continue;
      if (lockSrcHas(p.src, t.en) && !lockTgtHas(p.next, t.he)) miss.push({ en: t.en, he: t.he });
    }
    p.termHint = miss.length ? miss : null;
  }
}
// Read the open task's term references from the page's MAIN world (executeScript world:'MAIN'
// — the popover data is preloaded on each span's React vnode, so no hover simulation is needed).
async function tbGrab() {
  const t = await activeTab();
  if (!t) { tbInfo('Open your Starling task tab first.', 'err'); return; }
  tbInfo('Scanning the task for term references…');
  let scraped = [];
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: t.id },
      world: 'MAIN',
      func: async () => {
        const POS = /^(Noun|Verb|Proper noun|Adjective|Adverb|Phrase|Abbreviation|Pronoun|Preposition|Interjection)$/i;
        const getVnode = (span) => { const fk = Object.keys(span).find((k) => k.startsWith('__reactFiber$')); if (!fk) return null; let f = span[fk], hops = 0; while (f && hops < 8) { const p = f.memoizedProps; if (p && p.content && p.content.$$typeof) return p.content; f = f.return; hops++; } return null; };
        const leavesOf = (n, d, out) => { if (!n || d > 16) return; if (typeof n === 'string') { const s = n.trim(); if (s) out.push(s); return; } if (Array.isArray(n)) { n.forEach((x) => leavesOf(x, d + 1, out)); return; } if (typeof n === 'object' && n.props) leavesOf(n.props.children, d + 1, out); };
        const parse = (word, texts) => {
          const dnt = texts.includes('DNT') || texts.includes('Brand name');
          const entries = [];
          for (let i = 0; i < texts.length; i++) { if (texts[i] === '->' || texts[i] === '→') { const en = (i > 0 ? texts[i - 1] : '') || '', he = (i + 1 < texts.length ? texts[i + 1] : '') || ''; if (en && !POS.test(en) && en !== 'DNT' && en !== 'Brand name') entries.push({ en, he }); } }
          let ent = entries.find((e) => e.en.toLowerCase() === word.toLowerCase()) || entries[0] || null;
          let he = ent ? ent.he : (dnt ? word : '');
          if (dnt && (!he || he === 'Brand name')) he = word;
          const pos = texts.find((x) => POS.test(x)) || '';
          const def = texts.find((x) => /\s/.test(x) && x.length > 15 && !POS.test(x)) || '';
          return { en: word, he, pos, dnt, def };
        };
        // The segment list is a VIRTUALIZED list — only the rows currently scrolled into
        // view exist in the DOM, so a single snapshot only captures on-screen terms. Find
        // the scroller (the scrollable ancestor of a rendered term span, else the tallest
        // scroll area on the page) and walk it top→bottom, parsing the term spans that mount
        // at each step, so ONE grab captures every task term regardless of scroll position.
        const map = new Map();
        const collect = () => { for (const sp of document.querySelectorAll('span.highlight-text-term')) { const word = (sp.textContent || '').trim(); if (!word) continue; const key = word.toLowerCase(); if (map.has(key)) continue; const vn = getVnode(sp); if (!vn) continue; const texts = []; leavesOf(vn, 0, texts); const e = parse(word, texts); if (e.he) map.set(key, e); } };
        // ---- Document editor (CAT /doc/editor) path -----------------------------------------
        // The Document editor uses a different term markup (span.cat-content__term, no preloaded
        // vnode) and holds EVERY segment's term matches in its redux store — so we read them all
        // in one shot, no scrolling. Each segment carries a `termMap` { sourceWord: [entry…] };
        // entry.langItemMap.{source,target}.content give EN/HE, tags[].tag === "DNT" (or
        // description "Brand name") marks do-not-translate, partOfSpeech is a numeric code.
        // Falls through to the String-editor scroll-walk below when this isn't a doc task.
        try {
          const POS_CODE = { 1: 'Noun', 2: 'Verb', 3: 'Adjective', 4: 'Adverb', 6: 'Proper noun' };
          const anchor = document.querySelector('.cat-content__term, [class*="cat-content__source"], [class*="cat-content"]');
          let store = null;
          if (anchor) {
            let n = anchor;
            for (let up = 0; n && up < 18 && !store; up++, n = n.parentElement) {
              const fk = Object.keys(n).find((k) => k.startsWith('__reactFiber$')); if (!fk) continue;
              let f = n[fk], hops = 0;
              while (f && hops < 16) { const p = f.memoizedProps; if (p && p.docEditor && p.docEditor.taskDetail) { store = p.docEditor; break; } f = f.return; hops++; }
            }
          }
          const segs = store && store.taskDetail && store.taskDetail.segmentInfo && store.taskDetail.segmentInfo.segments;
          if (segs && segs.length) {
            for (const s of segs) {
              const tm = (s && s.termMap) || {};
              for (const key of Object.keys(tm)) {
                const arr = tm[key] || []; const e = arr[0]; if (!e) continue;
                const lim = e.langItemMap || {};
                const en = String(((lim.source && lim.source.content) || (lim.en && lim.en.content) || key || '')).trim(); if (!en) continue;
                const dnt = arr.some((x) => ((x.tags || []).some((t) => String(t.tag).toUpperCase() === 'DNT')) || x.description === 'Brand name');
                let he = String(((lim.target && lim.target.content) || (lim['he-IL'] && lim['he-IL'].content) || '')).trim();
                if (dnt && !he) he = en;
                if (!he) continue;
                const posCode = e.partOfSpeech != null ? e.partOfSpeech : (lim.source && lim.source.partOfSpeech);
                const pos = POS_CODE[posCode] || '';
                const def = (e.description && e.description !== 'Brand name') ? e.description : '';
                const kk = en.toLowerCase();
                if (!map.has(kk)) map.set(kk, { en, he, pos, dnt, def });
              }
            }
            return [...map.values()];   // doc editor: whole task read from the store, no scroll
          }
        } catch (e) { /* not a doc task, or store shape changed → fall through to String editor */ }
        const pickScroller = () => {
          const sp = document.querySelector('span.highlight-text-term');
          if (sp) { let n = sp; while (n && n !== document.body) { const s = getComputedStyle(n); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 30) return n; n = n.parentElement; } }
          let best = null, bh = 0; document.querySelectorAll('*').forEach((el) => { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 30 && el.scrollHeight > bh) { bh = el.scrollHeight; best = el; } }); return best;
        };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const sc = pickScroller();
        if (!sc) { collect(); return [...map.values()]; }              // no scroller → read what's on screen
        const orig = sc.scrollTop, fire = () => sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        sc.scrollTop = 0; fire(); await sleep(220); collect();
        const step = Math.max(200, Math.floor(sc.clientHeight * 0.8));
        let pos = 0, last = -1, stuck = 0, guard = 0;
        while (guard++ < 200) {
          pos += step; if (pos > sc.scrollHeight) pos = sc.scrollHeight;
          sc.scrollTop = pos; fire(); await sleep(170); collect();
          const at = sc.scrollTop;
          if (at <= last + 1) { if (++stuck >= 2) break; } else stuck = 0;  // scroll no longer advances → bottom reached
          last = at;
        }
        collect();
        sc.scrollTop = orig; fire();                                    // restore the user's scroll position
        return [...map.values()];
      }
    });
    scraped = (r && r.result) || [];
  } catch (e) { tbInfo('Scrape failed: ' + e.message + ' — open the task’s String editor and try again.', 'err'); return; }
  if (!scraped.length) { tbInfo('No term references found here. Open a task’s String editor — terms are the dotted-underline words in the Source column.', 'err'); return; }
  let softN = 0, lockedN = 0, updatedN = 0, alreadyN = 0;
  for (const e of scraped) {
    const en = String(e.en || '').trim(); if (!en) continue;
    if (e.dnt) {                                   // DNT / brand → 🔒 Locked (keep-as-is, dedupe by en)
      if (!(LOCK.terms || []).some((x) => (x.en || '').toLowerCase() === en.toLowerCase())) { LOCK.terms.push({ id: brainUid(), en, he: (String(e.he || '').trim() || en), note: 'DNT · term base', ts: Date.now() }); lockedN++; }
      else alreadyN++;                             // DNT term already in 🔒 Locked — dedupe, but report it (not a miss)
    } else {                                        // translatable → soft term hint (overwrite same en)
      const he = String(e.he || '').trim(); if (!he) continue;
      const prev = (TB.terms || []).find((x) => (x.en || '').toLowerCase() === en.toLowerCase());
      if (prev && wbFold(prev.he) !== wbFold(he)) updatedN++;
      TB.terms = (TB.terms || []).filter((x) => (x.en || '').toLowerCase() !== en.toLowerCase());
      TB.terms.push({ id: tbUid(), en, he, pos: e.pos || '', def: e.def || '', ts: Date.now() });
      softN++;
    }
  }
  await tbSave(); if (lockedN) await lockSave();
  tbRefresh(); if (lockedN && typeof lockRefresh === 'function') lockRefresh();
  tbInfo(`Grabbed ${scraped.length} term(s): ${softN} translatable (soft hints)${lockedN ? ` · 🔒 ${lockedN} DNT locked` : ''}${alreadyN ? ` · 🔒 ${alreadyN} DNT already locked` : ''}${updatedN ? ` · ${updatedN} updated` : ''}.`, 'good');
}

// ---- AUTO-FIX: deterministic post-GPT rewriter ("smart scanner") -----------
// A curated dictionary of locked Hebrew corrections applied to every target AFTER
// the GPT run (and after memory/locked-term checks) — e.g. a plural imperative GPT
// still returned is rewritten to your singular gender-slash form: שלמו→שלם/י,
// הצטרפו→הצטרף/י, נסו→נסה/י … It is a DICTIONARY, not auto-morphology, because Hebrew
// imperatives are irregular (נסו→נסה/י, not נס/י) — you lock in both sides so each fix
// is correct by construction. Whole-word (Hebrew-boundary) match, an optional leading
// ו is preserved (והצטרפו→והצטרף/י). Every change is badged ✎ auto-fixed and reversible
// by editing the row. Stored as { rules:[{id,from,to,note,ts}], enabled, seeded, updatedAt }.
const HEB_L = 'א-ת';
const FIX_SEED = [
  { from: 'שלמו', to: 'שלם/י' }, { from: 'הצטרפו', to: 'הצטרף/י' }, { from: 'נסו', to: 'נסה/י' },
  { from: 'חכו', to: 'חכה/י' }, { from: 'היכנסו', to: 'היכנס/י' }, { from: 'בדקו', to: 'בדוק/בדקי' },
];
let FIX = { rules: [], enabled: true, seeded: false, updatedAt: 0 };
async function fixLoad() {
  try { FIX = await store.get('autoFix', { rules: [], enabled: true, seeded: false, updatedAt: 0 }); } catch (e) {}
  if (!FIX || !FIX.rules) FIX = { rules: [], enabled: true, seeded: false, updatedAt: 0 };
  if (FIX.enabled === undefined) FIX.enabled = true;
  if (!FIX.seeded) {   // first ever load → seed the user's starter corrections (stays cleared if they clear it later)
    FIX.seeded = true;
    for (const s of FIX_SEED) FIX.rules.push({ id: fixUid(), from: s.from, to: s.to, note: '', ts: Date.now() });
    try { await store.set({ autoFix: FIX }); } catch (e) {}
  }
  return FIX;
}
async function fixSave() { FIX.updatedAt = Date.now(); try { await store.set({ autoFix: FIX }); } catch (e) {} }
function fixCount() { return FIX && FIX.rules ? FIX.rules.length : 0; }
function fixUid() { return 'fx' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
function fixEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Apply every enabled rule to one string. Returns { text, changes:[{from,to}] }.
function fixApplyText(text) {
  let s = String(text == null ? '' : text); const changes = [];
  for (const r of (FIX.rules || [])) {
    const from = String(r.from == null ? '' : r.from).trim(), to = String(r.to == null ? '' : r.to);
    if (!from || !to) continue;
    let re; try { re = new RegExp('(^|[^' + HEB_L + '])(ו?)(' + fixEsc(from) + ')(?![' + HEB_L + '])', 'g'); } catch (_) { continue; }
    s = s.replace(re, (m, pre, vav, w) => { changes.push({ from, to }); return pre + vav + to; });
  }
  return { text: s, changes };
}
// Rewrite every proposal's target in place; badge what changed. Never auto-approves a
// memory-override row (that one is intentionally left for your review).
function fixApply(proposals) {
  if (!FIX || !FIX.enabled || !(FIX.rules || []).length) return;
  for (const p of proposals) {
    const res = fixApplyText(p.next);
    if (res.text !== p.next) {
      p.fixPrev = p.next; p.next = res.text;
      const seen = new Set(); p.fixApplied = res.changes.filter((c) => { const k = c.from + '⇢' + c.to; if (seen.has(k)) return false; seen.add(k); return true; }).map((c) => c.from + ' → ' + c.to);
      if (!p.manual && !p.tmOverride && !sameRender(p.next, p.old)) p.approved = true;
    }
  }
}

// ---- GPT: system prompt (identical policy to the admin Copy Deck tool) ------
// tiktok=true appends the TikTok Hebrew Style Guide (Starling / Feishu). Omit it for memoQ/Crowdin/YiCAT.
function sysPrompt(mode, plural, tiktok) {
  const base =
    'You are a professional English→Hebrew (he-IL) localization specialist for TikTok product UI and help-center content.\n' +
    'STRICT PRESERVATION (applies to every item):\n' +
    '- Keep EVERY placeholder and tag byte-for-byte and in the same order and count: {x}, {{x}}, %s, %1$s, HTML like <b>…</b> / <p> / <ul> / <li> / <br>, XLIFF inline tags like <g id="1">…</g> / <x/>, and circled markers ①②③. Never translate, rename, reorder, add, or drop any of them.\n' +
    '- Keep "TikTok" and other brand / product / feature names in Latin script — do not translate or transliterate them, and keep them EXACTLY as in the source including internal spaces and capitalization: "TikTok Lite" stays "TikTok Lite" (never "TikTok-Lite" or "TikTokLite"). When adding a Hebrew prefix to a Latin name use a maqaf between the prefix and the name (ב-TikTok Lite / וב-TikTok Lite), never inside the name.\n' +
    '- MARKDOWN EMPHASIS: keep every **bold** and *italic* marker from the source — same count, wrapping the SAME term (its Hebrew equivalent, or the Latin brand kept verbatim). If the source wraps a term in **…** the target MUST wrap the corresponding term in **…** too. Never drop the asterisks (a common failure) and never add new ones.\n' +
    '- PUNCTUATION: MIRROR the source\'s sentence-final full stop (.). If the English source ends with "." the Hebrew MUST end with "."; if the source does NOT end with "." the Hebrew must NOT end with ".". Never add or drop it independently. Keep "?", "!", "…" and all mid-sentence punctuation as the meaning requires.\n' +
    '- NUMBERS & CURRENCY (do-not-translate): keep every number, amount, date and currency symbol/code from the SOURCE — the SAME digits, the SAME currency and the SAME grouping ("67,000" stays "67,000", "MX$" stays "MX$", "₩" stays "₩"). Never translate, convert to another currency, localize or change the figure, and never keep a different (stale TM) figure from the old target. HEBREW POSITION: place the currency symbol or code AFTER the number for EVERY foreign currency — symbols ($, MX$, ₩, €, £, ₪, ฿, R$…) and letter codes (Rp, kr, zł…) alike — adjacent, no space: "Under $20" → "מתחת ל-20$" (never "$20"), "$100+" → "מעל ל-100$", "MX$67,000" → "67,000MX$", "₩4,500,000" → "4,500,000₩", "Rp150,000" → "150,000Rp". Only the symbol/code moves to follow the number (the he-IL number-formatting convention); the digits and currency identity stay exactly as in the source.\n' +
    '- HEBREW NUMBER POSITION for counted nouns (time units, people, items — any "{n} <noun>"): Hebrew places the number differently for 1 vs many. SINGULAR / CLDR-"one" form (count is exactly 1) → put the NOUN BEFORE the placeholder: "{s_num} hour" → "שעה {s_num}", "{s_num} day" → "יום {s_num}", "{s_num} min" → "דקה {s_num}", "1 person" → "אדם {s_number}" (mirrors שעה אחת / יום אחד / אדם אחד). PLURAL form → put the PLACEHOLDER FIRST with the plural noun: "{s_num} hours" → "{s_num} שעות", "{s_num} days" → "{s_num} ימים", "{s_num} people" → "{s_number} אנשים". Keep the {placeholder} byte-for-byte — only its POSITION changes. Compounds follow the same rule per noun, e.g. "{s_num} hour {s_num} min" → "שעה {s_num} ו-{s_num} דקות".\n' +
    '- STATUS-LABEL VERBS: translate English past-participle status labels as Hebrew VERB phrases, not noun phrases — "Last updated" → "עודכן לאחרונה" (NOT the noun "עדכון אחרון" / "עידכון אחרון", which also wrongly implies a final update), "Last modified" → "נערך לאחרונה", "Last edited" → "נערך לאחרונה", "Last synced" → "סונכרן לאחרונה", "Last seen" → "נצפה לאחרונה", "Last saved" → "נשמר לאחרונה". Keep any {placeholder}, its colon and position (e.g. "Last updated: {s_updateDate}" → "עודכן לאחרונה: {s_updateDate}").\n' +
    '- NO ADDITIONS: render ONLY what the source says. Never add names, facts, titles or clauses not present or implied in the source (e.g. do not insert a person\'s name like "דיוגו דאלוט" / "ראמי רביע" when the source has none). If the existing target contains such an addition, REMOVE it.\n' +
    '- NO SPACE BEFORE PUNCTUATION: no space before "." "," ":" ";" "!" "?"; no double spaces; no leading/trailing spaces.\n' +
    '- SEGMENT CONTEXT (each item MAY include extra fields "key", "context", "fullSource" — USE them to decide, and NEVER echo them into the output):\n' +
    '  • "key" = the string\'s resource key; its suffix/segments hint at the UI ROLE — resolve the register/role dilemma (gerund vs imperative) from it instead of guessing: suffixes like "_title"/"_heading"/"_desc"/"_subtitle" ⇒ a title/label/body → GERUND (שם פעולה); "_btn"/"_button"/"_cta" ⇒ a button → GERUND; "_toast"/"_tip"/"_tooltip"/"_hint"/"_placeholder" ⇒ inline instruction → IMPERATIVE slash; a list/enum namespace (e.g. "reasonForDispute", "...Reasons...") ⇒ a selectable option → short noun/nominal phrase. When "key" or "context" makes the role clear, do NOT set "flag".\n' +
    '  • "context" = a human note from the string owner explaining the meaning, intent, what a term does or does NOT mean, or which tokens are variables. Treat it as AUTHORITATIVE and follow it, but never translate the note itself. Because it is written for THIS specific string, it OUTRANKS any general house-style rule or glossary term (built-in OR ingested from a style doc) whenever they conflict for this item — the per-item note wins.\n' +
    '  • "fullSource" = the COMPLETE source string when "src" is only a split fragment of it. Use it to understand the fragment in context, but translate ONLY the "src" fragment — do NOT translate, add, or repeat the rest of "fullSource".\n' +
    '  • "terms" = client-approved term references whose English appears in THIS segment, each as {"en","he","pos"}. Render each listed term with the given Hebrew BY DEFAULT (it is the approved glossary form). BUT deviate when the grammar or sense of this segment clearly requires a different form — e.g. a term listed as a Noun that is used here as a VERB (use the natural verb form: "Highlight"→נקודת שיא as a noun, but הדגש/י when it means "to highlight"), or a word used in a different sense ("Due"→לתשלום, but עקב in "due to …"). These are STRONG DEFAULTS, not locked terms: the per-item "context" note and correct Hebrew grammar still win. Never echo this field.\n' +
    (plural
      ? '- FORM OF ADDRESS: Hebrew MUST be in לשון רבים — plural, gender-neutral forms (e.g. הצטרפו, שלמו, לחצו, קראו ואשרו) — never masculine singular and never slash forms like שלם/י.\n'
      : '- FORM OF ADDRESS: use the SINGULAR, gender-neutral second person with a slash for both genders (לחץ/י, את/ה, בחר/י). Put the final letter (אות סופית) BEFORE the slash. If the masculine and feminine suffixes differ, write BOTH words in full to avoid a malformed feminine (התחל/התחילי, not התחל/י). Use the imperative when the source is imperative. NEVER use the plural form of address (לשון רבים) and NEVER use masculine-singular alone — even when the source number/gender is ambiguous, DEFAULT to this singular gender-slash form. Convert any plural imperative to it: הצטרפו→הצטרף/י, נסו→נסה/י, חכו→חכה/י, היכנסו→היכנס/י, שלמו→שלם/י, לחצו→לחץ/י, קראו→קרא/י; and when the stem differs write both words IN FULL: בדקו→בדוק/בדקי, אמרו→אמור/אמרי, שמרו→שמור/שמרי.\n') +
    (tiktok ? brainText() : '') +
    '- Return ONLY the JSON object requested. No commentary, no markdown, no code fences.';
  if (mode === 'translate') return base + '\nTASK: Translate each item\'s English "src" into natural, idiomatic Hebrew.';
  return base + '\nTASK: Proofread and correct each item\'s Hebrew "tgt" (use "src" as the reference meaning): fix grammar, spelling, terminology, and punctuation' +
    (plural ? ', and convert imperatives / second person to plural gender-neutral' : ', and convert imperatives / second person to the singular gender-neutral slash form (לחץ/י)') +
    '. Preserve the original meaning. If an item is already correct, return it unchanged.';
}

async function gptBatch(items, mode, key, model, plural, extraSys, tiktok) {
  const user = (mode === 'translate' ? 'Translate the "src" of each item. ' : 'Proofread the "tgt" of each item. ') +
    'Return JSON exactly as {"out":[{"i":<number>,"text":"<hebrew>","flag":"<optional: a SHORT note ONLY when the register/UI-role is genuinely ambiguous (see REGISTER DEPENDS ON THE UI ROLE); omit or leave empty otherwise>"}]}, one entry per input item, same "i" numbers.\n' +
    JSON.stringify({ items });
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, temperature: mode === 'translate' ? 0.2 : 0.1,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sysPrompt(mode, plural, tiktok) + (extraSys ? '\n' + extraSys : '') }, { role: 'user', content: user }]
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error && data.error.message || ('GPT error ' + r.status));
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  return parsed.out || parsed.segments || [];
}

// ---- actions ---------------------------------------------------------------
// Parse the "Only segments" box → a matcher fn over a SEGMENT OBJECT, or null for ALL.
//  • Numbers/ranges: "8", "10-20", "5,8,12", "3-6,10", "5 8 12".
//  • Term(s): any non-numeric token is a case-insensitive text match against the segment's
//    source / target / key (e.g. "Family Pairing" — harvest only segments mentioning it).
// Split on COMMAS first so multi-word terms stay intact; quotes optional. Mix freely:
// "1-4, Family Pairing, 6". Empty / "all" → null (everything).
function parseSegSel(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s || /^all$/i.test(s)) return null;
  const nums = new Set(), ranges = [], terms = [];
  s.split(/[,;]+/).map((t) => t.trim()).filter(Boolean).forEach((tok) => {
    const clean = tok.replace(/^["']+|["']+$/g, '').trim(); if (!clean) return;
    let m;
    if ((m = clean.match(/^(\d+)\s*[-–]\s*(\d+)$/))) { ranges.push([Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])]); return; }
    if (/^\d+$/.test(clean)) { nums.add(+clean); return; }
    const parts = clean.split(/\s+/);                                   // back-compat: "5 8 12" (space-sep numbers)
    if (parts.length > 1 && parts.every((p) => /^\d+$/.test(p))) { parts.forEach((p) => nums.add(+p)); return; }
    terms.push(clean.toLowerCase());                                    // otherwise it's a text term
  });
  if (!nums.size && !ranges.length && !terms.length) return null;
  return (seg) => {
    if (!seg || typeof seg !== 'object') return false;                 // matcher now takes the whole segment
    const n = parseInt(seg.seg != null ? seg.seg : seg.rank, 10);
    if (!isNaN(n) && (nums.has(n) || ranges.some(([a, b]) => n >= a && n <= b))) return true;
    if (!terms.length) return false;
    const bits = [seg.src, seg.source, seg.tgt, seg.target, seg.key, seg.fullSrc, seg.fullSource, seg.context];
    for (const f of [seg.srcForms, seg.tgtForms]) if (f && typeof f === 'object') bits.push.apply(bits, Object.values(f));
    const hay = bits.filter(Boolean).join('  ').toLowerCase();
    return terms.some((t) => hay.includes(t));
  };
}

// Coverage preview under the Run button — how many of your STORED terms actually
// match the harvested sources, so you see what will guide the run BEFORE spending
// the GPT call. Mirrors exactly what gets fed on Run:
//   🔒 locked   → mandatory, in the system prompt (lockText)
//   🏷 term hint → soft per-segment "terms" field (tbHintsFor; gated by the toggle)
//   📖 glossary  → advisory, in the system prompt (brainText)
// "covering N/total" counts segments carrying ≥1 locked or term-base match.
function runCoverage() {
  const el = $('run-coverage'); if (!el) return;
  const segs = (state && state.segments) || [];
  if (!segs.length) { el.textContent = ''; el.className = 'cov'; return; }
  const srcs = segs.map((s) => String(s.src || ''));
  const covered = new Set();
  const scan = (en) => { let hit = false; srcs.forEach((src, i) => { if (lockSrcHas(src, en)) { hit = true; covered.add(i); } }); return hit; };
  const seen = (en) => srcs.some((src) => lockSrcHas(src, en));   // glossary is global — count matches, don't mark coverage
  const tbOn = !!(TB && TB.enabled);
  let lockN = 0, tbN = 0, glossN = 0;
  for (const t of (LOCK && LOCK.terms) || []) if (t && t.en && scan(t.en)) lockN++;
  if (tbOn) for (const t of (TB && TB.terms) || []) if (t && t.en && t.he && scan(t.en)) tbN++;
  for (const g of (BRAIN && BRAIN.glossary) || []) if (g && g.en && seen(g.en)) glossN++;
  if (!lockN && !tbN && !glossN) {
    el.className = 'cov cov-none';
    el.textContent = `⚖ No stored terms match these ${segs.length} segment(s) — ⬇ grab a term base, or add 🔒 locked terms, to guide the run.`;
    return;
  }
  const parts = [];
  if (lockN) parts.push(`🔒 ${lockN} locked`);
  parts.push(tbOn ? `🏷 ${tbN} term hint${tbN === 1 ? '' : 's'}` : '🏷 term base off');
  if (glossN) parts.push(`📖 ${glossN} glossary`);
  el.className = 'cov';
  el.textContent = `⚖ Will guide this run: ${parts.join(' · ')} — covering ${covered.size}/${segs.length} segment(s).`;
}

async function doHarvest() {
  info('harvest-info', 'Harvesting… (scrolling the segment list)');
  $('harvest').disabled = true;
  try {
    const r = await send({ type: 'HARVEST' });
    if (!r || !r.ok) throw new Error(r && r.error || 'harvest failed');
    const all = r.segments || [];
    const sel = parseSegSel($('seg-filter').value);
    state.segments = sel ? all.filter((s) => sel(s)) : all;
    const filtered = sel && state.segments.length !== all.length;
    if (sel && !state.segments.length && all.length) {
      info('harvest-info', `No segments matched "${$('seg-filter').value.trim()}" (task has ${all.length}). Clear the box for all.`, 'err');
      $('gpt-card').hidden = true; return;
    }
    const tagged = state.segments.filter((s) => s.tagged).length;
    const chips = state.segments.filter((s) => s.chip).length;
    const recovered = all.filter((s) => s.apiOnly).length;   // rows the scroll dropped, refilled from the API
    info('harvest-info', `Harvested ${state.segments.length}${filtered ? ` of ${all.length}` : ''} segments${filtered ? ' (filtered)' : ''}${tagged ? ` · ⚠ ${tagged} tagged${chips ? ` (${chips} chip → copy-by-hand)` : ''}` : ''}${recovered ? ` · ↺ ${recovered} recovered via API (the scroll missed ${recovered === 1 ? 'it' : 'them'})` : ''}.`, 'good');
    log(`harvest: ${state.segments.length}/${all.length} segments${sel ? ' (filtered)' : ''}, ${tagged} tagged, ${chips} chips${recovered ? `, ${recovered} api-recovered` : ''}`);
    $('gpt-card').hidden = state.segments.length === 0;
    runCoverage();   // preview which stored terms will guide the run
    if (!all.length) info('harvest-info', 'No segments found — run Diagnostics in Settings to recalibrate selectors.', 'err');
  } catch (e) {
    info('harvest-info', e.message, 'err');
  } finally {
    $('harvest').disabled = false;
  }
}

async function doGpt() {
  const key = await store.get('key', '');
  if (!key) { info('gpt-info', 'Add your OpenAI key in Settings first.', 'err'); $('settings').open = true; return; }
  const model = $('model').value;
  const plural = $('plural').checked;
  const mode = document.querySelector('input[name=mode]:checked').value;
  const inclTagged = $('incl-tagged').checked;
  const fillEmpty = $('fill-empty') ? $('fill-empty').checked : true;
  state.mode = mode;

  // Group each candidate by its EFFECTIVE mode. In proofread mode an empty
  // target (but non-empty source) is translated from scratch and written in
  // alongside the proofread ones — so blank cells don't get left behind.
  const tagOk = (s) => inclTagged ? true : !s.tagged;
  const groups = { proofread: [], translate: [] };
  for (const s of state.segments) {
    if (!tagOk(s)) continue;
    const hasT = String(s.tgt || '').trim();
    const hasS = String(s.src || '').trim();
    if (mode === 'translate') { if (hasS) groups.translate.push(s); }
    else if (hasT) groups.proofread.push(s);
    else if (hasS && fillEmpty) groups.translate.push(s);   // blank target → translate
  }
  const total = groups.proofread.length + groups.translate.length;
  if (!total) { info('gpt-info', 'Nothing to process (all segments empty, or tagged excluded).', 'err'); return; }

  $('run-gpt').disabled = true;
  const proposals = [];
  let done = 0, failed = 0, filled = 0;
  const B = 10;
  try {
    for (const gm of ['proofread', 'translate']) {
      const list = groups[gm];
      for (let i = 0; i < list.length; i += B) {
        const slice = list.slice(i, i + B);
        info('gpt-info', `✨ ${gm === 'translate' ? 'Translating' : 'Proofreading'} ${done + failed + 1}–${Math.min(done + failed + slice.length, total)} of ${total}…`);
        const items = slice.map((s, j) => {
          const it = { i: j + 1, src: String(s.src || ''), tgt: String(s.tgt || '') };
          if (s.key) it.key = String(s.key);                 // role hint (…_title/_btn/_toast/…)
          if (s.context) it.context = String(s.context);     // translator note from Starling
          if (s.fullSrc) it.fullSource = String(s.fullSrc);  // complete string when src is a split fragment
          const th = tbHintsFor(String(s.src || ''));         // Starling term-base hints for this source (soft; gated by TB.enabled)
          if (th.length) it.terms = th;
          return it;
        });
        try {
          const out = await gptBatch(items, gm, key, model, plural, null, true);   // true = apply TikTok style guide
          out.forEach((o) => {
            const idx = (o.i | 0) - 1;
            if (idx >= 0 && idx < slice.length && o.text != null) {
              const s = slice[idx];
              const next = polish(s.src, o.text);   // fix spacing + mirror the source's full stop
              const wasEmpty = !String(s.tgt || '').trim();
              // Copy-by-hand ("manual") = a REAL chip object OR Starling's numbered
              // wrapping tags (O-/C- tokens / ①②③) — typing either back destroys the
              // tags. String placeholders ({0}, %s, <g id>…) are plain text GPT keeps
              // byte-for-byte, so those auto-write (⚠ placeholder badge to eyeball them).
              const tagWrapped = hasTags(next) || hasTags(s.src) || hasTags(s.tgt);
              const manual = !!s.chip || tagWrapped;
              const flag = (o.flag && String(o.flag).trim()) ? String(o.flag).trim() : '';
              proposals.push({ seg: s.seg, src: s.src, old: s.tgt, next: next, tagged: !!s.tagged || tagWrapped, chip: !!s.chip, tagWrapped: tagWrapped, manual: manual, filled: gm === 'translate' && wasEmpty, flag: flag, key: s.key || '', context: s.context || '', fullSrc: s.fullSrc || '', shots: s.shots || [], approved: !manual && next !== String(s.tgt) });
              done++;
              if (gm === 'translate' && wasEmpty) filled++;
            }
          });
        } catch (e) { failed += slice.length; log(`gpt ${gm} batch @${i} failed: ${e.message}`); }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    tmApply(proposals);   // enforce your remembered wording on exact-source recurrences
    fixApply(proposals);  // deterministic post-GPT rewrites (plural imperative → your singular slash form, etc.)
    lockCheck(proposals); // flag rows where a MANDATORY locked term is missing from the target (sees the fixed text)
    consistCheck(proposals); // flag in-task term drift (Case 2) — never rewrites; you review + one-click lock
    tbCheck(proposals);   // 🏷 flag rows where a Starling term-base term's approved HE is missing (soft — context may explain it)
    state.proposals = proposals;
    const changed = proposals.filter((p) => !sameRender(p.next, p.old)).length;
    const tmN = proposals.filter((p) => p.tm).length;         // remembered wording (cross-task memory)
    const dedupeN = proposals.filter((p) => p.dedupe).length; // aligned to one wording within this task
    const consistN = proposals.filter((p) => p.consist && p.consist.length).length; // ⚖ term-drift flags
    const termN = proposals.filter((p) => p.termHint && p.termHint.length).length;   // 🏷 term-base deviations
    const pf = done - filled;
    info('gpt-info', `✅ ${done} done${filled ? ` (${pf} proofread · ${filled} translated)` : ''} · ${changed} changed${tmN ? ` · 🧠 ${tmN} from memory` : ''}${dedupeN ? ` · 🧠 ${dedupeN} aligned` : ''}${consistN ? ` · ⚖ ${consistN} consistency` : ''}${termN ? ` · 🏷 ${termN} term-base` : ''}${failed ? ` · ${failed} failed` : ''}`, failed ? 'err' : 'good');
    renderReview();
    $('review-card').hidden = false;
    $('write-card').hidden = false;
  } finally {
    $('run-gpt').disabled = false;
  }
}

let revFilter = 'changed';   // 'changed' | 'all' | 'manual' (✋ paste-by-hand) | 'memrev' (🧠 memory — review) | 'consist' (⚖ consistency)
function renderReview() {
  const box = $('review');
  const list = state.proposals.filter((p) =>
    revFilter === 'manual' ? p.manual :
    revFilter === 'memrev' ? !!p.tmOverride :   // 🧠 memory differs from GPT — left unchecked for you to confirm
    revFilter === 'consist' ? !!(p.consist && p.consist.length) :   // ⚖ in-task term drift — flag only
    revFilter === 'icdrift' ? !!p.icDrift :                         // ⚖ GPT internal-consistency drift — flag only
    revFilter === 'termrev' ? !!(p.termHint && p.termHint.length) : // 🏷 term-base deviation — flag only
    revFilter === 'all' ? true :
    !sameRender(p.next, p.old));   // 'changed'
  box.innerHTML = list.map((p) => {
    const idx = state.proposals.indexOf(p);
    const changed = !sameRender(p.next, p.old);
    const cleanFull = stripTags(p.next);                        // whole target, inner text only (no tokens)
    // Prefer tag-run splitting whenever O-/C- tokens are present: those tokens are the REAL chip
    // boundaries, so a run between them is exactly what you paste between the ①…① tags. Only fall
    // back to the bullet splitter for a pure bullet list with no tags — otherwise a bullet that
    // sits INSIDE a tag pair (e.g. a bolded "• Heading:") would split there and orphan the tag token.
    const runParts = splitTagRuns(p.next);                      // text runs between O-/C- tags
    const bulletParts = runParts ? null : splitParts(p.next);   // else a pure bullet list (no tags)
    // Per-part copy block: text runs between tags first, else bullet items.
    // Copy a part → in Starling paste it BETWEEN its matching ①…① (tags untouched).
    let copyBlock = '';
    if (runParts) {
      const sruns = splitTagRuns(p.src);                        // source runs align 1:1 by tag structure
      copyBlock = `<div class="rc-parts" title="Each run of text between two tags — copy it and paste it BETWEEN the matching ①…① tags in Starling; the tags stay untouched.">` +
        runParts.map((r, i) => {
          const id = r.id || String(i + 1);
          const sclean = (sruns && sruns.length === runParts.length) ? sruns[i].text : '';
          const sref = sclean ? `<div class="rc-psrc" dir="ltr">${hl(esc(sclean))}</div>` : '';
          return `<div class="rc-part"><span class="rc-pidx" title="tag ${esc(id)}">${esc(id)}</span><div class="rc-pbody">${sref}<div class="rc-ptxt" dir="rtl">${hl(esc(r.text))}</div></div><button class="rc-copy" type="button" data-copy="${esc(r.text)}">Copy</button></div>`;
        }).join('') + `</div>`;
    } else if (bulletParts) {
      const sparts = splitParts(p.src);
      copyBlock = `<div class="rc-parts" title="Paste each part between its matching ①…① tags in Starling — the tags stay untouched.">` +
        bulletParts.map((pt, i) => {
          const clean = stripTags(pt);                          // inner text only — no O-/C- tokens
          const id = tagId(pt) || String(i + 1);                // badge = the tag's own id when present
          const sclean = (sparts && sparts.length === bulletParts.length) ? stripTags(sparts[i]) : '';
          const sref = sclean ? `<div class="rc-psrc" dir="ltr">${hl(esc(sclean))}</div>` : '';
          return `<div class="rc-part"><span class="rc-pidx" title="tag ${esc(id)}">${esc(id)}</span><div class="rc-pbody">${sref}<div class="rc-ptxt" dir="rtl">${hl(esc(clean))}</div></div><button class="rc-copy" type="button" data-copy="${esc(clean)}">Copy</button></div>`;
        }).join('') + `</div>`;
    }
    // Every card gets a whole-segment Copy + a ✍ Write button. Manual (tagged) rows
    // also show the paste-by-hand hint; their Write confirms first (it would replace
    // the tag chips — the per-part Copy buttons are the safe path for those).
    const buttons =
      `<button class="rc-copy" type="button" data-copy="${esc(cleanFull)}" title="Copy the whole target (inner text only, no tag tokens)">Copy</button>` +
      `<button class="rc-write" type="button" data-i="${idx}" title="${p.manual ? 'Types the text in — WARNING: replaces the tag chips. For tagged segments use the per-part Copy buttons instead.' : 'Write just this one segment into Starling now'}">✍ Write</button>`;
    const control = (p.manual
      ? `<span class="rc-manual" title="Has tags/chips — paste it by hand between them; auto-write would break the tags.">✋ paste by hand</span>`
      : `<label><input type="checkbox" class="rc-cb" ${p.approved ? 'checked' : ''}/> apply</label>`) + buttons;
    // Every target is editable. Tagged/chip ("manual") rows carry the raw tokens so you can edit the
    // text too, and get a blur-refresh so their per-part Copy blocks re-split from your edit.
    const newRow = `<div class="rc-new${p.manual ? ' has-tags' : ''}" dir="rtl" contenteditable="true" spellcheck="false">${esc(p.next)}</div>`;
    return `<div class="rc${p.tagged ? ' tagged' : ''}${p.manual ? ' manual' : ''}${changed ? '' : ' unchanged'}" data-i="${idx}">
      <div class="rc-top">
        <span class="rc-seg">#${esc(p.seg)}</span>
        <span class="rc-edited"${p.edited ? '' : ' hidden'} title="You edited this suggestion — your text is what gets written / copied.">✎ edited</span>
        ${p.tmOverride ? `<span class="rc-warn" style="background:#7a5c0a" title="Memory has a DIFFERENT wording than GPT for this exact source. Set to your remembered version but left UNCHECKED — confirm it, or edit the text if the memory is wrong (writing your fix updates the memory). GPT proposed: ${esc(p.tmPrev || '')}">🧠 memory — review</span>`
          : p.tm ? '<span class="rc-warn" style="background:#0c4a6e" title="Matches a source you translated before — already consistent with your previous wording.">🧠 memory</span>' : ''}
        ${p.dedupe && !p.tm ? '<span class="rc-warn" style="background:#0c4a6e" title="This exact source appears more than once in this task — aligned to one wording for consistency.">🧠 same-as-above</span>' : ''}
        ${p.filled ? '<span class="rc-warn" title="Target was empty — translated from the source and will be written in with the rest." style="background:#0a7a3f">＋ new</span>' : ''}
        ${p.chip ? '<span class="rc-warn" title="Real inline-tag object (chip) in the cell — copy-by-hand.">⚠ chip</span>' : (p.tagWrapped ? '<span class="rc-warn" title="Numbered wrapping tags (①②③ / O-/C- tokens) — copy-by-hand; writing would type the literal tokens and break the tags. Use the per-part Copy buttons.">⚠ tag</span>' : (p.tagged ? '<span class="rc-warn" title="Text placeholder ({0}, %s, &lt;g id&gt;…) — kept byte-for-byte; safe to write. Eyeball that the token survived.">⚠ placeholder</span>' : ''))}
        ${amountMismatch(p.src, p.next) ? '<span class="rc-warn" title="Number/currency differs from the source — the amount &amp; currency symbol must stay verbatim (may be a stale TM value).">⚠ number</span>' : ''}
        ${hasSpacingIssue(p.old) || edgeMismatch(p.src, p.old) ? '<span class="rc-warn" title="Spacing adjusted — space before punctuation, double spaces, or leading/trailing space to match the source.">⚠ spacing</span>' : ''}
        ${brandIssue(p.src, p.next) ? `<span class="rc-warn" title="A product name from the source (${esc(brandIssue(p.src, p.next))}) isn't kept verbatim — check the brand spelling/spacing.">⚠ brand</span>` : ''}
        ${boldIssue(p.src, p.next) ? `<span class="rc-warn" title="Markdown **bold** from the source (**${esc(boldIssue(p.src, p.next))}**) isn't wrapped in the target — the asterisks were dropped. Add ** around the matching term.">⚠ bold</span>` : ''}
        ${p.flag ? `<span class="rc-warn" title="${esc(p.flag)}" style="background:#7a5c0a">⚠ register</span>` : ''}
        ${p.lockMiss ? `<span class="rc-warn" style="background:#b91c1c" title="MANDATORY locked term missing from the target — must be rendered exactly (a prefix is OK): ${esc(p.lockMiss.join(' · '))}. Fix the Hebrew, then this clears.">🔒 locked term</span>` : ''}
        ${p.fixApplied ? `<span class="rc-warn" style="background:#0e7490" title="Auto-corrected by your locked 🩹 Auto-fix rules: ${esc(p.fixApplied.join(' · '))}. Edit the text to revert.">✎ auto-fixed</span>` : ''}
        ${p.fuzzy && p.fuzzy.matches.length ? `<span class="rc-warn" style="background:#3b0764" title="No exact memory match, but ${p.fuzzy.matches.length} near-match(es) from your past work are shown below — click “use” to adopt one. Nothing is applied automatically.">🧠 ${p.fuzzy.matches.length} near-match${p.fuzzy.matches.length === 1 ? '' : 'es'}</span>` : ''}
        ${p.consist && p.consist.length ? p.consist.map((c) => `<span class="rc-warn" style="background:#7c2d12" title="Consistency check: “${esc(c.en)}” was translated as “${esc(c.he)}” on its own (segment ${esc(String(c.from))}), but this segment's target doesn't appear to use that wording. Flag only — nothing was changed. Fix the Hebrew by hand if it should match, or click 🔒 lock to make “${esc(c.en)}” → “${esc(c.he)}” mandatory everywhere.">⚖ consistency: ${esc(c.en)}</span><button class="rc-lockterm" type="button" data-en="${esc(c.en)}" data-he="${esc(c.he)}" title="Lock “${esc(c.en)}” → “${esc(c.he)}” as a mandatory term (adds it to 🔒 Locked terms)">🔒 lock</button>`).join('') : ''}
        ${p.termHint && p.termHint.length ? p.termHint.map((c) => `<span class="rc-warn" style="background:#155e75" title="Starling term base: “${esc(c.en)}” is approved as “${esc(c.he)}”, but this target doesn't appear to use that wording. This is a SOFT hint — a different form can be correct here (e.g. the term used as a verb, or a different sense). Nothing was changed; fix by hand only if it should match.">🏷 term: ${esc(c.en)}</span>`).join('') : ''}
        ${p.icDrift ? `<span class="rc-warn" style="background:#7c2d12" title="Internal-consistency drift: ${esc(p.icDrift.reason)}. Pick which Hebrew rendering to standardize on (buttons below) — it updates EVERY segment in this task that uses this term. Flag only; nothing changes until you choose.">⚖ drift${p.icDrift.concept ? ': ' + esc(p.icDrift.concept) : ''}</span>` : ''}
        <div class="rc-ctl">${control}</div>
      </div>
      ${p.src ? `<div class="rc-src" dir="ltr">${hl(esc(p.src))}</div>` : ''}
      ${p.fullSrc && p.fullSrc !== p.src ? `<div class="rc-full" dir="ltr" title="Full source string this segment is a split fragment of — GPT sees it for context but translates only the fragment above.">↔ ${esc(p.fullSrc)}</div>` : ''}
      ${p.context ? `<div class="rc-ctx" title="Translator note from Starling (Translation Information → Context) — GPT was given this as authoritative guidance.">ℹ️ ${esc(p.context)}</div>` : ''}
      ${p.key || (p.shots && p.shots.length) ? `<div class="rc-meta">${p.key ? `<span class="rc-key" title="String key — its suffix (…_title / _btn / _toast / …) hints at the UI role.">🔑 ${esc(p.key)}</span>` : ''}${(p.shots || []).map((sh, i) => `<a class="rc-shot" href="${esc(sh.uri)}" target="_blank" rel="noopener" title="Open this segment's UI screenshot in a new tab">📷 screenshot${p.shots.length > 1 ? ' ' + (i + 1) : ''}</a>`).join('')}</div>` : ''}
      ${p.fuzzy && p.fuzzy.matches.length ? `<div class="rc-fuzzy" title="Near-matches from your Consistency memory — review-only. “use” drops the wording into the target for you to adjust.">` +
        p.fuzzy.matches.map((m, j) => `<div class="fz-m"><div class="fz-meta"><span class="fz-score">${m.tier === 'template' ? 'template' : Math.round(m.score * 100) + '%'}</span> <span class="fz-src" dir="ltr">${hl(esc(m.src))}</span></div><div class="fz-body"><div class="fz-tgt" dir="rtl">${esc(m.suggest)}</div><button class="fz-use" type="button" data-i="${idx}" data-j="${j}" title="Use this wording (fills the target — edit as needed)">use</button></div></div>`).join('') +
        `</div>` : ''}
      ${p.icDrift ? `<div class="rc-fuzzy" title="Pick the Hebrew rendering to standardize on — it updates every segment in this task that uses “${esc(p.icDrift.concept)}”. Nothing auto-applied."><div class="fz-m"><div class="fz-meta"><span class="fz-score">⚖ unify</span> <span class="fz-src" dir="ltr">${esc(p.icDrift.reason)}</span></div><div class="ic-opts">` +
        p.icDrift.options.map((o) => `<button class="ic-use" type="button" data-i="${idx}" data-he="${esc(o.he)}" dir="rtl" title="Use “${esc(o.he)}” everywhere “${esc(p.icDrift.concept)}” appears in this task (rewrites each segment grammatically).">use ${esc(o.he)}</button>`).join('') +
        `<button class="ic-keep" type="button" data-i="${idx}" title="Keep every segment's current wording for “${esc(p.icDrift.concept)}” as harvested, and dismiss this drift flag — nothing is rewritten.">keep current</button>` +
        `</div></div></div>` : ''}
      ${changed && String(p.old).trim() ? `<div class="rc-old" dir="rtl">${hl(esc(p.old))}</div>` : ''}
      ${newRow}
      ${copyBlock}
    </div>`;
  }).join('') || `<div class="info">${revFilter === 'manual' ? 'No ✋ paste-by-hand (tagged/chip) segments in this task.' : revFilter === 'memrev' ? 'No 🧠 memory — review rows — your remembered wording matched GPT (or no memory hit) on every segment.' : revFilter === 'consist' ? 'No ⚖ consistency flags — every term you translated on its own is rendered the same way where it recurs. (Only multi-word / ≥5-letter terms that also appear as a standalone segment are checked.)' : revFilter === 'icdrift' ? 'No ⚖ drift flags. Click “⚖ Sweep drift” to run the GPT internal-consistency check, or recurring wording is already consistent across the task.' : revFilter === 'termrev' ? 'No 🏷 term-base flags — every Starling term whose English appears was rendered with its approved Hebrew (or the term base is empty / the toggle is off).' : 'No changes proposed.'}</div>`;

  box.querySelectorAll('.rc-cb').forEach((cb) => cb.addEventListener('change', (e) => {
    const i = +e.target.closest('.rc').dataset.i; state.proposals[i].approved = e.target.checked; updateRevCount();
  }));
  box.querySelectorAll('.rc-new[contenteditable]').forEach((ed) => {
    ed.addEventListener('input', (e) => {
      const card = e.target.closest('.rc'), i = +card.dataset.i, p = state.proposals[i];
      p.next = e.target.innerText;
      p.edited = true;
      const badge = card.querySelector('.rc-edited'); if (badge) badge.hidden = false;
      if (!p.manual && !p.approved) {                 // editing a suggestion = intent to apply it
        p.approved = true;
        const cb = card.querySelector('.rc-cb'); if (cb) cb.checked = true;
        updateRevCount();
      }
    });
    // On blur, mirror the source's edge whitespace + trailing "\n" onto the edited text, so an
    // accidental trailing space (Starling's blue "|") or newline left over from editing isn't written.
    ed.addEventListener('blur', (e) => {
      const card = e.target.closest('.rc'); if (!card) return;
      const p = state.proposals[+card.dataset.i]; if (!p) return;
      const norm = matchTrailingNL(p.src, mirrorEdges(p.src, p.next));
      if (norm !== p.next) p.next = norm;
      // Re-run the locked-term check on the edited text so the 🔒 flag clears (or re-appears) live.
      const wasMiss = p.lockMiss ? p.lockMiss.join('|') : '';
      const v = lockViolations(p.src, p.next); p.lockMiss = v.length ? v.map((t) => t.en + ' → ' + t.he) : null;
      const nowMiss = p.lockMiss ? p.lockMiss.join('|') : '';
      if (ed.classList.contains('has-tags') || wasMiss !== nowMiss) renderReview();   // re-split parts and/or refresh the badge
      else if (ed.innerText !== norm) ed.textContent = norm;          // reflect the cleaned text
    });
  });
  box.querySelectorAll('.rc-copy').forEach((b) => b.addEventListener('click', () => panelCopy(b.getAttribute('data-copy'), b)));
  box.querySelectorAll('.rc-write').forEach((b) => b.addEventListener('click', () => doWriteOne(+b.dataset.i, b)));
  box.querySelectorAll('.rc-lockterm').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const r = await consistLock(b.dataset.en, b.dataset.he);
    info('gpt-info', r.msg, r.ok ? 'good' : 'err');
    if (r.ok) { b.textContent = '🔒 locked'; b.title = 'Locked as a mandatory term.'; }
    else b.disabled = false;
  }));
  box.querySelectorAll('.fz-use').forEach((b) => b.addEventListener('click', () => {
    const p = state.proposals[+b.dataset.i], m = p && p.fuzzy && p.fuzzy.matches[+b.dataset.j]; if (!m) return;
    p.next = m.suggest; p.edited = true; p.fuzzy = null;   // adopted → clear the near-match panel; your text now leads
    if (!p.manual) p.approved = !sameRender(p.next, p.old);
    renderReview();
  }));
  box.querySelectorAll('.ic-use').forEach((b) => b.addEventListener('click', () => {
    const p = state.proposals[+b.dataset.i]; if (!p || !p.icDrift) return;
    const he = b.getAttribute('data-he'), group = p.icDrift.group;
    let cnt = 0;                                                     // standardize EVERY segment in this drift group on the chosen rendering
    for (const q of state.proposals) {
      if (!q.icDrift || q.icDrift.group !== group) continue;
      const opt = q.icDrift.options.find((o) => o.he === he); if (!opt) continue;
      q.next = opt.suggest; q.edited = true; q.icDrift = null;
      if (!q.manual) q.approved = !sameRender(q.next, q.old);
      cnt++;
    }
    if (cnt) info('gpt-info', `⚖ Standardized ${cnt} segment(s) on “${he}”.`, 'good');
    renderReview();
  }));
  box.querySelectorAll('.ic-keep').forEach((b) => b.addEventListener('click', () => {
    const p = state.proposals[+b.dataset.i]; if (!p || !p.icDrift) return;
    const group = p.icDrift.group; let cnt = 0;                     // keep every segment's CURRENT wording; just dismiss the group's drift flags
    for (const q of state.proposals) { if (q.icDrift && q.icDrift.group === group) { q.icDrift = null; cnt++; } }
    if (cnt) info('gpt-info', `⚖ Kept current wording for ${cnt} segment(s) — drift dismissed.`, '');
    renderReview();
  }));
  updateRevCount();
}

// Write a single segment into Starling (the per-row "✍ Write" button). Uses the
// row's current text (respects any inline edit). No confirm — it's one explicit click.
async function doWriteOne(idx, btn) {
  const p = state.proposals[idx];
  if (!p) return;
  if (p.manual && !confirm(`Segment #${p.seg} has tags/chips. Writing types the text in and will REPLACE the tag chips — they won't survive, so Starling may flag a missing-tag error.\n\nThe safe way is the per-part Copy buttons (paste each run between its ①…① tags). Write anyway?`)) return;
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await send({ type: 'WRITE', edits: [{ seg: p.seg, text: p.next }] });
    const res = (r && r.results && r.results[0]) || null;
    if (res && res.ok) { btn.textContent = '✓ written'; p.written = true; if (tmRecordOne(p.src, p.next)) await tmSave(); }
    else { btn.textContent = '✕ failed'; log(`write #${p.seg} failed: ${(res && res.reason) || (r && r.error) || 'unknown'}`); }
  } catch (e) {
    btn.textContent = '✕ failed'; log(`write #${p.seg} failed: ${e.message}`);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 1600);
  }
}
function updateRevCount() {
  const auto = state.proposals.filter((p) => p.approved && !p.manual).length;
  const manual = state.proposals.filter((p) => p.manual).length;
  $('rev-count').textContent = `${auto} to write` + (manual ? ` · ✋ ${manual} copy-by-hand` : '');
}

async function doWrite() {
  // Manual (tagged) segments are copy-by-hand only — never auto-written.
  const edits = state.proposals.filter((p) => p.approved && !p.manual).map((p) => ({ seg: p.seg, text: p.next }));
  if (!edits.length) { info('write-info', 'Nothing to auto-write (tagged segments are copy-by-hand — use their Copy buttons).', 'err'); return; }
  if (!confirm(`Write ${edits.length} segment(s) into Starling? This types into each cell — make sure no one else is editing the same task.`)) return;
  $('write').disabled = true;
  info('write-info', `Writing ${edits.length} segment(s)…`);
  $('write-bar').style.width = '0%';
  try {
    // stream progress by writing in small chunks so the bar moves
    const results = [];
    const CH = 5;
    for (let i = 0; i < edits.length; i += CH) {
      const chunk = edits.slice(i, i + CH);
      const r = await send({ type: 'WRITE', edits: chunk });
      (r && r.results || []).forEach((x) => results.push(x));
      $('write-bar').style.width = Math.round(Math.min(i + CH, edits.length) / edits.length * 100) + '%';
      info('write-info', `Wrote ${Math.min(i + CH, edits.length)}/${edits.length}…`);
    }
    // Doc-editor rescue: Starling's read-back API (getSourceTextListWithTargetText) returns 1002
    // for Document-editor tasks, so those writes come back "unverified" even when they landed.
    // Verify them the way the doc grab/harvest do — read the open editor's redux store and
    // fold-match each unverified segment's target text against what we wrote. A match = it saved.
    try {
      const stillUnv = results.filter((r) => r.via === 'unverified');
      if (stillUnv.length) {
        await new Promise((r) => setTimeout(r, 450));   // let the editor commit the typed text into its redux store
        const doc = await hvDocRows(null);   // null id → verify against whatever doc task is open
        if (doc && doc.ok && Array.isArray(doc.rows)) {
          const bySrc = new Map();           // folded source → [folded targets] (a source can repeat)
          for (const row of doc.rows) {
            const k = wbFold(row.source || ''); if (!k) continue;
            if (!bySrc.has(k)) bySrc.set(k, []);
            bySrc.get(k).push(wbFold(row.target || ''));
          }
          for (const r of stillUnv) {
            const p = (state.proposals || []).find((x) => x.seg === r.seg); if (!p) continue;
            const want = wbFold(p.next || ''); if (!want) continue;
            const cands = bySrc.get(wbFold(p.src || '')) || [];
            if (cands.some((t) => t === want)) { r.via = 'store'; r.ok = true; r.reason = 'verified in the doc editor'; }
          }
        }
      }
    } catch (e) { /* leave them unverified — the message below will say so */ }
    // Break results down by WHERE each write actually landed (verified), so the message
    // tells the truth instead of a bare count: dom = typed + server-confirmed, api = rescued via
    // API, store = confirmed by re-reading the doc editor, unverified = couldn't check, fail = lost.
    const domN = results.filter((r) => r.via === 'dom').length;
    const storeN = results.filter((r) => r.via === 'store').length;
    const apiN = results.filter((r) => r.via === 'api').length;
    const unv = results.filter((r) => r.via === 'unverified');
    const bad = results.filter((r) => !r.ok && r.via !== 'unverified');
    const okSegs = new Set(results.filter((r) => r.ok && r.via !== 'unverified').map((r) => r.seg));
    // Segments that were EMPTY and got a fresh translation (vs a proofread edit of existing text).
    // Call them out in the log + summary so a "did my new translations get written?" question is
    // answerable at a glance — each still goes through the same server-verify + API rescue.
    const filledSegs = new Set((state.proposals || []).filter((p) => p.filled).map((p) => p.seg));
    const newOk = results.filter((r) => r.ok && r.via !== 'unverified' && filledSegs.has(r.seg)).length;
    const newBad = results.filter((r) => filledSegs.has(r.seg) && (!r.ok || r.via === 'unverified')).length;
    const remembered = await tmRecordWritten(okSegs);
    if (remembered) tmRefresh();
    results.forEach((r) => log(`write #${r.seg}: ${r.via}${filledSegs.has(r.seg) ? ' (new translation)' : ''}${r.ok ? '' : ' ✕'}${r.reason ? ' — ' + r.reason : ''}`));
    if (unv.length) {
      // The server read failed — we genuinely don't know if these landed. Say so; don't claim success.
      info('write-info', `⚠ Wrote ${unv.length} via the editor but COULDN'T verify against Starling's server (it may not have saved). Reload the tab (Ctrl+R) and re-run ↩ Write, or use ⚡ Write·Confirm·Submit.`, 'err');
    } else {
      const parts = [];
      if (domN) parts.push(`${domN} confirmed on the server`);
      if (apiN) parts.push(`${apiN} rescued via API (auto-confirmed)`);
      if (storeN) parts.push(`${storeN} confirmed in the doc editor`);
      if (bad.length) parts.push(`${bad.length} failed`);
      const allOk = domN + apiN + storeN === results.length && !bad.length;
      const newNote = filledSegs.size ? ` · ✍ ${newOk}/${filledSegs.size} new translation${filledSegs.size === 1 ? '' : 's'} written${newBad ? ` (${newBad} NOT written — see log)` : ''}` : '';
      info('write-info', `✅ ${results.length} segment(s): ${parts.join(' · ')}${newNote}${remembered ? ` · 🧠 ${remembered} remembered` : ''}. ${allOk ? (storeN ? 'All verified — if the editor still shows old text, reload (Ctrl+R) to refresh the display.' : 'Starling’s server has them all — if the editor still shows old text, reload (Ctrl+R) to refresh the display.') : ''}`, (bad.length || newBad) ? 'err' : 'good');
    }
  } catch (e) {
    info('write-info', e.message, 'err');
  } finally {
    $('write').disabled = false;
  }
}

// Confirm-all via Starling's API (confirmTextTaskTargetV2 per pending segment) instead of
// clicking the label-less, zoom-fragile toolbar ✓ dropdown. Previews the count first, then
// confirms every not-yet-confirmed segment and re-reads to verify. Never submits the task.
async function doConfirmAll() {
  info('confirm-info', 'Checking how many segments still need confirming…');
  let pre;
  try { pre = await send({ type: 'API_CONFIRM_ALL', opts: { dryRun: true } }); }
  catch (e) { info('confirm-info', e.message, 'err'); return; }
  if (!pre || !pre.ok) { info('confirm-info', (pre && pre.error) || 'Could not read the task.', 'err'); return; }
  if (!pre.count) { info('confirm-info', '✅ Nothing to confirm — all segments are already confirmed.', 'good'); return; }
  if (!confirm(`Confirm ${pre.count} segment(s) via Starling's API (ignoring normal QA errors — only Critical errors block)? This does NOT submit the task.`)) return;
  info('confirm-info', `Confirming ${pre.count} segment(s)…`);
  try {
    const r = await send({ type: 'API_CONFIRM_ALL', opts: { ignoreQa: true } });
    if (r && r.ok) {
      // The API confirms server-side, but the editor's cached React state still shows the
      // rows as unconfirmed (the ✓✓ stays blue) until the task is re-fetched. Reloading the
      // tab — exactly what the user does by hand — re-reads from the server so they turn green.
      info('confirm-info', `✅ Confirmed ${r.confirmed}/${r.attempted}. Refreshing so the ✓✓ turn green…`, 'good');
      try { const t = await activeTab(); if (t) { await new Promise((res) => setTimeout(res, 700)); await chrome.tabs.reload(t.id); return; } } catch (e) {}
      await showPostSummary();
    } else {
      const f = (r && r.failed) || [];
      const stuck = (r && r.remaining && r.remaining.length) ? ` · still pending: ${r.remaining.slice(0, 10).join(', ')}` : '';
      const why = f.length ? ` · failures: ${f.slice(0, 5).map((x) => '#' + x.rank + ' ' + x.msg).join('; ')}` : (r && r.error ? ' · ' + r.error : '');
      info('confirm-info', `Confirmed ${(r && r.confirmed) || 0}/${(r && r.attempted) || 0}${stuck}${why}`, 'err');
    }
  } catch (e) { info('confirm-info', e.message, 'err'); }
}

// Submit the task via Starling's own dialog (text-matched DOM — the submit has no capturable
// HTTP endpoint, it goes over a WebSocket/internal channel). Delivers the task to the requester,
// so it always asks first. Never auto-runs.
async function doSubmit() {
  if (!confirm('Submit this task to the requester?\n\nThis runs Starling\'s "Submit all translations" → confirm, delivering your translation. It can\'t be undone from here.')) return;
  info('submit-info', 'Submitting…');
  try {
    const r = await send({ type: 'SUBMIT_TASK' });
    if (r && r.ok) {
      info('submit-info', r.submitted ? '✅ Task submitted to the requester.' : '✅ Submit confirmed (dialog closed).', 'good');
    } else if (r && r.disabled) {
      info('submit-info', '⚠ Nothing to submit — no pending changes (the task is already submitted). Edit/confirm a segment first.', 'err');
    } else {
      // Couldn't positively confirm — the submit may still have gone through (Starling shows a
      // brief success dialog and the button flips to "Task submitted"). Say so instead of "failed".
      info('submit-info', (r && r.error) || `Couldn't confirm the submit here${r && r.buttonNow ? ` (button now: "${r.buttonNow}")` : ''} — check Starling; if it shows "Task submitted", it went through.`, 'err');
    }
  } catch (e) { info('submit-info', e.message, 'err'); }
}

// Poll a tab until its content script (matching CS_EXPECT) answers PING — used
// after a reload so we don't message the page before the script re-injects.
async function wbWaitContentReady(tabId, ms) {
  const deadline = Date.now() + (ms || 12000);
  while (Date.now() < deadline) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' }); if (r && r.ver === CS_EXPECT) return true; }
    catch (e) { /* not injected yet */ }
    await wbSleep(500);
  }
  return false;
}

// One-click finish: Write+Confirm (atomic, API) → Confirm the rest → reload → Submit.
// A SINGLE upfront confirmation (Submit is irreversible — it delivers the task), then it
// runs in order and STOPS if any step fails, so it never submits a half-written task.
// Writing goes through the API (confirmTextTaskTargetV2 carries the content), so it both
// writes AND confirms server-side in one call — this avoids the race that made a DOM write
// look "written" while the immediate confirm found nothing saved yet. We then reload so the
// editor reflects the confirmed state (which the submit dialog needs) before submitting.
async function doWriteConfirmSubmit() {
  const edits = state.proposals ? state.proposals.filter((p) => p.approved && !p.manual).map((p) => ({ seg: p.seg, text: p.next })) : [];
  const manual = state.proposals ? state.proposals.filter((p) => p.manual).length : 0;
  const lines = [
    'One-click finish — this will:',
    `  1) Write & confirm ${edits.length} approved segment(s) via Starling's API`,
    '  2) Confirm any remaining unconfirmed segments (ignoring normal QA — Critical still blocks)',
    '  3) Reload, then SUBMIT the task to the requester — this DELIVERS your translation and can\'t be undone',
    manual ? `\n⚠ ${manual} tagged (copy-by-hand) segment(s) are NOT auto-written — if they still need pasting, Cancel and do that first.` : '',
    '\nProceed?'
  ].filter(Boolean);
  if (!confirm(lines.join('\n'))) return;
  const btn = $('write-confirm-submit'); btn.disabled = true;
  const say = (m, k) => info('wcs-info', m, k || '');
  try {
    // 1) WRITE + CONFIRM the approved changed segments, atomically via the API.
    if (edits.length) {
      say(`1/3 · writing & confirming ${edits.length} segment(s)…`);
      const w = await send({ type: 'API_WRITE_CONFIRM', edits, ignoreQa: true });
      if (!w || !w.ok) {
        const bad = (w && w.results || []).filter((x) => !x.ok);
        const why = bad.length ? ' · ' + bad.slice(0, 4).map((b) => '#' + b.seg + ' ' + (b.msg || b.reason || '')).join('; ') : (w && w.error ? ' · ' + w.error : '');
        say(`Write+confirm failed (${(w && w.confirmed) || 0}/${(w && w.attempted) || 0})${why} — stopped, nothing submitted.`, 'err'); return;
      }
      const okSegs = new Set(((w.results || []).filter((x) => x.ok).map((x) => x.seg)));
      await tmRecordWritten(okSegs.size ? okSegs : null);
      say(`1/3 · wrote & confirmed ${w.confirmed} ✓ — confirming the rest…`);
    } else {
      say('1/3 · nothing to write — confirming…');
    }
    // 2) CONFIRM the remaining unconfirmed (unchanged) segments.
    const c = await send({ type: 'API_CONFIRM_ALL', opts: { ignoreQa: true } });
    if (!c || !c.ok) {
      const f = (c && c.failed) || [];
      const why = f.length ? ` · ${f.slice(0, 4).map((x) => '#' + x.rank + ' ' + x.msg).join('; ')}` : (c && c.error ? ' · ' + c.error : '');
      say(`Confirm failed (${(c && c.confirmed) || 0}/${(c && c.attempted) || 0})${why} — stopped before submit.`, 'err'); return;
    }
    // 3) Reload so the editor's own state shows everything confirmed (the submit dialog
    //    reads client state), wait for the content script to come back, then submit.
    say(`2/3 · confirmed — refreshing the page to submit…`);
    const t = await activeTab();
    if (t) {
      await chrome.tabs.reload(t.id);
      const ready = await wbWaitContentReady(t.id, 15000);
      if (!ready) { say('Written & confirmed ✓, but the page didn\'t finish reloading in time — click ➤ Submit task manually.', 'err'); return; }
    }
    say('3/3 · submitting…');
    const s = await send({ type: 'SUBMIT_TASK' });
    if (s && s.ok) { say(s.submitted ? '✅ Written, confirmed & submitted to the requester.' : '✅ Written & confirmed; submit dialog closed — verify Starling shows “Task submitted”.', 'good'); }
    else if (s && s.disabled) { say('Written & confirmed ✓, but Submit found nothing pending — it may already be submitted.', 'err'); }
    else { say(`Written & confirmed ✓, but couldn't confirm the submit${s && s.error ? ' · ' + s.error : ''} — check Starling; click ➤ Submit task if needed.`, 'err'); }
  } catch (e) { say(e.message, 'err'); }
  finally { btn.disabled = false; }
}

// ---- QA summary + post-confirm summary -------------------------------------
function qaCategory(row) {
  if (/critical/i.test(row.level)) return 'critical';
  const t = (row.type || '') + ' ' + (row.desc || '');
  if (/punctuat|comma|period|full stop|colon|semicolon|quotation|quote|bracket|paren|dash|ellipsis/i.test(t)) return 'punctuation';
  if (/\bspace|spacing|whitespace|trailing|leading/i.test(t)) return 'spacing';
  return 'other';
}
const QA_ORDER = [['critical', '🔴 Critical'], ['punctuation', '✒️ Punctuation'], ['spacing', '␣ Spacing'], ['other', '• Other']];
function renderQa(rows) {
  const box = $('qa-groups');
  if (!rows || !rows.length) { box.innerHTML = '<div class="info good">No QA warnings found. 🎉</div>'; return; }
  const byCat = {};
  rows.forEach((r) => { const c = qaCategory(r); (byCat[c] = byCat[c] || []).push(r); });
  box.innerHTML = QA_ORDER.filter(([k]) => byCat[k] && byCat[k].length).map(([k, label]) => {
    const items = byCat[k];
    const segs = [...new Set(items.map((i) => i.seg).filter(Boolean))];
    const rowsHtml = items.slice(0, 60).map((i) => `<div class="qa-row"><span class="qa-seg">#${esc(i.seg || '?')}</span><span class="qa-desc">${esc(i.desc || '')}</span></div>`).join('');
    return `<details class="qa-group qa-${k}"${k === 'critical' ? ' open' : ''}><summary><b>${label}</b> · ${items.length} on ${segs.length} seg${segs.length === 1 ? '' : 's'}</summary>${rowsHtml}</details>`;
  }).join('');
}
async function doQaSummary() {
  info('qa-info', 'Reading QA panel…');
  try {
    const r = await send({ type: 'READ_QA' });
    if (!r || !r.ok) throw new Error(r && r.error || 'failed');
    const crit = (r.rows || []).filter((x) => /critical/i.test(x.level)).length;
    info('qa-info', r.count ? `${r.count} QA warning(s) · ${crit} critical` : (r.note || 'No QA rows found — run QA diagnostics to calibrate.'), crit ? 'err' : 'good');
    if (r.note && r.count) log('QA: ' + r.note);
    renderQa(r.rows || []);
  } catch (e) { info('qa-info', e.message, 'err'); }
}
async function showPostSummary() {
  const box = $('post-summary'); box.hidden = false; box.innerHTML = 'Reading task status…';
  let status = {}, qa = { rows: [] };
  try { status = await send({ type: 'TASK_STATUS' }); } catch (e) {}
  try { qa = await send({ type: 'READ_QA' }); } catch (e) {}
  const written = state.proposals ? state.proposals.filter((p) => p.approved && !p.manual).length : 0;
  const manual = state.proposals ? state.proposals.filter((p) => p.manual).length : 0;
  const crit = (qa.rows || []).filter((x) => /critical/i.test(x.level)).length;
  const pct = (status && status.percent != null) ? status.percent + '%' : '—';
  box.innerHTML = `<div class="sum-h">Post-confirm summary</div>
    <ul class="sum-list">
      <li>Task progress: <b>${pct}</b></li>
      <li>Auto-written this session: <b>${written}</b></li>
      <li>Copy-by-hand (tagged): <b>${manual}</b>${manual ? ' — paste these before submitting' : ''}</li>
      <li class="${crit ? 'bad' : 'good'}">QA criticals: <b>${crit}</b>${crit ? ' — must fix before submit' : ''}</li>
    </ul>
    <div class="sum-note">⚠ Not submitted. Review in Starling, then submit yourself.</div>`;
  renderQa(qa.rows || []);
}

async function doDiag() {
  $('diag-out').textContent = 'Running…';
  try {
    const r = await send({ type: 'DIAG' });
    let qa = null;
    try { qa = await send({ type: 'QA_DIAG' }); } catch (e) {}
    $('diag-out').textContent = JSON.stringify(r, null, 2) + (qa ? '\n\n— QA —\n' + JSON.stringify(qa, null, 2) : '');
  } catch (e) { $('diag-out').textContent = e.message; }
}

// ══════════ FEISHU LQA ADJUDICATOR ══════════════════════════════════════════
// Feishu sheets render to <canvas> (no DOM cells), so this ingests pasted rows /
// CSV instead of scraping, then GPT-5.4 decides whether each AI-flagged error is
// real. Reuses esc/hl/panelCopy and the shared key/model/plural settings.
const LQ = { header: [], records: [], map: {}, rows: [], sel: [], results: {}, filter: 'all', validYmeansReal: true, workbook: null, fileName: '' };
const LQ_FIELDS = [['src', 'Source (EN)'], ['tgt', 'Current target'], ['ai', 'AI suggested'], ['cat', 'Error type'], ['level', 'Level'], ['comment', 'AI comment'], ['key', 'Key'], ['valid', 'Valid col'], ['final', 'Final (approved)'], ['lang', 'Language']];
const LQ_BATCH = 8;
// Learn-from-Starling harvest: pairs per distill call, and a cap on unique pairs sent to GPT.
const HV_BATCH = 40, HV_CAP = 200;
let HV = { pairs: [], taskId: '', taskName: '' };

// RFC4180-ish parser — survives quoted, multi-line cells (Feishu Source spans lines).
function lqSplitTable(text, delim) {
  const s = String(text).replace(/\r\n?/g, '\n'); const rows = []; let row = [], f = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else inQ = false; } else f += c; continue; }
    if (c === '"') { inQ = true; continue; }
    if (c === delim) { row.push(f); f = ''; continue; }
    if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; continue; }
    f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function lqAutoMap(header) {
  const used = new Set(), map = {};
  const find = (re) => { for (let i = 0; i < header.length; i++) { if (used.has(i)) continue; if (re.test(header[i])) { used.add(i); return i; } } return -1; };
  map.lang = find(/lang|语言|語言/i);
  map.ai = find(/suggest|correct\s*target/i);                  // Feishu "Suggested Target by AI" · XBench/CAT "CorrectTarget" (the proposed fix), claimed before plain Target
  map.tgt = find(/target|译文|譯文|tgt\s*text|\btgt\b/i);      // "Target" / "TgtText"
  map.src = find(/source|原文|src\s*text|\bsrc\b/i);           // "Source" / "SrcText"
  map.cat = find(/category|errortype|error\s*type|类型|類型/i);
  map.level = find(/level|severity|等级|等級/i);
  map.comment = find(/comment|说明|說明|备注|備註|reason/i);
  map.key = find(/^keys?$|\bkeys?\b|键|鍵/i);                  // "Key" or "keys"
  map.valid = find(/valid|proofread|\bagree/i);         // "Valid (Y/N)" · "Validation feedback" (=agree) · a bare "agree" column
  map.final = find(/final\s*translation|\bfinal\b/i);   // "Final Translation (Only for valid issues)" — the human-approved fix (col K); lrnAdd falls back to the AI/CorrectTarget when absent
  return map;
}
function lqLoad(preRows) {
  LQ.results = {}; LQ.sel = [];
  let rows;
  if (Array.isArray(preRows)) {                     // xlsx tab → already a 2-D array of cells
    rows = preRows.filter((r) => Array.isArray(r) && r.length);
    if (!rows.length) { info('lq-info', 'That sheet tab is empty.', 'err'); return; }
  } else {
    const text = $('lq-input').value;
    if (!text.trim()) { info('lq-info', 'Paste rows copied from Feishu, or load an .xlsx / CSV / TSV.', 'err'); return; }
    const mode = $('lq-delim').value;
    const delim = mode === 'csv' ? ',' : mode === 'tsv' ? '\t' : (text.indexOf('\t') >= 0 ? '\t' : ',');
    rows = lqSplitTable(text, delim).filter((r) => r.length);
    if (!rows.length) { info('lq-info', 'Nothing parsed — check the format.', 'err'); return; }
  }
  // Find the header row by matching real header *labels* (incl. XBench SrcText/TgtText/CorrectTarget),
  // anchored to whole cells — otherwise a data row whose ErrorComment mentions "source"/"target"
  // (e.g. "The source phrase… the target translation…") gets mistaken for the header.
  const looksHeader = (r) =>
    r.some((c) => /^\s*(source|src\s*text)\s*$/i.test(c)) &&
    r.some((c) => /^\s*(target|tgt\s*text|correct\s*target)\s*$/i.test(c));
  let hi = rows.findIndex(looksHeader);
  if (hi < 0) hi = rows.findIndex((r) => r.some((c) => /source/i.test(c)) && r.some((c) => /target/i.test(c)));
  if (hi < 0) hi = rows.findIndex((r) => r.some((c) => /source|target|error/i.test(c)));
  if (hi < 0) hi = 0;
  LQ.hi = hi;                                    // header row index — for pasting back at the right sheet row
  LQ.header = rows[hi].map((c) => String(c).trim());
  LQ.records = rows.slice(hi + 1).filter((r) => r.some((c) => String(c).trim().length));
  if (!LQ.records.length) { info('lq-info', 'Found a header but no data rows below it.', 'err'); return; }
  LQ.map = lqAutoMap(LQ.header);
  lqBuildRows(); lqRenderMap();
  $('lq-map-card').hidden = false; $('lq-run-card').hidden = false;
  if ($('lq-learn-card')) $('lq-learn-card').hidden = false;
  $('lq-review-card').hidden = true; $('lq-paste-card').hidden = true;
  $('lq-cards').innerHTML = ''; $('lq-legend').innerHTML = '';
  info('lq-info', `Loaded ${LQ.rows.length} rows${LQ.langFiltered ? ` (Hebrew only — ${LQ.langFiltered} other-language rows hidden)` : ''}${LQ.lvlFiltered ? ` (${(($('lq-level') && $('lq-level').value) || '')} only — ${LQ.lvlFiltered} other-level rows hidden)` : ''} (header row ${hi + 1}). Check the mapping, then pick a range.`, 'good');
}
function lqIsHe(v) { return /^he([_-]?il)?$|hebrew|עברית/i.test(String(v == null ? '' : v).trim()); }
function lqBuildRows() {
  const m = LQ.map, g = (r, i) => (i >= 0 && i < r.length) ? String(r[i]).trim() : '';
  let rows = LQ.records.map((r, ri) => ({ ri, lang: g(r, m.lang), src: g(r, m.src), tgt: g(r, m.tgt), ai: g(r, m.ai), cat: g(r, m.cat), level: g(r, m.level), comment: g(r, m.comment), key: g(r, m.key), valid: g(r, m.valid), final: g(r, m.final) }));
  // The sync sheets stack he / jv / ko in one tab; default to Hebrew-only when a Language column exists.
  const wantHe = (($('lq-lang') && $('lq-lang').value) || 'he') === 'he';
  LQ.langFiltered = 0;
  if (wantHe && m.lang >= 0) {
    const before = rows.length;
    rows = rows.filter((x) => lqIsHe(x.lang));
    LQ.langFiltered = before - rows.length;
  }
  // Optional error-level filter (opt-in): "All" keeps every row (the normal flow); pick e.g.
  // "minor" to adjudicate only that severity. Matches the Level cell loosely (minor/major/critical).
  const wantLvl = (($('lq-level') && $('lq-level').value) || 'all').toLowerCase();
  LQ.lvlFiltered = 0;
  if (wantLvl !== 'all' && m.level >= 0) {
    const before = rows.length;
    const re = new RegExp(wantLvl, 'i');
    rows = rows.filter((x) => re.test(String(x.level || '')));
    LQ.lvlFiltered = before - rows.length;
  }
  LQ.rows = rows.map((x, idx) => Object.assign({ n: idx + 1 }, x));
}
function lqRenderMap() {
  const wrap = $('lq-map'); if (!wrap) return;
  const opts = (sel) => ['<option value="-1">(none)</option>'].concat(LQ.header.map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(h || ('col ' + (i + 1)))}</option>`)).join('');
  wrap.innerHTML = LQ_FIELDS.map(([f, label]) => `<div><label>${label}</label><select data-f="${f}">${opts(LQ.map[f])}</select></div>`).join('');
  wrap.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => { LQ.map[s.dataset.f] = parseInt(s.value, 10); lqBuildRows(); info('lq-info', 'Mapping updated · ' + LQ.rows.length + ' rows.', 'good'); }));
}
// "1, 3, 1-10, 5-8" | "all" | blank → sorted unique row numbers, clamped to 1..max
function lqParseRange(str, max) {
  let s = String(str || '').trim();
  if (!s || /^all$/i.test(s)) return Array.from({ length: max }, (_, i) => i + 1);
  s = s.replace(/\s*[-–—]\s*/g, '-');
  const set = new Set();
  s.split(/[,;\s]+/).forEach((tok) => {
    tok = tok.trim(); if (!tok) return;
    const m = tok.match(/^(\d+)-(\d+)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b) { const t = a; a = b; b = t; } for (let i = a; i <= b; i++) set.add(i); }
    else if (/^\d+$/.test(tok)) set.add(+tok);
  });
  return [...set].filter((n) => n >= 1 && n <= max).sort((a, b) => a - b);
}
function lqSys(plural) {
  return 'You are a senior English→Hebrew (he-IL) localization QA reviewer for TikTok product & help-center copy.\n' +
    'For each item an automated checker flagged a POSSIBLE error in the Hebrew "tgt", described by "error_type" / "error_comment", with a machine "ai_suggested" rewrite. Judge whether the flagged error is a REAL error.\n' +
    'HOUSE STYLE for any Hebrew you output (FORM OF ADDRESS): ' + (plural ? 'plural, gender-neutral (לשון רבים — e.g. הצטרפו, לחצו, קראו) — never masculine-singular, never שלם/י slash forms. ' : 'singular, gender-neutral with a slash for both genders (לחץ/י, את/ה, בחר/י) — final letter before the slash; write both words in full when the suffixes differ (התחל/התחילי, not התחל/י); NOT the plural form and NOT masculine-singular alone. ') +
    'Keep "TikTok" and brand / product / feature names in Latin script, EXACTLY as in "src" including internal spaces/capitalization ("TikTok Lite" stays "TikTok Lite", never "TikTok-Lite"/"TikTokLite"; a Hebrew prefix takes a maqaf before the name: ב-TikTok Lite). Keep EVERY placeholder / tag byte-for-byte and in order: {x}, {{x}}, %s, %1$s, <b>…</b>, <g id="1">…</g>, ①②③.\n' +
    brainText() + '\n' +
    'PUNCTUATION: MIRROR the English "src" sentence-final full stop (.). If "src" ends with "." then "corrected" MUST end with "."; if "src" does NOT end with "." then "corrected" must NOT end with ".". Never add or drop it independently. Keep "?", "!", "…" as the meaning requires.\n' +
    'NUMBERS & CURRENCY (do-not-translate): "corrected" must keep every number, amount and currency symbol/code from "src" — same digits, same currency, same grouping — never translate/convert/localize/change the figure, and never keep a different (stale TM) figure from "tgt". A differing figure IS a valid error → verdict "valid" and fix it. HEBREW POSITION: the currency symbol/code goes AFTER the number for every foreign currency ($, MX$, ₩, €, £, Rp, R$, kr…): "$20"→"20$", "$100+"→"100$+", "MX$67,000"→"67,000MX$", "Rp150,000"→"150,000Rp". A target that puts the symbol BEFORE the number (e.g. "$20") when the figure is otherwise right is a positional error → "valid", fix the order only (do not treat the moved symbol as a changed amount).\n' +
    'ADDITIONS: if "tgt" contains a name, word or clause NOT present or implied in "src" (e.g. a player name like "ראמי רביע" the source omits), the Addition flag is VALID → verdict "valid" and "corrected" must REMOVE the added content. Never introduce content not in "src".\n' +
    'SPACING: "corrected" must have no space before "." "," ":" ";" "!" "?", no double spaces, and no leading/trailing spaces.\n' +
    'TERMINOLOGY SKEPTICISM: you do NOT have the project glossary / terminology reference. When the checker justifies an error ONLY by citing a "terminology reference", "approved target string", "terminology list" or "should remain in English" that you cannot see, do NOT assume it is correct — treat such unverifiable claims skeptically and lean "invalid" unless the Hebrew is independently wrong. Common English words/phrases ("for you", "tips", "settings", "learn more") are NOT brand names and are normally translated to Hebrew; only unmistakable product/feature proper nouns (e.g. TikTok, TikTok LIVE) must stay in Latin script. Note: standalone "LIVE" (the live-streaming feature/badge) is NOT kept in Latin — per the glossary it is translated to "שידור חי"; only the full product name "TikTok LIVE" stays in Latin.\n' +
    'REGISTER / UI ROLE (gerund vs imperative — e.g. "Save" → שמירה as a button but שמור/שמרי as a tooltip): you see only the English "src", not the screenshot or string key, so the on-screen role can be unknowable. Do NOT mark a register choice invalid merely because you would have picked the other one — if the "tgt" register is defensible for a plausible role of that string, treat the flag as "invalid" (false positive). Only mark it "valid" when the register is wrong for the role the source clearly implies (e.g. a full imperative sentence "Save your changes" rendered as a gerund). When you DO change the register on a valid/partial row, put the role reason in "ai_diff_reason" (e.g. "imperative — source is a tooltip instruction, not a button label").\n' +
    'DIFFERENCE FROM THE AI SUGGESTION: each item includes the automated checker\'s own rewrite as "ai_suggested". When your verdict is "valid" or "partial" AND your "corrected" DIFFERS from "ai_suggested" (ignore whitespace-only differences), set "ai_diff_reason" to a SHORT English phrase (a few words) naming WHY yours differs — e.g. "singular imperative (הקש/י) instead of plural (הקישו)", "removed trailing period to match source", "kept placeholder {s_ota}", "fixed brand spacing (TikTok Lite)". Leave "ai_diff_reason" EMPTY when there is no "ai_suggested", when your "corrected" equals it (ignoring whitespace), or when the verdict is invalid.\n' +
    'Return ONLY JSON: {"out":[{"i":<n>,"verdict":"valid|invalid|partial","category":"<exactly one of: Typo | Punctuation/Space/Tag/Formatting | Grammar and syntax | Mistranslation | Preferential change | Term mismatch | Semantic addition | Semantic omission | Inconsistency>","corrected":"<hebrew, the corrected target>","reason":"<short invalid reason, ONLY when verdict is invalid, else empty>","ai_diff_reason":"<short English reason your corrected differs from ai_suggested on a valid/partial row; see rule above; else empty>","rationale":"<one short line for the human reviewer>","confidence":<0..1>}]}.\n' +
    'verdict "valid" = the flagged error is real and the target MUST be fixed; "invalid" = false positive, the current target is fine; "partial" = only part of the flag is right. Always classify "category" (the best-fit class of the issue being discussed) — even for invalid, so spelling/grammar false-positives can be identified. "corrected" = the corrected Hebrew target for valid/partial; for invalid return the original "tgt" unchanged. Be conservative — do not invent errors the checker did not raise.';
}
async function lqRun() {
  const key = await store.get('key', '');
  if (!key) { info('lq-run-info', 'Add your OpenAI key in Settings first.', 'err'); $('settings').open = true; return; }
  if (!LQ.rows.length) { info('lq-run-info', 'Load rows first.', 'err'); return; }
  const sel = lqParseRange($('lq-range').value, LQ.rows.length);
  if (!sel.length) { info('lq-run-info', 'That range selected no rows (loaded 1–' + LQ.rows.length + ').', 'err'); return; }
  LQ.sel = sel;
  const model = $('model').value, plural = $('plural').checked;
  const byN = {}; LQ.rows.forEach((r) => byN[r.n] = r);
  $('lq-run').disabled = true;
  let done = 0, failed = 0, firstErr = '';
  // Some newer models (gpt-5.x) reject a non-default temperature with a 400. Once we see that, drop
  // the field for the rest of the run instead of failing every batch.
  let dropTemp = false;
  const callGpt = async (items) => {
    const body = { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: lqSys(plural) }, { role: 'user', content: 'Adjudicate these items. Return one entry per item with the same "i".\n' + JSON.stringify({ items }) }] };
    if (!dropTemp) body.temperature = 0.1;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) { const e = new Error(data.error && data.error.message || ('GPT error ' + resp.status)); e.status = resp.status; throw e; }
    return data;
  };
  try {
    for (let i = 0; i < sel.length; i += LQ_BATCH) {
      const slice = sel.slice(i, i + LQ_BATCH);
      info('lq-run-info', `⚖️ Adjudicating ${i + 1}–${Math.min(i + LQ_BATCH, sel.length)} of ${sel.length}…`);
      const items = slice.map((n, j) => { const r = byN[n]; return { i: j + 1, src: r.src, tgt: r.tgt, ai_suggested: r.ai, error_type: r.cat, error_level: r.level, error_comment: r.comment }; });
      try {
        let data;
        try { data = await callGpt(items); }
        catch (e1) { if (!dropTemp && /temperature/i.test(e1.message || '')) { dropTemp = true; data = await callGpt(items); } else throw e1; }
        const arr = JSON.parse(data.choices?.[0]?.message?.content || '{}').out || [];
        arr.forEach((o) => {
          const idx = (o.i | 0) - 1; if (idx < 0 || idx >= slice.length) return; const n = slice[idx]; const row = byN[n];
          const corrected = o.corrected != null ? polish(row ? row.src : '', o.corrected) : '';  // fix spacing + mirror the source's full stop
          LQ.results[n] = { verdict: String(o.verdict || '').toLowerCase().trim(), category: String(o.category || '').trim(), corrected: corrected, reason: o.reason ? String(o.reason) : '', aiDiff: o.ai_diff_reason ? String(o.ai_diff_reason) : '', rationale: o.rationale ? String(o.rationale) : '', confidence: (typeof o.confidence === 'number' ? o.confidence : null) };
          done++;
        });
      } catch (e) { failed += slice.length; if (!firstErr) firstErr = e.message || String(e); log('lq batch @' + i + ' failed: ' + e.message); }
      if (i + LQ_BATCH < sel.length) await new Promise((r) => setTimeout(r, 250));
    }
    lqDedupeReasons();
    LQ.filter = 'all'; lqRenderLegend(); lqRenderCards();
    $('lq-review-card').hidden = false; $('lq-paste-card').hidden = false;
    info('lq-run-info', `✅ Adjudicated ${done} · ${lqCountYN('Yes')} valid · ${lqCountYN('No')} invalid` + (failed ? ` · ${failed} failed — ${firstErr || 'see console'}` : ''), failed ? 'err' : 'good');
  } finally { $('lq-run').disabled = false; }
}
function lqVerdict(r) { const v = r.verdict; if (v === 'valid' || v === 'invalid' || v === 'partial') return v; if (v === 'no' || v === 'false' || v === 'n') return 'invalid'; if (v === 'yes' || v === 'true' || v === 'y') return 'valid'; return 'valid'; }
const LQ_CATS = ['Typo', 'Punctuation/Space/Tag/Formatting', 'Grammar and syntax', 'Mistranslation', 'Preferential change', 'Term mismatch', 'Semantic addition', 'Semantic omission', 'Inconsistency'];
// A "real error to fix" = GPT's call, UNLESS you overrode Valid Yes/No on the card.
function lqReal(r) { return r.validOverride ? r.validOverride === 'Yes' : lqVerdict(r) !== 'invalid'; }
// Explicit per-row "Agree" flag (the ✓ Agree button). It drives column J ("agree") in the
// download / paste-back. Defaults to the accepted verdict (lqReal) so the former flow is
// unchanged until you click Agree; once set, r.agree wins. Column J = "agree" iff this is true.
function lqAgreeState(r) { return (r && r.agree != null) ? !!r.agree : lqReal(r); }
function lqSetAgree(n, on) { const r = LQ.results[n]; if (!r) return; r.agree = on; lqRenderCards(); }
function lqValidYN(r) { if (r.validOverride) return r.validOverride; return (LQ.validYmeansReal ? lqReal(r) : !lqReal(r)) ? 'Yes' : 'No'; }
function lqNaturalYN(r) { return (LQ.validYmeansReal ? (lqVerdict(r) !== 'invalid') : (lqVerdict(r) === 'invalid')) ? 'Yes' : 'No'; }
function lqCountYN(yn) { return LQ.sel.filter((n) => { const r = LQ.results[n]; return r && lqValidYN(r) === yn; }).length; }
function lqSpellingGrammar(r) { return /^(Typo|Grammar and syntax)$/i.test(r.category || ''); }
// Email rule: a Comment (= the invalid reason) is given ONLY for INVALID spelling/grammar
// errors, and ONE per category type (valid rows and other invalids get no comment).
function lqDedupeReasons() {
  const seen = new Set();
  LQ.sel.forEach((n) => {
    const r = LQ.results[n]; if (!r) return;
    const row = LQ.rows.find((x) => x.n === n);
    if (!lqReal(r) && lqSpellingGrammar(r)) {
      const t = (r.category || 'other').toLowerCase(); if (seen.has(t)) r.comment = ''; else { seen.add(t); r.comment = r.reason || ''; }
    } else if (lqReal(r) && row && row.ai && r.corrected && wbNorm(r.corrected) !== wbNorm(row.ai)) {
      // Valid, but our Final Translation differs from the AI's suggested target → comment WHY
      // (e.g. "singular imperative (הקש/י) instead of plural"). Per-row, not deduped.
      r.comment = r.aiDiff || '';
    } else r.comment = '';
  });
}
// Flip a verdict on the card; clears the override when set back to GPT's own call.
function lqSetOverride(n, yn) {
  const r = LQ.results[n]; if (!r) return;
  r.validOverride = (yn === lqNaturalYN(r)) ? null : yn;
  lqDedupeReasons(); lqRenderLegend(); lqRenderCards();
}
function lqRenderLegend() {
  const leg = $('lq-legend'); if (!leg) return; leg.innerHTML = '';
  const mk = (key, label, n) => { const b = document.createElement('button'); b.className = 'lq-chip' + (LQ.filter === key ? ' active' : ''); b.textContent = label + ' · ' + n; b.onclick = () => { LQ.filter = key; lqRenderLegend(); lqApplyFilter(); }; return b; };
  leg.appendChild(mk('all', 'All', LQ.sel.length));
  leg.appendChild(mk('valid', '🔴 Valid (Yes)', lqCountYN('Yes')));
  leg.appendChild(mk('invalid', '🟢 Invalid (No)', lqCountYN('No')));
}
function lqApplyFilter() { $('lq-cards').querySelectorAll('.lqc').forEach((c) => c.classList.toggle('hide', LQ.filter !== 'all' && c.dataset.verdict !== LQ.filter)); }
function lqCardHtml(n) {
  const r = LQ.rows.find((x) => x.n === n); const res = LQ.results[n]; if (!r || !res) return '';
  const gv = lqVerdict(res), yn = lqValidYN(res), real = lqReal(res);
  const eff = real ? 'valid' : 'invalid';                 // your effective decision drives stripe + filter
  const c = lqCells(res);
  const lvl = r.level ? `<span class="lqc-lvl">${esc(r.level)}</span>` : '';
  const keyHtml = r.key ? `<span class="lqc-key" title="Key">${esc(r.key)}</span>` : '';
  const ovr = res.validOverride ? `<span class="lqc-ovr" title="You overrode GPT's call">overridden</span>` : '';
  const numWarn = amountMismatch(r.src, c.final || r.tgt) ? `<span class="lqc-warn" title="Number/currency differs from the source — the amount & currency symbol must stay verbatim (may be a stale TM value).">⚠ number</span>` : '';
  const spWarn = (hasSpacingIssue(r.tgt) || edgeMismatch(r.src, r.tgt)) ? `<span class="lqc-warn" title="Spacing adjusted — space before punctuation, double spaces, or leading/trailing space to match the source.">⚠ spacing</span>` : '';
  const brWarn = brandIssue(r.src, c.final || r.tgt) ? `<span class="lqc-warn" title="A product name from the source (${esc(brandIssue(r.src, c.final || r.tgt))}) isn't kept verbatim — check the brand spelling/spacing.">⚠ brand</span>` : '';
  const vset = `<span class="lqc-vset" title="Valid (Yes/No) — flip it to correct GPT; the paste-back updates">` +
    `<button class="lqc-vbtn${yn === 'Yes' ? ' on' : ''}" type="button" data-set="Yes" data-n="${n}">Yes</button>` +
    `<button class="lqc-vbtn${yn === 'No' ? ' on' : ''}" type="button" data-set="No" data-n="${n}">No</button></span>`;
  // Explicit Agree toggle → column J "agree" in the download / paste-back. Defaults to the accepted
  // verdict so the former flow is unchanged; click to include/exclude this row from the "agree" set.
  const agr = lqAgreeState(res);
  const agBtn = `<button class="lqc-agree${agr ? ' on' : ''}" type="button" data-agree="${n}" title="Agree with the Correct target — writes &quot;agree&quot; into column J of the downloaded sheet (picked up by Sheet → Starling)">${agr ? '✓ Agreed' : 'Agree'}</button>`;
  const claim = (r.cat || r.comment) ? `<div class="lqc-claim"><b>${esc(r.cat || '')}</b>${r.comment ? ' — ' + esc(r.comment) : ''}</div>` : '';
  const changed = (real && res.corrected && res.corrected !== r.tgt);
  const cat = c.category ? `<div class="lqc-lbl">Category</div><span class="lqc-cat">${esc(c.category)}</span>` : '';
  const finalT = real ? `<div class="lqc-lbl">Final translation</div><div class="lqc-new" dir="rtl">${hl(esc(c.final || r.tgt))}</div>` : '';
  const comment = c.comments ? `<div class="lqc-lbl">Comment${real ? ' (differs from AI suggestion)' : ' (invalid reason)'}</div><div class="lqc-reason" dir="auto">${esc(c.comments)}</div>` : '';
  const rat = res.rationale ? `<div class="lqc-rat">${esc(res.rationale)}${res.confidence != null ? ` · conf ${Math.round(res.confidence * 100)}%` : ''}</div>` : '';
  const acts = [];
  if (c.final) acts.push(`<button class="lqc-copy" type="button" data-copy="${esc(c.final)}">Copy final</button>`);
  if (c.category) acts.push(`<button class="lqc-copy ghost" type="button" data-copy="${esc(c.category)}">Copy category</button>`);
  acts.push(`<button class="lqc-copy ghost" type="button" data-copy="${esc(yn)}">Copy ${esc(yn)}</button>`);
  if (c.comments) acts.push(`<button class="lqc-copy ghost" type="button" data-copy="${esc(c.comments)}">Copy comment</button>`);
  return `<div class="lqc v-${eff}" data-verdict="${eff}" data-n="${n}">
    <div class="lqc-top"><span class="lqc-seg">#${n}</span><span class="lqc-badge b-${gv}" title="GPT's call">${gv}</span>${vset}${agBtn}${numWarn}${spWarn}${brWarn}${ovr}${lvl}${keyHtml}</div>
    ${r.src ? `<div class="lqc-lbl">Source</div><div class="lqc-src" dir="ltr">${hl(esc(r.src))}</div>` : ''}
    <div class="lqc-lbl">Current target</div><div class="lqc-tgt${changed ? ' old' : ''}" dir="rtl">${hl(esc(r.tgt))}</div>
    ${r.ai ? `<div class="lqc-lbl">${/correct\s*target/i.test((LQ.header[LQ.map.ai] || '')) ? 'Correct target' : 'AI suggested'}</div><div class="lqc-tgt" dir="rtl">${hl(esc(r.ai))}</div>` : ''}
    ${claim}${cat}${finalT}${comment}${rat}
    <div class="lqc-acts">${acts.join('')}</div>
  </div>`;
}
function lqRenderCards() {
  const wrap = $('lq-cards'); if (!wrap) return;
  wrap.innerHTML = LQ.sel.map(lqCardHtml).join('');
  wrap.querySelectorAll('.lqc-copy').forEach((b) => b.addEventListener('click', () => panelCopy(b.getAttribute('data-copy'), b)));
  wrap.querySelectorAll('.lqc-vbtn').forEach((b) => b.addEventListener('click', () => lqSetOverride(+b.dataset.n, b.dataset.set)));
  wrap.querySelectorAll('.lqc-agree').forEach((b) => b.addEventListener('click', () => lqSetAgree(+b.dataset.agree, !b.classList.contains('on'))));
  lqApplyFilter();
}
// Paste-back columns come from LQ.results (exact), not DOM attributes. They map to the
// sheet's 5 "Linguists" columns: Valid (Yes/No) · Category · Final Translation ·
// Updated on Starling (you fill) · Comments. Category + Final are "only for valid issues".
function lqCells(res) {
  const real = lqReal(res);
  return {
    valid: lqValidYN(res),
    category: real ? (res.category || '') : '',
    final: real ? (res.corrected || '') : '',
    updated: '',                                   // your manual tracker — left blank
    comments: res.comment || ''
  };
}
// Escape a cell for pasting into a sheet: if it holds a tab / newline / quote, wrap it in
// double quotes (doubling any inner quote) — RFC4180. Without this, a multi-line Final
// Translation spills onto extra rows and shifts every row below it out of alignment.
// A raw TAB inside a cell is what pushes its text into the NEXT column on paste, so replace
// tabs with a space (never meaningful mid-cell). Newlines are still RFC4180-quoted so a
// multi-line Final Translation stays in one cell (doesn't spill onto extra rows).
function lqTsvCell(v) { v = String(v == null ? '' : v).replace(/\t/g, ' '); return /[\n\r"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function lqColumn(kind) {
  return LQ.sel.map((n) => { const res = LQ.results[n]; return lqTsvCell(res ? (lqCells(res)[kind] || '') : ''); }).join('\n');
}
function lqCopyCol(kind, btn) { panelCopy(lqColumn(kind), btn); }
function lqCopyAll(btn) {
  const tsv = LQ.sel.map((n) => {
    const res = LQ.results[n]; if (!res) return '\t\t\t\t';
    const c = lqCells(res);
    return [c.valid, c.category, c.final, c.updated, c.comments].map(lqTsvCell).join('\t');
  }).join('\n');
  panelCopy(tsv, btn);
}
function lqCopyStarling(btn) {
  const map = {}; LQ.sel.forEach((n) => { const r = LQ.rows.find((x) => x.n === n), res = LQ.results[n]; if (!res) return; if (lqVerdict(res) !== 'invalid' && res.corrected && r && r.key) map[r.key] = { target: res.corrected }; });
  if (!Object.keys(map).length) { info('lq-paste-info', 'No valid rows with a Key + fix to hand off.', 'err'); return; }
  panelCopy(JSON.stringify(map, null, 2), btn);
  info('lq-paste-info', `Copied ${Object.keys(map).length} Key→fix entries.`, 'good');
}
// Single-column paste-back for reviewer status sheets (e.g. XBench LQA reports): for every AGREED
// row → column J "agree". Non-agreed rows stay blank. Column I is left completely untouched (your
// prior reviewer-status notes are never clobbered). Paste the block at the first adjudicated row's
// column J.
function lqCopyAgreeFixed(btn) {
  if (!LQ.sel.length) { info('lq-paste-info', 'Adjudicate a range first.', 'err'); return; }
  let nAcc = 0;
  const lines = LQ.sel.map((n) => {
    const row = LQ.rows.find((x) => x.n === n), res = LQ.results[n];
    const accepted = res ? lqAgreeState(res) : false;
    if (accepted) nAcc++;
    const finalT = accepted ? ((lqCells(res).final) || (row && row.ai) || (row && row.tgt) || '') : '';
    return lqTsvCell(accepted ? 'agree' : '') + '\t' + lqTsvCell(finalT);   // column J, column K
  });
  panelCopy(lines.join('\n'), btn);
  const first = LQ.rows.find((x) => x.n === LQ.sel[0]);
  const cell = first ? ('J' + (first.ri + (LQ.hi || 0) + 2)) : 'column J';
  info('lq-paste-info', `Copied ${lines.length} rows · ${nAcc} agreed → J="agree" + K=final translation. Paste at cell ${cell} — it fills columns J and K. Column I is left untouched.`, 'good');
}
// Same as above, but writes the values into the ORIGINAL .xlsx bytes via zip-surgery (inject only
// columns I and J into the target sheet's XML, copy every other zip entry verbatim) and downloads
// it. Byte-identical to the original except the injected cells — no full re-serialize, so no
// _x000d_ newline mangling / lost formatting, and untouched tabs stay untouched. Only ACCEPTED rows
// are stamped; existing column-I notes are left alone (never injected over).
async function lqDownloadAgreeFixed(btn) {
  if (!LQ.rawBytes) { info('lq-paste-info', 'Load the .xlsx first — download needs the original file.', 'err'); return; }
  if (!LQ.sel.length) { info('lq-paste-info', 'Adjudicate a range first.', 'err'); return; }
  const tabName = ($('lq-tab') && $('lq-tab').value) || (LQ.workbook && LQ.workbook.SheetNames[0]) || '';
  try {
    const entries = zipEntries(LQ.rawBytes);
    const byName = {}; for (const e of entries) byName[e.name] = e;
    const getText = async (nm) => { const e = byName[nm]; if (!e) return null; const raw = e.method === 0 ? e.cdata : await zipInflateRaw(e.cdata); return new TextDecoder().decode(raw); };
    const wbx = await getText('xl/workbook.xml'), rels = await getText('xl/_rels/workbook.xml.rels');
    if (!wbx || !rels) throw new Error('workbook parts missing');
    const ne = tabName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ridM = wbx.match(new RegExp('<sheet[^>]*name="' + ne + '"[^>]*r:id="(rId\\d+)"')) || wbx.match(new RegExp('<sheet[^>]*r:id="(rId\\d+)"[^>]*name="' + ne + '"'));
    if (!ridM) throw new Error('sheet "' + tabName + '" not in workbook.xml');
    const tgtM = rels.match(new RegExp('Id="' + ridM[1] + '"[^>]*Target="([^"]+)"'));
    if (!tgtM) throw new Error('sheet relationship not found');
    const tgt = tgtM[1], sheetPath = tgt.charAt(0) === '/' ? tgt.slice(1) : (tgt.slice(0, 3) === 'xl/' ? tgt : 'xl/' + tgt);
    let xml = await getText(sheetPath);
    if (!xml) throw new Error('sheet xml missing: ' + sheetPath);
    const iCol = LQ.header.length - 1, jCol = iCol + 1, kCol = jCol + 1, hi = LQ.hi || 0;
    const jMap = {}, kMap = {}; let nAcc = 0;
    // Columns J ("agree") and K (the agreed Final translation) are the only things written; column I
    // is left completely untouched. Their headers let the Sheet → Starling section auto-find the agree
    // column and prefer the vetted final on re-upload (wbAutoMap XBench branch).
    jMap[hi + 1] = 'Validation feedback (from proofreader)';
    kMap[hi + 1] = 'Final translation';
    LQ.sel.forEach((n) => {
      const row = LQ.rows.find((x) => x.n === n), res = LQ.results[n];
      if (!row) return;
      const accepted = res ? lqAgreeState(res) : false; if (!accepted) return;
      nAcc++;
      const rowNum = hi + row.ri + 2;                    // 1-based sheet row of this record
      jMap[rowNum] = 'agree';
      const c = lqCells(res);
      kMap[rowNum] = c.final || row.ai || row.tgt;       // GPT's adjudicated final; fall back to Correct target, then current
    });
    let total = 0;
    { const r = injectCol(xml, zipColLetter(jCol), jMap); xml = r.xml; total += r.n; }
    { const r = injectCol(xml, zipColLetter(kCol), kMap); xml = r.xml; total += r.n; }
    xml = xml.replace(/(<dimension ref="[A-Z]+\d+:)([A-Z]+)(\d+"\s*\/?>)/, (m, a, endCol, b) => zipColGt(zipColLetter(kCol), endCol) ? a + zipColLetter(kCol) + b : m);
    const nb = new TextEncoder().encode(xml), te = byName[sheetPath];
    te.usize = nb.length; te.crc = crc32(nb); te.method = 8; te.cdata = await zipDeflateRaw(nb);
    const out = zipBuild(entries);
    const base = (LQ.fileName || 'lqa').replace(/\.xlsx?$/i, '');
    const fname = `${base} (J=agree, K=final).xlsx`;
    const url = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    info('lq-paste-info', `⬇ Downloaded "${fname}" — ${nAcc} agreed → J="agree", K=final translation (${total} cells). Byte-identical to the original except columns J/K; column I, notes & other tabs untouched.`, 'good');
  } catch (e) { info('lq-paste-info', 'Download failed: ' + ((e && e.message) || e), 'err'); }
}
function lqOnFile(input) {
  const f = input.files && input.files[0]; if (!f) return;
  input.value = '';
  if (/\.xlsx?$/i.test(f.name)) {                    // Excel workbook → read it, offer a tab picker
    const r = new FileReader();
    r.onload = () => {
      try {
        const wb = XLSX.read(new Uint8Array(r.result), { type: 'array' });
        LQ.workbook = wb; LQ.fileName = f.name; LQ.rawBytes = new Uint8Array(r.result);   // kept for style-preserving zip-surgery download
        const sel = $('lq-tab');
        sel.innerHTML = wb.SheetNames.map((n) => `<option>${esc(n)}</option>`).join('');
        const pick = wb.SheetNames.find((n) => wbTabIsLqaWithData(wb, n))    // real LQA columns + data
          || wb.SheetNames.find((n) => /sync|he[_-]?il|hebrew|^he$/i.test(n))
          || wb.SheetNames[0];
        sel.value = pick;
        $('lq-tab-row').hidden = false;
        lqLoadSheet();
      } catch (e) { info('lq-info', 'Could not read that .xlsx: ' + ((e && e.message) || e), 'err'); }
    };
    r.readAsArrayBuffer(f);
    return;
  }
  LQ.workbook = null; $('lq-tab-row').hidden = true;   // CSV/TSV/TXT → plain-text path (unchanged)
  const r = new FileReader();
  r.onload = () => { $('lq-input').value = r.result; if (/\.csv$/i.test(f.name)) $('lq-delim').value = 'csv'; else if (/\.(tsv|tab)$/i.test(f.name)) $('lq-delim').value = 'tsv'; lqLoad(); };
  r.readAsText(f);
}
// Load the currently-selected xlsx tab into the adjudication queue.
function lqLoadSheet() {
  if (!LQ.workbook) return;
  const name = $('lq-tab').value, ws = LQ.workbook.Sheets[name];
  if (!ws) { info('lq-info', 'That tab is gone — reload the workbook.', 'err'); return; }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
  $('lq-input').value = '';                            // xlsx wins; keep the paste box clear
  lqLoad(rows);
  const n = LQ.rows ? LQ.rows.length : 0;
  info('lq-info', `Tab "${name}" (${LQ.fileName}) · ${n} row(s)${LQ.langFiltered ? ` — Hebrew only, ${LQ.langFiltered} other-language rows hidden` : ''}. Switch tabs above to pick another, or check the mapping below.`, 'good');
}
// ══════════ SHEET → STARLING WRITE-BACK (Mode 3) ═══════════════════════════
// Ingest the adjudicated sheet (xlsx/csv/paste), build a queue of Valid=Yes rows
// (Key + Final Translation), then per key: filter All tasks by key (en→he, HARD
// RELOAD — the URL param only applies on a real load), open the task, read the
// live segment, write the Final Translation, and proofread-confirm that one row.
// It guards on source-match and shows live-vs-sheet before every write. NEVER submits.
const WB = { header: [], records: [], map: {}, rows: [], queue: [], filter: 'todo', workbook: null, tabNames: [], engine: 'api', index: new Map(), indexTabs: [], lqa: false, xbench: false, sheetName: '', fileName: '', rawBytes: null };

// Join normaliser for sheet-source ↔ live-source comparison. The API returns the TRUE
// characters, and real content uses fullwidth punctuation ("Man United defender｜…") and
// trailing spaces — both visually identical to their ASCII/absent counterparts. Fold
// fullwidth→ASCII, unify quotes/dashes, collapse whitespace, trim.
const wbFold = (s) => String(s == null ? '' : s)
  // Unify EVERY apostrophe / prime / quote / dash variant a "smart" editor or paste can
  // produce (Excel autocorrect, Win-1252 mojibake, acute, backtick, Hebrew geresh,
  // fullwidth via NFKC) so a source that LOOKS identical is not flagged "source
  // mismatch" over an invisible punctuation swap or a zero-width / bidi character.
  .replace(/[\u2018\u2019\u201A\u201B\u2032\u02B9\u02BB\u02BC\u02BD\u02C8\u0060\u00B4\u05F3\uA78B\uA78C\u0091\u0092]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F\u2033\u3003\u05F4\u00AB\u00BB\u0093\u0094]/g, '"')
  .replace(/[\u2010-\u2015\u2212\u2043\uFF0D]/g, '-')
  .normalize('NFKC')                                                      // fullwidth->ASCII, compatibility forms
  .replace(/[\u0300-\u036F]/g, '')                                       // strip Latin combining accents (match only)
  .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '') // soft hyphen, zero-width, bidi marks
  .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')    // any Unicode space -> ASCII space
  .replace(/\s+/g, ' ')
  .trim();

// Index EVERY sheet tab: key → [{tab,row,source,valid,final}]. A key commonly exists at
// several source revisions, each in a different sync tab (7.8/7.10/7.15/7.17) and each
// matching a different Starling task. Indexing all tabs turns "which revision is this?"
// from guesswork into a lookup.
function wbBuildIndex() {
  WB.index = new Map(); WB.indexTabs = [];
  if (!WB.workbook) return;                       // pasted/CSV input → no cross-tab index
  for (const name of WB.workbook.SheetNames) {
    const ws = WB.workbook.Sheets[name]; if (!ws) continue;
    let rows;
    try { rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false }); } catch (e) { continue; }
    if (!rows || !rows.length) continue;
    let hi = rows.findIndex((r) => r.some((c) => /key/i.test(c)) && r.some((c) => /valid|final/i.test(c)));
    if (hi < 0) hi = rows.findIndex((r) => r.some((c) => /source|target|key/i.test(c)));
    if (hi < 0) continue;
    const header = rows[hi].map((c) => String(c).trim());
    const m = wbAutoMap(header);
    if (m.key < 0 || m.src < 0) continue;
    // CRITICAL: keep only Hebrew rows. Per-locale tabs (ko_KR / km_KH / jv_ID) carry the
    // SAME keys and the SAME English sources but foreign-language finals — indexing them
    // would let a Korean final match a Hebrew segment and get written. Tabs with a
    // Language column are filtered per row; tabs without one are judged by tab name, and
    // anything not clearly Hebrew is skipped wholesale.
    // The LQA report is a Hebrew-only file whose data tab ("All") isn't name-tagged he — always
    // index the tab the user actually loaded, so its keys resolve instead of coming back "norev".
    // Index the tab if it's the loaded LQA tab OR its own header self-identifies as an LQA
    // report (independent of the tab selector / WB.lqa — the data tab "All" matches no locale
    // name, so name-matching alone dropped it and the index came back empty).
    const isLoadedLqaTab = (WB.lqa && name === WB.sheetName) || wbIsLqaReport(header);
    if (!isLoadedLqaTab && m.lang < 0 && !/he[_-]?il|hebrew|^he$|\bhe\b|sync/i.test(name)) { WB.indexTabs.push(`${name}:skipped(non-he)`); continue; }
    const g = (r, i) => (i >= 0 && i < r.length) ? String(r[i]).trim() : '';
    let n = 0, dropped = 0;
    rows.slice(hi + 1).forEach((r, idx) => {
      const key = g(r, m.key), src = g(r, m.src);
      if (!key || !src) return;
      const lang = g(r, m.lang);
      if (!isLoadedLqaTab && m.lang >= 0 && !/^he|hebrew/i.test(lang)) { dropped++; return; }   // he rows only (never drop on the loaded LQA tab — it's single-language)
      const final = g(r, m.final);
      // LQA: you adjudicate per card (Write = agree), so any row with a Suggested fix is a
      // candidate — don't gate on Column I being pre-filled with "agree". Otherwise use Valid.
      const valid = isLoadedLqaTab ? !!final : wbIsYes(g(r, m.valid));
      if (!WB.index.has(key)) WB.index.set(key, []);
      WB.index.get(key).push({ tab: name, row: hi + 2 + idx, source: src, valid, final });
      n++;
    });
    if (n || dropped) WB.indexTabs.push(`${name}:${n}` + (dropped ? ` (+${dropped} non-he dropped)` : ''));
  }
}
const WB_FIELDS = [['key', 'Key'], ['valid', 'Valid (Y/N)'], ['final', 'Final Translation'], ['src', 'Source (EN)'], ['tgt', 'Current target'], ['lang', 'Language'], ['updated', 'Updated on Starling']];
const STAR_KEY_URL = 'https://starling.bytedance.com/#/all-task?pageNum=1&pageSize=10&progress=all&translateTypeList=%5B%5D&sortType=1&order=0&sourceLocales=en&targetLocales=he-IL&textKeys=';
const CS_EXPECT = 40;   // must match content.js CS_VERSION

// Direct call surface — invokes the page's window.__wb.* via chrome.scripting.executeScript.
// This bypasses chrome.runtime messaging entirely, so a stale/duplicate content-script
// listener can never hijack or mask the response. Reads whatever version is actually loaded.
async function wbCall(type, payload) {
  const t = await wbActiveTab();
  if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) throw new Error('Open the Starling tab.');
  let out;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: t.id },
      func: async (type, payload, expect) => {
        const api = window.__wb;
        if (!api || api.ver !== expect) return { __noapi: true, ver: api && api.ver };
        if (type === 'WB_CTX') return await api.ctx();
        if (type === 'WB_OPEN') return api.open ? await api.open(payload.taskId) : { ok: false, error: 'open not in this content script' };
        if (type === 'WB_FIND') return await api.find(payload.key, payload.expectSource);
        if (type === 'WB_WRITE') return await api.write(payload.edit || payload);
        if (type === 'API_TASK') return await api.apiTask(payload.taskId);
        if (type === 'API_TASKS') return await api.apiTasks(payload.key);
        if (type === 'API_CONFIRM') return await api.apiConfirm(payload);
        if (type === 'WB_REVEAL') return api.reveal ? await api.reveal(payload.seg) : false;
        if (type === 'WB_WRITE_SEG') return api.writeSeg ? await api.writeSeg(payload) : { ok: false, reason: 'writeSeg not in this content script' };
        return { __noapi: true };
      },
      args: [type, payload || {}, CS_EXPECT]
    });
    out = r && r.result;
  } catch (e) { throw new Error('Could not reach the Starling page — reload the extension, then Ctrl+R the page.'); }
  if (out && out.__noapi) throw new Error(`Current script not loaded (page has v${out.ver == null ? '—' : out.ver}, need v${CS_EXPECT}) — reload the extension, then Ctrl+R the page.`);
  return out;
}
// Make sure the ACTIVE Starling tab is running the current content script. If it's stale (or
// missing — e.g. a tab opened before an update), re-inject content.js via chrome.scripting so
// the tab self-heals with no page reload. Only warns if injection itself fails.
async function wbEnsureFresh(i) {
  const st = () => WB.queue[i] && WB.queue[i].status;
  const t = await wbActiveTab();
  if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) {
    wbSetStatus(i, st(), 'Make the Starling task tab the active/frontmost tab, then retry.'); return false;
  }
  // Read the page's DIRECT API version (window.__wb.ver) — no messaging, so a stale or
  // duplicate listener can't interfere. If it's not current, re-inject content.js (which
  // cleanly replaces the previous version via __scCleanup) and read again.
  const readVer = async () => {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => (window.__wb && window.__wb.ver) || null });
      return r && r.result;
    } catch (e) { return null; }
  };
  let ver = await readVer();
  if (ver !== CS_EXPECT) {
    try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }); } catch (e) {}
    await wbSleep(300);
    ver = await readVer();
  }
  if (ver !== CS_EXPECT) {
    wbLog(`[freshness] tab#${t.id} ${t.url.split('#')[0]} → __wb.ver=${ver == null ? 'none' : ver}, need ${CS_EXPECT}`);
    wbSetStatus(i, st(), `⚠ Couldn't load the current script here (page has v${ver == null ? '—' : ver}). Reload the extension at chrome://extensions, then Ctrl+R this Starling page.`);
    return false;
  }
  return true;
}
const wbNorm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const wbSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function wbLog(...a) { const el = $('wb-log'); if (!el) return; el.textContent += (el.textContent ? '\n' : '') + a.join(' '); el.scrollTop = el.scrollHeight; }

function wbReadFile(input) {
  const f = input.files && input.files[0]; if (!f) return;
  const isXlsx = /\.x(lsx|ls)$/i.test(f.name);
  const r = new FileReader();
  r.onload = () => {
    try {
      if (isXlsx) {
        if (typeof XLSX === 'undefined') { info('wb-info', 'xlsx reader not loaded — reload the extension.', 'err'); return; }
        const wb = XLSX.read(new Uint8Array(r.result), { type: 'array' });
        WB.workbook = wb; WB.tabNames = wb.SheetNames; WB.fileName = f.name; WB.rawBytes = new Uint8Array(r.result);
        const sel = $('wb-tab'); sel.innerHTML = wb.SheetNames.map((n) => `<option>${esc(n)}</option>`).join('');
        // Prefer the tab whose HEADER is an LQA report with data — the TikTok report's data tab
        // is named "All", which no Hebrew name-pattern matches, so name-matching alone left the
        // selector on tab 1 ("Issue mapping") → wrong WB.lqa/sheetName → empty index. Fall back
        // to a Hebrew-named tab for non-LQA files.
        const lqaTab = wb.SheetNames.find((n) => wbTabIsLqaWithData(wb, n));
        const heTab = wb.SheetNames.find((n) => /he[_-]?il|hebrew|^he$/i.test(n)) || wb.SheetNames.find((n) => /\bhe\b/i.test(n));
        const pick = lqaTab || heTab;
        if (pick) sel.value = pick;
        $('wb-tab-row').hidden = false;
        info('wb-info', `Workbook "${f.name}" · ${wb.SheetNames.length} tab(s).${lqaTab ? ` LQA data tab "${lqaTab}" auto-selected —` : ' Pick the tab, then'} click Load.`, 'good');
      } else {
        WB.workbook = null; WB.fileName = ''; WB.rawBytes = null; $('wb-tab-row').hidden = true;
        $('wb-input').value = r.result;
        info('wb-info', `Loaded ${f.name}. Click Load.`, 'good');
      }
    } catch (e) { info('wb-info', 'Could not read file: ' + e.message, 'err'); }
  };
  if (isXlsx) r.readAsArrayBuffer(f); else r.readAsText(f);
  input.value = '';
}
// TikTok interior-LQA report layout (the July combined file): the reviewer decides
// agree/disagree and writes "agree" in "Validation feedback (from proofreader)" (col I).
// Columns: Key | Source | Before translation | Suggested translation | Error category |
// Sub category | Severity | LQA comments | Validation feedback (from proofreader) | …
// The ORIGINAL LQA template ("Suggested Translation" + a "Before"/comment column). Its columns
// map differently (below), so keep a narrow check for that mapping branch only.
function wbIsOldLqaFormat(header) {
  const h = header.map((x) => String(x).toLowerCase());
  const has = (re) => h.some((x) => re.test(x));
  return has(/suggested translation/) && has(/before translation|lqa comment|validation feedback/);
}
// XBench / CAT QA report exported from the ⚖️ Feishu LQA tab with per-card "Agree" (column J).
// Columns: (lang) | SrcText | TgtText | CorrectTarget | ErrorType | ErrorLevel | ErrorComment |
// keys | (reviewer status "fixed") | Validation feedback (from proofreader) ← "agree".
// Writing an agreed row means pushing its CorrectTarget (the fix you agreed to) into Starling.
function wbIsXbenchReport(header) {
  const h = header.map((x) => String(x).toLowerCase());
  const has = (re) => h.some((x) => re.test(x));
  return has(/src\s*text/) && has(/tgt\s*text/) && has(/correct\s*target/);
}
// Is this an adjudicated LQA report at all? Broadened to also recognize the CURRENT TikTok
// format — a "Valid (Y/N)" column plus a "Final Translation" column (what the linguist fills).
// Drives WB.lqa (the ✏ Edit note→Column-I area + stamping); mapping still branches on format.
function wbIsLqaReport(header) {
  const h = header.map((x) => String(x).toLowerCase());
  const has = (re) => h.some((x) => re.test(x));
  return wbIsOldLqaFormat(header) || wbIsXbenchReport(header) || (has(/\bvalid\b/) && has(/final translation/));
}
// True if a workbook tab's own header is an LQA report AND it has at least one data row.
// Used to auto-select the data tab on load (its name — e.g. "All" — matches no locale pattern).
function wbTabIsLqaWithData(wb, name) {
  try {
    const ws = wb.Sheets[name]; if (!ws) return false;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
    if (!rows || rows.length < 2) return false;
    let hi = rows.findIndex((r) => r.some((c) => /key/i.test(c)) && r.some((c) => /valid|final|suggested/i.test(c)));
    if (hi < 0) return false;
    if (!wbIsLqaReport(rows[hi].map((c) => String(c).trim()))) return false;
    return rows.slice(hi + 1).some((r) => r.some((c) => String(c).trim().length));   // has data
  } catch (e) { return false; }
}
function wbAutoMap(header) {
  const used = new Set(), map = {};
  const find = (re) => { for (let i = 0; i < header.length; i++) { if (used.has(i)) continue; if (re.test(header[i])) { used.add(i); return i; } } return -1; };
  if (wbIsOldLqaFormat(header)) {
    map.key   = find(/^key$|\bkey\b/i);
    map.src   = find(/^source$|source/i);                 // first "Source" (col B), not the far-right "Source"
    map.tgt   = find(/before translation|^before/i);      // current Hebrew = the "Before"
    map.final = find(/suggested translation|suggest/i);   // the LQA fix to write into Starling
    map.valid = find(/validation feedback/i);             // col I (proofreader) — your "agree"
    map.note  = map.valid;                                // old template's Column-I note target
    map.lang  = find(/^lang(uage)?$/i);   // exact "Language"/"Lang" only — NOT "Validation feedback (from Language Leads)"
    map.updated = find(/updated on starling/i);           // usually absent on the old template → -1
    return map;
  }
  if (wbIsXbenchReport(header)) {                          // ⚖️ Feishu LQA export → agree in column J
    map.key   = find(/^keys?$|\bkeys?\b/i);               // "keys"
    map.src   = find(/src\s*text|^source$|source/i);      // "SrcText"
    map.tgt   = find(/tgt\s*text|^target$|target/i);      // "TgtText" (the current Hebrew)
    map.final = find(/final translation/i);               // column K = the vetted final (preferred)…
    if (map.final < 0) map.final = find(/correct\s*target/i);   // …else fall back to "CorrectTarget"
    map.valid = find(/validation feedback|proofread|^agree$|\bagree\b/i);   // column J = "agree"
    map.note  = map.valid;
    map.lang  = find(/^lang(uage)?$/i);                   // header-less locale col (A) stays unmapped → he-only file
    map.updated = -1;
    return map;
  }
  map.key = find(/^key$|\bkey\b|键|鍵/i);
  map.final = find(/final/i);                                  // "Final Translation (only for valid…)"
  map.valid = find(/valid/i);
  map.src = find(/source|原文/i);
  map.tgt = find(/suggest/i); map.tgt = find(/^target$|\btarget\b|译文|譯文/i) >= 0 ? find(/^target$|\btarget\b|译文|譯文/i) : map.tgt;
  map.lang = find(/^lang|language|语言|語言/i);
  // Note target for the ✏ Edit → Column-I stamp on a CURRENT-format LQA sheet: the linguist's
  // "Comments" column (exact — NOT "ErrorComment"). Never the Valid column (that holds Y/N).
  // Left -1 on non-LQA sheets; wbStampForKey falls back safely.
  map.note = find(/^comments?$/i);
  // "Updated on Starling" (Y/N) is its own column: on every successful write we stamp it "Yes"
  // (separate from the note/Comments stamp), so the exported sheet records what you pushed.
  map.updated = find(/updated on starling/i);
  return map;
}
function wbLoad() {
  let rows;
  if (WB.workbook) {
    const name = ($('wb-tab').value) || WB.tabNames[0];
    const ws = WB.workbook.Sheets[name];
    if (!ws) { info('wb-info', 'Pick a sheet tab.', 'err'); return; }
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
  } else {
    const text = $('wb-input').value;
    if (!text.trim()) { info('wb-info', 'Load a file or paste rows first.', 'err'); return; }
    const delim = text.indexOf('\t') >= 0 ? '\t' : ',';
    rows = lqSplitTable(text, delim).filter((r) => r.length);
  }
  if (!rows || !rows.length) { info('wb-info', 'Nothing parsed.', 'err'); return; }
  let hi = rows.findIndex((r) => r.some((c) => /key/i.test(c)) && r.some((c) => /valid|final/i.test(c)));
  if (hi < 0) hi = rows.findIndex((r) => r.some((c) => /source|target|key/i.test(c)));
  if (hi < 0) hi = 0;
  WB.header = rows[hi].map((c) => String(c).trim());
  WB.records = rows.slice(hi + 1).filter((r) => r.some((c) => String(c).trim().length));
  if (!WB.records.length) { info('wb-info', 'Header found but no data rows below it.', 'err'); return; }
  WB.map = wbAutoMap(WB.header);
  WB.lqa = wbIsLqaReport(WB.header);
  WB.xbench = wbIsXbenchReport(WB.header);   // ⚖️ Feishu LQA "agree" export → gate on column J
  WB.sheetName = WB.workbook ? (($('wb-tab').value) || WB.tabNames[0]) : '';
  wbBuildRowObjs(); wbRenderMap(); wbBuildIndex();
  $('wb-map-card').hidden = false; $('wb-build-card').hidden = false;
  $('wb-queue-card').hidden = true; $('wb-queue').innerHTML = ''; if ($('wb-log')) $('wb-log').textContent = '';
  if ($('wb-lqa-row')) $('wb-lqa-row').hidden = !WB.lqa;                 // "queue all with a fix" toggle
  // XBench "agree" export → default to agree-only (queue just the rows you agreed to = column J).
  // Interior-LQA reports keep the former default (queue every changed row, review each). Either
  // way the toggle stays, so both flows remain selectable.
  if (WB.xbench && $('wb-lqa-all')) $('wb-lqa-all').checked = false;
  if ($('wb-export')) $('wb-export').hidden = !(WB.lqa && WB.workbook);  // export needs the original .xlsx
  const idxNote = WB.index.size
    ? ` · cross-tab index: ${WB.index.size} keys from ${WB.indexTabs.join(', ')}`
    : ' · no cross-tab index (paste/CSV input — API engine will match against this tab only)';
  const lqaNote = WB.xbench
    ? ' · ⚖️ Feishu LQA export detected — key→keys, fix→Final translation (col K, else CorrectTarget), gating on column J="agree" (untick the box below to queue every row instead).'
    : (WB.lqa ? ' · 📋 LQA report detected — mapped Before→current, Suggested→fix, Column I→"agree".' : '');
  info('wb-info', `Loaded ${WB.rows.length} rows (header row ${hi + 1})${lqaNote}${idxNote}. Check the mapping, then build the queue.`, 'good');
}
function wbBuildRowObjs() {
  const m = WB.map, g = (r, i) => (i >= 0 && i < r.length) ? String(r[i]).trim() : '';
  WB.rows = WB.records.map((r, idx) => ({ n: idx + 1, key: g(r, m.key), valid: g(r, m.valid), final: g(r, m.final), src: g(r, m.src), tgt: g(r, m.tgt), lang: g(r, m.lang) }));
}
function wbRenderMap() {
  const wrap = $('wb-map'); if (!wrap) return;
  const opts = (sel) => ['<option value="-1">(none)</option>'].concat(WB.header.map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(h || ('col ' + (i + 1)))}</option>`)).join('');
  wrap.innerHTML = WB_FIELDS.map(([f, label]) => `<div><label>${label}</label><select data-f="${f}">${opts(WB.map[f])}</select></div>`).join('');
  wrap.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => { WB.map[s.dataset.f] = parseInt(s.value, 10); wbBuildRowObjs(); info('wb-info', 'Mapping updated · ' + WB.rows.length + ' rows.', 'good'); }));
}
function wbIsYes(v) { return /^(yes|y|valid|true|1|✓|agree|agreed|approve|approved|ok|👍)$/i.test(String(v == null ? '' : v).trim()); }
function wbBuild() {
  if (!WB.rows.length) { info('wb-build-info', 'Load rows first.', 'err'); return; }
  // LQA mode: an interior-LQA report isn't pre-adjudicated — YOU decide agree/disagree. So by
  // default queue EVERY row that has a suggested fix which actually changes the target (you still
  // approve each write). Untick to fall back to the normal gate (only "agree"/valid rows).
  const lqaAll = WB.lqa && $('wb-lqa-all') && $('wb-lqa-all').checked;
  const byKey = new Map();
  let skipped = 0, notHe = 0, notYes = 0, nochange = 0;
  for (const r of WB.rows) {
    if (r.lang && !/^he|hebrew/i.test(r.lang)) { notHe++; continue; }   // multi-language tabs → he only
    if (lqaAll) {
      if (!r.key || !r.final) { skipped++; continue; }
      if (wbNorm(r.final) === wbNorm(r.tgt)) { nochange++; continue; }  // Suggested == Before → nothing to change
    } else {
      if (!wbIsYes(r.valid)) { notYes++; continue; }
      if (!r.key || !r.final) { skipped++; continue; }
    }
    if (!byKey.has(r.key)) byKey.set(r.key, { key: r.key, final: r.final, src: r.src, rows: [r.n], conflict: false });
    else { const e = byKey.get(r.key); e.rows.push(r.n); if (wbNorm(e.final) !== wbNorm(r.final)) e.conflict = true; }
  }
  WB.queue = [...byKey.values()].map((e) => ({
    key: e.key, final: e.final, src: e.src, rows: e.rows, conflict: e.conflict,
    status: e.conflict ? 'conflict' : 'todo', note: e.conflict ? 'Conflicting Final Translations for this key across rows — resolve in the sheet, then reload.' : '',
    live: null, decision: null
  }));
  const conflicts = WB.queue.filter((q) => q.conflict).length;
  WB.filter = 'todo'; wbRenderQueue();
  $('wb-queue-card').hidden = false;
  if ($('wb-export')) $('wb-export').hidden = !(WB.lqa && WB.workbook);
  const tail = (skipped ? ` · ${skipped} missing key/fix` : '') + (nochange ? ` · ${nochange} no-change skipped` : '') + (notYes ? ` · ${notYes} not "agree"` : '') + (notHe ? ` · ${notHe} non-he skipped` : '');
  info('wb-build-info', `Queue: ${WB.queue.length} key(s)` + (conflicts ? ` · ⚠ ${conflicts} conflict` : '') + tail, conflicts ? 'err' : 'good');
  wbRestoreProgress();   // re-mark keys written in a previous session (and re-stamp their Column I)
}
// Stamp "agree" into Column I for every sheet row carrying `key` whose cell is still empty.
// Called on each successful Write + confirm (LQA mode) so the in-memory workbook always mirrors
// your decisions; never clobbers a comment you typed yourself. Returns the number of cells set.
// (Browsers can't silently overwrite the file on disk — the actual .xlsx download is the Export
// button. Because this keeps the workbook current, Export always reflects everything written.)
// Generalized: stamp `note` (defaults to "agree") into Column I for every row with this key.
// `overwrite` replaces an existing value (used when you type an explicit note — your note should
// win over an earlier "agree"); without it, only empty cells are filled (never clobbers a comment).
function wbStampForKey(key, note, overwrite) {
  if (typeof XLSX === 'undefined' || !WB.workbook || !WB.sheetName) return 0;
  const ws = WB.workbook.Sheets[WB.sheetName];
  const colI = (WB.map.note != null && WB.map.note >= 0) ? WB.map.note : WB.map.valid, colKey = WB.map.key;
  if (!ws || !ws['!ref'] || colI == null || colI < 0 || colKey == null || colKey < 0) return 0;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const want = String(key == null ? '' : key).trim();
  const val = (note != null && String(note).trim() !== '') ? String(note).trim() : 'agree';
  let n = 0;
  for (let R = range.s.r; R <= range.e.r; R++) {
    const kc = ws[XLSX.utils.encode_cell({ r: R, c: colKey })];
    if (!kc || String(kc.v == null ? '' : kc.v).trim() !== want) continue;
    const addr = XLSX.utils.encode_cell({ r: R, c: colI });
    const cur = ws[addr] && ws[addr].v;
    if (overwrite || cur == null || String(cur).trim() === '') { ws[addr] = { t: 's', v: val }; n++; }
  }
  return n;
}
function wbStampAgreeForKey(key) { return wbStampForKey(key, 'agree', false); }
// Stamp the "Updated on Starling" column = "Yes" for every row of this key. Called on each
// successful write (a write always means the row was updated on Starling). Overwrites, so a
// pre-existing "No" flips to "Yes". No-op when the column isn't mapped. Returns rows stamped.
function wbStampUpdatedForKey(key) {
  if (typeof XLSX === 'undefined' || !WB.workbook || !WB.sheetName) return 0;
  const col = WB.map.updated, colKey = WB.map.key;
  if (col == null || col < 0 || colKey == null || colKey < 0) return 0;
  const ws = WB.workbook.Sheets[WB.sheetName];
  if (!ws || !ws['!ref']) return 0;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const want = String(key == null ? '' : key).trim();
  let n = 0;
  for (let R = range.s.r; R <= range.e.r; R++) {
    const kc = ws[XLSX.utils.encode_cell({ r: R, c: colKey })];
    if (!kc || String(kc.v == null ? '' : kc.v).trim() !== want) continue;
    ws[XLSX.utils.encode_cell({ r: R, c: col })] = { t: 's', v: 'Yes' };
    n++;
  }
  return n;
}
// Stamp the workbook for one written key. Distinguishes the two sheet types by their columns:
//   • SYNC sheet (has an "Updated on Starling" column) → stamp it "Yes". The default "agree"
//     is NOT written (only an explicit ✏ note goes to Comments).
//   • LQA report (no "Updated on Starling") → stamp "agree" (or your note) into Validation
//     feedback / Column I, as before.
function wbStampRow(q) {
  if (!(WB.lqa && WB.workbook)) return;
  const hasUpdated = WB.map.updated != null && WB.map.updated >= 0;
  const explicitNote = !!(q && q.noteText && String(q.noteText).trim());
  if (explicitNote || !hasUpdated) {
    const ci = wbColIFor(q);
    const st = wbStampForKey(q.key, ci.note, ci.overwrite);
    if (st) wbLog(`📋 Column I → "${ci.note}" for ${q.key} (${st} row) — Export form to download`);
  }
  if (hasUpdated) {
    const su = wbStampUpdatedForKey(q.key);
    if (su) wbLog(`✅ "Updated on Starling" → Yes for ${q.key} (${su} row)`);
  }
}
// Shared post-write bookkeeping on an LQA workbook: stamp the row, then persist.
function wbMarkWritten(q) {
  if (!(WB.lqa && WB.workbook)) return;
  q.agreed = true;
  wbStampRow(q);
  wbPersistProgress();
}
// The Column-I value for a card: an explicit note wins, else "agree". Returns { note, overwrite }.
function wbColIFor(q) {
  const note = q && q.noteText && String(q.noteText).trim();
  return note ? { note, overwrite: true } : { note: 'agree', overwrite: false };
}
// ---- progress persistence (survives panel close / re-load of the SAME report) ----------
// The in-memory workbook (and its "agree" stamps) dies when the side panel closes. So persist
// the set of written keys (+ their task ids) per file to chrome.storage.local, and on the next
// Build restore them: mark those cards done and re-stamp Column I, so Export still reflects
// everything you did last session. Scoped by file name + sheet so a different report can't collide.
// Progress key: fingerprint the report's CONTENT (sheet + its set of keys), not the filename —
// so the original and any exported/with-agrees copy of the same report share one record, and
// skips restore no matter which file you re-load. wbFileSigLegacy is the old filename-based key,
// still read for backward-compat and migrated on first restore.
function wbFileSig() {
  const keys = (WB.rows || []).map((r) => String((r && r.key) || '')).filter(Boolean).sort();
  let h = 5381; const s = keys.join('');
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return (WB.sheetName || '') + '#' + keys.length + '#' + h.toString(36);
}
function wbFileSigLegacy() { return (WB.fileName || '') + '|' + (WB.sheetName || ''); }
// Persist BOTH written keys (+task ids) and skipped keys, per file. Called after each Write AND
// after each Skip, so the stored record always mirrors the queue. Stored shape:
//   wbProgress[fileSig] = { done: { key: [taskIds] }, skipped: [keys] }
async function wbPersistProgress() {
  if (!WB.lqa || !WB.fileName) return;
  const done = {}, skipped = [], notes = {}, edits = {};
  for (const q of WB.queue) {
    if (q.doneTasks && q.doneTasks.length) done[q.key] = q.doneTasks.slice();
    else if (q.status === 'done') skipped.push(q.key);   // marked done without a write = skipped
    if (q.noteText && q.noteText.trim()) notes[q.key] = q.noteText;   // your Column-I note (survives reopen)
    if (q.editText && q.editText.trim()) edits[q.key] = q.editText;   // your edited correction
  }
  try { const all = await store.get('wbProgress', {}); all[wbFileSig()] = { done, skipped, notes, edits }; await store.set({ wbProgress: all }); } catch (e) {}
}
// Does the LOADED sheet already carry a non-empty Column I for this key? Lets progress ride
// along INSIDE the .xlsx: re-loading an exported/with-agrees file restores done-state with no
// storage at all (portable across machines).
function wbColIFilledForKey(key) {
  if (typeof XLSX === 'undefined' || !WB.workbook || !WB.sheetName) return false;
  const ws = WB.workbook.Sheets[WB.sheetName];
  // The "already done in the sheet" signal differs by report type:
  //   • SYNC sheet (has an "Updated on Starling" column) → THAT column being filled = written.
  //     Valid(Y/N) is filled for EVERY adjudicated row (Yes AND No), so it must NOT count as done —
  //     otherwise finishing adjudication makes the whole queue vanish. (bug fixed 2026-08-07)
  //   • old LQA report (no "Updated on Starling") → Column I (the agree/validation column) filled = done.
  //   • ⚖️ Feishu LQA "agree" export → column J "agree" is the QUEUE GATE ("write this"), NOT a
  //     done-marker, so it must never count as already-done — else the whole queue is pre-marked done
  //     and loses its Search/Check/Write actions. Done-ness here comes only from recorded writes.
  const hasUpdated = WB.map.updated != null && WB.map.updated >= 0;
  if (WB.xbench && !hasUpdated) return false;
  const colDone = hasUpdated ? WB.map.updated : WB.map.valid, colKey = WB.map.key;
  if (!ws || !ws['!ref'] || colDone == null || colDone < 0 || colKey == null || colKey < 0) return false;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const want = String(key == null ? '' : key).trim();
  for (let R = range.s.r; R <= range.e.r; R++) {
    const kc = ws[XLSX.utils.encode_cell({ r: R, c: colKey })];
    if (!kc || String(kc.v == null ? '' : kc.v).trim() !== want) continue;
    const vc = ws[XLSX.utils.encode_cell({ r: R, c: colDone })];
    if (vc && String(vc.v == null ? '' : vc.v).trim()) return true;
  }
  return false;
}
async function wbRestoreProgress() {
  if (!WB.lqa) return;
  let all; try { all = await store.get('wbProgress', {}); } catch (e) { all = {}; }
  // Read BOTH the content key and the legacy filename key, merging — so skips saved under an
  // older filename-based record still come back and get migrated to the content key below.
  const recs = [all && all[wbFileSig()], all && all[wbFileSigLegacy()]].filter(Boolean);
  let doneMap = {}, notesMap = {}, editsMap = {}; const skipSet = new Set();
  for (const rec of recs) {
    if (rec.done || rec.skipped || rec.notes || rec.edits) {
      Object.assign(doneMap, rec.done || {}); (rec.skipped || []).forEach((k) => skipSet.add(k));
      Object.assign(notesMap, rec.notes || {}); Object.assign(editsMap, rec.edits || {});
    } else Object.assign(doneMap, rec);   // old flat {key:[tasks]} = all-done
  }
  let nDone = 0, nSkip = 0, nFile = 0;
  for (const q of WB.queue) {
    if (q.status === 'conflict') continue;
    if (notesMap[q.key] != null) q.noteText = notesMap[q.key];   // restore your Column-I note / edit
    if (editsMap[q.key] != null) q.editText = editsMap[q.key];
    const tasks = doneMap[q.key];
    if (tasks && tasks.length) {
      q.doneTasks = tasks.slice(); q.status = 'done'; q.agreed = true; wbStampRow(q); nDone++;
    } else if (skipSet.has(q.key)) {
      q.status = 'done'; q.note = 'Skipped last session (not written).'; nSkip++;
    } else if (wbColIFilledForKey(q.key)) {
      q.status = 'done'; q.agreed = true; q.note = 'Already marked done in the sheet.'; nFile++;
    }
  }
  const parts = [];
  if (nDone) parts.push(`${nDone} written`);
  if (nFile) parts.push(`${nFile} already in the sheet`);
  if (nSkip) parts.push(`${nSkip} skipped`);
  if (parts.length) { wbRenderQueue(); info('wb-build-info', `↩ Restored progress: ${parts.join(' · ')} — marked done (switch to “All” to see them).`, 'good'); }
  if (recs.length) wbPersistProgress();   // re-save under the content key (migrates a legacy filename record)
}
// ---- in-browser xlsx zip-surgery (STYLE-PRESERVING export) ---------------------------------
// SheetJS mini rewrites the whole workbook and strips Excel styling. Instead we edit the ORIGINAL
// file's bytes: inflate only the target sheet's XML, inject inline-string cells into Column I,
// re-deflate that one entry, and copy every other entry's compressed bytes verbatim — so all
// formatting survives. Core (crc32/zipEntries/zipBuild/injectCol) is byte-for-byte the code
// verified in Node against the real report; only inflate/deflate use the browser streams here.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) { if (u32(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = u16(eocd + 10); let off = u32(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (u32(off) !== 0x02014b50) throw new Error('bad central header');
    const flag = u16(off + 8), method = u16(off + 10), crc = u32(off + 16);
    const csize = u32(off + 20), usize = u32(off + 24);
    const nameLen = u16(off + 28), extraLen = u16(off + 30), commentLen = u16(off + 32);
    const localOff = u32(off + 42);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, flag, method, crc, csize, usize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  for (const e of entries) {
    const lo = e.localOff;
    if (u32(lo) !== 0x04034b50) throw new Error('bad local header for ' + e.name);
    const dataStart = lo + 30 + u16(lo + 26) + u16(lo + 28);
    e.cdata = bytes.subarray(dataStart, dataStart + e.csize);
  }
  return entries;
}
function zipBuild(entries) {
  const enc = new TextEncoder(); const parts = []; let offset = 0; const central = [];
  for (const e of entries) {
    const nb = enc.encode(e.name);
    const lh = new Uint8Array(30 + nb.length); const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, (e.flag || 0) & ~0x8, true);
    dv.setUint16(8, e.method, true); dv.setUint32(14, e.crc, true);
    dv.setUint32(18, e.cdata.length, true); dv.setUint32(22, e.usize, true);
    dv.setUint16(26, nb.length, true); lh.set(nb, 30);
    parts.push(lh, e.cdata);
    const ch = new Uint8Array(46 + nb.length); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, (e.flag || 0) & ~0x8, true); cv.setUint16(10, e.method, true);
    cv.setUint32(16, e.crc, true); cv.setUint32(20, e.cdata.length, true); cv.setUint32(24, e.usize, true);
    cv.setUint16(28, nb.length, true); cv.setUint32(42, offset, true); ch.set(nb, 46);
    central.push(ch); offset += lh.length + e.cdata.length;
  }
  const cdStart = offset; let cdSize = 0; for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true);
  const all = [...parts, ...central, eocd]; let total = 0; for (const a of all) total += a.length;
  const out = new Uint8Array(total); let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
function zipXmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function zipColGt(a, b) { return a.length !== b.length ? a.length > b.length : a > b; }
function zipColLetter(idx) { let s = '', n = idx + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
function injectCol(xml, colLetter, stampMap) {
  let n = 0;
  const out = xml.replace(/(<row[^>]*\br="(\d+)"[^>]*>)([\s\S]*?)(<\/row>)/g, (m, head, rnum, body, tail) => {
    if (!(rnum in stampMap)) return m;
    const ref = colLetter + rnum;
    const existing = new RegExp('<c\\b[^>]*\\br="' + ref + '"[^>]*?(?:/>|>[\\s\\S]*?</c>)');
    const em = body.match(existing);
    let sAttr = '';
    if (em) { const sm = em[0].match(/^<c\b[^>]*?\ss="(\d+)"/); if (sm) sAttr = ' s="' + sm[1] + '"'; }
    const cell = `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${zipXmlEsc(stampMap[rnum])}</t></is></c>`;
    if (em) { body = body.replace(existing, cell); }
    else {
      let ins = body.length;
      const cellRe = /<c\b[^>]*\br="([A-Z]+)\d+"/g; let mm;
      while ((mm = cellRe.exec(body))) { if (zipColGt(mm[1], colLetter)) { ins = mm.index; break; } }
      body = body.slice(0, ins) + cell + body.slice(ins);
    }
    n++; return head + body + tail;
  });
  return { xml: out, n };
}
async function zipInflateRaw(bytes) { const ds = new DecompressionStream('deflate-raw'); return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer()); }
async function zipDeflateRaw(bytes) { const cs = new CompressionStream('deflate-raw'); return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer()); }

// Style-preserving export: inject the in-memory Column I values into the ORIGINAL file's bytes.
async function wbStyledExport(fname) {
  const entries = zipEntries(WB.rawBytes);
  const byName = {}; for (const e of entries) byName[e.name] = e;
  const getText = async (name) => { const e = byName[name]; if (!e) return null; const raw = e.method === 0 ? e.cdata : await zipInflateRaw(e.cdata); return new TextDecoder().decode(raw); };
  const wbx = await getText('xl/workbook.xml');
  const rels = await getText('xl/_rels/workbook.xml.rels');
  if (!wbx || !rels) throw new Error('workbook parts missing');
  const ne = WB.sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ridM = wbx.match(new RegExp('<sheet[^>]*name="' + ne + '"[^>]*r:id="(rId\\d+)"')) || wbx.match(new RegExp('<sheet[^>]*r:id="(rId\\d+)"[^>]*name="' + ne + '"'));
  if (!ridM) throw new Error('sheet "' + WB.sheetName + '" not in workbook.xml');
  const tgtM = rels.match(new RegExp('Id="' + ridM[1] + '"[^>]*Target="([^"]+)"'));
  if (!tgtM) throw new Error('sheet relationship not found');
  const tgt = tgtM[1]; const sheetPath = tgt.charAt(0) === '/' ? tgt.slice(1) : (tgt.slice(0, 3) === 'xl/' ? tgt : 'xl/' + tgt);
  const xml = await getText(sheetPath);
  if (!xml) throw new Error('sheet xml missing: ' + sheetPath);
  const ws = WB.workbook.Sheets[WB.sheetName];
  const range = XLSX.utils.decode_range(ws['!ref']);
  // Inject EVERY column the tool stamps, so both LQA-report stamps (Column I / Comments = "agree"/note)
  // AND sync-sheet stamps ("Updated on Starling" = Yes) survive. (Old bug: only WB.map.valid was
  // injected, so a sync sheet's "Updated on Starling" verdicts were silently dropped on export.)
  const cols = [...new Set([WB.map.valid, WB.map.note, WB.map.updated].filter((c) => c != null && c >= 0))];
  let outXml = xml, total = 0;
  for (const col of cols) {
    const stampMap = {};
    for (let R = range.s.r; R <= range.e.r; R++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: col })];
      const val = cell && cell.v != null ? String(cell.v).trim() : '';
      if (val) stampMap[R + 1] = val;
    }
    if (!Object.keys(stampMap).length) continue;
    const res = injectCol(outXml, zipColLetter(col), stampMap);
    outXml = res.xml; total += res.n;
  }
  const nb = new TextEncoder().encode(outXml);
  const te = byName[sheetPath];
  te.usize = nb.length; te.crc = crc32(nb); te.method = 8; te.cdata = await zipDeflateRaw(nb);
  const out = zipBuild(entries);
  const url = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return total;
}
function wbExportPlain(fname, count) {
  try { XLSX.writeFile(WB.workbook, fname.replace(/ with-agrees\.xlsx$/i, '_he_filled.xlsx')); info('wb-queue-info', `⬇ Exported (plain — Excel styling NOT preserved) · Column I = "agree" on ${count} key(s). To keep formatting, run make-deliverable.bat on the original + this file.`, 'good'); }
  catch (e) { info('wb-queue-info', 'Export failed: ' + e.message, 'err'); }
}
// Export orchestrator: re-stamp defensively, then produce the FORMATTED file in-browser
// (falls back to the plain SheetJS write only if the zip surgery isn't available/fails).
function wbExportForm() {
  if (typeof XLSX === 'undefined') { info('wb-queue-info', 'xlsx writer not loaded — reload the extension.', 'err'); return; }
  if (!WB.workbook || !WB.sheetName) { info('wb-queue-info', 'Export needs the original .xlsx (load the file, not pasted text).', 'err'); return; }
  const hasUpdated = WB.map.updated != null && WB.map.updated >= 0;
  const doneCol = hasUpdated ? WB.map.updated : WB.map.valid;   // sync → "Updated on Starling" · LQA → Column I
  if (doneCol == null || doneCol < 0 || WB.map.key == null || WB.map.key < 0) { info('wb-queue-info', 'The done column ("Updated on Starling" / Column I) or Key isn\'t mapped — fix the mapping.', 'err'); return; }
  // Re-stamp anything written THIS session first (sync → Updated=Yes · LQA → Column I=agree), then
  // gate on what's actually in that column — so a restored-from-sheet file still exports.
  for (const q of WB.queue) if (q.doneTasks && q.doneTasks.length) wbStampRow(q);
  let filled = 0;
  const ws0 = WB.workbook.Sheets[WB.sheetName];
  if (ws0 && ws0['!ref']) {
    const rg = XLSX.utils.decode_range(ws0['!ref']);
    for (let R = rg.s.r + 1; R <= rg.e.r; R++) { const c = ws0[XLSX.utils.encode_cell({ r: R, c: doneCol })]; if (c && c.v != null && String(c.v).trim()) filled++; }
  }
  if (!filled) { info('wb-queue-info', hasUpdated ? 'Nothing in "Updated on Starling" yet — write some fixes to Starling first.' : 'Nothing in Column I to export yet — write/agree to some rows first.', 'err'); return; }
  const base = WB.fileName ? WB.fileName.replace(/\.xlsx?$/i, '') : (WB.sheetName || 'LQA');
  const fname = base + ' with-agrees.xlsx';
  if (WB.rawBytes && typeof DecompressionStream !== 'undefined' && typeof CompressionStream !== 'undefined') {
    info('wb-queue-info', 'Building the formatted file…', 'good');
    wbStyledExport(fname)
      .then((n) => info('wb-queue-info', `⬇ Exported ${fname} — ${hasUpdated ? '"Updated on Starling" = Yes' : '"agree" in Column I'} stamped (${n} cell(s)), original formatting kept. Ready to submit.`, 'good'))
      .catch((e) => { wbLog('styled export failed: ' + (e && e.message)); info('wb-queue-info', 'Formatted export failed (' + (e && e.message) + ') — wrote a plain copy instead.', 'err'); wbExportPlain(fname, filled); });
  } else {
    wbExportPlain(fname, filled);
  }
}

// ---- orchestration (drive the active Starling tab across hard reloads) ----
async function wbActiveTab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }
async function wbWaitComplete(tabId, tries = 60) { for (let i = 0; i < tries; i++) { const t = await new Promise((res) => chrome.tabs.get(tabId, res)); if (t && t.status === 'complete') return true; await wbSleep(300); } return false; }
async function wbWaitScript(tabId, tries = 40) { for (let i = 0; i < tries; i++) { try { const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' }); if (r && r.ok) return true; } catch (e) {} await wbSleep(300); } return false; }
async function wbNav(url) {
  const t = await wbActiveTab();
  if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) throw new Error('Open a Starling tab in this window first.');
  await chrome.tabs.update(t.id, { url });
  await wbSleep(250);
  await chrome.tabs.reload(t.id);                 // hash-route param only applies on a real reload
  await wbWaitComplete(t.id); await wbSleep(700); await wbWaitScript(t.id);
  return t.id;
}
async function wbSend(msg) {
  const t = await wbActiveTab();
  if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) throw new Error('Open the Starling tab.');
  try { return await chrome.tabs.sendMessage(t.id, msg); }
  catch (e) { throw new Error('Content script not loaded — reload the Starling page.'); }
}
function wbSetStatus(i, status, note) { const q = WB.queue[i]; if (!q) return; if (status) q.status = status; if (note != null) q.note = note; wbRenderQueue(); }

async function wbSearch(i) {
  const q = WB.queue[i]; if (!q) return;
  wbLog('search ' + q.key); wbSetStatus(i, 'searching', 'Filtering All tasks by key (hard reload)…');
  try {
    await wbNav(STAR_KEY_URL + encodeURIComponent(q.key));
    let ctx = {}; try { ctx = await wbCall('WB_CTX'); } catch (e) {}
    const n = (ctx && ctx.matchCount) ? ` (~${ctx.matchCount} hit)` : '';
    // Auto-open the task by clicking its 👁 and navigating the same tab into the editor, so the
    // next step is just Check — but ONLY when exactly one task matches the key. If several match,
    // don't guess: just report the count and let the human pick the right 👁. Retry a few times —
    // right after the reload the React table may not have painted the eye rows yet.
    let op = null;
    for (let a = 0; a < 8; a++) {
      try { op = await wbCall('WB_OPEN', { taskId: q.taskId }); } catch (e) { op = { ok: false, error: e.message }; }
      if (op && (op.ok || !/still loading|no task rows/i.test(op.error || ''))) break;
      await wbSleep(400);
    }
    if (op && op.ok && op.count > 1) {                       // several tasks — don't auto-open
      wbSetStatus(i, 'searched', `${op.count} tasks match this key — open the right one with 👁, then Check.`);
      return;
    }
    if (op && op.ok && op.url) {                             // exactly one — open it (unchanged path)
      wbSetStatus(i, 'searching', `Opening task ${op.taskId}…`);
      try { await wbNav(op.url); } catch (e) {}
      wbSetStatus(i, 'searched', `Opened task ${op.taskId} — run Check to read the live segment.`);
      return;
    }
    wbSetStatus(i, 'searched', `Filtered All tasks by key${n}. ${op && op.error ? op.error + ' — ' : ''}Open the matching task with 👁, then Check.`);
  } catch (e) { wbSetStatus(i, 'todo', e.message); }
}
// Engine dispatch — the DOM path below is the proven v13 build, untouched. Flip the
// engine in ⚙️ Settings to fall straight back to it if the API path misbehaves.
async function wbCheck(i) { return WB.engine === 'api' ? wbCheckApi(i) : wbCheckDom(i); }
async function wbWriteOne(i) { return WB.engine === 'api' ? wbWriteApi(i) : wbWriteDom(i); }

async function wbCheckDom(i) {
  const q = WB.queue[i]; if (!q) return;
  if (!(await wbEnsureFresh(i))) return;
  wbSetStatus(i, 'checking', 'Reading the live segment…');
  try {
    const ctx = await wbCall('WB_CTX');
    if (ctx.page !== 'editor') { wbSetStatus(i, 'searched', `You're on "${ctx.page}". Open the task (👁) first, then Check.`); return; }
    const f = await wbCall('WB_FIND', { key: q.key, expectSource: q.src });
    if (!f || !f.found) {
      const clip = (s) => { s = String(s || ''); return s.length > 110 ? s.slice(0, 110) + '…' : s; };
      const rel = f && f.rel;
      q.live = {
        found: false, taskId: f && f.taskId, noSourceMatch: !!(f && f.noSourceMatch),
        ambiguous: !!(f && f.ambiguous), visible: (f && f.visible) || 0, sources: (f && f.sources) || []
      };
      q.decision = 'mismatch';
      const msg = f && f.noSourceMatch
        ? (rel && rel.kind === 'expanded'
          ? `⚠ Different revision of this key — the live source is your sheet source PLUS extra text, so writing would TRUNCATE the segment (you'd lose the extra). Live: "${clip(rel.live)}". Usually: Skip (the fix belongs to the other task), or edit by hand.`
          : rel && rel.kind === 'shortened'
            ? `⚠ Different revision of this key — the live source is only a FRAGMENT of your sheet source, so writing would add text this revision doesn't have. Live: "${clip(rel.live)}". Skip, or edit by hand.`
            : f.near
              ? `⚠ Same key, different revision — the sources differ only here: sheet ${f.near.sheet ? `"${clip(f.near.sheet)}"` : '(nothing)'} vs live ${f.near.live ? `"${clip(f.near.live)}"` : '(nothing)'}. The sheet's fix belongs to the other revision, so nothing was written. Usually: Skip.`
              : `⚠ The key IS here, but this task's source is a different string — almost always a different revision of the key, so the sheet's fix doesn't belong to it. Live source${f.visible === 1 ? '' : 's'}: ${(f.sources || []).map((s) => `"${clip(s)}"`).join(' · ') || '(none read)'}. Compare with the Sheet source above: if they describe different text, Skip.`)
        : f && f.ambiguous
          ? `⚠ Key matched ${f.visible} segments and there's no sheet Source to disambiguate — map the Source column, or handle by hand.`
          : 'Segment not found in this task (0 rows after the key search). Is this the right task?';
      wbSetStatus(i, 'checked', msg); return;
    }
    q.live = { found: true, taskId: f.taskId, source: f.source, target: f.target, qaFlag: f.qaFlag };
    const already = wbNorm(f.target) === wbNorm(q.final);
    q.decision = already ? 'already' : 'ready';
    const tierNote = f.matchTier === 'normalized' ? ' — matched after normalizing quotes/emoji, so double-check it’s the right row'
      : f.matchTier === 'placeholder-stripped' ? ' — matched only after ignoring placeholders/{tags}, so double-check it’s the right row'
      : '';
    const note = already ? 'Live target already equals the Final Translation — nothing to write.'
      : `Ready — source matches (picked among ${f.visible} key hit${f.visible === 1 ? '' : 's'})${tierNote}; current target differs. Eyeball current-vs-final before writing.`;
    wbSetStatus(i, 'checked', note);
  } catch (e) { wbSetStatus(i, 'searched', e.message); }
}
async function wbWriteDom(i) {
  const q = WB.queue[i]; if (!q) return;
  if (!(q.live && q.live.found)) { wbSetStatus(i, q.status, 'Run Check first.'); return; }
  if (!(await wbEnsureFresh(i))) return;
  const confirm = $('wb-autoconfirm').checked;
  wbSetStatus(i, 'writing', 'Writing the Final Translation…');
  try {
    const text = (q.editText && q.editText.trim()) ? q.editText.trim() : q.final;
    const r = await wbCall('WB_WRITE', { edit: { key: q.key, text, confirm, expectSource: q.src } });
    if (!r || !r.ok) { wbSetStatus(i, 'checked', '⚠ ' + (r && r.reason || 'write failed')); return; }
    const tid = (q.live && q.live.taskId) || r.taskId || '?';
    q.doneTasks = q.doneTasks || [];
    if (!q.doneTasks.includes(tid)) q.doneTasks.push(tid);
    wbLog(`wrote ${q.key} @task ${tid}: "${r.after}"${r.confirmed ? ' [confirmed]' : ''}`);
    // A key can live in several tasks — DON'T mark the card fully done after one write.
    // Clear the live read so the next task must be Checked, and keep the buttons live so
    // you can Search → open another 👁 → Check → Write again. "Done" ends the card.
    q.live = null; q.decision = null; q.status = 'written';
    wbMarkWritten(q);
    q.note = `Wrote${r.confirmed ? ' + proofread-confirmed ✓' : ' (auto-confirm off / not found — confirm by hand)'} to task ${tid}. Same key in another task? Search again, open it with 👁, Check, Write. Click “Done” when every task is fixed. You resubmit each task.`;
    wbRenderQueue();
  } catch (e) { wbSetStatus(i, 'checked', e.message); }
}
// ---- API engine ----------------------------------------------------------
// Resolve the segments of one task against the cross-tab sheet index and return the
// best-ranked outcome. Shared by single-key Check and the batch Resolve-all walk.
const WB_RANK = { ready: 0, already: 1, invalid: 2, norev: 3 };
// Character-bigram Dice similarity on folded text — 1 = identical, 0 = nothing in common.
// Used ONLY to pick/explain the closest near-miss when no source matches exactly; it never
// decides whether to WRITE (that stays a strict equality on wbFold).
function wbBigrams(s) { const m = new Map(); const t = String(s || ''); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
function wbSim(a, b) {
  if (!a || !b) return 0; if (a === b) return 1;
  const A = wbBigrams(a), B = wbBigrams(b); let inter = 0, na = 0, nb = 0;
  A.forEach((v) => { na += v; });
  B.forEach((v) => { nb += v; });
  A.forEach((v, g) => { if (B.has(g)) inter += Math.min(v, B.get(g)); });
  return (na + nb) ? (2 * inter) / (na + nb) : 0;
}
// Compact word-level diff: which words are unique to each side (up to 4 each).
function wbWordDiff(sheet, live) {
  const sw = wbFold(sheet).split(/\s+/).filter(Boolean), lw = wbFold(live).split(/\s+/).filter(Boolean);
  const inS = new Set(sw), inL = new Set(lw);
  const onlyS = sw.filter((w) => !inL.has(w)).slice(0, 4).join(' ');
  const onlyL = lw.filter((w) => !inS.has(w)).slice(0, 4).join(' ');
  if (!onlyS && !onlyL) return '';
  return `differs: sheet «${onlyS || '—'}» vs live «${onlyL || '—'}»`;
}
function wbPickCandidate(key, segs, taskId) {
  const entries = WB.index.get(key) || [];
  const clip = (s) => { s = String(s || ''); return s.length > 100 ? s.slice(0, 100) + '…' : s; };
  let best = null;
  for (const s of segs) {
    // A key can appear in SEVERAL sheet tabs for the same source with conflicting verdicts
    // (e.g. a Valid=No row in "For Liat to check" AND the Valid=Yes row you queued from in a
    // sync tab). A plain .find() would grab whichever comes first — often the Valid=No one —
    // and wrongly mark a real fix as "skip". So among all source-matches, prefer the
    // ACTIONABLE row (valid + has a Final), then any valid row, then the first match.
    const matches = entries.filter((e) => wbFold(e.source) === wbFold(s.source));
    const hit = matches.find((e) => e.valid && e.final) || matches.find((e) => e.valid) || matches[0] || null;
    let verdict, why, sim = 1;
    if (!hit) {
      verdict = 'norev';
      // Explain the near-miss against the CLOSEST sheet source, so a split/revised segment
      // shows a coherent side-by-side instead of an unrelated sibling segment.
      let closest = null, sc = -1;
      for (const e of entries) { const x = wbSim(wbFold(s.source), wbFold(e.source)); if (x > sc) { sc = x; closest = e; } }
      sim = sc < 0 ? 0 : sc;
      why = closest
        ? `No exact source match — closest is ${closest.tab} row ${closest.row} (${Math.round(sim * 100)}% alike); ${wbWordDiff(closest.source, s.source) || 'wording differs'}. Different revision — skip.`
        : `This task's source matches no sheet row for this key. Live: "${clip(s.source)}".`;
    } else if (!hit.valid) {
      verdict = 'invalid';
      why = `Matched ${hit.tab} row ${hit.row}, where LQA marked this Valid = No — nothing to fix in this revision. Skip.`;
    } else if (!hit.final) {
      verdict = 'invalid';
      why = `Matched ${hit.tab} row ${hit.row} (Valid = Yes) but it has no Final Translation. Skip.`;
    } else if (wbFold(s.target) === wbFold(hit.final)) {
      verdict = 'already';
      why = `Already correct — live target already equals ${hit.tab} row ${hit.row}'s Final. Nothing to write.`;
    } else {
      verdict = 'ready';
      why = `Ready — source matches ${hit.tab} row ${hit.row} exactly (seg #${s.rank}).`;
    }
    const cand = { seg: s, hit, verdict, why, sim, taskId: String(taskId) };
    // Rank by verdict first; within the SAME verdict (e.g. two norev siblings of a split
    // segment) prefer the one whose source is closest to the sheet — so the card pairs the
    // meaningful live segment with the sheet row, not an unrelated sibling.
    if (!best || WB_RANK[verdict] < WB_RANK[best.verdict]
      || (WB_RANK[verdict] === WB_RANK[best.verdict] && sim > best.sim)) best = cand;
  }
  return best;
}
// Apply a resolved candidate onto a queue card (shared by Check and Resolve-all).
function wbApplyCandidate(i, best, segCount) {
  const q = WB.queue[i], s = best.seg, hit = best.hit;
  const flags = [];
  if (s.hasComment) flags.push(`💬 task comment${s.comment ? ` — "${String(s.comment).slice(0, 120)}"` : ''} — read it before writing; comments can overrule the sheet`);
  if (!s.modifiable) flags.push('🔒 not modifiable by you');
  if (s.lock) flags.push('🔒 editor lock ' + s.lock);
  if (s.errs) flags.push(`${s.errs} QA error(s)`);
  const blocked = !s.modifiable || !!s.lock;
  q.live = { found: true, taskId: best.taskId, source: s.source, target: s.target, qaFlag: !!s.errs };
  q.api = {
    taskId: best.taskId, sourceTextId: s.sourceTextId, flowSequence: s.flowSequence,
    rank: s.rank, final: hit && hit.final, verdict: best.verdict, blocked,
    hasComment: !!s.hasComment, tab: hit && hit.tab, row: hit && hit.row
  };
  q.decision = best.verdict === 'ready' ? 'ready' : best.verdict === 'already' ? 'already' : 'mismatch';
  const extra = flags.length ? ' · ' + flags.join(' · ') : '';
  const lead = best.verdict === 'ready' && blocked ? '⚠ Blocked: ' : best.verdict === 'ready' ? '' : '⚠ ';
  const more = segCount > 1 ? ` (${segCount} segments carry this key there)` : '';
  wbSetStatus(i, 'checked', `${lead}${best.why} · task ${best.taskId}${extra}${more}`);
  return { verdict: best.verdict, blocked, comment: !!s.hasComment };
}

// ---- Resolve all ---------------------------------------------------------
// Walks every queued key: enumerates its en→he tasks (by subtaskId), reads each task's
// JSON once (cached — tasks repeat heavily across keys), resolves against the index, and
// leaves each card Checked. Reads only — nothing is written. Per-key Write is unchanged.
let wbStopAll = false;
async function wbResolveAll() {
  if (!WB.queue.length) { info('wb-queue-info', 'Build the queue first.', 'err'); return; }
  if (WB.engine !== 'api') { info('wb-queue-info', 'Resolve all needs the API engine (⚙️ Settings).', 'err'); return; }
  if (!(await wbEnsureFresh(0))) return;
  const btn = $('wb-resolve-all');
  wbStopAll = false; if (btn) btn.textContent = '■ Stop';
  // Include already-written cards: a key can live in several tasks, and the tasks it has
  // NOT been written to yet must still surface. Tasks already done for a key are skipped.
  const todo = WB.queue.map((q, i) => ({ q, i })).filter(({ q }) => !q.conflict && q.status !== 'done');
  const taskCache = new Map();
  const tally = { ready: 0, already: 0, invalid: 0, norev: 0, notask: 0, blocked: 0, comment: 0, error: 0 };
  let n = 0;
  for (const { q, i } of todo) {
    if (wbStopAll) { wbLog('[resolve all] stopped by you'); break; }
    n++;
    info('wb-queue-info', `Resolving ${n}/${todo.length} — ${q.key}…`, 'good');
    try {
      const tl = await wbCall('API_TASKS', { key: q.key });
      if (!tl || !tl.ok) { tally.error++; wbSetStatus(i, q.status, 'Task lookup failed: ' + ((tl && tl.error) || '?')); continue; }
      if (!tl.rows.length) { tally.notask++; wbSetStatus(i, 'searched', 'No en→he task found for this key.'); continue; }
      let best = null, bestSegs = 0;
      const alreadyDone = q.doneTasks || [];
      for (const t of tl.rows) {
        if (wbStopAll) break;
        if (alreadyDone.includes(t.subtaskId)) continue;          // already written there
        let res = taskCache.get(t.subtaskId);
        if (!res) {
          res = await wbCall('API_TASK', { taskId: t.subtaskId });
          taskCache.set(t.subtaskId, res);
          await wbSleep(120);                                   // pace the API politely
        }
        if (!res || !res.ok) continue;
        const segs = res.rows.filter((r) => r.key === q.key);
        if (!segs.length) continue;
        const cand = wbPickCandidate(q.key, segs, t.subtaskId);
        if (!best || WB_RANK[cand.verdict] < WB_RANK[best.verdict]) { best = cand; bestSegs = segs.length; }
        if (best.verdict === 'ready') break;                    // can't do better; stop early
      }
      if (!best) {
        if (q.status === 'written') continue;                     // written everywhere it applies — leave it
        tally.notask++; wbSetStatus(i, 'searched', `Key not present in any of its ${tl.rows.length} task(s).`); continue;
      }
      // An already-written card only re-opens if another task genuinely still needs writing.
      // Otherwise the leftovers are just Valid=No / other revisions — keep it written.
      if (q.status === 'written' && best.verdict !== 'ready') continue;
      const r = wbApplyCandidate(i, best, bestSegs);
      tally[r.verdict]++; if (r.blocked) tally.blocked++; if (r.comment) tally.comment++;
    } catch (e) { tally.error++; wbSetStatus(i, q.status, e.message); }
  }
  if (btn) btn.textContent = '⚡ Resolve all';
  wbRenderQueue();
  const line = `Resolved ${n}/${todo.length} · ✅ ${tally.ready} ready · ✔ ${tally.already} already correct · ⤫ ${tally.invalid} Valid=No revision · ? ${tally.norev} no matching revision · ${tally.notask} no task` +
    (tally.blocked ? ` · 🔒 ${tally.blocked} blocked` : '') + (tally.comment ? ` · 💬 ${tally.comment} with comments` : '') + (tally.error ? ` · ⚠ ${tally.error} errors` : '') +
    ` · read ${taskCache.size} task(s). Nothing written — review, then Write per key.`;
  info('wb-queue-info', line, tally.error ? 'err' : 'good');
  wbLog('[resolve all] ' + line);
}

// Read the whole task as JSON, find the segments carrying this key, and resolve each
// against the cross-tab sheet index by EXACT (folded) source. Addressing later uses
// sourceTextId, so no fuzzy matching is ever involved in deciding *where* to write.
async function wbCheckApi(i) {
  const q = WB.queue[i]; if (!q) return;
  if (!(await wbEnsureFresh(i))) return;
  wbSetStatus(i, 'checking', 'Reading the task via the Starling API…');
  try {
    const ctx = await wbCall('WB_CTX');
    const taskId = ctx && ctx.taskId;
    if (!taskId || !/^\d{6,}$/.test(String(taskId))) {
      wbSetStatus(i, 'searched', `No task id in this URL (page: "${ctx && ctx.page}"). Open the task with 👁 first, then Check.`); return;
    }
    const res = await wbCall('API_TASK', { taskId });
    if (!res || !res.ok) { wbSetStatus(i, 'searched', 'API read failed: ' + ((res && res.error) || '?')); return; }
    const segs = res.rows.filter((r) => r.key === q.key);
    q.api = null;
    if (!segs.length) {
      q.live = { found: false, taskId, visible: 0 }; q.decision = 'mismatch';
      wbSetStatus(i, 'checked', `Key not in this task (read ${res.rows.length} segments cleanly). Wrong task — Search again and open a different 👁.`); return;
    }
    const best = wbPickCandidate(q.key, segs, taskId);
    wbApplyCandidate(i, best, segs.length);
    // Reveal the segment in the editor (read-only scroll — Check used to park the editor on it).
    // Best-effort: the segment lives in the task that's open, so its seg # is valid here.
    if (best && best.seg && best.seg.rank != null) {
      try { await wbCall('WB_REVEAL', { seg: best.seg.rank }); } catch (e) {}
    }
  } catch (e) { wbSetStatus(i, 'searched', e.message); }
}

// Atomic write + proofread-confirm, then VERIFY by re-reading the task.
// HYBRID WRITE: the API Check pinned the exact segment (rank + source + sourceTextId); we now
// TYPE it into the editor via the DOM so the editor's own state is correct and safe to resubmit
// (the API confirm wrote server-only, leaving the editor stale — it never reflected the change).
// The DOM write goes to whatever task is on screen, so we first make sure the open task is the
// one the API resolved. After typing we re-read via the API to confirm the value persisted.
async function wbWriteApi(i) {
  const q = WB.queue[i]; const a = q && q.api;
  if (!a) { wbSetStatus(i, q && q.status, 'Run Check first.'); return; }
  const editedTxt = (q.editText && q.editText.trim()) ? q.editText.trim() : null;
  const editedDiffers = editedTxt && (!a.final || wbFold(editedTxt) !== wbFold(a.final));
  if (a.verdict !== 'ready' && !(a.verdict === 'already' && editedDiffers)) { wbSetStatus(i, 'checked', `Nothing to write here (${a.verdict}). Skip this task.`); return; }
  if (a.blocked) { wbSetStatus(i, 'checked', '🔒 This segment is locked / not modifiable — do it by hand.'); return; }
  if (!(await wbEnsureFresh(i))) return;
  // The DOM write types into the task that's OPEN. If the API resolved this segment in a
  // different task (e.g. via Resolve-all), refuse — open that task first.
  const ctx = await wbCall('WB_CTX');
  const openTask = ctx && String(ctx.taskId || '');
  if (openTask && String(a.taskId) && openTask !== String(a.taskId)) {
    wbSetStatus(i, 'checked', `⚠ This segment is in task ${a.taskId}, but task ${openTask} is open. Open the right task (👁), run Check, then Write.`); return;
  }
  const doConfirm = !($('wb-autoconfirm') && $('wb-autoconfirm').checked === false);

  // ---- API write (editor-agnostic) --------------------------------------
  // Addressed by the exact sourceTextId the Check step pinned from the SAME API read that
  // matched the sheet — so it can never land on the wrong row, no matter which editor the
  // task uses. confirmTextTaskTargetV2 is atomic write+confirm; we re-read to verify.
  // ignoreQa mirrors confirm-all: an LQA-approved Final must still save even if Starling's
  // auto-QA flags it (e.g. a period the proofreader deliberately kept).
  const apiWrite = async (why) => {
    if (!a.sourceTextId) { wbSetStatus(i, 'checked', '⚠ No sourceTextId on this row — write it by hand.'); return false; }
    const text = (q.editText && q.editText.trim()) ? q.editText.trim() : a.final;
    wbSetStatus(i, 'writing', 'Writing the Final via the Starling API…');
    const ar = await wbCall('API_CONFIRM', {
      taskId: a.taskId, key: q.key, sourceTextId: a.sourceTextId,
      flowSequence: a.flowSequence, text, ignoreQa: WB.lqa === true && doConfirm
    });
    if (!(ar && ar.ok)) {
      const msg = (ar && (ar.msg || (ar.status_code != null && 'status_code ' + ar.status_code) || (ar.http != null && 'HTTP ' + ar.http) || ar.error)) || 'unknown';
      wbLog(`⚠ API write failed (${why}) — ${msg}`);
      wbSetStatus(i, 'checked', `⚠ API write failed (${msg}). ${WB.lqa ? 'Do this key by hand.' : 'Try the DOM engine, or write by hand.'}`);
      return false;
    }
    await wbSleep(350);
    const v2 = await wbCall('API_TASK', { taskId: a.taskId });
    const seg2 = v2 && v2.ok && v2.rows.find((x) => x.sourceTextId === a.sourceTextId);
    const ok2 = seg2 && wbFold(seg2.target) === wbFold(text);
    wbLog(`API-wrote ${q.key} @task ${a.taskId} id=${a.sourceTextId} (${why}) — server=${ok2 ? 'matches ✓' : (seg2 ? 'not-yet(status ' + seg2.status + ')' : 're-read failed')}`);
    q.doneTasks = q.doneTasks || []; if (!q.doneTasks.includes(a.taskId)) q.doneTasks.push(a.taskId);
    q.live = null; q.decision = null; q.api = null; q.status = 'written';
    wbMarkWritten(q);
    q.note = `✅ Written + confirmed via the API · task ${a.taskId}${ok2 ? ' · server confirms it saved' : ' · sent'} · refreshing the task so the fix shows in the editor… Same key elsewhere? Search → 👁 → Check → Write. You resubmit each task.`;
    wbRenderQueue();
    // The API write saves server-side but doesn't repaint the on-screen editor — reload the
    // task tab (as Confirm-all does) so the fix + green ✓✓ show without a manual refresh. The
    // open tab was already verified to be this task earlier in wbWriteApi.
    try { const t = await wbActiveTab(); if (t) { await wbSleep(600); await chrome.tabs.reload(t.id); } } catch (e) {}
    return true;
  };

  // LQA tasks overwhelmingly use the Document (virtual-table) editor the DOM writer can't
  // reach, and its source-sanity abort used to block the fallback entirely. Go straight to
  // the API — it's addressed by sourceTextId, so it's exact and reload-verifiable.
  if (WB.lqa && a.sourceTextId) { await apiWrite('lqa-first'); return; }

  wbSetStatus(i, 'writing', 'Typing the Final into the editor…');
  try {
    const before = q.live && q.live.target;
    const r = await wbCall('WB_WRITE_SEG', { seg: a.rank, text: a.final, confirm: doConfirm, expectSource: q.live && q.live.source });
    // Any DOM failure → API fallback (broadened from the old narrow "didn't mount" regex, which
    // let the source-mismatch abort slip through). The API write is keyed by sourceTextId, so
    // it's safe regardless of why the DOM path bailed.
    if (!r || !r.ok) {
      const reason = (r && r.reason) || 'unknown';
      wbLog(`DOM write failed (${reason}) — API fallback for ${q.key} @task ${a.taskId} seg#${a.rank}${r && r.sawSource ? ` · row read "${String(r.sawSource).slice(0, 90)}"` : ''}`);
      await apiWrite('dom-fail: ' + reason);
      return;
    }
    if (!r.wrote) {
      wbLog(`typed but editor text ≠ Final — seg#${a.rank}: after="${String(r.after || '').slice(0, 120)}" — API fallback`);
      await apiWrite('dom-mismatch');
      return;
    }
    // verify-after-write: re-read the task via the API and confirm the value persisted server-side.
    await wbSleep(400);
    const v = await wbCall('API_TASK', { taskId: a.taskId });
    const seg = v && v.ok && v.rows.find((x) => x.sourceTextId === a.sourceTextId);
    const persisted = seg && wbFold(seg.target) === wbFold(a.final);
    wbLog(`wrote ${q.key} @task ${a.taskId} seg#${a.rank} id=${a.sourceTextId} confirmed=${r.confirmed}`);
    wbLog(`  before: "${String(before || '').slice(0, 120)}"`);
    wbLog(`  after : "${String(r.after || '').slice(0, 120)}"  server=${persisted ? 'matches' : (seg ? 'not-yet' : 're-read failed')}${seg ? ' status=' + seg.status : ''}`);
    q.doneTasks = q.doneTasks || [];
    if (!q.doneTasks.includes(a.taskId)) q.doneTasks.push(a.taskId);
    q.live = null; q.decision = null; q.api = null; q.status = 'written';
    wbMarkWritten(q);
    const serverNote = persisted ? 'server confirms it saved' : 'typed into the editor — it will save on confirm/resubmit';
    q.note = `✅ Typed into the editor + ${r.confirmed ? 'proofread-confirmed' : 'written (not confirmed — confirm by hand)'} · task ${a.taskId} (seg #${a.rank}) · ${serverNote}. The editor now shows the fix. Same key in another task? Search again, open it with 👁, Check, Write. Click “Done” when every task is fixed. You resubmit each task.`;
    wbRenderQueue();
  } catch (e) { wbSetStatus(i, 'checked', e.message); }
}

function wbRenderQueue() {
  const box = $('wb-queue'); if (!box) return;
  const list = WB.queue.map((q, i) => ({ q, i })).filter(({ q }) => WB.filter !== 'todo' || q.status !== 'done');
  box.innerHTML = list.map(({ q, i }) => wbCardHtml(q, i)).join('') || '<div class="info good">Nothing to show — all done. 🎉</div>';
  box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const i = +b.dataset.i, act = b.dataset.act;
    if (act === 'search') wbSearch(i);
    else if (act === 'check') wbCheck(i);
    else if (act === 'write') wbWriteOne(i);
    else if (act === 'skip') { WB.queue[i].status = 'done'; WB.queue[i].note = 'Skipped by you (not written).'; wbRenderQueue(); wbPersistProgress(); }
    else if (act === 'done') { WB.queue[i].status = 'done'; WB.queue[i].note = 'Marked done for all tasks.' + (WB.queue[i].doneTasks && WB.queue[i].doneTasks.length ? ' Wrote to: ' + WB.queue[i].doneTasks.join(', ') : ''); wbRenderQueue(); wbPersistProgress(); }
    else if (act === 'copy-final') panelCopy(WB.queue[i].final, b);
    else if (act === 'edit') { WB.queue[i].editing = !WB.queue[i].editing; wbRenderQueue(); }
    else if (act === 'edit-reset') { WB.queue[i].editText = null; wbRenderQueue(); wbPersistProgress(); }
  }));
  // Live-bind the edit textareas WITHOUT re-rendering on each keystroke (would drop focus).
  box.querySelectorAll('textarea.wb-edit-final').forEach((t) => {
    t.addEventListener('input', () => { const q = WB.queue[+t.dataset.i]; if (q) q.editText = t.value; });
    t.addEventListener('change', () => wbPersistProgress());
  });
  box.querySelectorAll('textarea.wb-edit-note').forEach((t) => {
    t.addEventListener('input', () => { const q = WB.queue[+t.dataset.i]; if (q) q.noteText = t.value; });
    t.addEventListener('change', () => wbPersistProgress());
  });
  const done = WB.queue.filter((q) => q.status === 'done').length;
  if ($('wb-qcount')) $('wb-qcount').textContent = `${done}/${WB.queue.length} done`;
}
function wbCardHtml(q, i) {
  const live = q.live, dec = q.decision;
  const edited = (q.editText != null && String(q.editText).trim() !== '') ? String(q.editText) : null;
  const effFinal = edited != null ? edited : q.final;   // what Write actually sends
  const verd = (q.api && q.api.verdict) || null;   // 'norev' | 'invalid' | … when resolved by the API engine
  const mismatchBadge = verd === 'invalid'
    ? '<span class="lqc-warn" title="A sheet row DID match this source, but that revision is marked Valid = No (or has no Final Translation) — nothing to fix in this task.">⚠ Valid = No here</span>'
    : verd === 'norev'
      ? '<span class="lqc-warn" title="No sheet row’s source matches this task’s source for this key — this is a different revision, so nothing is written. (Punctuation/invisible-character differences are already normalised, so this is a real wording difference.)">⚠ no source match</span>'
      : '<span class="lqc-warn" title="Live task source differs from the sheet source — the sheet fix may not apply here.">⚠ source mismatch</span>';
  const decBadge = dec === 'already' ? '<span class="lqc-badge b-invalid" title="Live target already equals the Final Translation">already correct</span>'
    : dec === 'mismatch' ? mismatchBadge
      : dec === 'ready' ? '<span class="lqc-badge b-valid">ready</span>' : '';
  const liveBlock = live && live.found ? `
    <div class="lqc-lbl">Live source</div><div class="lqc-src" dir="ltr">${hl(esc(live.source))}</div>
    <div class="lqc-lbl">Current target</div><div class="lqc-tgt${wbNorm(live.target) !== wbNorm(effFinal) ? ' old' : ''}" dir="rtl">${hl(esc(live.target))}</div>`
    : (live && !live.found ? `<div class="info err">${live.noSourceMatch
      ? `Key found here (${live.visible} segment${live.visible === 1 ? '' : 's'}), but its source doesn’t match the sheet — nothing written.`
      : live.ambiguous
        ? `Key matched ${live.visible} segments — too ambiguous to pick one safely.`
        : 'Segment not found in the open task.'}</div>` : '');
  // Normally can't write when the live target already matches the final; but if you've EDITED to
  // something different from the live target, writing that edit is exactly the point — allow it.
  const canWrite = !!(live && live.found) && (dec !== 'already' || (edited != null && wbNorm(edited) !== wbNorm(live.target)));
  const done = q.status === 'done';
  const written = q.status === 'written';
  const acts = q.conflict
    ? '<span class="rc-manual">Resolve in the sheet</span>'
    : done
      ? `<button class="lqc-copy ghost" data-act="copy-final" data-i="${i}">Copy final</button>`
      : `<button class="lqc-copy" data-act="search" data-i="${i}">1 · Search</button>
         <button class="lqc-copy ghost" data-act="check" data-i="${i}">2 · Check</button>
         <button class="lqc-copy${canWrite ? '' : ' ghost'}" data-act="write" data-i="${i}">3 · Write + confirm</button>
         <button class="lqc-copy ghost" data-act="edit" data-i="${i}" title="Edit the correction before writing, and add a Column I note">${q.editing ? '✕ Close edit' : (edited != null || (q.noteText && q.noteText.trim()) ? '✏ Edit •' : '✏ Edit')}</button>
         ${written
        ? `<button class="lqc-copy" data-act="done" data-i="${i}">✓ Done (all tasks)</button>`
        : `<button class="lqc-copy ghost" data-act="skip" data-i="${i}">Skip</button>`}`;
  const wroteTally = (q.doneTasks && q.doneTasks.length)
    ? `<div class="lqc-rat" title="Tasks this key's fix was written to">✓ written to task(s): ${esc(q.doneTasks.join(', '))}</div>` : '';
  return `<div class="lqc wbc" data-verdict="${esc(q.status)}">
    <div class="lqc-top"><span class="lqc-seg">${done ? '✓' : '#' + (i + 1)}</span>
      <span class="lqc-key" title="Key">${esc(q.key)}</span>
      ${q.conflict ? '<span class="lqc-warn">⚠ conflict</span>' : ''}${decBadge}
      ${q.rows.length > 1 ? `<span class="lqc-lvl" title="Sheet rows sharing this key">rows ${esc(q.rows.join(','))}</span>` : ''}</div>
    <div class="lqc-lbl">Final translation (from sheet)${edited != null ? '<span class="lqc-edited" title="You edited this — Write sends the edited text">edited</span>' : ''}</div>
    <div class="lqc-new" dir="rtl">${hl(esc(effFinal))}</div>
    ${q.editing ? `
      <div class="wb-edit">
        <div class="lqc-lbl">Edit correction (this text is written to Starling)</div>
        <textarea class="wb-edit-final" data-i="${i}" dir="rtl" rows="2" placeholder="Edited Hebrew correction…">${esc(effFinal)}</textarea>
        ${WB.lqa ? `<div class="lqc-lbl">Note → Column I (sheet)</div>
        <textarea class="wb-edit-note" data-i="${i}" dir="auto" rows="2" placeholder="Note for Column I — e.g. why you changed it. Blank = &quot;agree&quot;.">${esc(q.noteText || '')}</textarea>` : ''}
        <div class="wb-edit-hint">Then hit <b>3 · Write + confirm</b>: it sends the edited text to Starling${WB.lqa ? ' and writes this note into Column I (blank ⇒ “agree”)' : ''}. <b>Reset</b> restores the sheet’s original.</div>
        <div class="lqc-acts"><button class="lqc-copy ghost" data-act="edit-reset" data-i="${i}">Reset to sheet</button></div>
      </div>` : ''}
    ${q.src ? `<div class="lqc-lbl">Sheet source</div><div class="lqc-src" dir="ltr">${hl(esc(q.src))}</div>` : ''}
    ${liveBlock}
    ${wroteTally}
    ${q.note ? `<div class="lqc-rat">${esc(q.note)}</div>` : ''}
    <div class="lqc-acts wb-acts">${acts}</div>
  </div>`;
}

// ============================================================================
// CROWDIN (official API v2) — harvest strings → GPT-5.4 cards → enter (unapproved).
// The tool NEVER approves/submits; the user does the final approve in the editor.
// All calls go through the background proxy (CROWDIN_API) so there's no page CORS.
// ============================================================================
const CW = { ctx: null, cards: [] };
function cwLog(...a) { const el = $('cw-log'); if (!el) return; el.textContent += (el.textContent ? '\n' : '') + a.join(' '); el.scrollTop = el.scrollHeight; }

// One API v2 call via the background worker. Returns {ok,status,data} or throws a clear message.
async function cwCall(method, path, body) {
  const token = (await store.get('cwToken', '')).trim();
  if (!token) throw new Error('Add your Crowdin API token in ⚙️ Settings first.');
  if (!CW.ctx || !CW.ctx.org) throw new Error('Click “Detect the open file” first.');
  const r = await new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: 'CROWDIN_API', org: CW.ctx.org, method, path, token, body }, (x) => {
        if (chrome.runtime.lastError) { res({ ok: false, error: 'background worker not reachable (' + chrome.runtime.lastError.message + ') — reload the extension at chrome://extensions.' }); return; }
        res(x || { ok: false, error: 'no reply from the background worker — reload the extension at chrome://extensions (the new proxy loads only on a full reload, not on reopening the panel).' });
      });
    } catch (e) { res({ ok: false, error: String((e && e.message) || e) }); }
  });
  if (r.error) throw new Error(r.error);
  if (r.status === 401) throw new Error('Crowdin rejected the token (HTTP 401 — not authenticated). The Personal Access Token must be created INSIDE the ukg-hrsd org (log in at ukg-hrsd.crowdin.com → Account Settings → API → Personal Access Tokens), then re-paste it in ⚙️ Settings and Save — a partial paste or a token from a different account/org also 401s.');
  if (r.status === 403) throw new Error('Crowdin refused (HTTP 403 — token authenticates but lacks scope). Give the token Projects (read) + Translations (write) scope.');
  if (!r.ok) throw new Error(`Crowdin API HTTP ${r.status}${r.data && r.data.error ? ' · ' + (r.data.error.message || JSON.stringify(r.data.error)) : ''}`);
  return r.data;
}

// Parse the active Crowdin editor tab: org, projectId, fileId, target language.
async function cwDetect() {
  const t = await activeTab();
  const url = (t && t.url) || '';
  const host = (url.match(/^https:\/\/([a-z0-9-]+)\.crowdin\.com\//i) || [])[1];
  const m = url.match(/\/editor\/(\d+)\/(\d+)\/([a-z0-9]+)-([a-z0-9-]+)/i);
  if (!host || !m) {
    CW.ctx = null;
    info('cw-ctx', 'Open the Crowdin editor tab (…/editor/<project>/<file>/<src>-<tgt>/…), then Detect.', 'err');
    $('cw-harvest-card').hidden = true;
    return;
  }
  CW.ctx = { org: host, projectId: m[1], fileId: m[2], source: m[3], target: m[4] };
  info('cw-ctx', `Connected · org ${CW.ctx.org} · project ${CW.ctx.projectId} · file ${CW.ctx.fileId} · ${CW.ctx.source} → ${CW.ctx.target}.`, 'good');
  $('cw-harvest-card').hidden = false;
  cwLog(`[detect] ${JSON.stringify(CW.ctx)}`);
}

// GET every source string in the file (paged), plus current target translations to show/skip.
async function cwHarvest() {
  if (!CW.ctx) { await cwDetect(); if (!CW.ctx) return; }
  const btn = $('cw-harvest'); btn.disabled = true;
  info('cw-harvest-info', 'Reading source strings…');
  try {
    // 1) source strings (paginated, 500/page)
    const strings = [];
    for (let offset = 0; ; offset += 500) {
      const d = await cwCall('GET', `/projects/${CW.ctx.projectId}/strings?fileId=${CW.ctx.fileId}&limit=500&offset=${offset}`);
      const rows = (d && d.data) || [];
      rows.forEach((x) => { const s = x.data || x; strings.push({ id: s.id, key: s.identifier || s.context || String(s.id), src: cwPlain(s.text), context: s.context || '' }); });
      info('cw-harvest-info', `Read ${strings.length} strings…`);
      if (rows.length < 500) break;
    }
    // 2) current target translations → map stringId → text (best-effort)
    const tgt = new Map();
    try {
      for (let offset = 0; ; offset += 500) {
        const d = await cwCall('GET', `/projects/${CW.ctx.projectId}/languages/${CW.ctx.target}/translations?fileId=${CW.ctx.fileId}&limit=500&offset=${offset}`);
        const rows = (d && d.data) || [];
        rows.forEach((x) => { const s = x.data || x; if (s.stringId != null) tgt.set(s.stringId, cwPlain(s.text != null ? s.text : s.translation)); });
        if (rows.length < 500) break;
      }
    } catch (e) { cwLog('[harvest] current-target read skipped: ' + e.message); }

    const onlyUntranslated = $('cw-only-untranslated').checked;
    CW.cards = strings
      .map((s) => ({ ...s, tgt: tgt.get(s.id) || '', proposal: '', status: 'new', approved: false }))
      .filter((c) => (c.src || '').trim() && (onlyUntranslated ? !c.tgt.trim() : true));

    info('cw-harvest-info', `Harvested ${CW.cards.length} string(s)${onlyUntranslated ? ' with no Hebrew yet' : ''} · ${strings.length} total in file.`, 'good');
    $('cw-propose-card').hidden = CW.cards.length === 0;
    $('cw-review-card').hidden = true;
    cwRender();
    if (!CW.cards.length) info('cw-harvest-info', 'Nothing to harvest (all already translated, or no source text). Untick “only untranslated” to review everything.', 'err');
  } catch (e) {
    info('cw-harvest-info', e.message, 'err');
  } finally { btn.disabled = false; }
}

// Crowdin string text can be a plain string or a plural object {one,other,…}; take a display form.
function cwPlain(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'object') return t.other || t.one || Object.values(t)[0] || '';
  return String(t);
}

// GPT-5.4 proposals over the harvested cards (reuses gptBatch/sysPrompt + house style).
async function cwPropose() {
  const key = await store.get('key', '');
  if (!key) { info('cw-propose-info', 'Add your OpenAI key in ⚙️ Settings first.', 'err'); return; }
  if (!CW.cards.length) { info('cw-propose-info', 'Harvest first.', 'err'); return; }
  const model = $('model').value, plural = $('plural').checked, mode = $('cw-mode').value;
  const btn = $('cw-propose'); btn.disabled = true;
  const B = 10; let done = 0, failed = 0;
  try {
    for (let i = 0; i < CW.cards.length; i += B) {
      const slice = CW.cards.slice(i, i + B);
      info('cw-propose-info', `✨ ${mode === 'translate' ? 'Translating' : 'Proofreading'} ${i + 1}–${Math.min(i + B, CW.cards.length)} of ${CW.cards.length}…`);
      const items = slice.map((c, j) => ({ i: j + 1, src: String(c.src || ''), tgt: String(c.tgt || '') }));
      try {
        const out = await gptBatch(items, mode, key, model, plural);
        out.forEach((o) => { const idx = (o.i | 0) - 1; if (idx >= 0 && idx < slice.length && o.text != null) { slice[idx].proposal = String(o.text); slice[idx].approved = true; slice[idx].status = 'proposed'; done++; } });
      } catch (e) { failed += slice.length; cwLog('[gpt] batch failed: ' + e.message); }
    }
    info('cw-propose-info', `Proposed ${done}${failed ? ` · ${failed} failed` : ''}. Review, then Enter.`, failed ? 'err' : 'good');
    $('cw-review-card').hidden = CW.cards.every((c) => !c.proposal);
    cwRender();
  } finally { btn.disabled = false; }
}

// POST one card's translation to Crowdin, UNAPPROVED (approve is the user's job in the editor).
async function cwEnter(i) {
  const c = CW.cards[i]; if (!c) return;
  const text = (c.proposal || '').trim();
  if (!text) { c.note = 'Nothing to enter — no proposal.'; cwRender(); return; }
  c.status = 'entering'; cwRender();
  try {
    const d = await cwCall('POST', `/projects/${CW.ctx.projectId}/translations`, { stringId: c.id, languageId: CW.ctx.target, text });
    const tid = d && d.data && d.data.id;
    c.status = 'entered'; c.note = `✅ Entered (unapproved) · translation ${tid || '?'} — approve it in the editor.`; c.tgt = text;
    cwLog(`entered string ${c.id} "${c.key}" → translation ${tid}`);
  } catch (e) { c.status = 'proposed'; c.note = '⚠ ' + e.message; cwLog(`enter failed for string ${c.id}: ${e.message}`); }
  cwRender();
}

async function cwEnterAll() {
  const pending = CW.cards.map((c, i) => ({ c, i })).filter(({ c }) => c.approved && (c.proposal || '').trim() && c.status !== 'entered');
  if (!pending.length) { info('cw-review-info', 'Nothing checked to enter.', 'err'); return; }
  info('cw-review-info', `Entering ${pending.length}…`);
  let n = 0;
  for (const { i } of pending) { await cwEnter(i); n++; info('cw-review-info', `Entered ${n}/${pending.length}…`); await wbSleep(120); }
  const ok = CW.cards.filter((c) => c.status === 'entered').length;
  info('cw-review-info', `Done — ${ok} entered (unapproved). Approve them in the Crowdin editor to submit.`, 'good');
}

function cwRender() {
  const box = $('cw-cards'); if (!box) return;
  box.innerHTML = CW.cards.map((c, i) => {
    const entered = c.status === 'entered';
    const badge = entered ? '<span class="lqc-badge b-valid">entered</span>'
      : c.status === 'entering' ? '<span class="lqc-warn">entering…</span>'
        : c.proposal ? '<span class="lqc-badge b-invalid">proposed</span>' : '';
    return `<div class="lqc wbc">
      <div class="lqc-top"><span class="lqc-seg">#${i + 1}</span><span class="lqc-key" title="Key">${esc(c.key)}</span>${badge}</div>
      <div class="lqc-lbl">Source (EN)</div><div class="lqc-src" dir="ltr">${hl(esc(c.src))}</div>
      ${c.tgt ? `<div class="lqc-lbl">Current Hebrew</div><div class="lqc-tgt" dir="rtl">${hl(esc(c.tgt))}</div>` : ''}
      ${c.proposal ? `<div class="lqc-lbl">GPT proposal</div><div class="lqc-new" dir="rtl">${hl(esc(c.proposal))}</div>` : ''}
      ${c.note ? `<div class="lqc-rat">${esc(c.note)}</div>` : ''}
      <div class="lqc-acts wb-acts">
        <label class="ck" style="margin:0 8px 0 0"><input type="checkbox" data-cw-appr="${i}" ${c.approved ? 'checked' : ''} ${entered ? 'disabled' : ''}/> approve</label>
        <button class="lqc-copy${c.proposal && !entered ? '' : ' ghost'}" data-cw-enter="${i}" ${entered ? 'disabled' : ''}>⤵ Enter</button>
        <button class="lqc-copy ghost" data-cw-copy="${i}">Copy</button>
      </div>
    </div>`;
  }).join('') || '<div class="info">Harvest a file to begin.</div>';
  box.querySelectorAll('[data-cw-enter]').forEach((b) => b.addEventListener('click', () => cwEnter(+b.dataset.cwEnter)));
  box.querySelectorAll('[data-cw-copy]').forEach((b) => b.addEventListener('click', () => panelCopy(CW.cards[+b.dataset.cwCopy].proposal || '', b)));
  box.querySelectorAll('[data-cw-appr]').forEach((b) => b.addEventListener('change', () => { CW.cards[+b.dataset.cwAppr].approved = b.checked; }));
  const ok = CW.cards.filter((c) => c.status === 'entered').length;
  if ($('cw-count')) $('cw-count').textContent = `${ok}/${CW.cards.length} entered`;
}

// ============================================================================
// memoQ mode — harvest → GPT → write-back through memoQ's own editor API.
// The memoq.js content script does the API I/O (same-origin session); this side
// runs the review UI and the GPT proposals (reusing gptBatch/sysPrompt).
// ============================================================================
const MQ = { ctx: null, cards: [] };
function mqLog(...a) { const el = $('mq-log'); if (!el) return; el.textContent += (el.textContent ? '\n' : '') + a.join(' '); el.scrollTop = el.scrollHeight; }

async function mqDetect() {
  try {
    const r = await sendMQ({ type: 'MQ_PING' });
    if (!r || !r.ok) throw new Error(r && r.error || 'no response');
    MQ.ctx = { project: r.project, doc: r.doc, rows: r.rows };
    if (!r.csrf) mqLog('[detect] warning: no X-CSRF-TOKEN cookie seen — writes may be rejected.');
    info('mq-ctx', `Connected · ${r.rows} segments · doc ${String(r.doc || '').slice(0, 8)}… (memoQ v${r.ver}).`, 'good');
    $('mq-harvest-card').hidden = false;
    mqLog(`[detect] project ${r.project} · doc ${r.doc} · ${r.rows} rows`);
  } catch (e) {
    MQ.ctx = null;
    info('mq-ctx', e.message, 'err');
    $('mq-harvest-card').hidden = true;
  }
}

async function mqHarvest() {
  const btn = $('mq-harvest'); btn.disabled = true;
  info('mq-harvest-info', 'Harvesting segments via the memoQ API…');
  try {
    const r = await sendMQ({ type: 'MQ_HARVEST' });
    if (!r || !r.ok) throw new Error(r && r.error || 'harvest failed');
    const skipConfirmed = $('mq-skip-confirmed').checked;
    const skipLocked = $('mq-skip-locked').checked;
    const isConfirmed = (s) => /confirm/i.test(s || '');
    let skippedC = 0, skippedL = 0;
    MQ.cards = (r.segments || [])
      .filter((s) => {
        if (!String(s.src || '').trim()) return false;              // no source → nothing to do
        if (skipLocked && (s.locked || s.readonly)) { skippedL++; return false; }
        if (skipConfirmed && isConfirmed(s.status)) { skippedC++; return false; }
        return true;
      })
      .map((s) => ({ ...s, proposal: '', status_ui: 'new', approved: false, note: '' }));
    const total = (r.segments || []).length;
    const tagged = MQ.cards.filter((c) => c.tagged).length;
    info('mq-harvest-info', `Harvested ${MQ.cards.length} of ${total} segment(s)${tagged ? ` · ⚠ ${tagged} with tags` : ''}${skippedC ? ` · skipped ${skippedC} confirmed` : ''}${skippedL ? ` · skipped ${skippedL} locked` : ''}.`, 'good');
    $('mq-propose-card').hidden = MQ.cards.length === 0;
    $('mq-review-card').hidden = true;
    mqRender();
    if (!MQ.cards.length) info('mq-harvest-info', 'Nothing to harvest with these filters — untick the skip options to include confirmed/locked segments.', 'err');
  } catch (e) {
    info('mq-harvest-info', e.message, 'err');
  } finally { btn.disabled = false; }
}

async function mqPropose() {
  const key = await store.get('key', '');
  if (!key) { info('mq-propose-info', 'Add your OpenAI key in ⚙️ Settings first.', 'err'); return; }
  if (!MQ.cards.length) { info('mq-propose-info', 'Harvest first.', 'err'); return; }
  const model = $('model').value, plural = $('plural').checked, mode = $('mq-mode').value;
  const btn = $('mq-propose'); btn.disabled = true;
  const B = 10; let done = 0, failed = 0;
  try {
    for (let i = 0; i < MQ.cards.length; i += B) {
      const slice = MQ.cards.slice(i, i + B);
      info('mq-propose-info', `✨ ${mode === 'translate' ? 'Translating' : 'Proofreading'} ${i + 1}–${Math.min(i + B, MQ.cards.length)} of ${MQ.cards.length}…`);
      const items = slice.map((c, j) => ({ i: j + 1, src: String(c.src || ''), tgt: String(c.tgt || '') }));
      try {
        const out = await gptBatch(items, mode, key, model, plural);
        out.forEach((o) => {
          const idx = (o.i | 0) - 1;
          if (idx >= 0 && idx < slice.length && o.text != null) {
            const c = slice[idx];
            c.proposal = polish(c.src, String(o.text));
            // tag list for the write: proofread edits the existing target's tags; translate carries the source's.
            c.writeTags = mode === 'translate' ? (c.srcTags || []) : ((c.tgtTags && c.tgtTags.length) ? c.tgtTags : (c.srcTags || []));
            c.approved = true; c.status_ui = 'proposed'; done++;
          }
        });
      } catch (e) { failed += slice.length; mqLog('[gpt] batch failed: ' + e.message); }
    }
    info('mq-propose-info', `Proposed ${done}${failed ? ` · ${failed} failed` : ''}. Review, then Write.`, failed ? 'err' : 'good');
    $('mq-review-card').hidden = MQ.cards.every((c) => !c.proposal);
    mqRender();
  } finally { btn.disabled = false; }
}

async function mqWrite(i) {
  const c = MQ.cards[i]; if (!c) return;
  const text = (c.proposal || '').trim();
  if (!text) { c.note = 'Nothing to write — no proposal.'; mqRender(); return; }
  c.status_ui = 'writing'; mqRender();
  try {
    const r = await sendMQ({ type: 'MQ_WRITE', edits: [{ rowId: c.rowId, text: c.proposal, tags: c.writeTags || [] }] });
    const res = r && r.results && r.results[0];
    if (res && res.ok) { c.status_ui = 'written'; c.tgt = c.proposal; c.note = `✅ Written (unconfirmed) — confirm segment ${c.seg} in memoQ.`; mqLog(`wrote seg ${c.seg} (row ${c.rowId})`); }
    else { c.status_ui = 'proposed'; c.note = '⚠ ' + ((res && res.error) || (r && r.error) || 'write failed'); mqLog(`write failed seg ${c.seg}: ${c.note}`); }
  } catch (e) { c.status_ui = 'proposed'; c.note = '⚠ ' + e.message; mqLog(`write failed seg ${c.seg}: ${e.message}`); }
  mqRender();
}

async function mqWriteAll() {
  const pending = MQ.cards.map((c, i) => ({ c, i })).filter(({ c }) => c.approved && (c.proposal || '').trim() && c.status_ui !== 'written');
  if (!pending.length) { info('mq-review-info', 'Nothing approved to write.', 'err'); return; }
  info('mq-review-info', `Writing ${pending.length}…`);
  let n = 0;
  for (const { i } of pending) { await mqWrite(i); info('mq-review-info', `Writing ${++n}/${pending.length}…`); }
  const ok = MQ.cards.filter((c) => c.status_ui === 'written').length;
  info('mq-review-info', `Done · ${ok} written (unconfirmed). Confirm each segment in memoQ.`, 'good');
}

function mqRender() {
  const box = $('mq-cards'); if (!box) return;
  box.innerHTML = MQ.cards.map((c, i) => {
    const written = c.status_ui === 'written';
    const badge = written ? '<span class="lqc-badge b-valid">written</span>'
      : c.status_ui === 'writing' ? '<span class="lqc-warn">writing…</span>'
        : c.proposal ? '<span class="lqc-badge b-invalid">proposed</span>' : '';
    const tag = c.tagged ? '<span class="lqc-warn" title="has inline tags ①②③">⚑ tags</span>' : '';
    return `<div class="lqc wbc">
      <div class="lqc-top"><span class="lqc-seg">#${c.seg}</span>${tag}${badge}</div>
      <div class="lqc-lbl">Source (EN)</div><div class="lqc-src" dir="ltr">${hl(esc(c.src))}</div>
      ${c.tgt ? `<div class="lqc-lbl">Current Hebrew</div><div class="lqc-tgt" dir="rtl">${hl(esc(c.tgt))}</div>` : ''}
      ${c.proposal ? `<div class="lqc-lbl">GPT proposal</div><div class="lqc-new" dir="rtl">${hl(esc(c.proposal))}</div>` : ''}
      ${c.note ? `<div class="lqc-rat">${esc(c.note)}</div>` : ''}
      <div class="lqc-acts wb-acts">
        <label class="ck" style="margin:0 8px 0 0"><input type="checkbox" data-mq-appr="${i}" ${c.approved ? 'checked' : ''} ${written ? 'disabled' : ''}/> approve</label>
        <button class="lqc-copy${c.proposal && !written ? '' : ' ghost'}" data-mq-write="${i}" ${written ? 'disabled' : ''}>⤵ Write</button>
        <button class="lqc-copy ghost" data-mq-copy="${i}">Copy</button>
      </div>
    </div>`;
  }).join('') || '<div class="info">Harvest a document to begin.</div>';
  box.querySelectorAll('[data-mq-write]').forEach((b) => b.addEventListener('click', () => mqWrite(+b.dataset.mqWrite)));
  box.querySelectorAll('[data-mq-copy]').forEach((b) => b.addEventListener('click', () => panelCopy(MQ.cards[+b.dataset.mqCopy].proposal || '', b)));
  box.querySelectorAll('[data-mq-appr]').forEach((b) => b.addEventListener('change', () => { MQ.cards[+b.dataset.mqAppr].approved = b.checked; }));
  const ok = MQ.cards.filter((c) => c.status_ui === 'written').length;
  if ($('mq-count')) $('mq-count').textContent = `${ok}/${MQ.cards.length} written`;
}

// ============================================================================
// YiCAT mode — REST harvest → GPT → copy (default) / experimental DOM write.
// The yicat.js content script does the segment I/O (same-origin session); this
// side runs the review UI and the GPT proposals (reusing gptBatch/sysPrompt).
// YiCAT saves over a WebSocket, so there is no REST write — the human pastes.
// ============================================================================
const YC = { ctx: null, cards: [], write: false };
function ycLog(...a) { const el = $('yc-log'); if (!el) return; el.textContent += (el.textContent ? '\n' : '') + a.join(' '); el.scrollTop = el.scrollHeight; }
// strip circled tag markers ①②③㉑…/PUA → plain text (what you paste into a cell)
function ycStripMarkers(text) {
  let out = '';
  for (const ch of Array.from(String(text || ''))) {
    const cp = ch.codePointAt(0);
    const isMarker = (cp >= 0x2460 && cp <= 0x2473) || (cp >= 0x3251 && cp <= 0x325f) || (cp >= 0xE000 && cp <= 0xF8FF);
    if (!isMarker) out += ch;
  }
  return out;
}

async function ycDetect() {
  try {
    const r = await sendYC({ type: 'YC_PING' });
    if (!r || !r.ok) throw new Error(r && r.error || 'not a YiCAT editor task URL');
    YC.ctx = { group: r.group, task: r.task, doc: r.doc };
    info('yc-ctx', `Connected · task ${String(r.task || '').slice(0, 8)}… · group ${r.group} (YiCAT v${r.ver}).`, 'good');
    $('yc-harvest-card').hidden = false;
    ycLog(`[detect] group ${r.group} · task ${r.task}`);
  } catch (e) {
    YC.ctx = null;
    info('yc-ctx', e.message, 'err');
    $('yc-harvest-card').hidden = true;
  }
}

async function ycHarvest() {
  const btn = $('yc-harvest'); btn.disabled = true;
  info('yc-harvest-info', 'Harvesting segments via the YiCAT API…');
  try {
    const r = await sendYC({ type: 'YC_HARVEST' });
    if (!r || !r.ok) throw new Error(r && r.error || 'harvest failed');
    const skipConfirmed = $('yc-skip-confirmed').checked;
    const skipLocked = $('yc-skip-locked').checked;
    let skippedC = 0, skippedL = 0;
    YC.cards = (r.segments || [])
      .filter((s) => {
        if (!String(s.src || '').trim()) return false;              // no source → nothing to do
        if (skipLocked && s.locked) { skippedL++; return false; }
        if (skipConfirmed && s.confirmed) { skippedC++; return false; }
        return true;
      })
      .map((s) => ({ ...s, proposal: '', status_ui: 'new', approved: false, note: '' }));
    const total = (r.segments || []).length;
    const tagged = YC.cards.filter((c) => c.tagged).length;
    info('yc-harvest-info', `Harvested ${YC.cards.length} of ${total} segment(s)${tagged ? ` · ⚠ ${tagged} with tags` : ''}${skippedC ? ` · skipped ${skippedC} confirmed` : ''}${skippedL ? ` · skipped ${skippedL} locked` : ''}.`, 'good');
    $('yc-propose-card').hidden = YC.cards.length === 0;
    $('yc-review-card').hidden = true;
    ycRender();
    if (!YC.cards.length) info('yc-harvest-info', 'Nothing to harvest with these filters — untick the skip options to include confirmed/locked segments.', 'err');
  } catch (e) {
    info('yc-harvest-info', e.message, 'err');
  } finally { btn.disabled = false; }
}

async function ycPropose() {
  const key = await store.get('key', '');
  if (!key) { info('yc-propose-info', 'Add your OpenAI key in ⚙️ Settings first.', 'err'); return; }
  if (!YC.cards.length) { info('yc-propose-info', 'Harvest first.', 'err'); return; }
  const model = $('model').value, plural = $('plural').checked, mode = $('yc-mode').value;
  const btn = $('yc-propose'); btn.disabled = true;
  const B = 10; let done = 0, failed = 0;
  try {
    for (let i = 0; i < YC.cards.length; i += B) {
      const slice = YC.cards.slice(i, i + B);
      info('yc-propose-info', `✨ ${mode === 'translate' ? 'Translating' : 'Proofreading'} ${i + 1}–${Math.min(i + B, YC.cards.length)} of ${YC.cards.length}…`);
      const items = slice.map((c, j) => ({ i: j + 1, src: String(c.src || ''), tgt: String(c.tgt || '') }));
      try {
        const out = await gptBatch(items, mode, key, model, plural);
        out.forEach((o) => {
          const idx = (o.i | 0) - 1;
          if (idx >= 0 && idx < slice.length && o.text != null) {
            const c = slice[idx];
            c.proposal = polish(c.src, String(o.text));
            c.approved = true; c.status_ui = 'proposed'; done++;
          }
        });
      } catch (e) { failed += slice.length; ycLog('[gpt] batch failed: ' + e.message); }
    }
    info('yc-propose-info', `Proposed ${done}${failed ? ` · ${failed} failed` : ''}. Review, then Copy (or paste) into YiCAT.`, failed ? 'err' : 'good');
    $('yc-review-card').hidden = YC.cards.every((c) => !c.proposal);
    ycRender();
  } finally { btn.disabled = false; }
}

function ycCopyText(c) { return ycStripMarkers(c.proposal || ''); }

async function ycCopyAll() {
  const pending = YC.cards.filter((c) => c.approved && (c.proposal || '').trim());
  if (!pending.length) { info('yc-review-info', 'Nothing approved to copy.', 'err'); return; }
  const text = pending.map((c) => ycCopyText(c)).join('\n');
  await panelCopy(text, $('yc-copy-all'));
  info('yc-review-info', `Copied ${pending.length} proposal(s) — paste into YiCAT (one per line, in order).`, 'good');
}

async function ycWrite(i) {
  if (!YC.write) return;
  const c = YC.cards[i]; if (!c) return;
  const text = ycStripMarkers(c.proposal || '').trim();
  if (!text) { c.note = 'Nothing to write — no proposal.'; ycRender(); return; }
  if (c.tagged) { c.note = '⚠ has tags — auto-write skips tagged segments; paste it by hand.'; ycRender(); return; }
  c.status_ui = 'writing'; ycRender();
  try {
    const tracked = !$('yc-untracked') || !$('yc-untracked').checked;
    const r = await sendYC({ type: 'YC_WRITE', tracked, edits: [{ segId: c.segId, text }] });
    const res = r && r.results && r.results[0];
    if (res && res.ok) { c.status_ui = 'written'; const how = res.tracked ? 'tracked change' : 'untracked draft'; c.note = `✅ Written & verified in segment ${c.seq} (${how}) — review it in YiCAT, then confirm.`; ycLog(`wrote seg ${c.seq} (${c.segId}) [${how}]`); }
    else { c.status_ui = 'proposed'; c.note = '⚠ ' + ((res && res.error) || (r && r.error) || 'write failed'); ycLog(`write failed seg ${c.seq}: ${c.note}`); }
  } catch (e) { c.status_ui = 'proposed'; c.note = '⚠ ' + e.message; ycLog(`write failed seg ${c.seq}: ${e.message}`); }
  ycRender();
}

async function ycWriteAll() {
  if (!YC.write) { info('yc-review-info', 'Enable experimental auto-write first.', 'err'); return; }
  const pending = YC.cards.map((c, i) => ({ c, i })).filter(({ c }) => c.approved && (c.proposal || '').trim() && !c.tagged && c.status_ui !== 'written');
  if (!pending.length) { info('yc-review-info', 'Nothing approved & untagged to auto-write.', 'err'); return; }
  info('yc-review-info', `Auto-writing ${pending.length}…`);
  let n = 0;
  for (const { i } of pending) { await ycWrite(i); info('yc-review-info', `Auto-writing ${++n}/${pending.length}…`); }
  const ok = YC.cards.filter((c) => c.status_ui === 'written').length;
  const offscreen = YC.cards.filter((c) => c.status_ui !== 'written' && /not rendered|scroll/i.test(c.note || '')).length;
  info('yc-review-info', `Done · ${ok} written (draft). ${offscreen ? `${offscreen} weren't on screen — scroll to them in YiCAT and re-run. ` : ''}Review each and confirm.`, 'good');
}

function ycRender() {
  const box = $('yc-cards'); if (!box) return;
  box.innerHTML = YC.cards.map((c, i) => {
    const written = c.status_ui === 'written';
    const badge = written ? '<span class="lqc-badge b-valid">written</span>'
      : c.status_ui === 'writing' ? '<span class="lqc-warn">writing…</span>'
        : c.proposal ? '<span class="lqc-badge b-invalid">proposed</span>' : '';
    const tag = c.tagged ? '<span class="lqc-warn" title="has inline tags ①②③ — paste by hand">⚑ tags</span>' : '';
    const canWrite = YC.write && c.proposal && !c.tagged && !written;
    return `<div class="lqc wbc">
      <div class="lqc-top"><span class="lqc-seg">#${c.seq}</span>${tag}${badge}</div>
      <div class="lqc-lbl">Source (EN)</div><div class="lqc-src" dir="ltr">${hl(esc(c.src))}</div>
      ${c.tgt ? `<div class="lqc-lbl">Current Hebrew</div><div class="lqc-tgt" dir="rtl">${hl(esc(c.tgt))}</div>` : ''}
      ${c.proposal ? `<div class="lqc-lbl">GPT proposal</div><div class="lqc-new" dir="rtl">${hl(esc(c.proposal))}</div>` : ''}
      ${c.note ? `<div class="lqc-rat">${esc(c.note)}</div>` : ''}
      <div class="lqc-acts wb-acts">
        <label class="ck" style="margin:0 8px 0 0"><input type="checkbox" data-yc-appr="${i}" ${c.approved ? 'checked' : ''}/> approve</label>
        <button class="lqc-copy${c.proposal ? '' : ' ghost'}" data-yc-copy="${i}">⧉ Copy</button>
        ${YC.write ? `<button class="lqc-copy${canWrite ? '' : ' ghost'}" data-yc-write="${i}" ${canWrite ? '' : 'disabled'}>⤵ Write</button>` : ''}
      </div>
    </div>`;
  }).join('') || '<div class="info">Harvest a task to begin.</div>';
  box.querySelectorAll('[data-yc-copy]').forEach((b) => b.addEventListener('click', () => panelCopy(ycCopyText(YC.cards[+b.dataset.ycCopy]), b)));
  box.querySelectorAll('[data-yc-write]').forEach((b) => b.addEventListener('click', () => ycWrite(+b.dataset.ycWrite)));
  box.querySelectorAll('[data-yc-appr]').forEach((b) => b.addEventListener('change', () => { YC.cards[+b.dataset.ycAppr].approved = b.checked; }));
  const ok = YC.cards.filter((c) => c.status_ui === 'written').length;
  if ($('yc-count')) $('yc-count').textContent = YC.write ? `${ok}/${YC.cards.length} written` : `${YC.cards.length} ready to copy`;
}

function setMode(m) {
  const views = { starling: 'view-starling', lqa: 'view-lqa', wb: 'view-wb', crowdin: 'view-crowdin', memoq: 'view-memoq', yicat: 'view-yicat', pay: 'view-pay' };
  const btns = { starling: 'mode-starling', lqa: 'mode-lqa', wb: 'mode-wb', crowdin: 'mode-crowdin', memoq: 'mode-memoq', yicat: 'mode-yicat', pay: 'mode-pay' };
  if (!views[m]) m = 'starling';
  Object.keys(views).forEach((k) => { $(views[k]).hidden = k !== m; $(btns[k]).classList.toggle('active', k === m); });
  store.set({ mode_ui: m });
}

// ---- 💰 Weighted word count & pay -----------------------------------------
// Reads Starling "My tasks" via /api/task/getMyTasks (offset/limit paging — pageNum is
// ignored server-side; offset+limit works). The displayed "Weighted word count" column is
// weightingWordCountV2. Sums it and multiplies by the editing rate. Fetch runs in the active
// Starling tab's context (same-origin cookie) via executeScript — no content.js dependency.
const PC = { rows: null, dateFields: [], dateField: '' };
const PC_STATUS = { 1: 'In progress', 2: 'Submitted', 4: 'To be claimed' };   // Closed (3) is excluded from the word count entirely
function pcInfo(m, k) { info('pc-info', m, k || ''); }
// Guess which detected date column is the "first submitted" one (most→least specific).
function pcPickDateField(fields) {
  const pri = [/first.*submit/i, /submit.*first/i, /firstsubmit/i, /submit/i, /deliver/i, /finish/i, /complete/i, /update/i, /create/i];
  for (const rx of pri) { const f = (fields || []).find((x) => rx.test(x)); if (f) return f; }
  return (fields && fields[0]) || '';
}
// Fill the "By month of <field>" dropdown from the detected date columns (hidden if none).
function pcFillDateSel() {
  const sel = $('pc-datefield'), wrap = $('pc-datewrap'); if (!sel) return;
  if (!PC.dateFields || !PC.dateFields.length) { if (wrap) wrap.hidden = true; sel.innerHTML = ''; return; }
  sel.innerHTML = PC.dateFields.map((f) => `<option value="${esc(f)}"${f === PC.dateField ? ' selected' : ''}>${esc(f)}</option>`).join('');
  if (wrap) wrap.hidden = false;
}
async function pcFetch() {
  const t = await wbActiveTab();
  if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) { pcInfo('Open any starling.bytedance.com tab (e.g. My tasks), then Compute.', 'err'); return; }
  if ($('pc-run')) $('pc-run').disabled = true; pcInfo('Reading My tasks…');
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: t.id },
      func: async () => {
        // A value is a date iff it lands in a sane year window (2000–2100). Handles epoch
        // seconds (10-digit) / ms (13-digit), numeric or string, and ISO/parseable strings.
        const parseDate = (v) => {
          if (v == null) return null;
          if (typeof v === 'number' && isFinite(v)) { const ms = v < 1e12 ? v * 1000 : v; const y = new Date(ms).getFullYear(); return (y >= 2000 && y <= 2100) ? ms : null; }
          if (typeof v === 'string' && v.trim()) {
            const s = v.trim();
            if (/^\d{10}$/.test(s)) { const ms = Number(s) * 1000, y = new Date(ms).getFullYear(); return (y >= 2000 && y <= 2100) ? ms : null; }
            if (/^\d{13}$/.test(s)) { const ms = Number(s), y = new Date(ms).getFullYear(); return (y >= 2000 && y <= 2100) ? ms : null; }
            const t2 = Date.parse(s); if (!isNaN(t2)) { const y = new Date(t2).getFullYear(); return (y >= 2000 && y <= 2100) ? t2 : null; }
          }
          return null;
        };
        try {
          const res = await fetch('/api/task/getMyTasks?offset=0&limit=5000&progress=all&translateTypeList=%5B%5D&_=' + Date.now(), { credentials: 'include', cache: 'no-store' });
          const j = await res.json(); const d = j.data || {};
          const rows = (d.rows || []).map((x) => {
            const dates = {};   // every field on the task row that parses as a date → epoch ms
            for (const k of Object.keys(x)) { const dd = parseDate(x[k]); if (dd != null) dates[k] = dd; }
            return { s: x.taskStatus, w: Number(x.weightingWordCountV2) || 0, dates };
          });
          return { ok: true, count: d.count, rows };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }
    });
    const out = r && r.result;
    if (!out || !out.ok) throw new Error((out && out.error) || 'fetch failed');
    PC.rows = (out.rows || []).filter((r) => String(r.s) !== '3');   // drop Closed tasks — never counted
    // Union of date-like field names across rows; default to the one that looks like "first submitted".
    const fset = new Set(); for (const r of PC.rows) for (const k of Object.keys(r.dates || {})) fset.add(k);
    PC.dateFields = [...fset].sort();
    PC.dateField = pcPickDateField(PC.dateFields);
    pcFillDateSel();
    pcInfo(`Loaded ${PC.rows.length} translation task(s) from My tasks (Closed excluded).`, 'good');
    pcRender();
  } catch (e) { pcInfo('Could not read My tasks — reload the extension, make sure a Starling tab is active, then try again. (' + e.message + ')', 'err'); }
  finally { if ($('pc-run')) $('pc-run').disabled = false; }
}
function pcRender() {
  if (!PC.rows) return;
  const rate = Number($('pc-rate').value) || 0;
  const sel = $('pc-status').value;
  const rows = sel === 'all' ? PC.rows : PC.rows.filter((r) => String(r.s) === sel);
  const n = rows.length;
  const weighted = rows.reduce((a, r) => a + r.w, 0);
  const fmt = (x) => x.toLocaleString('en-US', { maximumFractionDigits: 1 });
  const money = (x) => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const by = {};
  for (const r of PC.rows) { by[r.s] = by[r.s] || { n: 0, w: 0 }; by[r.s].n++; by[r.s].w += r.w; }
  const brk = Object.keys(by).sort().map((k) =>
    `<tr${String(k) === sel ? ' style="font-weight:700"' : ''}><td>${esc(PC_STATUS[k] || 'Status ' + k)}</td><td style="text-align:right">${by[k].n}</td><td style="text-align:right">${fmt(by[k].w)}</td><td style="text-align:right">${money(by[k].w * rate)}</td></tr>`).join('');
  // Monthly breakdown by the chosen date column (respects the Tasks status filter).
  let monthly = '';
  if (PC.dateField && PC.dateFields && PC.dateFields.length) {
    const mb = new Map();   // 'YYYY-MM' -> {n,w}; '' bucket = rows with no value for this field
    for (const r of rows) {
      const ms = r.dates && r.dates[PC.dateField];
      let key = '';
      if (ms) { const d = new Date(ms); key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
      if (!mb.has(key)) mb.set(key, { n: 0, w: 0 });
      const b = mb.get(key); b.n++; b.w += r.w;
    }
    const keys = [...mb.keys()].filter(Boolean).sort();
    const monthLabel = (k) => { const [y, m] = k.split('-'); return new Date(Number(y), Number(m) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }); };
    const mrows = keys.map((k) => `<tr><td>${monthLabel(k)}</td><td style="text-align:right">${mb.get(k).n}</td><td style="text-align:right">${fmt(mb.get(k).w)}</td><td style="text-align:right">${money(mb.get(k).w * rate)}</td></tr>`).join('');
    const nd = mb.get('');
    const ndRow = nd ? `<tr style="opacity:.6"><td>(no ${esc(PC.dateField)})</td><td style="text-align:right">${nd.n}</td><td style="text-align:right">${fmt(nd.w)}</td><td style="text-align:right">${money(nd.w * rate)}</td></tr>` : '';
    monthly =
      `<table style="width:100%;margin-top:14px;border-collapse:collapse;font-size:.92em">
         <thead><tr style="text-align:left;border-bottom:1px solid #8884"><th>Month</th><th style="text-align:right">Tasks</th><th style="text-align:right">Weighted</th><th style="text-align:right">Pay</th></tr></thead>
         <tbody>${mrows || `<tr><td colspan="4" class="hint">No dated tasks in this filter.</td></tr>`}${ndRow}</tbody>
       </table>
       <div class="hint" style="margin-top:6px">Grouped by month of <b>${esc(PC.dateField)}</b> (auto-detected date column — switch it in <b>By month of</b> above if that isn't “first submitted”). Respects the Tasks filter.</div>`;
  }
  $('pc-out').hidden = false;
  $('pc-out').innerHTML =
    `<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:baseline;font-weight:600">
       <div><span style="font-size:1.7em">${n}</span> tasks summed</div>
       <div><span style="font-size:1.7em">${fmt(weighted)}</span> weighted words</div>
       <div>× ${rate} = <span style="font-size:1.7em;color:#1a7f37">${money(weighted * rate)}</span></div>
     </div>
     <table style="width:100%;margin-top:10px;border-collapse:collapse;font-size:.92em">
       <thead><tr style="text-align:left;border-bottom:1px solid #8884"><th>Status</th><th style="text-align:right">Tasks</th><th style="text-align:right">Weighted</th><th style="text-align:right">Pay</th></tr></thead>
       <tbody>${brk}</tbody>
     </table>
     ${monthly}
     <div class="hint" style="margin-top:6px">Sums the <b>Weighted word count</b> column (weightingWordCountV2). Translation tasks only; bold row = current filter.</div>`;
}

// ---- 📦 CORPUS BUILDER (singular lane) ------------------------------------
// Batch-reads every SUBMITTED task's proofread-confirmed segments, aggregates
// identical sources with occurrence + task-spread counts, classifies how
// consistently you translated each, and promotes the reliable pairs into
// Consistency memory (+ proposes short Locked terms). Reads via same-origin
// fetch in the active Starling tab (executeScript, like 💰 Word count) —
// panel-only, no content.js, no GPT, $0. Plural lane comes later.
// Persisted as `corpusIndex` = { builtAt, taskCount, pairCount, tasksSeen, sources }.
const CB = { index: null, buckets: null, cand: null, building: false };
const CB_MAJORITY = 0.8;   // "dominant" = the top target holds ≥ this share
function cbInfo(m, k) { info('cb-info', m, k || ''); }
function cbBadge() {
  const el = $('cb-badge'); if (!el) return;
  const ix = CB.index;
  el.textContent = (ix && ix.taskCount) ? `· ${ix.taskCount} tasks · ${Object.keys(ix.sources || {}).length} sources` : '· not built';
}
// Enumerate Submitted tasks (taskStatus 2) — same getMyTasks read the word count uses.
async function cbFetchMyTasks(tabId) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      try {
        const res = await fetch('/api/task/getMyTasks?offset=0&limit=5000&progress=all&translateTypeList=%5B%5D&_=' + Date.now(), { credentials: 'include', cache: 'no-store' });
        const j = await res.json(); const d = j.data || {};
        // subtaskId is the id the editor/content endpoints use (the sibling taskId is often 0).
        // taskType 1 = Document editor, 2 = String editor. createTime = unix SECONDS (string).
        const rows = (d.rows || []).map((x) => ({ id: String(x.subtaskId || x.subTaskId || x.id || ''), name: x.taskName || '', status: x.taskStatus, taskType: x.taskType, createTime: Number(x.createTime) || 0 }));
        return { ok: true, rows };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
  });
  const out = r && r.result;
  if (!out || !out.ok) throw new Error((out && out.error) || 'getMyTasks failed');
  // Submitted (status 2) always; In-progress (status 1) too when the toggle is on — those are
  // then gated by a ≥95% confirmed ratio measured per task during harvest.
  const inProg = $('cb-inprogress') && $('cb-inprogress').checked;
  let rows = (out.rows || []).filter((x) => x.id && (String(x.status) === '2' || (inProg && String(x.status) === '1')));
  // Optional 📅 "created on/after" filter: learn only from tasks created on or after the chosen
  // day. createTime is unix SECONDS; the input is a local YYYY-MM-DD (see cbSinceUnix).
  const since = cbSinceUnix();
  if (since) rows = rows.filter((x) => x.createTime && x.createTime >= since);
  return rows;
}
// Parse the corpus 📅 "created on/after" input → unix SECONDS at local midnight (0 if unset/invalid).
function cbSinceUnix() {
  const el = $('cb-since'); if (!el || !el.value) return 0;
  const ms = new Date(el.value + 'T00:00:00').getTime();   // local midnight of the chosen day
  return isNaN(ms) ? 0 : Math.floor(ms / 1000);
}
// Harvest a chunk of tasks → { [id]: { pairs:[{src,tgt,key}], plurals, total, confirmed } | { error } }.
// Confirmed (status 3), non-empty only. String-editor tasks (taskType 2) go through the content API
// (getSourceTextListWithTargetText, with the plural/textExtra lane). Document-editor tasks (taskType 1)
// 1002 on that API, so they read from getDocTaskDetailOnline instead (data.segmentInfo.segments →
// Source.Text / Target.Text, per-segment Status; that endpoint needs task-id/task-type/starling-origin
// headers, which the doc editor itself sends). A task the string API 1002s on is retried as a doc task,
// so a wrong/missing taskType still resolves. Takes the task objects (need id + taskType), not bare ids.
async function cbFetchTasks(tasks, tabId) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, args: [tasks],
    func: async (tasks) => {
      const STR_URL = 'https://starling.bytedance.com/api/text/getSourceTextListWithTargetText';
      const DOC_URL = 'https://starling.bytedance.com/api/editor/getDocTaskDetailOnline';
      // Non-empty CLDR forms from a textExtra field ({zero,one,two,few,many,other}).
      const formsOf = (o) => { const e = o && o.textExtra; if (!e) return {}; let v; try { v = typeof e === 'string' ? JSON.parse(e) : e; } catch (_) { return {}; } if (!v || typeof v !== 'object') return {}; const out = {}; for (const k of Object.keys(v)) { const val = String(v[k] == null ? '' : v[k]); if (val.trim()) out[k] = val; } return out; };
      const txt = (o) => (o ? (o.Text != null ? o.Text : (o.text != null ? o.text : '')) : '');
      async function readString(id) {
        const res = await fetch(STR_URL + '?limit=10000&sortType=1&offset=0&editMode=dual&taskId=' + encodeURIComponent(id), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
        if (!res.ok) return { httpError: res.status };
        const j = await res.json(); return { sc: j && j.status_code, j };
      }
      async function readDoc(id) {
        const res = await fetch(DOC_URL + '?docTaskId=' + encodeURIComponent(id), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json', 'content-type': 'application/json', 'starling-origin': 'https://starling.bytedance.com', 'task-id': String(id), 'task-type': 1 } });
        if (!res.ok) return { httpError: res.status };
        const j = await res.json(); return { sc: j && j.status_code, j };
      }
      function parseString(j) {
        const rows = (j.data && j.data.rows) || [];
        const pairs = [], plurals = []; let confirmed = 0;
        for (const row of rows) {
          const s = row.sourceText || {}, t = row.targetText || (s.targetTexts && s.targetTexts[0]) || {};
          if (t.status === 3) confirmed++;
          const sf = formsOf(s), tf = formsOf(t);
          if (Object.keys(sf).length || Object.keys(tf).length) {   // plural row → plural lane
            if (t.status === 3 && Object.keys(sf).length && Object.keys(tf).length) plurals.push({ srcForms: sf, tgtForms: tf, key: s.key || '' });
            continue;
          }
          if (t.status !== 3) continue;               // proofread-confirmed only
          const src = s.content == null ? '' : String(s.content), tgt = t.content == null ? '' : String(t.content);
          if (!src.trim() || !tgt.trim()) continue;
          pairs.push({ src, tgt, key: s.key || '' });
        }
        return { pairs, plurals, total: rows.length, confirmed };
      }
      function parseDoc(j) {
        const d = j.data || {};
        const segs = (d.segmentInfo && d.segmentInfo.segments) || d.segments || [];
        const pairs = []; let confirmed = 0;   // the doc detail has no CLDR plural lane
        for (const sg of segs) {
          const st = (sg.Status != null ? sg.Status : sg.status);
          if (st === 3) confirmed++;
          if (st !== 3) continue;                     // proofread-confirmed only
          const src = String(txt(sg.Source) || txt(sg.source) || '').trim();
          const tgt = String(txt(sg.Target) || txt(sg.target) || '').trim();
          if (!src || !tgt) continue;
          pairs.push({ src, tgt, key: sg.SegmentID || sg.segmentID || '' });
        }
        return { pairs, plurals: [], total: segs.length, confirmed };
      }
      const out = {};
      for (const task of tasks) {
        const id = task.id;
        try {
          if (String(task.taskType) !== '1') {          // treat as a String-editor task first
            const r1 = await readString(id);
            if (r1.httpError) { out[id] = { error: 'HTTP ' + r1.httpError }; continue; }
            if (r1.sc === 1000) { out[id] = parseString(r1.j); continue; }
            if (r1.sc !== 1002) { out[id] = { error: 'sc ' + r1.sc }; continue; }
            // sc 1002 → no permission on the string API = it's really a Document-editor task; fall through
          }
          const r2 = await readDoc(id);                 // Document-editor task
          if (r2.httpError) { out[id] = { error: 'HTTP ' + r2.httpError }; continue; }
          if (r2.sc !== 1000) { out[id] = { error: 'doc sc ' + r2.sc }; continue; }
          out[id] = parseDoc(r2.j);
        } catch (e) { out[id] = { error: String((e && e.message) || e) }; }
      }
      return out;
    }
  });
  return (r && r.result) || {};
}
// Fold one task's pairs into the index (source → variants with counts + task-spread).
function cbAgg(index, id, pairs) {
  for (const p of pairs) {
    const k = tmKey(p.src); if (!k) continue;
    let e = index.sources[k]; if (!e) e = index.sources[k] = { src: p.src, total: 0, variants: [] };
    e.total++;
    const tk = wbFold(p.tgt);
    let v = e.variants.find((x) => wbFold(x.tgt) === tk);
    if (!v) { v = { tgt: p.tgt, n: 0, tasks: {} }; e.variants.push(v); }
    v.n++; v.tasks[id] = 1;
  }
}
// --- plural lane: key on the representative source form; a variant is a whole CLDR set ---
function cbPlKey(srcForms) { return wbFold(String((srcForms && (srcForms.other || srcForms.one)) || (srcForms && Object.values(srcForms)[0]) || '')); }
function cbFormSig(forms) { return Object.keys(forms || {}).sort().map((k) => k + '=' + wbFold(forms[k])).join('|'); }
function cbAggPlural(index, id, plurals) {
  if (!index.plurals) index.plurals = {};
  for (const p of plurals) {
    const k = cbPlKey(p.srcForms); if (!k) continue;
    let e = index.plurals[k]; if (!e) e = index.plurals[k] = { srcForms: p.srcForms, total: 0, variants: [] };
    e.total++;
    const sig = cbFormSig(p.tgtForms);
    let v = e.variants.find((x) => x.sig === sig);
    if (!v) { v = { forms: p.tgtForms, sig, n: 0, tasks: {} }; e.variants.push(v); }
    v.n++; v.tasks[id] = 1;
  }
}
// ---- PLURAL MEMORY (PM): remembered CLDR form-sets, read by the 🔢 Plurals tool ----
let PM = { map: {}, updatedAt: 0 };
async function pmLoad() { try { PM = await store.get('pluralMemory', { map: {}, updatedAt: 0 }); } catch (e) {} if (!PM || !PM.map) PM = { map: {}, updatedAt: 0 }; return PM; }
async function pmSave() { PM.updatedAt = Date.now(); try { await store.set({ pluralMemory: PM }); } catch (e) {} }
function pmCount() { return PM && PM.map ? Object.keys(PM.map).length : 0; }
function pmLookup(srcForms) { const k = cbPlKey(srcForms); return (k && PM.map[k]) ? PM.map[k] : null; }
function pmRecord(srcForms, forms) { const k = cbPlKey(srcForms); if (!k || !forms || !Object.keys(forms).length) return false; const prev = PM.map[k]; PM.map[k] = { srcForms, forms, ts: Date.now(), n: (prev ? prev.n || 1 : 0) + 1 }; return true; }
async function cbBuild(opts) {
  if (CB.building) return;
  CB.building = true;
  if ($('cb-build')) $('cb-build').disabled = true;
  if ($('cb-update')) $('cb-update').disabled = true;
  try {
    const t = await wbActiveTab();
    if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) { cbInfo('Open a starling.bytedance.com tab (e.g. My tasks), then Build.', 'err'); return; }
    cbInfo('Reading My tasks…');
    const tasks = await cbFetchMyTasks(t.id);
    if (!tasks.length) { const el = $('cb-since'); cbInfo('No Submitted tasks found (only taskStatus 2 is harvested)' + (el && el.value ? ` created on/after ${el.value} — clear the 📅 date to widen` : '') + '.', 'err'); return; }
    // ⟳ Update passes {force:false} so it can never trigger a from-scratch rebuild, whatever
    // the checkbox says; 📦 Build (no opts) honours the checkbox as before.
    const force = (opts && opts.force != null) ? opts.force : ($('cb-force') && $('cb-force').checked);
    const prior = force ? null : await store.get('corpusIndex', null);
    const index = (prior && prior.sources) ? prior : { builtAt: 0, taskCount: 0, pairCount: 0, tasksSeen: {}, sources: {}, plurals: {} };
    if (!index.sources) index.sources = {}; if (!index.tasksSeen) index.tasksSeen = {}; if (!index.plurals) index.plurals = {};
    const todo = tasks.filter((x) => force || !index.tasksSeen[x.id]);
    if (!todo.length) { CB.index = index; cbClassify(); cbRender(); cbBadge(); clBadge(); cbInfo(`Corpus already covers all ${tasks.length} Submitted task(s) — nothing new. Tick “Rebuild” to redo from scratch.`, 'good'); return; }
    const CH = 6; let done = 0, failed = 0, skippedWip = 0;
    if ($('cb-bar')) $('cb-bar').style.width = '0%';
    for (let i = 0; i < todo.length; i += CH) {
      const chunk = todo.slice(i, i + CH);
      const res = await cbFetchTasks(chunk, t.id);   // pass task objects (cbFetchTasks needs taskType)
      for (const task of chunk) {
        const rr = res[task.id];
        if (!rr || rr.error) { failed++; continue; }
        // In-progress tasks only fold in once they're ≥95% confirmed; below that, skip AND don't
        // record them, so a later build re-checks the task when it has progressed further.
        if (String(task.status) === '1') {
          const ratio = rr.total ? (rr.confirmed || 0) / rr.total : 0;
          if (ratio < 0.95) { skippedWip++; continue; }
        }
        cbAgg(index, task.id, rr.pairs || []);
        cbAggPlural(index, task.id, rr.plurals || []);
        index.tasksSeen[task.id] = { name: task.name, ts: Date.now(), pairs: (rr.pairs || []).length, plurals: (rr.plurals || []).length, wip: String(task.status) === '1' };
        done++;
      }
      if ($('cb-bar')) $('cb-bar').style.width = Math.round(Math.min(i + CH, todo.length) / todo.length * 100) + '%';
      cbInfo(`Harvesting… ${Math.min(i + CH, todo.length)}/${todo.length} task(s)${failed ? ` · ${failed} failed` : ''}`, '');
      if (i % (CH * 5) === 0) { index.builtAt = Date.now(); try { await store.set({ corpusIndex: index }); } catch (e) {} }   // checkpoint (resumable)
      await new Promise((r) => setTimeout(r, 150));
    }
    index.builtAt = Date.now();
    index.taskCount = Object.keys(index.tasksSeen).length;
    index.pairCount = Object.values(index.tasksSeen).reduce((a, x) => a + (x.pairs || 0), 0);
    try { await store.set({ corpusIndex: index }); } catch (e) {}
    CB.index = index; cbClassify(); cbRender(); cbBadge(); clBadge();
    cbInfo(`Done — harvested ${done} new task(s)${skippedWip ? ` · ${skippedWip} in-progress skipped (<95%)` : ''}${failed ? ` · ${failed} failed` : ''}. ${Object.keys(index.sources).length} unique sources. Review below, then Apply.`, 'good');
  } catch (e) { cbInfo('Build failed: ' + (e.message || e), 'err'); }
  finally {
    CB.building = false;
    if ($('cb-build')) $('cb-build').disabled = false;
    if ($('cb-update')) $('cb-update').disabled = false;
  }
  cbNewCheck();   // re-count "new since build" (now 0, unless a task was submitted mid-build)
}
// ---- "new since last build" check --------------------------------------------
// Best-effort, lazy: only runs when a starling.bytedance.com tab is active (it needs the
// live session to read My tasks). Compares the Submitted list against index.tasksSeen and
// surfaces how many tasks the corpus hasn't absorbed yet. Never throws into the UI.
let cbChecking = false;
function cbNewSet(n) {
  const el = $('cb-new'); if (!el) return;
  if (n == null) { el.hidden = true; el.textContent = ''; el.className = 'info'; return; }   // couldn't check (not on a Starling tab)
  el.hidden = false;
  if (n === 0) { el.textContent = '✓ Corpus is up to date — no new Submitted tasks.'; el.className = 'info good'; }
  else { el.textContent = `🆕 ${n} new Submitted task${n === 1 ? '' : 's'} not in the corpus — click ⟳ Update to add ${n === 1 ? 'it' : 'them'}.`; el.className = 'info cb-hot'; }
}
async function cbNewCheck() {
  if (cbChecking || CB.building) return;
  cbChecking = true;
  try {
    const t = await wbActiveTab();
    if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) { cbNewSet(null); return; }   // can't read My tasks from here
    const tasks = await cbFetchMyTasks(t.id);
    const seen = (CB.index && CB.index.tasksSeen) || {};
    cbNewSet(tasks.filter((x) => !seen[x.id]).length);
  } catch (e) { cbNewSet(null); }
  finally { cbChecking = false; }
}
// Classify one source into a consistency bucket.
function cbBucketOf(e) {
  const vs = e.variants.slice().sort((a, b) => b.n - a.n);
  const total = e.total, top = vs[0], distinct = vs.length;
  const topShare = total ? top.n / total : 0;
  const topTasks = Object.keys(top.tasks || {}).length;
  let bucket;
  if (distinct === 1 && total === 1) bucket = 'singleton';
  else if (distinct === 1) bucket = 'unanimous';
  else if (topShare >= CB_MAJORITY && topTasks >= 2) bucket = 'dominant';
  else bucket = 'contested';
  return { bucket, vs, top, distinct, total, topShare, topTasks };
}
// Short, term-like source worth PROPOSING as a Locked term (never a whole sentence).
function cbTermLike(src) {
  const s = String(src || '').trim(); if (!s) return false;
  const words = s.split(/\s+/);
  if (words.length > 4) return false;
  if (/[.?!:;]$/.test(s)) return false;
  if (/[{}<>%]/.test(s)) return false;   // no placeholders/tags
  return /[A-Za-z]/.test(s);
}
function cbClassify() {
  const idx = CB.index; if (!idx) return;
  const buckets = { unanimous: [], dominant: [], contested: [], singleton: [] };
  const cand = []; let resolved = 0;
  for (const k of Object.keys(idx.sources)) {
    const e = idx.sources[k], c = cbBucketOf(e);
    // Hide contested items you've already decided — the source is now in Consistency memory,
    // so re-adjudicating is pointless. Counted so the header can say how many were hidden.
    if (c.bucket === 'contested' && TM.map && TM.map[k]) { resolved++; continue; }
    buckets[c.bucket].push({ key: k, src: e.src, vs: c.vs, top: c.top, total: c.total, topShare: c.topShare, topTasks: c.topTasks });
    if ((c.bucket === 'unanimous' || c.bucket === 'dominant') && c.topTasks >= 2 && cbTermLike(e.src)) cand.push({ key: k, en: e.src, he: c.top.tgt, tasks: c.topTasks });
  }
  for (const b of Object.keys(buckets)) buckets[b].sort((a, z) => z.topTasks - a.topTasks || z.total - a.total);
  cand.sort((a, z) => z.tasks - a.tasks);
  CB.buckets = buckets; CB.cand = cand; CB.resolvedContested = resolved;
  cbClassifyPlural();
}
// Classify the plural form-sets (variant = a whole CLDR set), reusing cbBucketOf.
function cbClassifyPlural() {
  const idx = CB.index; CB.pbuckets = null;
  if (!idx || !idx.plurals || !Object.keys(idx.plurals).length) return;
  const buckets = { unanimous: [], dominant: [], contested: [], singleton: [] };
  for (const k of Object.keys(idx.plurals)) {
    const e = idx.plurals[k], c = cbBucketOf(e);
    if (c.bucket === 'contested' && PM.map && PM.map[k]) continue;   // already resolved into Plural memory → hide
    buckets[c.bucket].push({ key: k, srcForms: e.srcForms, vs: c.vs, top: c.top, total: c.total, topShare: c.topShare, topTasks: c.topTasks });
  }
  for (const b of Object.keys(buckets)) buckets[b].sort((a, z) => z.topTasks - a.topTasks || z.total - a.total);
  CB.pbuckets = buckets;
}
function cbRender() {
  const b = CB.buckets, idx = CB.index; if (!b || !idx) return;
  const consistent = b.unanimous.length + b.dominant.length + b.singleton.length;
  const pb = CB.pbuckets, plN = idx.plurals ? Object.keys(idx.plurals).length : 0;
  if ($('cb-summary')) {
    $('cb-summary').hidden = false;
    $('cb-summary').innerHTML = `<b>${idx.taskCount}</b> tasks · <b>${idx.pairCount}</b> confirmed pairs · <b>${Object.keys(idx.sources).length}</b> unique sources → ` +
      `${b.unanimous.length} unanimous · ${b.dominant.length} dominant · ${b.contested.length} contested · ${b.singleton.length} singleton` +
      (plN ? ` · <b>${plN}</b> plural set${plN === 1 ? '' : 's'}` : '');
  }
  const rev = $('cb-review'); if (!rev) return; rev.hidden = false;
  let html = `<div class="cb-sec"><div class="cb-h">✅ Consistent — ${consistent} pair(s) ready for memory</div>` +
    `<div class="hint">Unanimous + dominant (≥${Math.round(CB_MAJORITY * 100)}%) + singletons. Adds them to Consistency memory; a clash with an existing entry goes to the orange ⚠ card. A memory backup downloads first.</div>` +
    `<button id="cb-promote" class="btn sm"${consistent ? '' : ' disabled'}>➕ Promote ${consistent} to memory</button></div>`;
  if (b.contested.length || CB.resolvedContested) {
    html += `<div class="cb-sec"><div class="cb-h">⚖️ Contested — ${b.contested.length} · pick the canonical${CB.resolvedContested ? ` <span class="hint">(${CB.resolvedContested} already resolved — hidden)</span>` : ''}</div>` +
      b.contested.slice(0, 150).map((r, i) => `<div class="cb-item"><div class="cb-src" dir="ltr">${esc(r.src)}</div>` +
        r.vs.slice(0, 5).map((v, j) => `<label class="cb-opt"><input type="radio" name="cbc-${i}" value="${j}"${j === 0 ? ' checked' : ''}/> <span dir="rtl">${esc(v.tgt)}</span> <span class="hint">×${v.n} · ${Object.keys(v.tasks).length} task(s)</span></label>`).join('') +
        `</div>`).join('') +
      `<button id="cb-contested-apply" class="btn sm">➕ Add chosen to memory</button>` +
      (b.contested.length > 150 ? `<div class="hint">Showing 150 of ${b.contested.length}.</div>` : '') + `</div>`;
  }
  if (CB.cand.length) {
    html += `<div class="cb-sec"><div class="cb-h">🔒 Locked-term candidates — ${CB.cand.length}</div>` +
      `<div class="hint">Short, consistent terms across many tasks. Check any to also lock (mandatory).</div>` +
      CB.cand.slice(0, 150).map((c, i) => `<label class="cb-opt"><input type="checkbox" class="cb-lk" data-i="${i}"/> <span dir="ltr">${esc(c.en)}</span> → <span dir="rtl">${esc(c.he)}</span> <span class="hint">${c.tasks} task(s)</span></label>`).join('') +
      `<button id="cb-lock-apply" class="btn sm">🔒 Lock checked terms</button></div>`;
  }
  // --- plural lane sections ---
  if (pb) {
    const fmtSet = (forms) => Object.keys(forms).map((f) => `<span class="fz-src"><b>${esc(f)}</b> </span><span dir="rtl">${esc(forms[f])}</span>`).join(' · ');
    const plConsistent = pb.unanimous.length + pb.dominant.length + pb.singleton.length;
    html += `<div class="cb-sec"><div class="cb-h">🔢 Plural sets — ${plConsistent} consistent · ${pb.contested.length} contested</div>` +
      `<div class="hint">Each CLDR form-set (one/two/many/other) as a unit. Promote feeds the 🔢 Plurals tool so a remembered plural pre-fills instead of asking GPT. Clashes go to the orange ⚠ card.</div>` +
      `<button id="cb-pl-promote" class="btn sm"${plConsistent ? '' : ' disabled'}>➕ Promote ${plConsistent} plural set(s)</button>`;
    if (pb.contested.length) {
      html += `<div style="margin-top:8px"></div>` +
        pb.contested.slice(0, 60).map((r, i) => `<div class="cb-item"><div class="cb-src" dir="ltr">${esc((r.srcForms.other || r.srcForms.one || ''))}</div>` +
          r.vs.slice(0, 4).map((v, j) => `<label class="cb-opt"><input type="radio" name="cbp-${i}" value="${j}"${j === 0 ? ' checked' : ''}/> <span class="fz-body">${fmtSet(v.forms)}</span> <span class="hint">×${v.n} · ${Object.keys(v.tasks).length} task(s)</span></label>`).join('') +
          `</div>`).join('') +
        `<button id="cb-pl-contested-apply" class="btn sm">➕ Add chosen plural sets</button>` +
        (pb.contested.length > 60 ? `<div class="hint">Showing 60 of ${pb.contested.length}.</div>` : '');
    }
    html += `</div>`;
  }
  rev.innerHTML = html;
  if ($('cb-promote')) $('cb-promote').addEventListener('click', cbPromote);
  if ($('cb-contested-apply')) $('cb-contested-apply').addEventListener('click', cbApplyContested);
  if ($('cb-lock-apply')) $('cb-lock-apply').addEventListener('click', cbApplyLocked);
  if ($('cb-pl-promote')) $('cb-pl-promote').addEventListener('click', cbPromotePlural);
  if ($('cb-pl-contested-apply')) $('cb-pl-contested-apply').addEventListener('click', cbApplyContestedPlural);
}
// Shared memory-write with conflict routing (mirrors hvToMemory).
function cbWritePairs(list) {   // list: [{key, src, tgt}]
  let added = 0, matched = 0, fixed = 0; const clashes = [];
  const parked = new Set(CONF.filter((c) => c.kind === 'mem').map((c) => c.srcKey + '⇢' + wbFold(c.newVal)));
  for (const r of list) {
    // Auto-fix protection: normalize the historical target to your CURRENT style (e.g. an old
    // plural imperative → your slash form) BEFORE it enters memory, so promoting years of tasks
    // can't re-introduce a style you've moved away from.
    let tgt = r.tgt;
    if (FIX && FIX.enabled) { const res = fixApplyText(tgt); if (res.text !== tgt) { tgt = res.text; fixed++; } }
    const k = r.key, prev = TM.map[k];
    if (prev && wbFold(prev.tgt) !== wbFold(tgt)) {
      const sig = k + '⇢' + wbFold(tgt);
      if (!parked.has(sig)) { parked.add(sig); clashes.push({ kind: 'mem', label: r.src, srcKey: k, src: r.src, oldVal: prev.tgt, newVal: tgt }); }
      continue;
    }
    if (prev) matched++; else { tmRecordOne(r.src, tgt); added++; }
  }
  return { added, matched, fixed, clashes };
}
async function cbPromote() {
  const b = CB.buckets; if (!b) return;
  const list = [].concat(b.unanimous, b.dominant, b.singleton).map((r) => ({ key: r.key, src: r.src, tgt: r.top.tgt }));
  if (!list.length) { cbInfo('Nothing to promote.', 'err'); return; }
  try { backupAll(); } catch (e) {}   // auto-download a FULL snapshot of every brain before writing
  const { added, matched, fixed, clashes } = cbWritePairs(list);
  await tmSave(); tmRefresh(); cbClassify(); cbRender();
  let msg = `Promoted ${added} pair(s) to Consistency memory` + (matched ? ` · ${matched} already matched` : '') + (fixed ? ` · ${fixed} auto-fixed to current style` : '') + ` (now ${tmCount()}). Memory backup downloaded.`;
  if (clashes.length) { confAdd(clashes); cbInfo(msg + ` ⚠ ${clashes.length} clash with existing wording — resolve in the orange ⚠ card.`, 'err'); }
  else cbInfo(msg, 'good');
}
async function cbApplyContested() {
  const b = CB.buckets, rev = $('cb-review'); if (!b || !rev) return;
  const list = [];
  b.contested.slice(0, 150).forEach((r, i) => {
    const sel = rev.querySelector(`input[name="cbc-${i}"]:checked`); if (!sel) return;
    const v = r.vs[+sel.value]; if (v) list.push({ key: r.key, src: r.src, tgt: v.tgt });
  });
  if (!list.length) { cbInfo('Nothing chosen.', 'err'); return; }
  const { added, matched, fixed, clashes } = cbWritePairs(list);
  await tmSave(); tmRefresh(); cbClassify(); cbRender();
  let msg = `Added ${added} chosen pair(s) to memory` + (matched ? ` · ${matched} matched` : '') + (fixed ? ` · ${fixed} auto-fixed to current style` : '') + ` — resolved rows now hidden.`;
  if (clashes.length) { confAdd(clashes); cbInfo(msg + ` ⚠ ${clashes.length} clash — see orange ⚠ card.`, 'err'); }
  else cbInfo(msg, 'good');
}
async function cbApplyLocked() {
  const rev = $('cb-review'); if (!rev) return;
  const checked = [...rev.querySelectorAll('.cb-lk:checked')].map((el) => CB.cand[+el.getAttribute('data-i')]).filter(Boolean);
  if (!checked.length) { cbInfo('Check at least one term to lock.', 'err'); return; }
  let n = 0, skipped = 0;
  for (const c of checked) {
    const clash = (LOCK.terms || []).find((t) => (t.en || '').toLowerCase() === c.en.toLowerCase() && wbFold(t.he) !== wbFold(c.he));
    if (clash) { skipped++; continue; }   // already locked to a different Hebrew → leave it, don't clobber
    LOCK.terms = (LOCK.terms || []).filter((t) => (t.en || '').toLowerCase() !== c.en.toLowerCase());
    LOCK.terms.push({ id: brainUid(), en: c.en, he: c.he, note: 'from corpus', ts: Date.now() }); n++;
  }
  await lockSave(); lockRefresh();
  cbInfo(`Locked ${n} term(s)${skipped ? ` · ${skipped} skipped (already locked differently)` : ''}. ${lockCount()} locked total.`, 'good');
}
// Write plural form-sets to Plural memory, routing form-set clashes to the orange ⚠ card.
function cbWritePlurals(list) {   // list: [{key, srcForms, forms}]
  let added = 0, matched = 0; const clashes = [];
  const parked = new Set(CONF.filter((c) => c.kind === 'plural').map((c) => c.plKey + '⇢' + cbFormSig(c.newForms)));
  for (const r of list) {
    const k = cbPlKey(r.srcForms), prev = PM.map[k];
    if (prev && cbFormSig(prev.forms) !== cbFormSig(r.forms)) {
      const sig = k + '⇢' + cbFormSig(r.forms);
      if (!parked.has(sig)) { parked.add(sig); clashes.push({ kind: 'plural', plKey: k, label: (r.srcForms.other || r.srcForms.one || ''), srcForms: r.srcForms, oldForms: prev.forms, newForms: r.forms }); }
      continue;
    }
    if (prev) matched++; else { pmRecord(r.srcForms, r.forms); added++; }
  }
  return { added, matched, clashes };
}
async function cbPromotePlural() {
  const pb = CB.pbuckets; if (!pb) return;
  const list = [].concat(pb.unanimous, pb.dominant, pb.singleton).map((r) => ({ key: r.key, srcForms: r.srcForms, forms: r.top.forms }));
  if (!list.length) { cbInfo('No plural sets to promote.', 'err'); return; }
  try { backupAll(); } catch (e) {}
  const { added, matched, clashes } = cbWritePlurals(list);
  await pmSave(); cbClassify(); cbRender();
  let msg = `Promoted ${added} plural set(s) to Plural memory` + (matched ? ` · ${matched} already matched` : '') + ` (now ${pmCount()}). The 🔢 Plurals tool will pre-fill these.`;
  if (clashes.length) { confAdd(clashes); cbInfo(msg + ` ⚠ ${clashes.length} clash — resolve in the orange ⚠ card.`, 'err'); }
  else cbInfo(msg, 'good');
}
async function cbApplyContestedPlural() {
  const pb = CB.pbuckets, rev = $('cb-review'); if (!pb || !rev) return;
  const list = [];
  pb.contested.slice(0, 60).forEach((r, i) => {
    const sel = rev.querySelector(`input[name="cbp-${i}"]:checked`); if (!sel) return;
    const v = r.vs[+sel.value]; if (v) list.push({ key: r.key, srcForms: r.srcForms, forms: v.forms });
  });
  if (!list.length) { cbInfo('No plural sets chosen.', 'err'); return; }
  const { added, matched, clashes } = cbWritePlurals(list);
  await pmSave(); cbClassify(); cbRender();
  let msg = `Added ${added} chosen plural set(s) to Plural memory` + (matched ? ` · ${matched} matched` : '') + ` — resolved sets now hidden.`;
  if (clashes.length) { confAdd(clashes); cbInfo(msg + ` ⚠ ${clashes.length} clash — see orange ⚠ card.`, 'err'); }
  else cbInfo(msg, 'good');
}

// ---- 🔤 PHRASE MINING: sub-segment EN→HE term extraction from the corpus ----
// Deterministic (no GPT). Mines recurring EN phrase → HE lemma pairs across the
// built corpus: a HE lemma present in ≥70% of the targets whose source contains
// an EN phrase (seen in ≥3 tasks) is that phrase's translation. Consistent terms
// → Style-Brain glossary; drift (one EN rendered several ways) → pick canonical
// + optional Auto-fix rule. Hebrew clitics are folded so inflected forms group.
const PMINE = { consistent: [], drift: [], known: 0, running: false };
const PM_MIN_TASKS = 3, PM_MIN_COV = 0.7, PM_SAMPLE = 150;
const PM_EN_STOP = new Set(('the a an to of in on for and or your you we our us it its is are be been being this that these those with at from as by will would can could may might not no yes do does did have has i my me so if when what how who').split(' '));
const PM_HE_CLITIC = 'ובהלכמש';
const PM_HE_STOP = new Set(['של', 'את', 'זה', 'זו', 'הזה', 'הזו', 'שלך', 'שלכם', 'שלנו', 'אם', 'או', 'גם', 'כדי', 'על', 'עם', 'לא', 'כן', 'אל', 'יש', 'אין', 'הוא', 'היא', 'אני', 'אנחנו', 'כל', 'לך', 'לכם', 'אנו', 'אחרי', 'אחר', 'כמו', 'לפני', 'אלה', 'הזאת', 'יותר', 'רק', 'כבר']);
function pmEnTokens(s) { return (wbFold(s).toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g)) || []; }
function pmEnTokensCased(s) { return (wbFold(s).match(/[A-Za-z0-9]+(?:'[a-z]+)?/g)) || []; }
function pmHeTokens(s) { return (wbFold(s).match(/[א-ת]+(?:["'׳״][א-ת]+)?/g)) || []; }
function pmHeBases(t) { const out = [t]; let s = t; for (let k = 0; k < 2; k++) { if (s.length >= 4 && PM_HE_CLITIC.indexOf(s[0]) >= 0) { s = s.slice(1); out.push(s); } else break; } return out; }
function pmTokBases(t) { return pmHeBases(t).filter((b) => b.length >= 3 && !PM_HE_STOP.has(b)); }
function pmHeClean(t) { return (t.length >= 4 && (t[0] === 'ה' || t[0] === 'ו')) ? t.slice(1) : t; }
function pmTokMatchLemma(tok, lemma) { return tok === lemma || pmHeClean(tok) === lemma || pmHeBases(tok).indexOf(lemma) >= 0; }
function pmHasPhrase(toks, lemmas) { for (let i = 0; i + lemmas.length <= toks.length; i++) { let ok = true; for (let j = 0; j < lemmas.length; j++) { if (!pmTokMatchLemma(toks[i + j], lemmas[j])) { ok = false; break; } } if (ok) return true; } return false; }
// The best single contiguous HE phrase for a set of target token-arrays, + its coverage.
function pmTopPhrase(segs) {
  const N = segs.length; if (!N) return null;
  // cov: base -> #segs it appears in.  surfCnt: base -> Map(real surface token -> count).
  // Folding groups inflections for coverage, but the DISPLAY always comes from surfCnt
  // (a real corpus word), never a reconstructed/stripped base — so no letters are dropped.
  const cov = new Map(), surfCnt = new Map();
  for (const s of segs) {
    const bases = new Set();
    for (const t of s.toks) for (const b of pmTokBases(t)) {
      bases.add(b);
      let m = surfCnt.get(b); if (!m) { m = new Map(); surfCnt.set(b, m); }
      m.set(t, (m.get(t) || 0) + 1);
    }
    for (const b of bases) cov.set(b, (cov.get(b) || 0) + 1);
  }
  if (!cov.size) return null;
  const anchor = Math.max(...cov.values()); if (anchor / N < 0.35) return null;
  const floor = Math.max(anchor * 0.9, 0.35 * N);
  const high = new Set([...cov.keys()].filter((b) => cov.get(b) >= floor));
  // the most frequent REAL surface word that folds to this base (e.g. base ספר → מספר, not ספר)
  const domSurf = (b) => { const m = surfCnt.get(b); if (!m) return null; let bs = null, bc = -1; for (const [sf, c] of m) { if (c > bc) { bc = c; bs = sf; } } return bs; };
  let repI = 0, best = -1; segs.forEach((s, i) => { const c = s.toks.filter((t) => pmTokBases(t).some((b) => high.has(b))).length; if (c > best) { best = c; repI = i; } });
  const rep = segs[repI].toks;
  let run = [], disp = [], bestRun = [], bestDisp = [];   // run = folded bases (matching); disp = real surfaces (display)
  for (const t of rep) {
    const hb = pmTokBases(t).filter((b) => high.has(b)).sort((a, z) => a.length - z.length);
    if (hb.length) { run.push(hb[0]); disp.push(domSurf(hb[0]) || t); if (run.length > bestRun.length) { bestRun = run.slice(); bestDisp = disp.slice(); } }
    else { run = []; disp = []; }
  }
  if (!bestRun.length) return null;
  const c = segs.filter((s) => pmHasPhrase(s.toks, bestRun)).length;
  return { phrase: bestRun, disp: bestDisp.join(' '), cov: c / N };
}
function pmKnown(en) { const l = en.toLowerCase(); return (BRAIN.glossary || []).some((g) => (g.en || '').toLowerCase() === l) || (LOCK.terms || []).some((t) => (t.en || '').toLowerCase() === l); }
function pmMine() {
  const sources = CB.index && CB.index.sources; if (!sources) return;
  const EN = new Map();
  for (const k of Object.keys(sources)) {
    const e = sources[k]; const vs = e.variants.slice().sort((a, b) => b.n - a.n); const top = vs[0]; if (!top) continue;
    const tasks = new Set(); for (const v of e.variants) for (const t of Object.keys(v.tasks || {})) tasks.add(t);
    const toks = pmHeTokens(top.tgt); if (!toks.length) continue;
    const low = pmEnTokens(e.src), cased = pmEnTokensCased(e.src); if (!low.length) continue;
    const seen = new Set();
    for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= low.length; i++) {
      const gw = low.slice(i, i + n); if (PM_EN_STOP.has(gw[0]) || PM_EN_STOP.has(gw[gw.length - 1])) continue;
      const g = gw.join(' '); if (seen.has(g)) continue; seen.add(g);
      let rec = EN.get(g); if (!rec) { rec = { segs: [], tasks: new Set(), ex: [], disp: (cased.length === low.length ? cased.slice(i, i + n).join(' ') : g) }; EN.set(g, rec); }
      rec.segs.push({ toks }); for (const t of tasks) rec.tasks.add(t);
      if (rec.ex.length < 3) rec.ex.push({ src: e.src, tgt: top.tgt });   // real pairs → ground the optional GPT refine
    }
  }
  const consistent = [], drift = []; let known = 0;
  for (const [g, rec] of EN) {
    if (rec.tasks.size < PM_MIN_TASKS) continue;
    if (pmKnown(rec.disp)) { known++; continue; }
    const segs = rec.segs.length > PM_SAMPLE ? rec.segs.slice(0, PM_SAMPLE) : rec.segs;
    const tp = pmTopPhrase(segs); if (!tp) continue;
    if (tp.phrase.length === 1 && PM_HE_STOP.has(tp.phrase[0])) continue;
    const rest = segs.filter((s) => !pmHasPhrase(s.toks, tp.phrase));
    let dv = null;
    if (rest.length >= 2) { const tp2 = pmTopPhrase(rest); if (tp2 && rest.filter((s) => pmHasPhrase(s.toks, tp2.phrase)).length >= 2) dv = { he: tp2.disp }; }
    const item = { en: rec.disp, he: tp.disp, cov: Math.round(tp.cov * 100), tasks: rec.tasks.size, ex: rec.ex.slice(0, 3) };
    // "partial" = likely clipped by the deterministic run: a multi-word EN phrase reduced to a
    // single HE token (e.g. "LIVE on TikTok" → "בשידור"). These are the rows GPT refinement helps
    // most. (A single-token HE starting with a clitic letter is NOT a reliable signal — most real
    // words start with מ/ש/ה/ב/ל/כ/ו — so we don't flag on that.)
    item.partial = /\s/.test(item.en) && !/\s/.test(item.he);
    if (dv) { item.drift = dv; drift.push(item); }
    else if (tp.cov >= PM_MIN_COV) consistent.push(item);
  }
  const dedup = (list) => { list.sort((a, z) => z.en.split(' ').length - a.en.split(' ').length || z.tasks - a.tasks); const kept = []; for (const it of list) { if (kept.some((kk) => kk.he === it.he && (' ' + kk.en.toLowerCase() + ' ').includes(' ' + it.en.toLowerCase() + ' '))) continue; kept.push(it); } return kept; };
  PMINE.consistent = dedup(consistent).sort((a, z) => z.tasks - a.tasks);
  PMINE.drift = dedup(drift).sort((a, z) => z.tasks - a.tasks);
  PMINE.known = known;
}
function pmInfo(m, k) { info('pm-info', m, k || ''); }
function pmBadge() { const el = $('pm-badge'); if (el) el.textContent = (PMINE.consistent.length || PMINE.drift.length) ? `· ${PMINE.consistent.length} terms · ${PMINE.drift.length} drift` : ''; }
async function pmRun() {
  if (PMINE.running) return;
  if (!CB.index || !CB.index.sources || !Object.keys(CB.index.sources).length) { pmInfo('Build the 📦 Corpus first — phrase mining reads it.', 'err'); return; }
  PMINE.running = true; if ($('pm-run')) $('pm-run').disabled = true;
  pmInfo('Mining phrases from the corpus…');
  await new Promise((r) => setTimeout(r, 30));
  try { pmMine(); pmRender(); pmBadge(); pmInfo(`Found ${PMINE.consistent.length} consistent term(s) · ${PMINE.drift.length} drift term(s)${PMINE.known ? ` · ${PMINE.known} already in glossary/locked` : ''}.`, 'good'); }
  catch (e) { pmInfo('Mining failed: ' + (e.message || e), 'err'); }
  finally { PMINE.running = false; if ($('pm-run')) $('pm-run').disabled = false; }
}
function pmRender() {
  const box = $('pm-review'); if (!box) return; box.hidden = false;
  let html = '';
  if (PMINE.consistent.length) {
    const npart = PMINE.consistent.filter((c) => c.partial && !c.refined).length;
    const nref = PMINE.consistent.filter((c) => c.refined).length;
    html += `<div class="cb-sec"><div class="cb-h">✅ Consistent terms — ${PMINE.consistent.length}</div><div class="hint">Recurring EN→HE terms your translations agree on. Check any to add to the Style-Brain glossary (advisory).` +
      (npart ? ` <b>${npart}</b> look ⚠ partial (clipped) — <b>✨ Refine with GPT</b> reconstructs the full term from your real examples.` : '') +
      (nref ? ` ${nref} refined.` : '') + `</div>` +
      `<div class="row" style="gap:6px;margin:2px 0 6px"><button id="pm-refine" class="btn sm">✨ Refine ${PMINE.consistent.length} with GPT</button><span id="pm-refine-info" class="info"></span></div>` +
      PMINE.consistent.slice(0, 250).map((c, i) => {
        if (c.keep === false) return `<label class="cb-opt pm-skip" title="${esc(c.note || 'GPT: not a reusable glossary term')}"><input type="checkbox" class="pm-ck" data-i="${i}" disabled/> <span dir="ltr">${esc(c.en)}</span> → <span dir="rtl">${esc(c.he || c.mined || '')}</span> <span class="hint">✨ skipped${c.note ? ' · ' + esc(c.note) : ''}</span></label>`;
        const badge = c.refined ? `<span class="hint" title="was: ${esc(c.mined || '')}">✨${c.mined && wbFold(c.mined) !== wbFold(c.he) ? ' refined' : ' ok'}</span>` : (c.partial ? `<span class="hint">⚠ partial</span>` : '');
        return `<label class="cb-opt"><input type="checkbox" class="pm-ck" data-i="${i}"/> <span dir="ltr">${esc(c.en)}</span> → <span dir="rtl">${esc(c.he)}</span> <span class="hint">${c.cov}% · ${c.tasks} tasks</span> ${badge}</label>`;
      }).join('') +
      `<button id="pm-add-consistent" class="btn sm">➕ Add checked to glossary</button>` + (PMINE.consistent.length > 250 ? `<div class="hint">Showing 250 of ${PMINE.consistent.length}.</div>` : '') + `</div>`;
  }
  if (PMINE.drift.length) {
    html += `<div class="cb-sec"><div class="cb-h">⚖️ Drift terms — ${PMINE.drift.length} · pick the canonical</div><div class="hint">One EN term rendered several ways across tasks. Pick the canonical → glossary. The Auto-fix checkbox rewrites the other form → canonical on every run — <b>tick it only when the other form is a safe spelling/article variant</b>, never a different word (e.g. הורה = "parent").</div>` +
      PMINE.drift.slice(0, 150).map((d, i) => {
        const single = !d.he.includes(' ') && !d.drift.he.includes(' ');
        return `<div class="cb-item"><div class="cb-src" dir="ltr">${esc(d.en)} <span class="hint">· ${d.tasks} tasks</span></div>` +
          `<label class="cb-opt"><input type="radio" name="pmd-${i}" value="win" checked/> <span dir="rtl">${esc(d.he)}</span> <span class="hint">(${d.cov}%)</span></label>` +
          `<label class="cb-opt"><input type="radio" name="pmd-${i}" value="drift"/> <span dir="rtl">${esc(d.drift.he)}</span></label>` +
          (single ? `<label class="cb-opt"><input type="checkbox" class="pm-fx" data-i="${i}"/> <span class="hint">also add 🩹 Auto-fix (other form → canonical) — safe spelling variant only</span></label>` : '') +
          `</div>`;
      }).join('') +
      `<button id="pm-apply-drift" class="btn sm">➕ Apply drift choices</button>` + (PMINE.drift.length > 150 ? `<div class="hint">Showing 150 of ${PMINE.drift.length}.</div>` : '') + `</div>`;
  }
  box.innerHTML = html || '<div class="hint">No term candidates at the current thresholds (3 tasks · 70%).</div>';
  if ($('pm-add-consistent')) $('pm-add-consistent').addEventListener('click', pmApplyConsistent);
  if ($('pm-apply-drift')) $('pm-apply-drift').addEventListener('click', pmApplyDrift);
  if ($('pm-refine')) $('pm-refine').addEventListener('click', pmRefine);
}
function pmGlossPush(en, he, note, clashes) {
  const clash = (BRAIN.glossary || []).find((g) => (g.en || '').toLowerCase() === en.toLowerCase() && wbFold(g.he) !== wbFold(he));
  if (clash) { clashes.push({ kind: 'gloss', en, oldVal: clash.he, newVal: he, note, source: 'phrase-mining' }); return false; }
  BRAIN.glossary = (BRAIN.glossary || []).filter((g) => (g.en || '').toLowerCase() !== en.toLowerCase());
  BRAIN.glossary.push({ id: brainUid(), en, he, note, source: 'phrase-mining', ts: Date.now() });
  return true;
}
async function pmApplyConsistent() {
  const box = $('pm-review'); if (!box) return;
  const checked = [...box.querySelectorAll('.pm-ck:checked')].map((el) => PMINE.consistent[+el.getAttribute('data-i')]).filter((c) => c && c.keep !== false);
  if (!checked.length) { pmInfo('Check at least one term.', 'err'); return; }
  let added = 0; const clashes = [];
  for (const c of checked) { if (pmGlossPush(c.en, c.he, 'from phrase-mining', clashes)) added++; }
  await brainSave(); brainRefresh();
  let msg = `Added ${added} term(s) to the glossary (now ${(BRAIN.glossary || []).length}).`;
  if (clashes.length) { confAdd(clashes); pmInfo(msg + ` ⚠ ${clashes.length} clash — resolve in the orange ⚠ card.`, 'err'); }
  else pmInfo(msg, 'good');
}
async function pmApplyDrift() {
  const box = $('pm-review'); if (!box) return;
  let added = 0, fx = 0; const clashes = [];
  PMINE.drift.slice(0, 150).forEach((d, i) => {
    const sel = box.querySelector(`input[name="pmd-${i}"]:checked`); if (!sel) return;
    const canon = sel.value === 'win' ? d.he : d.drift.he, loser = sel.value === 'win' ? d.drift.he : d.he;
    if (pmGlossPush(d.en, canon, 'from phrase-mining (drift)', clashes)) added++;
    const fxCk = box.querySelector(`.pm-fx[data-i="${i}"]`);
    if (fxCk && fxCk.checked && !canon.includes(' ') && !loser.includes(' ') && wbFold(loser) !== wbFold(canon) && !(FIX.rules || []).some((r) => r.from === loser)) {
      FIX.rules.push({ id: fixUid(), from: loser, to: canon, note: 'phrase-mining drift', ts: Date.now() }); fx++;
    }
  });
  await brainSave(); brainRefresh(); if (fx) { await fixSave(); fixRefresh(); }
  let msg = `Applied ${added} canonical term(s) to glossary${fx ? ` · ${fx} Auto-fix rule(s) added` : ''}.`;
  if (clashes.length) { confAdd(clashes); pmInfo(msg + ` ⚠ ${clashes.length} clash — orange ⚠ card.`, 'err'); }
  else pmInfo(msg, 'good');
}
// ---- ✨ GPT refinement of mined consistent terms ---------------------------
// The deterministic miner is high-recall but clips at Latin/short tokens and leaves stray
// clitics (LIVE on TikTok → בשידור). This asks GPT, per candidate, to reconstruct the clean
// canonical HE term from the EN phrase + real example pairs, or to drop it (keep:false) when
// it isn't a reusable term. Grounded (it only cleans phrases your own work already agreed on),
// batched, and every result still goes through the normal review → glossary flow.
function pmRefineInfo(m, k) { info('pm-refine-info', m, k || ''); }
async function pmGptRefine(items, key, model) {
  const sys = 'You refine EN→HE glossary TERM candidates for TikTok he-IL (Hebrew) UI localization. ' +
    'Each candidate has: "en" (an English UI phrase), "mined_he" (a Hebrew form a frequency counter pulled from real human translations — it may be CLIPPED, missing a word, or carry a stray leading prefix), and "ex" (1–3 real human translations of full sentences that contain the phrase — ground truth). ' +
    'For each, output the CANONICAL Hebrew equivalent of EXACTLY "en" as a clean, reusable glossary term:\n' +
    '- Reconstruct the FULL phrase when mined_he is clipped, using ex as ground truth (e.g. en="LIVE on TikTok" → "שידור חי ב-TikTok", not "בשידור").\n' +
    '- Keep brand/Latin tokens in Latin and use the maqaf prefix (ב-TikTok, ל-Story). Keep {placeholders} verbatim.\n' +
    '- Strip a stray leading clitic that is NOT part of the term (בשידור → שידור) unless the term needs it.\n' +
    '- House style: singular gender-neutral slash for imperatives (לחץ/י), never plural (לשון רבים); currency symbol/code AFTER the number.\n' +
    '- Set "keep": false when "en" is NOT a reusable term — a function/stop word (before, more, your), a context-only fragment, or too variable to pin as one Hebrew string.\n' +
    'Return ONLY JSON {"out":[{"i":<number>,"he":"<canonical hebrew>","keep":<true|false>,"note":"<optional short>"}]}, one per input item, same "i".';
  const payload = items.map((it) => ({ i: it.i, en: it.en, mined_he: it.he, ex: (it.ex || []).map((e) => ({ src: String(e.src || '').slice(0, 160), tgt: String(e.tgt || '').slice(0, 160) })) }));
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ items: payload }) }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error && data.error.message || ('GPT error ' + r.status));
  return JSON.parse(data.choices?.[0]?.message?.content || '{}').out || [];
}
async function pmRefine() {
  if (PMINE.refining) { PMINE.refineStop = true; return; }   // second click = stop
  const key = await store.get('key', '');
  if (!key) { pmRefineInfo('Add your OpenAI key in ⚙️ Settings first.', 'err'); return; }
  const model = await store.get('model', 'gpt-5.4');
  const list = PMINE.consistent;
  if (!list.length) { pmRefineInfo('Nothing to refine.', 'err'); return; }
  if (!confirm(`Send ${list.length} consistent term(s) to GPT (${model}) to reconstruct clean canonical Hebrew? This uses your OpenAI key. You can Stop mid-way.`)) return;
  PMINE.refining = true; PMINE.refineStop = false;
  const btn = $('pm-refine'); if (btn) btn.textContent = '⏹ Stop';
  const CH = 40; let done = 0, changed = 0, dropped = 0, failed = 0;
  try {
    for (let i = 0; i < list.length && !PMINE.refineStop; i += CH) {
      const chunk = []; for (let j = i; j < Math.min(i + CH, list.length); j++) chunk.push({ i: j, en: list[j].en, he: list[j].he, ex: list[j].ex });
      pmRefineInfo(`Refining ${Math.min(i + CH, list.length)}/${list.length}…`);
      let out;
      try { out = await pmGptRefine(chunk, key, model); }
      catch (e) { failed += chunk.length; if (/\b(401|invalid|api key)\b/i.test(e.message || '')) { pmRefineInfo('Stopped: ' + e.message, 'err'); break; } continue; }
      for (const o of out) {
        const c = list[+o.i]; if (!c) continue;
        c.mined = c.mined || c.he; c.refined = true; c.note = o.note || '';
        if (o.keep === false) { c.keep = false; dropped++; }
        else { c.keep = true; const he = String(o.he || '').trim(); if (he) { if (wbFold(he) !== wbFold(c.he)) changed++; c.he = he; } }
        done++;
      }
    }
  } finally {
    PMINE.refining = false; PMINE.refineStop = false;
    pmRender(); pmBadge();
    const tail = failed ? ` · ${failed} failed` : '';
    pmRefineInfo(`Refined ${done} term(s): ${changed} rewritten, ${dropped} dropped as non-terms${tail}. Review & check what to add.`, failed ? 'err' : 'good');
  }
}

// ---- 📚 LEARN FROM THE WHOLE CORPUS ---------------------------------------
// One GPT pass over EVERY pair in the built corpus → rules, terms, expressions,
// exceptions + conflicts, reconciled against the current brain. Two phases so it
// stays careful AND cheap: (1) EXTRACT candidates from the pairs alone (no brain
// in the prompt), recency-ordered newest-submitted-first with an evolution timeline
// for sources you rendered several ways over time; (2) RECONCILE the deduped
// candidates against the existing brain in one bounded pass — already-covered ones
// are dropped, contradictions become ⚠ conflicts. Findings land in the same
// Style-Brain review list (merge or discard); a full backup downloads first.
const CL = { running: false, cancel: false };
function clInfo(m, k) { info('cl-info', m, k || ''); }
function clBadge() { const el = $('cl-badge'); if (!el) return; const ix = CB.index; el.textContent = (ix && ix.sources) ? `· ${Object.keys(ix.sources).length} sources ready` : '· build the corpus first'; }
// Fetch getMyTasks once → map every task id to its first-submitted date (ms).
// Same same-origin fetch the 💰 Word count uses; {} on failure → id-order fallback.
async function clFetchDates() {
  try {
    const t = await wbActiveTab();
    if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) return {};
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: t.id },
      func: async () => {
        const parseDate = (v) => { if (v == null) return null; if (typeof v === 'number' && isFinite(v)) { const ms = v < 1e12 ? v * 1000 : v; const y = new Date(ms).getFullYear(); return (y >= 2000 && y <= 2100) ? ms : null; } if (typeof v === 'string' && v.trim()) { const s = v.trim(); if (/^\d{10}$/.test(s)) { const ms = Number(s) * 1000, y = new Date(ms).getFullYear(); return (y >= 2000 && y <= 2100) ? ms : null; } if (/^\d{13}$/.test(s)) { const ms = Number(s), y = new Date(ms).getFullYear(); return (y >= 2000 && y <= 2100) ? ms : null; } const t2 = Date.parse(s); if (!isNaN(t2)) { const y = new Date(t2).getFullYear(); return (y >= 2000 && y <= 2100) ? t2 : null; } } return null; };
        try {
          const res = await fetch('/api/task/getMyTasks?offset=0&limit=5000&progress=all&translateTypeList=%5B%5D&_=' + Date.now(), { credentials: 'include', cache: 'no-store' });
          const j = await res.json(); const d = j.data || {};
          const rows = (d.rows || []).map((x) => {
            const ids = [], dates = {};
            for (const k of Object.keys(x)) { const val = x[k]; const dd = parseDate(val); if (dd != null) dates[k] = dd; else if ((typeof val === 'number' || typeof val === 'string') && /^\d{10,13}$/.test(String(val))) ids.push(String(val)); }
            return { ids, dates };
          });
          return { ok: true, rows };
        } catch (e) { return { ok: false }; }
      }
    });
    const out = r && r.result; if (!out || !out.ok) return {};
    const fset = new Set(); for (const row of out.rows) for (const k of Object.keys(row.dates || {})) fset.add(k);
    const field = pcPickDateField([...fset]);
    const map = {};
    for (const row of out.rows) { const dt = field ? row.dates[field] : null; if (dt == null) continue; for (const id of row.ids) { if (!(id in map) || dt > map[id]) map[id] = dt; } }
    return map;
  } catch (e) { return {}; }
}
// Latest submit date among the tasks that produced this variant (id fallback: Starling ids are ~monotonic).
function clVariantDateMs(v, dateMap) {
  let best = -1;
  for (const tid of Object.keys(v.tasks || {})) { const d = dateMap[tid]; const val = (d != null) ? d : (parseInt(tid, 10) || 0); if (val > best) best = val; }
  return best;
}
// Recency-ordered learn pairs. Canonical = newest rendering; contested sources carry a distinct-rendering timeline.
function clGatherPairs(sources, dateMap, allSources) {
  const pairs = [];
  for (const k of Object.keys(sources)) {
    const e = sources[k]; const vs = (e.variants || []).slice(); if (!vs.length) continue;
    for (const v of vs) v._d = clVariantDateMs(v, dateMap);
    vs.sort((a, b) => (b._d - a._d) || (b.n - a.n));
    const canon = vs[0];
    const contested = vs.length > 1 && vs.some((v) => wbFold(v.tgt) !== wbFold(canon.tgt));
    if (!allSources && !contested) continue;
    const pair = { src: e.src, tgt: canon.tgt, d: canon._d, contested: !!contested };
    if (contested) {
      const seen = new Set(), tl = [];
      for (const v of vs.slice().sort((a, b) => a._d - b._d)) { const f = wbFold(v.tgt); if (!f || seen.has(f)) continue; seen.add(f); tl.push(v.tgt); }
      if (tl.length > 1) pair.timeline = tl;
    }
    pairs.push(pair);
  }
  pairs.sort((a, b) => (b.d - a.d));   // newest submitted first
  return pairs;
}
// Phase 1 — EXTRACT from the pairs alone (no existing brain shown; that's phase 2).
function clSysExtract() {
  return 'You learn TikTok Hebrew (he-IL) localization conventions from APPROVED en→he translation pairs — the submitted, proofread source of truth. Infer GENERALIZABLE, actionable conventions a translator/proofreader should reuse: term mappings, register/tone (e.g. singular gender-neutral slash form vs plural), punctuation, placeholder/tag handling, brand casing, and EXCEPTIONS (context-dependent choices). ' +
    'The pairs are ordered NEWEST-submitted first — later work is more reviewed, so when pairs disagree prefer the newer wording. Some pairs show an EVOLUTION timeline (oldest→newest renderings of the SAME source): learn the CORRECTION it implies (as a rule or a glossary term), and if the difference is context-dependent, record it as an exception in "rules". ' +
    'Output COMPACT rules (≤ ~30 words each, imperative and specific), each categorized as one of: ' + BRAIN_CATS.join(' | ') + '. Put exact recurring EN→HE term equivalences in "glossary" (with a short "note"). ' +
    'Extract ONLY high-confidence patterns the pairs actually demonstrate — do NOT invent generic localization common sense. If the pairs CONTRADICT each other in a way newer-vs-older does not resolve, put it in "conflicts" with "conflictsWith" describing the clash and cite the evidence. ' +
    'Keep Hebrew in Hebrew; never translate the rule text itself. Return ONLY JSON: {"rules":[{"cat":"…","text":"…"}],"glossary":[{"en":"…","he":"…","note":"…"}],"conflicts":[{"cat":"…","text":"…","conflictsWith":"…"}]}.';
}
// Phase 2 — RECONCILE candidate rules against the existing brain.
function clSysReconcile() {
  return 'You are reconciling CANDIDATE localization rules (distilled from a translation corpus) against an EXISTING, curated brain of rules. For each candidate: ' +
    'if it is ALREADY COVERED by an existing rule (same substance, even if worded differently), DROP it. ' +
    'If it CONTRADICTS an existing rule, output it under "conflicts" with "conflictsWith" naming/quoting the clashing existing rule. ' +
    'Otherwise (genuinely new and compatible) keep it under "rules". ' +
    'Do not invent new rules; only classify the candidates given. Keep Hebrew in Hebrew. Return ONLY JSON: {"rules":[{"cat":"…","text":"…"}],"conflicts":[{"cat":"…","text":"…","conflictsWith":"…"}]}.';
}
async function clGpt(key, model, sys, user, tempState) {
  const callGpt = async () => {
    const body = { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
    if (!tempState.drop) body.temperature = 0.1;
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status)); return data;
  };
  try { return await callGpt(); }
  catch (e1) { if (!tempState.drop && /temperature/i.test(e1.message || '')) { tempState.drop = true; return await callGpt(); } throw e1; }
}
async function clRun() {
  if (CL.running) return;
  const key = await store.get('key', '');
  if (!key) { clInfo('Add your OpenAI key in Settings first.', 'err'); if ($('settings')) $('settings').open = true; return; }
  if (!CB.index || !CB.index.sources || !Object.keys(CB.index.sources).length) { clInfo('Build the 📦 Corpus first.', 'err'); return; }
  const allSources = !($('cl-all') && !$('cl-all').checked);
  clInfo('Reading submission dates…');
  const dateMap = await clFetchDates();
  const haveDates = Object.keys(dateMap).length;
  const pairs = clGatherPairs(CB.index.sources, dateMap, allSources);
  if (!pairs.length) { clInfo(allSources ? 'No pairs in the corpus.' : 'No contested/evolved sources — tick “All sources” to learn from everything.', 'err'); return; }
  const batches = Math.ceil(pairs.length / HV_BATCH), contestedN = pairs.filter((p) => p.timeline).length;
  if (!confirm(`Learn from ${pairs.length} corpus pair(s) — ~${batches} extraction call(s) on ${$('model').value}, then a short reconcile pass` + (contestedN ? `. ${contestedN} source(s) carry an evolution timeline` : '') + (haveDates ? '' : ' (no submit dates found — ordering by task id)') + `.\n\nA full backup of every brain downloads first. Findings go to the 🧠 Style Brain review list — nothing changes until you click Merge.\n\nProceed?`)) { clInfo('Cancelled.', ''); return; }
  try { backupAll(); } catch (e) {}
  CL.running = true; CL.cancel = false; if ($('cl-run')) $('cl-run').disabled = true; if ($('cl-cancel')) $('cl-cancel').hidden = false;
  const model = $('model').value, temp = { drop: false };
  const agg = { rules: [], glossary: [], conflicts: [] }; let done = 0;
  try {
    // Phase 1 — extract
    for (let i = 0; i < pairs.length; i += HV_BATCH) {
      if (CL.cancel) { clInfo(`Stopped at ${done}/${pairs.length}. Distilling what was gathered…`, 'err'); break; }
      const chunk = pairs.slice(i, i + HV_BATCH);
      clInfo(`Extracting ${i + 1}–${Math.min(i + HV_BATCH, pairs.length)} of ${pairs.length}…`);
      const doc = chunk.map((p, j) => { let s = `${j + 1}. EN: ${p.src}\n   HE: ${p.tgt}`; if (p.timeline) s += `\n   (evolved oldest→newest: ${p.timeline.join('  →  ')})`; return s; }).join('\n');
      const user = 'APPROVED en→he PAIRS (newest submitted first):\n' + doc;
      let data; try { data = await clGpt(key, model, clSysExtract(), user, temp); } catch (e) { if (/401|invalid/i.test(e.message || '')) throw e; done = Math.min(i + HV_BATCH, pairs.length); continue; }
      let o = {}; try { o = JSON.parse(data.choices[0].message.content); } catch (e) { done = Math.min(i + HV_BATCH, pairs.length); continue; }
      (o.rules || []).forEach((x) => agg.rules.push(x)); (o.glossary || []).forEach((x) => agg.glossary.push(x)); (o.conflicts || []).forEach((x) => agg.conflicts.push(x));
      done = Math.min(i + HV_BATCH, pairs.length);
      if (i + HV_BATCH < pairs.length) await new Promise((r) => setTimeout(r, 120));
    }
    // Dedupe candidates
    const seenR = new Set(), candRules = [];
    for (const x of agg.rules) { const t = String(x.text || '').trim(); const kk = (x.cat || '') + '|' + wbNorm(t).toLowerCase(); if (!t || seenR.has(kk)) continue; seenR.add(kk); candRules.push({ cat: x.cat || 'misc', text: t }); }
    const seenG = new Set(), glossary = [];
    for (const x of agg.glossary) { const en = String(x.en || '').trim(), he = String(x.he || '').trim(); if (!en || !he) continue; const kk = en.toLowerCase(); if (seenG.has(kk)) continue; seenG.add(kk); glossary.push({ en, he, note: String(x.note || '').trim(), accept: true }); }
    const seenC = new Set(), conflicts = [];
    for (const x of agg.conflicts) { const t = String(x.text || '').trim(); const kk = wbNorm(t).toLowerCase(); if (!t || seenC.has(kk)) continue; seenC.add(kk); conflicts.push({ cat: x.cat || 'misc', text: t, conflictsWith: String(x.conflictsWith || '').trim(), accept: false }); }
    // Phase 2 — reconcile candidate rules against the existing brain (bounded pass)
    let keptRules = candRules.map((r) => ({ cat: r.cat, text: r.text, accept: true }));
    const existingRules = (BRAIN.rules || []).map((r) => '- [' + r.cat + '] ' + r.text);
    if (candRules.length && existingRules.length && !CL.cancel) {
      const kept = [], REC = 60;
      for (let i = 0; i < candRules.length; i += REC) {
        clInfo(`Reconciling ${i + 1}–${Math.min(i + REC, candRules.length)} of ${candRules.length} candidates against your brain…`);
        const cand = candRules.slice(i, i + REC).map((r, j) => `${j + 1}. [${r.cat}] ${r.text}`).join('\n');
        const user = 'EXISTING BRAIN RULES:\n' + existingRules.join('\n') + '\n\nCANDIDATE RULES to classify:\n' + cand;
        let data; try { data = await clGpt(key, model, clSysReconcile(), user, temp); } catch (e) { kept.push(...candRules.slice(i, i + REC)); continue; }
        let o = {}; try { o = JSON.parse(data.choices[0].message.content); } catch (e) { kept.push(...candRules.slice(i, i + REC)); continue; }
        (o.rules || []).forEach((x) => { const t = String(x.text || '').trim(); if (t) kept.push({ cat: x.cat || 'misc', text: t }); });
        (o.conflicts || []).forEach((x) => { const t = String(x.text || '').trim(); if (t) conflicts.push({ cat: x.cat || 'misc', text: t, conflictsWith: String(x.conflictsWith || '').trim(), accept: false }); });
        if (i + REC < candRules.length) await new Promise((r) => setTimeout(r, 120));
      }
      // re-dedupe kept rules
      const s2 = new Set(); keptRules = [];
      for (const x of kept) { const kk = (x.cat || '') + '|' + wbNorm(x.text).toLowerCase(); if (s2.has(kk)) continue; s2.add(kk); keptRules.push({ cat: x.cat || 'misc', text: x.text, accept: true }); }
    }
    brainProposal = { rules: keptRules, glossary, conflicts, sourceLabel: 'corpus learn (' + done + ' pairs)' };
    brainRenderReview(); if ($('brain-card')) $('brain-card').open = true; const bp = $('brain-review'); if (bp) bp.scrollIntoView({ block: 'nearest' });
    clInfo(`From ${done} pair(s): ${keptRules.length} new rule(s) · ${glossary.length} term(s)${conflicts.length ? ` · ⚠ ${conflicts.length} conflict(s)` : ''} — review & merge in 🧠 Style Brain above, or Discard to keep the brain as-is (a backup was downloaded first).`, 'good');
  } catch (e) { clInfo('Corpus learn failed: ' + (e.message || e), 'err'); }
  finally { CL.running = false; if ($('cl-run')) $('cl-run').disabled = false; if ($('cl-cancel')) $('cl-cancel').hidden = true; }
}

// ---- 🧹 CONSOLIDATE RULES -------------------------------------------------
// One GPT pass over the EXISTING Style-Brain rules (per category) that merges
// duplicates, drops near-repeats and tightens wording WITHOUT losing coverage —
// so a brain that's grown to thousands of rules stays tight enough for GPT to
// actually follow (and cheap to send). Glossary / locked / memory / auto-fix are
// untouched. Auto-backs-up first; you review the result and click Replace.
const CLS = { result: null, running: false, cancel: false };
// Persist the pending consolidate review so it survives closing/reopening the panel
// (like the corpus-learn tickets). Only the un-applied proposal is stored; Replace/Discard clear it.
function clsSave() { try { store.set({ consolidateReview: CLS.result || null }); } catch (e) {} }
async function clsLoad() { try { const r = await store.get('consolidateReview', null); if (r && r.rules && r.rules.length) CLS.result = r; } catch (e) {} return CLS.result; }
function clsInfo(m, k) { info('cls-info', m, k || ''); }
function clsBadge() { const el = $('cls-n'); if (el) el.textContent = (BRAIN && BRAIN.rules) ? BRAIN.rules.length : 0; }
function clsSys() {
  return 'You consolidate a large set of he-IL (Hebrew) TikTok localization RULES into a MINIMAL, non-redundant ruleset a translator/proofreader follows. Merge rules that mean the same thing, drop exact and near duplicates, and tighten each to <= ~25 words, imperative and specific. KEEP every DISTINCT piece of guidance — never lose coverage and never invent new rules. If two rules genuinely contradict, keep the more specific / more actionable one and record the drop in "notes". Preserve all Hebrew verbatim; never translate the rule text. Return ONLY JSON: {"rules":[{"cat":"…","text":"…"}],"notes":[{"text":"…"}]} — notes briefly describe the merges, drops and contradictions.';
}
// Consolidate one category's rule texts — chunked, with a final cross-chunk merge pass.
async function clsConsolidateList(key, model, cat, texts, temp, notes) {
  const CHUNK = 100;
  const runOnce = async (list) => {
    const user = 'CATEGORY: ' + cat + '\nRULES:\n' + list.map((t, i) => `${i + 1}. ${t}`).join('\n');
    let data; try { data = await clGpt(key, model, clsSys(), user, temp); } catch (e) { if (/401|invalid/i.test(e.message || '')) throw e; return list.map((t) => ({ cat, text: t })); }
    let o = {}; try { o = JSON.parse(data.choices[0].message.content); } catch (e) { return list.map((t) => ({ cat, text: t })); }
    (o.notes || []).forEach((n) => { const t = String(n.text || '').trim(); if (t) notes.push(t); });
    const rules = (o.rules || []).map((r) => ({ cat: (r.cat || cat), text: String(r.text || '').trim() })).filter((r) => r.text);
    return rules.length ? rules : list.map((t) => ({ cat, text: t }));
  };
  if (texts.length <= CHUNK) return await runOnce(texts);
  const acc = [];
  for (let i = 0; i < texts.length; i += CHUNK) { if (CLS.cancel) break; clsInfo(`Consolidating [${cat}] ${i + 1}–${Math.min(i + CHUNK, texts.length)} of ${texts.length}…`); acc.push(...await runOnce(texts.slice(i, i + CHUNK))); }
  const accTexts = acc.map((r) => r.text);
  if (accTexts.length > 1 && accTexts.length <= CHUNK && !CLS.cancel) { clsInfo(`Merging [${cat}] across chunks…`); return await runOnce(accTexts); }
  return acc;
}
async function clsRun() {
  if (CLS.running) return;
  const key = await store.get('key', ''); if (!key) { clsInfo('Add your OpenAI key in Settings first.', 'err'); if ($('settings')) $('settings').open = true; return; }
  const rules = (BRAIN.rules || []); if (rules.length < 8) { clsInfo(`Only ${rules.length} rule(s) — consolidation is only worth it on a big brain.`, 'err'); return; }
  if (!confirm(`Consolidate ${rules.length} rules with ${$('model').value}? A full brain backup downloads first; you review the result and click Replace — nothing changes until then. Proceed?`)) { clsInfo('Cancelled.', ''); return; }
  try { backupAll(); } catch (e) {}
  CLS.running = true; CLS.cancel = false; if ($('cls-run')) $('cls-run').disabled = true; if ($('cls-cancel')) $('cls-cancel').hidden = false;
  const model = $('model').value, temp = { drop: false };
  const byCat = new Map(); for (const r of rules) { const c = r.cat || 'misc'; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(String(r.text || '').trim()); }
  const outRules = [], notes = [];
  try {
    for (const [cat, texts] of byCat) { if (CLS.cancel) break; outRules.push(...await clsConsolidateList(key, model, cat, texts, temp, notes)); }
    const seen = new Set(), finalRules = [];
    for (const r of outRules) { const t = String(r.text || '').trim(); if (!t) continue; const kk = (r.cat || 'misc') + '|' + wbNorm(t).toLowerCase(); if (seen.has(kk)) continue; seen.add(kk); finalRules.push({ cat: r.cat || 'misc', text: t }); }
    CLS.result = { before: rules.length, rules: finalRules, notes };
    clsSave();
    clsRender();
    clsInfo(`Consolidated ${rules.length} → ${finalRules.length} rule(s)${CLS.cancel ? ' (cancelled — partial)' : ''}. Review below, then Replace (a backup was downloaded first).`, 'good');
  } catch (e) { clsInfo('Consolidate failed: ' + (e.message || e), 'err'); }
  finally { CLS.running = false; if ($('cls-run')) $('cls-run').disabled = false; if ($('cls-cancel')) $('cls-cancel').hidden = true; }
}
function clsRender() {
  const box = $('cls-review'); if (!box) return; const R = CLS.result; if (!R) { box.hidden = true; return; }
  const rows = R.rules.map((r, i) => `<div class="bl-row"><button class="cls-del" data-i="${i}" title="Drop this consolidated rule (keeps your current brain until you Replace)">✕</button><span class="bi-cat">${esc(r.cat)}</span><span class="bi-text" dir="auto">${esc(r.text)}</span></div>`).join('');
  const notes = R.notes.length ? `<details class="sub" style="margin-top:6px"><summary>What changed — ${R.notes.length} note(s)</summary>${R.notes.slice(0, 300).map((n) => `<div class="hint" dir="auto">• ${esc(n)}</div>`).join('')}</details>` : '';
  box.innerHTML = `<div class="brain-sec">Consolidated ruleset — ${R.before} → <b>${R.rules.length}</b> rules (drop any with ✕ before replacing)</div><div class="brain-list">${rows}</div>${notes}<div class="row" style="margin-top:6px"><button id="cls-apply" class="btn sm">✅ Replace all rules with these ${R.rules.length}</button><button id="cls-discard" class="btn sm ghost">Discard</button></div>`;
  box.hidden = false;
  box.querySelectorAll('.cls-del').forEach((b) => b.addEventListener('click', () => { CLS.result.rules.splice(+b.dataset.i, 1); clsSave(); clsRender(); }));
  if ($('cls-apply')) $('cls-apply').addEventListener('click', clsApply);
  if ($('cls-discard')) $('cls-discard').addEventListener('click', () => { CLS.result = null; clsSave(); box.hidden = true; clsInfo('Discarded — your rules are unchanged.', ''); });
}
async function clsApply() {
  const R = CLS.result; if (!R || !R.rules.length) { clsInfo('Nothing to apply.', 'err'); return; }
  if (!confirm(`Replace your ${R.before} rules with these ${R.rules.length}? Glossary, locked terms, memory and auto-fix are untouched. The pre-consolidation backup is already in your Downloads, so this is reversible. Proceed?`)) return;
  const now = Date.now();
  BRAIN.rules = R.rules.map((r) => ({ id: brainUid(), cat: r.cat || 'misc', text: r.text, source: 'consolidated', ts: now }));
  await brainSave(); brainRefresh(); clsBadge();
  const before = R.before; CLS.result = null; clsSave(); if ($('cls-review')) $('cls-review').hidden = true;
  clsInfo(`Replaced. Brain now has ${BRAIN.rules.length} rules (was ${before}) — active on the next Run.`, 'good');
}

// ---- 🔎 LOOKUP: "how do I normally translate this?" across every brain -----
// Read-only concordance. EN query → the corpus's dominant rendering + examples,
// plus matching memory / glossary / locked / auto-fix. HE query → reverse (where
// you used this Hebrew) + matching entries. Nothing is written.
function lkMatch(s, q) { return wbFold(String(s == null ? '' : s)).toLowerCase().includes(q.toLowerCase()); }
function lkSeq(arr, sub) { if (!sub.length) return false; for (let i = 0; i + sub.length <= arr.length; i++) { let ok = true; for (let j = 0; j < sub.length; j++) { if (arr[i + j] !== sub[j]) { ok = false; break; } } if (ok) return true; } return false; }
function lkInfo(m, k) { info('lk-info', m, k || ''); }
// Escape + highlight every case-insensitive occurrence of q with <mark>.
function lkHl(raw, q) {
  raw = String(raw == null ? '' : raw); if (!q) return esc(raw);
  const lc = raw.toLowerCase(), lq = q.toLowerCase(); let out = '', i = 0;
  while (i < raw.length) { const idx = lc.indexOf(lq, i); if (idx < 0) { out += esc(raw.slice(i)); break; } out += esc(raw.slice(i, idx)) + '<mark>' + esc(raw.slice(idx, idx + q.length)) + '</mark>'; i = idx + q.length; }
  return out;
}
// Build the exact deep-link Starling uses when you open a task from "My tasks" (the 👁 eye).
// Route is `#/outside/translate?taskid=…&from=station&fromUrl=<back-link>`, NOT `#/editor?…`
// (that only loaded the editor shell). `fromUrl` is the breadcrumb back-link and is itself a
// hash-route whose array params are percent-encoded, then the whole thing is encoded again —
// so this reproduces a real click byte-for-byte from just the task (sub)id.
function starlingTaskUrl(tid) {
  const t = String(tid);
  const inner = '#/my-task?pageNum=1&pageSize=100&progress=all&translateTypeList=%5B%5D&taskIds=%5B%22' + t + '%22%5D';
  return 'https://starling.bytedance.com/#/outside/translate?taskid=' + encodeURIComponent(t) + '&from=station&fromUrl=' + encodeURIComponent(inner);
}

// ---- 🔎 Lookup — clitic-folded variant distribution -----------------------
// Groups a corpus term's Hebrew renderings so inflections that differ only by a
// leading clitic (ו/ב/ה/ל/כ/מ/ש) count as ONE variant, then shows each variant's
// share. Folding is DATA-DRIVEN, not blind morphology: within a cluster a leading
// letter is treated as a clitic (coloured, uncounted) only if the same word occurs
// WITHOUT it elsewhere in the cluster — so the מ of משפחה (never seen as שפחה) is
// left alone, while the ה of המשפחה (seen bare as משפחה) is folded and coloured.
const LK_CLITIC = PM_HE_CLITIC;   // 'ובהלכמש'
// Candidate bases of one word: the word itself + up to two leading clitics stripped
// (kept ≥2 letters so we never strip a word down to a single letter).
function lkBases(w) {
  const out = [w]; let s = w;
  for (let k = 0; k < 2; k++) { if (s.length >= 3 && LK_CLITIC.indexOf(s[0]) >= 0) { s = s.slice(1); out.push(s); } else break; }
  return out;
}
// Cluster equal-length token arrays when every aligned word shares a base (clitic-tolerant).
// Union-find over pairwise "all positions' base-sets intersect".
function lkCluster(entries) {
  const byLen = new Map();
  entries.forEach((e, i) => { const L = e.toks.length; if (!byLen.has(L)) byLen.set(L, []); byLen.get(L).push(i); });
  const parent = entries.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const uni = (a, b) => { parent[find(a)] = find(b); };
  for (const idxs of byLen.values()) {
    const bs = idxs.map((i) => entries[i].toks.map((w) => new Set(lkBases(w))));
    for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++) {
      let ok = true;
      for (let p = 0; p < bs[a].length; p++) { let hit = false; for (const x of bs[a][p]) if (bs[b][p].has(x)) { hit = true; break; } if (!hit) { ok = false; break; } }
      if (ok) uni(idxs[a], idxs[b]);
    }
  }
  const cl = new Map();
  entries.forEach((e, i) => { const r = find(i); if (!cl.has(r)) cl.set(r, []); cl.get(r).push(e); });
  return [...cl.values()];
}
// Render one cluster's representative surface, colouring the optional (clitic) prefix of each word.
function lkClusterDisplay(members) {
  const total = members.reduce((a, e) => a + e.n, 0);
  const rep = members.slice().sort((a, b) => b.n - a.n || a.tgt.length - b.tgt.length || (a.tgt < b.tgt ? -1 : 1))[0];
  const repToks = rep.toks;
  const sameLen = members.every((m) => m.toks.length === repToks.length);
  let html;
  if (sameLen && repToks.length) {
    html = repToks.map((w, p) => {
      let common = new Set(lkBases(w));
      for (const m of members) { const bset = new Set(lkBases(m.toks[p])); common = new Set([...common].filter((x) => bset.has(x))); }
      // core = the LONGEST shared base that is still a suffix of w → strips only the truly-optional prefix.
      let core = w;
      for (const cand of [...common].sort((a, z) => z.length - a.length)) { if (w.endsWith(cand)) { core = cand; break; } }
      const pre = w.slice(0, w.length - core.length);
      return (pre ? `<span class="lk-clitic">${esc(pre)}</span>` : '') + esc(core);
    }).join(' ');
  } else { html = esc(rep.tgt); }
  return { html, total, rep };
}
// Full distribution for the corpus sources matching the query.
function lkVariantStats(sources) {
  const surf = new Map();   // raw target surface -> total occurrences
  for (const e of sources) for (const v of (e.variants || [])) { const t = String(v.tgt == null ? '' : v.tgt).trim(); if (!t) continue; surf.set(t, (surf.get(t) || 0) + (Number(v.n) || 1)); }
  if (!surf.size) return null;
  const entries = [...surf.entries()].map(([tgt, n]) => ({ tgt, n, toks: wbFold(tgt).split(/\s+/).filter(Boolean) }));
  const grandTotal = entries.reduce((a, e) => a + e.n, 0) || 1;
  const rows = lkCluster(entries).map((members) => { const d = lkClusterDisplay(members); return { html: d.html, n: d.total, pct: d.total / grandTotal, rep: d.rep.tgt }; })
    .sort((a, b) => b.n - a.n || a.rep.length - b.rep.length);
  return { rows, grandTotal, variants: rows.length };
}
// The stats block shown at the TOP of the corpus section.
function lkStatsHtml(stats) {
  const cap = 8, shown = stats.rows.slice(0, cap), rest = stats.rows.length - shown.length;
  const bars = shown.map((r) => { const pct = Math.round(r.pct * 100);
    return `<div class="lk-stat"><div class="lk-stat-he" dir="rtl">${r.html}</div><div class="lk-stat-track"><span style="width:${Math.max(2, pct)}%"></span></div><div class="lk-stat-pct">${pct}<span class="hint">% · ${r.n}</span></div></div>`;
  }).join('');
  return `<div class="lk-stats" title="How this term was translated across the corpus. Forms differing only by a leading clitic (ו/ב/ה/ל/כ/מ/ש) are grouped — the clitic is coloured and not counted as a separate variant. % = share of all ${stats.grandTotal} occurrence(s).">` +
    bars + (rest > 0 ? `<div class="hint" style="margin-top:2px">+ ${rest} rarer variant${rest === 1 ? '' : 's'}</div>` : '') + `</div>`;
}
function lkSearch(q) {
  const out = $('lk-out'); if (!out) return;
  q = (q || '').trim();
  if (q.length < 2) { out.innerHTML = '<div class="hint">Type an English or Hebrew word/phrase to see how it\'s normally translated across all your brains + the corpus.</div>'; return; }
  const heQ = /[א-ת]/.test(q), enQ = /[A-Za-z]/.test(q);
  const taskName = (tid) => (CB.index && CB.index.tasksSeen && CB.index.tasksSeen[tid] && CB.index.tasksSeen[tid].name) || '';
  // eg() renders one example line; pass tid to append a ↗ button that opens that task in Starling
  // (only corpus results carry a task id — memory/glossary/auto-fix pass none, so no button there).
  const eg = (s, t, tid) => `<div class="lk-eg"><span dir="ltr">${lkHl(s, q)}</span><span class="lk-t" dir="rtl">${lkHl(t, q)}</span>` +
    (tid ? ` <button class="lk-open" data-task="${esc(tid)}" title="${esc('Open task ' + tid + (taskName(tid) ? ' — ' + taskName(tid) : '') + ' in Starling')}">↗ task</button>` : '') + `</div>`;
  let html = '', pref = '';
  // 1) Corpus concordance — the richest signal
  if (CB.index && CB.index.sources) {
    const keys = Object.keys(CB.index.sources);
    if (enQ) {
      const qtoks = pmEnTokens(q), segs = [], ex = [], matched = [];
      for (const k of keys) {
        const e = CB.index.sources[k]; if (!lkSeq(pmEnTokens(e.src), qtoks)) continue;
        matched.push(e);
        const vs = e.variants.slice().sort((a, b) => b.n - a.n); const top = vs[0];
        const tasks = new Set(); for (const v of e.variants) for (const t of Object.keys(v.tasks || {})) tasks.add(t);
        const tid0 = Object.keys(top.tasks || {})[0] || '';   // a task that produced this exact top translation
        segs.push({ toks: pmHeTokens(top.tgt), tasks }); if (ex.length < 5) ex.push([e.src, top.tgt, tid0]);
      }
      if (segs.length) {
        const tp = pmTopPhrase(segs), taskN = new Set(); segs.forEach((s) => s.tasks.forEach((t) => taskN.add(t)));
        if (tp) pref = tp.disp;   // real corpus surface (ביוטי), never the clitic-stripped base (יוטי)
        const stats = lkVariantStats(matched);   // clitic-folded % distribution — shown on top
        html += `<div class="cb-sec"><div class="cb-h">📦 Corpus — “${esc(q)}” in ${segs.length} segment(s) · ${taskN.size} task(s)</div>` +
          (stats ? lkStatsHtml(stats) : (tp ? `<div class="lk-hit">usually → <b dir="rtl">${esc(tp.disp)}</b> <span class="hint">(${Math.round(tp.cov * 100)}% of them)</span></div>` : '')) +
          ex.map((x) => eg(x[0], x[1], x[2])).join('') + `</div>`;
      }
    }
    if (heQ) {
      const hits = [];
      for (const k of keys) { const e = CB.index.sources[k]; const top = e.variants.slice().sort((a, b) => b.n - a.n)[0]; if (top && wbFold(top.tgt).includes(wbFold(q))) { hits.push([e.src, top.tgt, Object.keys(top.tasks || {})[0] || '']); if (hits.length >= 6) break; } }
      if (hits.length) html += `<div class="cb-sec"><div class="cb-h">📦 Corpus — Hebrew “${esc(q)}” appears in</div>` + hits.map((x) => eg(x[0], x[1], x[2])).join('') + `</div>`;
    }
  }
  // 2) Consistency memory — exact first, then contains
  const exact = tmLookup(q), memHits = [];
  for (const kk of Object.keys(TM.map || {})) { const e = TM.map[kk]; if (e === exact) continue; if (lkMatch(e.src, q) || (heQ && wbFold(e.tgt).includes(wbFold(q)))) { memHits.push(e); if (memHits.length >= 8) break; } }
  if (exact || memHits.length) html += `<div class="cb-sec"><div class="cb-h">🧩 Consistency memory</div>` + (exact ? `<div class="lk-hit">exact → <b dir="rtl">${esc(exact.tgt)}</b> <span class="hint">(${lkHl(exact.src, q)})</span></div>` : '') + memHits.map((e) => eg(e.src, e.tgt)).join('') + `</div>`;
  // 3) Style-Brain glossary + Locked terms
  const gl = (BRAIN.glossary || []).filter((g) => lkMatch(g.en, q) || lkMatch(g.he, q)).slice(0, 12);
  const lk = (LOCK.terms || []).filter((t) => lkMatch(t.en, q) || lkMatch(t.he, q)).slice(0, 12);
  const exactGloss = (BRAIN.glossary || []).find((g) => (g.en || '').toLowerCase() === q.toLowerCase());
  if (enQ && exactGloss) pref = exactGloss.he;   // an existing preference wins the prefill
  if (gl.length || lk.length) html += `<div class="cb-sec"><div class="cb-h">🧠 Glossary / 🔒 Locked</div>` + gl.map((g) => eg(g.en, g.he)).join('') + lk.map((t) => `<div class="lk-eg">🔒 <span dir="ltr">${lkHl(t.en, q)}</span><span class="lk-t" dir="rtl">${lkHl(t.he, q)}</span></div>`).join('') + `</div>`;
  // 4) Auto-fix (HE rewrites)
  const fx = (FIX.rules || []).filter((r) => lkMatch(r.from, q) || lkMatch(r.to, q)).slice(0, 10);
  if (fx.length) html += `<div class="cb-sec"><div class="cb-h">🩹 Auto-fix</div>` + fx.map((r) => `<div class="lk-eg"><span dir="rtl">${lkHl(r.from, q)}</span><span class="lk-t lk-fix" dir="rtl">${lkHl(r.to, q)}</span></div>`).join('') + `</div>`;
  // 5) Set your preferred translation going forward (writes to a brain — corpus/memory are history)
  if (enQ && q.length <= 48) {
    html += `<div class="cb-sec"><div class="cb-h">✏️ Set your preferred translation</div>` +
      `<div class="row" style="gap:6px;align-items:center;flex-wrap:wrap"><span dir="ltr">${esc(q)}</span> → ` +
      `<input id="lk-pref" type="text" dir="rtl" value="${esc(pref)}" placeholder="your preferred Hebrew" style="flex:1;min-width:130px" />` +
      `<button id="lk-gloss" class="btn sm">➕ Glossary</button><button id="lk-lock" class="btn sm">🔒 Lock</button></div>` +
      `<div class="hint"><b>Glossary</b> = advisory (GPT prefers it and inflects naturally — best for a slash form like אפוטרופוס/ית). <b>Lock</b> = mandatory (flags any run that's missing it). This sets it <b>going forward</b>; it doesn't rewrite past corpus/memory.</div></div>`;
  }
  out.innerHTML = html || `<div class="hint">No matches for “${esc(q)}” in the brains${CB.index && CB.index.sources ? ' or corpus' : ' (build the 📦 Corpus for richer results)'}.</div>`;
  // ↗ task — open the Starling editor for the task this corpus example came from (new tab)
  out.querySelectorAll('.lk-open').forEach((b) => b.addEventListener('click', () => {
    const tid = b.getAttribute('data-task'); if (!tid) return;
    const url = starlingTaskUrl(tid);
    try { chrome.tabs.create({ url }); } catch (e) { window.open(url, '_blank'); }
  }));
  // wire the "set preferred" buttons (q captured)
  if ($('lk-gloss')) $('lk-gloss').addEventListener('click', async () => {
    const he = ($('lk-pref').value || '').trim(); if (!he) { lkInfo('Enter your preferred Hebrew first.', 'err'); return; }
    const clashes = [];
    if (pmGlossPush(q, he, 'from lookup', clashes)) { await brainSave(); brainRefresh(); lkInfo(`Added to glossary: “${q}” → “${he}”.`, 'good'); }
    else { confAdd(clashes); await brainSave(); lkInfo(`“${q}” already maps to a different term — resolve it in the orange ⚠ card.`, 'err'); }
  });
  if ($('lk-lock')) $('lk-lock').addEventListener('click', async () => {
    const he = ($('lk-pref').value || '').trim(); if (!he) { lkInfo('Enter your preferred Hebrew first.', 'err'); return; }
    const clash = (LOCK.terms || []).find((t) => (t.en || '').toLowerCase() === q.toLowerCase() && wbFold(t.he) !== wbFold(he));
    if (clash) { lkInfo(`“${q}” is already locked to “${clash.he}” — change it in the 🔒 Locked terms card.`, 'err'); return; }
    LOCK.terms = (LOCK.terms || []).filter((t) => (t.en || '').toLowerCase() !== q.toLowerCase());
    LOCK.terms.push({ id: brainUid(), en: q, he, note: 'from lookup', ts: Date.now() });
    await lockSave(); lockRefresh(); lkInfo(`Locked: “${q}” → “${he}”.`, 'good');
  });
}

// ---- FULL BACKUP / RESTORE (safety net for every brain) -------------------
// One JSON snapshot of EVERY store — Style Brain, Consistency memory, Locked
// terms, Auto-fix, and the corpus index — so you can always roll back to the
// exact state before any bulk change. The corpus Promote auto-downloads one first.
function snapshotAll() {
  return {
    _meta: { kind: 'starling-copilot-backup', ver: 1, ts: Date.now(), at: new Date().toISOString() },
    styleBrain: BRAIN, consistencyTM: TM, lockedTerms: LOCK, autoFix: FIX, pluralMemory: PM, corpusIndex: CB.index || null
  };
}
function backupAll() {
  const blob = new Blob([JSON.stringify(snapshotAll(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'starling-brains-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  cbInfo(`Backup downloaded — ${BRAIN.rules.length} rules · ${BRAIN.glossary.length} terms · ${tmCount()} memory · ${lockCount()} locked · ${fixCount()} auto-fix · ${pmCount()} plural. Keep it to roll back anytime.`, 'good');
}
async function restoreAll(file) {
  try {
    const o = JSON.parse(await file.text());
    if (!o || (!o.styleBrain && !o.consistencyTM && !o.lockedTerms && !o.autoFix)) throw new Error('not a full brains-backup file.');
    if (!confirm('Restore REPLACES your Style Brain, Consistency memory, Locked terms and Auto-fix with this backup — your current data is overwritten (a fresh backup of the current state downloads first). Continue?')) return;
    try { backupAll(); } catch (e) {}   // safety: snapshot the CURRENT state before overwriting it
    if (o.styleBrain) { BRAIN = o.styleBrain; if (!BRAIN.rules) BRAIN.rules = []; if (!BRAIN.glossary) BRAIN.glossary = []; await brainSave(); brainRefresh(); }
    if (o.consistencyTM) { TM = o.consistencyTM; if (!TM.map) TM.map = {}; await tmSave(); tmRefresh(); }
    if (o.lockedTerms) { LOCK = o.lockedTerms; if (!LOCK.terms) LOCK.terms = []; await lockSave(); lockRefresh(); }
    if (o.autoFix) { FIX = o.autoFix; if (!FIX.rules) FIX.rules = []; await fixSave(); fixRefresh(); }
    if (o.pluralMemory) { PM = o.pluralMemory; if (!PM.map) PM.map = {}; await pmSave(); }
    if (o.corpusIndex) { CB.index = o.corpusIndex; try { await store.set({ corpusIndex: CB.index }); } catch (e) {} cbClassify(); cbRender(); cbBadge(); clBadge(); }
    cbInfo('Restored all brains from the backup. (The pre-restore state was also downloaded, just in case.)', 'good');
  } catch (e) { cbInfo('Restore failed: ' + (e.message || e), 'err'); }
}

// ---- PLURAL (one/two/many/other) sub-forms --------------------------------
// Harvest is via the data API (all forms, no lazy-editor problem). Propose runs
// each source form through GPT (number-position rule already in the prompt), then
// he-IL fills one=distinct, two=many=other=the plural form. Write mounts+types each
// sub-form via the content script (WRITE_PLURAL). See project memory for the DOM model.
const PL = { segs: [] };
async function plScan() {
  info('pl-info', 'Scanning plural segments…');
  try {
    const r = await send({ type: 'HARVEST_PLURALS' });
    if (!r || !r.ok) throw new Error((r && r.error) || 'scan failed');
    let all = (r.plurals || []).map((s) => ({ rank: s.rank, key: s.key, srcForms: s.srcForms || {}, tgtForms: s.tgtForms || {}, forms: null, approved: false }));
    // Honor the "Only segments" box (rank = the displayed segment number).
    const sel = parseSegSel($('seg-filter').value);
    PL.segs = sel ? all.filter((s) => sel(s)) : all;
    if (sel && !PL.segs.length) {
      info('pl-info', `No plural segments matched "${$('seg-filter').value.trim()}" (task has ${all.length} plural segment(s)). Clear the box for all.`, 'err');
      plRender(); return;
    }
    // Plural memory pre-fill: a remembered form-set for this source drops straight in (no GPT).
    let mem = 0;
    for (const s of PL.segs) {
      const hit = pmLookup(s.srcForms);
      if (hit && hit.forms) {
        const need = Object.keys(s.tgtForms).length ? Object.keys(s.tgtForms) : Object.keys(hit.forms);
        s.forms = {}; need.forEach((f) => { s.forms[f] = hit.forms[f] != null ? hit.forms[f] : (hit.forms.other || hit.forms.one || ''); });
        s.approved = true; s.memory = true; mem++;
      }
    }
    info('pl-info', PL.segs.length ? `Found ${PL.segs.length} plural segment(s)${sel ? ' (filtered)' : ''}${mem ? ` · ${mem} pre-filled from Plural memory 🧠` : ''}. Propose the rest, review, then write.` : 'No plural segments in this task.', PL.segs.length ? 'good' : '');
    plRender();
  } catch (e) { info('pl-info', e.message, 'err'); }
}
async function plPropose(idx) {
  const key = await store.get('key', '');
  if (!key) { info('pl-info', 'Add your OpenAI key in Settings first.', 'err'); $('settings').open = true; return; }
  const model = $('model').value, plural = $('plural').checked;
  const s = PL.segs[idx];
  const srcOne = s.srcForms.one || s.srcForms.other || '';
  const srcOther = s.srcForms.other || s.srcForms.one || '';
  info('pl-info', `Proposing #${s.rank}…`);
  try {
    // Tell GPT which item is which CLDR form — the English is often IDENTICAL for one
    // and other (e.g. "{s_number} people" for both), so it can't infer the number position.
    const plSys = 'These are two Hebrew plural forms of the SAME string. Item i=1 is the CLDR "one" form (count exactly 1): use the SINGULAR noun and put the {placeholder} AFTER the noun ("שעה {s_num}", "אדם {s_number}"). Item i=2 is the plural form: use the plural noun with the {placeholder} BEFORE it ("{s_num} שעות", "{s_number} אנשים").';
    const out = await gptBatch([{ i: 1, src: srcOne, tgt: s.tgtForms.one || '' }, { i: 2, src: srcOther, tgt: s.tgtForms.other || '' }], 'translate', key, model, plural, plSys, true);   // true = TikTok style guide
    const byI = {}; (out || []).forEach((o) => { if (o && o.i != null && o.text != null) byI[o.i] = o.text; });
    const heOne = polish(srcOne, byI[1] != null ? byI[1] : (s.tgtForms.one || ''));
    const heOther = polish(srcOther, byI[2] != null ? byI[2] : (s.tgtForms.other || ''));
    // Fill the forms the target actually uses; default to he-IL's set. one=distinct, rest=plural.
    const need = Object.keys(s.tgtForms).length ? Object.keys(s.tgtForms) : ['one', 'two', 'many', 'other'];
    s.forms = {}; need.forEach((f) => { s.forms[f] = (f === 'one' || f === 'zero') ? heOne : heOther; });
    s.approved = true;
    plRender();
    info('pl-info', `Proposed #${s.rank}. Review the forms, then write.`, 'good');
  } catch (e) { info('pl-info', e.message, 'err'); }
}
function plRender() {
  const box = $('pl-list');
  box.innerHTML = PL.segs.map((s, idx) => {
    const src = Object.entries(s.srcForms).map(([f, v]) => `<div class="rc-psrc" dir="ltr"><b>${esc(f)}</b> · ${hl(esc(v))}</div>`).join('');
    const forms = s.forms
      ? Object.entries(s.forms).map(([f, v]) => `<div class="rc-part"><span class="rc-pidx" title="${esc(f)}">${esc(f)}</span><div class="rc-pbody"><div class="rc-ptxt" dir="rtl" contenteditable="true" spellcheck="false" data-i="${idx}" data-form="${esc(f)}">${esc(v)}</div></div></div>`).join('')
      : '<div class="info">Not proposed yet — click ✨ Propose.</div>';
    return `<div class="rc${s.written ? ' unchanged' : ''}" data-i="${idx}">
      <div class="rc-top"><span class="rc-seg">#${esc(s.rank)}</span>
        ${s.memory ? '<span class="rc-warn" style="background:#0c4a6e" title="Pre-filled from your Plural memory (a form-set you promoted from the corpus) — review and write, no GPT needed.">🧠 memory</span>' : ''}
        <div class="rc-ctl">${s.forms ? `<label><input type="checkbox" class="pl-cb" data-i="${idx}" ${s.approved ? 'checked' : ''}/> write</label>` : ''}<button class="rc-write pl-propose" type="button" data-i="${idx}">✨ ${s.memory ? 'Re-propose' : 'Propose'}</button></div>
      </div>
      <div class="rc-src">${src}</div>
      <div class="rc-parts">${forms}</div>
    </div>`;
  }).join('') || '<div class="info">No plural segments.</div>';
  box.querySelectorAll('.pl-propose').forEach((b) => b.addEventListener('click', () => plPropose(+b.dataset.i)));
  box.querySelectorAll('.pl-cb').forEach((cb) => cb.addEventListener('change', (e) => { PL.segs[+e.target.dataset.i].approved = e.target.checked; plUpdateWrite(); }));
  box.querySelectorAll('.rc-ptxt[contenteditable]').forEach((ed) => ed.addEventListener('input', (e) => { const s = PL.segs[+e.target.dataset.i]; if (s.forms) s.forms[e.target.dataset.form] = e.target.innerText; }));
  plUpdateWrite();
}
function plUpdateWrite() {
  const n = PL.segs.filter((s) => s.forms && s.approved && !s.written).length;
  $('pl-write-wrap').hidden = n === 0;
  $('pl-write').hidden = n === 0;
  $('pl-write').textContent = `✍ Write ${n} approved plural segment(s)`;
}
async function plWrite() {
  if (!$('pl-enable-write').checked) { info('pl-write-info', 'Tick "enable writing plural forms" first.', 'err'); return; }
  const todo = PL.segs.filter((s) => s.forms && s.approved && !s.written);
  if (!todo.length) { info('pl-write-info', 'Nothing approved to write.', 'err'); return; }
  if (!confirm(`Write ${todo.length} plural segment(s) into Starling? Each fills its one/two/many/other boxes (it briefly filters the list per segment).`)) return;
  $('pl-write').disabled = true;
  let ok = 0, bad = 0;
  for (const s of todo) {
    info('pl-write-info', `Writing #${s.rank}…`);
    try {
      const r = await send({ type: 'WRITE_PLURAL', edit: { rank: s.rank, key: s.key, srcForms: s.srcForms, forms: s.forms } });
      if (r && r.ok) { ok++; s.written = true; }
      else { bad++; log(`plural #${s.rank} failed: ${(r && (r.error || JSON.stringify(r.results))) || '?'}`); }
    } catch (e) { bad++; log(`plural #${s.rank} error: ${e.message}`); }
  }
  info('pl-write-info', `✅ Wrote ${ok}${bad ? ` · ${bad} failed (see log)` : ''}`, bad ? 'err' : 'good');
  plRender();
  $('pl-write').disabled = false;
}

// ---- wire up ---------------------------------------------------------------
// ---- Style Brain: ingest UI (paste / grab) → distill → review → merge ------
const BRAIN_CATS = ['register', 'address', 'punctuation', 'tone', 'numbers', 'format', 'placeholders', 'glossary', 'misc'];
let brainProposal = null;   // { rules:[{cat,text,accept}], glossary:[{en,he,note,accept}], conflicts:[{cat,text,conflictsWith,accept}] }
// Persist a pending review proposal (e.g. a corpus-learn run's findings) so it survives closing the panel.
function bpSave() { try { store.set({ brainReview: brainProposal || null }); } catch (e) {} }
async function bpLoad() { try { const p = await store.get('brainReview', null); if (p && ((p.rules && p.rules.length) || (p.glossary && p.glossary.length) || (p.conflicts && p.conflicts.length))) brainProposal = p; } catch (e) {} return brainProposal; }
const brainUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function brainInfo(msg, kind) { info('brain-info', msg, kind || ''); }

function brainRefresh() {
  const rn = (BRAIN.rules || []).length, gn = (BRAIN.glossary || []).length;
  const badge = $('brain-badge'); if (badge) badge.textContent = (rn || gn) ? `· ${rn} rules · ${gn} terms` : '· empty (built-in guide only)';
  if ($('brain-rules-n')) $('brain-rules-n').textContent = rn;
  if ($('brain-gloss-n')) $('brain-gloss-n').textContent = gn;
  clsBadge();   // keep the 🧹 Consolidate button's rule count in sync
  const list = $('brain-list'); if (!list) return;
  const q = (($('brain-search') && $('brain-search').value) || '').trim().toLowerCase();
  const rMatch = (r) => !q || `${r.cat || ''} ${r.text || ''}`.toLowerCase().includes(q);
  const gMatch = (g) => !q || `${g.en || ''} ${g.he || ''} ${g.note || ''}`.toLowerCase().includes(q);
  const rowsR = (BRAIN.rules || []).filter(rMatch).map((r) => `<div class="bl-row"><button class="bl-del" data-kind="rule" data-id="${esc(r.id)}" title="Delete this rule">✕</button><span class="bi-cat">${esc(r.cat || 'misc')}</span><span class="bi-text" dir="auto">${esc(r.text)}</span></div>`).join('');
  const rowsG = (BRAIN.glossary || []).filter(gMatch).map((g) => `<div class="bl-row"><button class="bl-del" data-kind="gloss" data-id="${esc(g.id)}" title="Delete this term">✕</button><span class="bi-text"><span dir="ltr">${esc(g.en)}</span> → <span dir="rtl">${esc(g.he)}</span>${g.note ? ` <span class="hint">(${esc(g.note)})</span>` : ''}</span></div>`).join('');
  list.innerHTML = (rowsR || rowsG)
    ? `${rowsR ? `<div class="brain-sec">Rules</div>${rowsR}` : ''}${rowsG ? `<div class="brain-sec">Glossary</div>${rowsG}` : ''}`
    : (q ? `<div class="hint">No rule or term matches “${esc(q)}”.</div>`
         : '<div class="hint">No ingested rules yet — the built-in guide is still fully in effect.</div>');
  list.querySelectorAll('.bl-del').forEach((b) => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-id'), kind = b.getAttribute('data-kind');
    if (kind === 'rule') BRAIN.rules = BRAIN.rules.filter((r) => String(r.id) !== id);
    else BRAIN.glossary = BRAIN.glossary.filter((g) => String(g.id) !== id);
    await brainSave(); brainRefresh();
  }));
}

async function brainDistill() {
  const key = await store.get('key', '');
  if (!key) { brainInfo('Add your OpenAI key in Settings first.', 'err'); $('settings').open = true; return; }
  const doc = $('brain-input').value.trim();
  if (doc.length < 40) { brainInfo('Paste a style-guide document first (or use ⬇ Grab from the active tab).', 'err'); return; }
  const model = $('model').value;
  $('brain-distill').disabled = true; brainInfo('Distilling… (one GPT call)');
  try {
    const existing = ((BRAIN.rules || []).map((r) => '- [' + r.cat + '] ' + r.text).join('\n') + '\n' + (BRAIN.glossary || []).map((g) => '- "' + g.en + '" → "' + g.he + '"').join('\n')).trim();
    const sys = 'You distill a TikTok Hebrew (he-IL) localization STYLE GUIDE document into a COMPACT, deduplicated ruleset for a translator/proofreader. Extract ONLY concrete, actionable rules and approved term mappings — no history, no rationale-only prose, no examples-only fluff, no generic localization common sense. Each rule ≤ ~30 words, imperative and specific. Categorize each rule as one of: ' + BRAIN_CATS.join(' | ') + '. Put exact EN→HE term equivalences in "glossary" (not "rules"). CRITICAL: do NOT repeat anything already covered by the EXISTING RULES the user provides. If a new rule CONTRADICTS an existing one, put it in "conflicts" (not "rules") with a short "conflictsWith" note naming what it clashes with. Return ONLY JSON: {"rules":[{"cat":"…","text":"…"}],"glossary":[{"en":"…","he":"…","note":"…"}],"conflicts":[{"cat":"…","text":"…","conflictsWith":"…"}]}. Keep Hebrew in Hebrew; never translate the rule text itself.';
    const user = 'EXISTING RULES (already enforced — do NOT repeat any of these):\n' + (existing || '(none ingested yet — but a built-in guide already covers voice, register, singular-slash address form, punctuation, numbers/dual, placeholders, and a base glossary; skip anything those cover)') + '\n\nSTYLE-GUIDE DOCUMENT TO DISTILL:\n' + doc.slice(0, 24000);
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
    });
    const data = await r.json();
    if (!r.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + r.status));
    let o = {}; try { o = JSON.parse(data.choices[0].message.content); } catch (e) { throw new Error('the model returned unparseable JSON.'); }
    brainProposal = {
      rules: (o.rules || []).map((x) => ({ cat: x.cat || 'misc', text: String(x.text || '').trim(), accept: true })).filter((x) => x.text),
      glossary: (o.glossary || []).map((x) => ({ en: String(x.en || '').trim(), he: String(x.he || '').trim(), note: String(x.note || '').trim(), accept: true })).filter((x) => x.en && x.he),
      conflicts: (o.conflicts || []).map((x) => ({ cat: x.cat || 'misc', text: String(x.text || '').trim(), conflictsWith: String(x.conflictsWith || '').trim(), accept: false })).filter((x) => x.text)
    };
    const total = brainProposal.rules.length + brainProposal.glossary.length + brainProposal.conflicts.length;
    brainInfo(`Distilled ${brainProposal.rules.length} rules · ${brainProposal.glossary.length} terms${brainProposal.conflicts.length ? ` · ⚠ ${brainProposal.conflicts.length} conflict(s)` : ''} — review and merge below.`, total ? 'good' : '');
    brainRenderReview();
  } catch (e) { brainInfo('Distill failed: ' + e.message, 'err'); }
  finally { $('brain-distill').disabled = false; }
}

function brainRenderReview() {
  bpSave();   // persist the current proposal (or clear storage when null) so a review survives closing the panel
  const box = $('brain-review'); if (!box) return;
  if (!brainProposal) { box.hidden = true; return; }
  const P = brainProposal;
  const rowsR = P.rules.map((x, i) => `<label class="brain-item"><input type="checkbox" data-t="rule" data-i="${i}" ${x.accept ? 'checked' : ''}/><span class="bi-cat">${esc(x.cat)}</span><span class="bi-text" dir="auto">${esc(x.text)}</span></label>`).join('');
  const rowsG = P.glossary.map((x, i) => `<label class="brain-item gloss"><input type="checkbox" data-t="gloss" data-i="${i}" ${x.accept ? 'checked' : ''}/><span class="bi-cat">term</span><span class="bi-text"><span dir="ltr">${esc(x.en)}</span> → ${esc(x.he)}${x.note ? ` <span class="hint">(${esc(x.note)})</span>` : ''}</span></label>`).join('');
  const rowsC = P.conflicts.map((x, i) => `<label class="brain-item conflict"><input type="checkbox" data-t="conflict" data-i="${i}" ${x.accept ? 'checked' : ''}/><span class="bi-cat">${esc(x.cat)}</span><span class="bi-text" dir="auto">${esc(x.text)} <span class="hint">— conflicts with: ${esc(x.conflictsWith)}</span></span></label>`).join('');
  box.innerHTML =
    (rowsR ? `<div class="brain-sec">New rules</div>${rowsR}` : '') +
    (rowsG ? `<div class="brain-sec">New glossary terms</div>${rowsG}` : '') +
    (rowsC ? `<div class="brain-sec">⚠ Conflicts — review carefully (unchecked by default)</div>${rowsC}` : '') +
    ((rowsR || rowsG || rowsC) ? `<div class="row"><button id="brain-merge" class="btn sm">Merge selected into brain</button><button id="brain-discard" class="btn sm ghost">Discard</button></div>` : '<div class="hint">Nothing new — everything in this doc is already covered.</div>');
  box.hidden = false;
  box.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
    const t = cb.getAttribute('data-t'), i = +cb.getAttribute('data-i');
    (t === 'rule' ? P.rules : t === 'gloss' ? P.glossary : P.conflicts)[i].accept = cb.checked;
  }));
  if ($('brain-merge')) $('brain-merge').addEventListener('click', brainMerge);
  if ($('brain-discard')) $('brain-discard').addEventListener('click', () => { brainProposal = null; bpSave(); box.hidden = true; brainInfo('Discarded — nothing was added.', ''); });
}

async function brainMerge() {
  if (!brainProposal) return;
  const src = (brainProposal.sourceLabel || ($('brain-input').value.trim().slice(0, 48) || 'pasted doc')).replace(/\s+/g, ' ');
  const now = Date.now();
  const addR = brainProposal.rules.filter((x) => x.accept).concat(brainProposal.conflicts.filter((x) => x.accept));
  for (const x of addR) BRAIN.rules.push({ id: brainUid(), cat: x.cat || 'misc', text: x.text, source: src, ts: now });
  const addG = brainProposal.glossary.filter((x) => x.accept);
  const clashes = [];
  for (const x of addG) {
    const clash = (BRAIN.glossary || []).find((g) => (g.en || '').toLowerCase() === x.en.toLowerCase() && wbFold(g.he) !== wbFold(x.he));
    if (clash) { clashes.push({ kind: 'gloss', en: x.en, oldVal: clash.he, newVal: x.he, note: x.note, source: src }); continue; }  // don't overwrite a different term silently
    BRAIN.glossary = BRAIN.glossary.filter((g) => g.en.toLowerCase() !== x.en.toLowerCase());   // same-en refresh / re-note
    BRAIN.glossary.push({ id: brainUid(), en: x.en, he: x.he, note: x.note, source: src, ts: now });
  }
  await brainSave();
  const n = addR.length + (addG.length - clashes.length);
  brainProposal = null; bpSave(); $('brain-review').hidden = true; $('brain-input').value = ''; brainRefresh();
  if (clashes.length) confAdd(clashes);
  brainInfo(`Merged ${n} item(s). Brain now has ${BRAIN.rules.length} rules · ${BRAIN.glossary.length} terms — active on the next Run.` + (clashes.length ? ` ⚠ ${clashes.length} term(s) clash with an existing entry — resolve them in the orange ⚠ panel.` : ''), clashes.length ? 'err' : 'good');
}

// ---- LEARN FROM STARLING: harvest a submitted task → memory + distilled brain ----
// Reads a task's segments via the page's window.__wb.apiTask (same-origin, your logged-in
// session — no credentials handled here), keeps only proofread-confirmed pairs (status 3 =
// the approved final, the source of truth), and (a) feeds them verbatim to Consistency memory
// and/or (b) distills generalizable rules/terms — routed through the SAME review/merge flow,
// with brain conflicts surfaced as decision tickets. No content.js change: apiTask already exists.
function hvInfo(m, k) { info('hv-info', m, k); }
function hvExtractId(s) { const m = String(s || '').match(/taskid=(\d+)/i) || String(s || '').match(/\b(\d{5,})\b/); return m ? m[1] : ''; }
// Document-editor (/doc/editor) fallback: the string content API 1002s on doc tasks, but the
// open editor's redux store holds every segment (source + confirmed target). Read it straight
// from the active tab's store (same approach as ⬇ Grab term base). Returns API_TASK-shaped rows.
async function hvDocRows(id) {
  let tab; try { tab = await wbActiveTab(); } catch (e) { return { ok: false, error: 'no active tab' }; }
  if (!tab || !/\/doc\/editor\//.test(tab.url || '')) return { ok: false, error: 'the Document editor for this task isn’t the active tab — open it, let it load, and try again' };
  if (id && !String(tab.url || '').includes(String(id))) return { ok: false, error: 'the open Document editor is a different task than the id requested' };
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        try {
          const anchor = document.querySelector('.cat-content__term, [class*="cat-content__source"], [class*="cat-content"]');
          let store = null, node = anchor;
          for (let up = 0; node && up < 18 && !store; up++, node = node.parentElement) {
            const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$')); if (!fk) continue;
            let f = node[fk], hops = 0;
            while (f && hops < 16) { const p = f.memoizedProps; if (p && p.docEditor && p.docEditor.taskDetail) { store = p.docEditor; break; } f = f.return; hops++; }
          }
          if (!store) return { ok: false, error: 'doc store not found (let the editor finish loading, then retry)' };
          const segs = (((store.taskDetail || {}).segmentInfo || {}).segments) || [];
          const txt = (o) => (o ? (o.Text != null ? o.Text : (o.text != null ? o.text : '')) : '');
          const rows = segs.map((s) => ({ status: (s.Status != null ? s.Status : s.status), source: String(txt(s.Source) || txt(s.source) || ''), target: String(txt(s.Target) || txt(s.target) || ''), key: '' }));
          const td = store.taskDetail || {};
          return { ok: true, rows, taskName: td.TaskName || td.taskName || td.name || '' };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }
    });
    return (r && r.result) || { ok: false, error: 'no result' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
async function hvHarvest() {
  let id = hvExtractId($('hv-task').value) || $('hv-task').value.trim();
  if (!id) { try { const t = await wbActiveTab(); id = hvExtractId(t && t.url); } catch (e) {} }
  if (!id) { hvInfo('Open a Starling task (its URL has taskid=…), or paste a task id / editor URL.', 'err'); return; }
  $('hv-harvest').disabled = true; hvInfo('Reading task ' + id + '…');
  try {
    let rows, taskNameOverride = '';
    const res = await wbCall('API_TASK', { taskId: id });
    if (res && res.ok) { rows = res.rows || []; }
    else {   // string API failed (e.g. 1002 on a /doc/editor task) → read the open doc editor's store
      const doc = await hvDocRows(id);
      if (doc && doc.ok) { rows = doc.rows; taskNameOverride = doc.taskName || ''; }
      else throw new Error((res && res.error) || (doc && doc.error) || 'read failed');
    }
    const pairs = [], seen = new Set();
    let confirmed = 0;
    for (const r of rows) {
      if (r.status !== 3) continue;                 // proofread-confirmed only
      confirmed++;
      const src = String(r.source || '').trim(), tgt = String(r.target || '').trim();
      if (!src || !tgt) continue;
      const dk = src + '' + tgt; if (seen.has(dk)) continue; seen.add(dk);   // de-dupe identical pairs
      pairs.push({ src, tgt, key: r.key || '' });
    }
    HV = { pairs, taskId: id, taskName: (res && res.ok && res.taskName) || taskNameOverride || ('task ' + id) };
    if (!pairs.length) { $('hv-actions').hidden = true; hvInfo(`Read ${rows.length} segments · ${confirmed} confirmed — none had both a source and target to learn from.`, 'err'); return; }
    $('hv-actions').hidden = false;
    hvInfo(`Harvested ${pairs.length} confirmed pair(s) (of ${rows.length} segments). Add them to memory, or distill rules & terms.`, 'good');
  } catch (e) { $('hv-actions').hidden = true; hvInfo('Harvest failed: ' + (e.message || e), 'err'); }
  finally { $('hv-harvest').disabled = false; }
}
async function hvToMemory() {
  if (!HV.pairs.length) { hvInfo('Harvest a task first.', 'err'); return; }
  let added = 0, same = 0; const clashes = [];
  // Don't re-park a conflict already sitting in the orange card (e.g. a second click, or the same
  // source appearing twice in the harvest with the same divergent target).
  const parked = new Set(CONF.filter((c) => c.kind === 'mem').map((c) => c.srcKey + '⇢' + wbFold(c.newVal)));
  for (const p of HV.pairs) {
    const k = tmKey(p.src), prev = TM.map[k];
    if (prev && wbFold(prev.tgt) !== wbFold(p.tgt)) {   // same source already remembered with a DIFFERENT target → adjudicate, never silently overwrite
      const sig = k + '⇢' + wbFold(p.tgt);
      if (!parked.has(sig)) { parked.add(sig); clashes.push({ kind: 'mem', label: p.src, srcKey: k, src: p.src, oldVal: prev.tgt, newVal: p.tgt }); }
      continue;
    }
    const existed = !!prev;
    if (tmRecordOne(p.src, p.tgt)) { if (existed) same++; else added++; }
  }
  await tmSave(); tmRefresh();
  let msg = `Added ${added} new pair(s) to Consistency memory` + (same ? ` · ${same} already matched` : '') + ` (now ${tmCount()} strings).`;
  if (clashes.length) {
    confAdd(clashes);
    msg += ` ⚠ ${clashes.length} conflict(s) with existing wording — resolve them in the orange ⚠ card (pick which to keep; the other is deleted).`;
    hvInfo(msg, 'err');
  } else {
    hvInfo(msg + ' Approved wording auto-fills on matching sources.', 'good');
  }
}
function hvSys() {
  return 'You learn TikTok Hebrew (he-IL) localization conventions from APPROVED en→he translation pairs — the submitted, proofread source of truth. Infer GENERALIZABLE, actionable conventions a translator/proofreader should reuse across future tasks: term mappings, register/tone (e.g. singular gender-neutral slash form vs plural), punctuation, placeholder/tag handling, brand casing. ' +
    'Output COMPACT rules (≤ ~30 words each, imperative and specific), each categorized as one of: ' + BRAIN_CATS.join(' | ') + '. Put exact recurring EN→HE term equivalences in "glossary" (with a short "note" — the register or that it recurs). ' +
    'Extract ONLY high-confidence patterns the pairs actually demonstrate — do NOT invent generic localization common sense, and do NOT restate anything already covered by the EXISTING BRAIN. ' +
    'If a pattern the pairs demonstrate CONTRADICTS an existing brain rule or term, DO NOT silently override it: put it in "conflicts" with "conflictsWith" naming the clashing rule/term and cite the evidence from the pairs. ' +
    'Keep Hebrew in Hebrew; never translate the rule text itself. Return ONLY JSON: {"rules":[{"cat":"…","text":"…"}],"glossary":[{"en":"…","he":"…","note":"…"}],"conflicts":[{"cat":"…","text":"…","conflictsWith":"…"}]}.';
}
async function hvDistill() {
  const key = await store.get('key', '');
  if (!key) { hvInfo('Add your OpenAI key in Settings first.', 'err'); $('settings').open = true; return; }
  if (!HV.pairs.length) { hvInfo('Harvest a task first.', 'err'); return; }
  const model = $('model').value;
  const capped = HV.pairs.slice(0, HV_CAP);
  const existing = ((BRAIN.rules || []).map((r) => '- [' + r.cat + '] ' + r.text).join('\n') + '\n' + (BRAIN.glossary || []).map((g) => '- "' + g.en + '" → "' + g.he + '"').join('\n')).trim();
  const sys = hvSys();
  const agg = { rules: [], glossary: [], conflicts: [] };
  $('hv-distill').disabled = true; let dropTemp = false;
  try {
    for (let i = 0; i < capped.length; i += HV_BATCH) {
      const chunk = capped.slice(i, i + HV_BATCH);
      hvInfo(`Distilling ${i + 1}–${Math.min(i + HV_BATCH, capped.length)} of ${capped.length}…`);
      const doc = chunk.map((p, j) => `${j + 1}. EN: ${p.src}\n   HE: ${p.tgt}`).join('\n');
      const user = 'EXISTING BRAIN (already enforced — do NOT repeat; contradictions → "conflicts"):\n' + (existing || '(only the built-in base guide so far)') + '\n\nAPPROVED en→he PAIRS (source of truth):\n' + doc;
      const callGpt = async () => {
        const body = { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
        if (!dropTemp) body.temperature = 0.1;
        const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await r.json();
        if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
        return data;
      };
      let data;
      try { data = await callGpt(); }
      catch (e1) { if (!dropTemp && /temperature/i.test(e1.message || '')) { dropTemp = true; data = await callGpt(); } else throw e1; }
      let o = {}; try { o = JSON.parse(data.choices[0].message.content); } catch (e) { continue; }
      (o.rules || []).forEach((x) => agg.rules.push(x));
      (o.glossary || []).forEach((x) => agg.glossary.push(x));
      (o.conflicts || []).forEach((x) => agg.conflicts.push(x));
      if (i + HV_BATCH < capped.length) await new Promise((r) => setTimeout(r, 200));
    }
    // Reconcile across batches: dedupe candidate rules/terms/conflicts.
    const seenR = new Set(), rules = [];
    for (const x of agg.rules) { const t = String(x.text || '').trim(); const kk = (x.cat || '') + '|' + wbNorm(t).toLowerCase(); if (!t || seenR.has(kk)) continue; seenR.add(kk); rules.push({ cat: x.cat || 'misc', text: t, accept: true }); }
    const seenG = new Set(), glossary = [];
    for (const x of agg.glossary) { const en = String(x.en || '').trim(), he = String(x.he || '').trim(); if (!en || !he) continue; const kk = en.toLowerCase(); if (seenG.has(kk)) continue; seenG.add(kk); glossary.push({ en, he, note: String(x.note || '').trim(), accept: true }); }
    const seenC = new Set(), conflicts = [];
    for (const x of agg.conflicts) { const t = String(x.text || '').trim(); const kk = wbNorm(t).toLowerCase(); if (!t || seenC.has(kk)) continue; seenC.add(kk); conflicts.push({ cat: x.cat || 'misc', text: t, conflictsWith: String(x.conflictsWith || '').trim(), accept: false }); }
    brainProposal = { rules, glossary, conflicts, sourceLabel: ('harvested: ' + HV.taskName).slice(0, 60) };
    brainRenderReview(); $('brain-card').open = true; $('brain-review').scrollIntoView({ block: 'nearest' });
    hvInfo(`Distilled ${rules.length} rule(s) · ${glossary.length} term(s)${conflicts.length ? ` · ⚠ ${conflicts.length} conflict ticket(s)` : ''} from ${capped.length} pair(s) — review & merge in the brain panel above.`, 'good');
  } catch (e) { hvInfo('Distill failed: ' + (e.message || e), 'err'); }
  finally { $('hv-distill').disabled = false; }
}

// ---- LEARN FROM A VALIDATED AI-CHECK SHEET (Feishu "Valid = Yes" rows) → memory + brain ----
// The sheet is ALREADY human-adjudicated: the "Valid (Y/N)" column is YOUR call and "Final
// Translation" YOUR fix. Every Valid=Yes row is therefore a CONFIRMED past mistake plus its
// approved correction — the richest learning signal we have. We (a) store source→final in
// Consistency memory (exact-match prevention) and (b) distill the CONTRASTIVE wrong-vs-right
// (+ the reviewer reason) into generalizable brain rules/terms. Accumulates across sheet tabs
// so you can add 8.7 sync, then 8.12 sync, then teach once. Honors the Hebrew + level filters.
const LRN_BATCH = 25, LRN_CAP = 400;
let LRN = { rows: [] };   // {src, wrong, final, comment, etype, key, sheet}
function lrnInfo(m, k) { info('lq-learn-info', m, k || ''); }
// A row counts as validated when you marked it Valid = Yes, OR — in an XBench/Feishu "agree" export
// (I=Fixed, J=agree, K=final) — when the Validation-feedback cell says "agree". Anchored so "disagree"
// never matches.
function lrnYes(v) { return /^(y|yes|valid|true|1|כן|✓|v|agree|מסכים|מאשר(?:\/ת)?)$/i.test(String(v == null ? '' : v).trim()); }
function lrnSheetName() { return (($('lq-tab') && $('lq-tab').value) || LQ.fileName || 'sheet'); }
function lrnAdd() {
  if (!LQ.rows || !LQ.rows.length) { lrnInfo('Load a sheet first (Step 1).', 'err'); return; }
  if (!(LQ.map.valid >= 0)) { lrnInfo('No "Valid" column is mapped — set it in Step 2 (column mapping).', 'err'); return; }
  const sheet = lrnSheetName();
  let added = 0, nofix = 0;
  const seen = new Set(LRN.rows.map((r) => wbFold(r.src) + '⇢' + wbFold(r.final)));
  for (const r of LQ.rows) {
    if (!lrnYes(r.valid)) continue;                              // only the rows YOU marked Valid = Yes
    const src = (r.src || '').trim();
    const final = (r.final || r.ai || '').trim();               // your approved fix (col K), or the AI suggestion it accepted
    if (!src || !final) { nofix++; continue; }
    const dk = wbFold(src) + '⇢' + wbFold(final);
    if (seen.has(dk)) continue; seen.add(dk);
    LRN.rows.push({ src, wrong: (r.tgt || '').trim(), final, comment: (r.comment || '').trim(), etype: (r.cat || '').trim(), key: (r.key || '').trim(), sheet });
    added++;
  }
  lrnRefresh();
  lrnInfo(`Added ${added} validated correction(s) from "${sheet}"${nofix ? ` · ${nofix} valid row(s) had no Final/AI fix (skipped)` : ''}. Learn-set: ${LRN.rows.length}. Switch tabs to add more, or teach below.`, added ? 'good' : '');
}
function lrnClear() { LRN = { rows: [] }; lrnRefresh(); lrnInfo('Learn-set cleared.', ''); }
function lrnRefresh() {
  const n = LRN.rows.length, sheets = new Set(LRN.rows.map((r) => r.sheet)).size;
  if ($('lq-learn-state')) $('lq-learn-state').textContent = n ? `Learn-set: ${n} validated correction(s) from ${sheets} sheet(s).` : 'Learn-set is empty.';
  if ($('lq-learn-mem')) $('lq-learn-mem').disabled = !n;
  if ($('lq-learn-distill')) $('lq-learn-distill').disabled = !n;
}
async function lrnToMemory() {
  if (!LRN.rows.length) { lrnInfo('Add validated rows first.', 'err'); return; }
  let wrote = 0; const clashes = [];
  for (const r of LRN.rows) {
    const k = tmKey(r.src); if (!k) continue;
    const prev = TM.map[k];
    if (prev && wbFold(prev.tgt) !== wbFold(r.final)) {
      clashes.push({ kind: 'mem', label: r.src, srcKey: k, src: r.src, oldVal: prev.tgt, newVal: r.final });   // don't overwrite silently
    } else if (tmRecordOne(r.src, r.final)) wrote++;
  }
  await tmSave(); tmRefresh();
  if (clashes.length) { confAdd(clashes); lrnInfo(`Stored ${wrote} correction(s). ⚠ ${clashes.length} clash with a different remembered target — resolve them in the orange ⚠ panel.`, 'err'); }
  else lrnInfo(`Stored ${wrote} correction(s) in Consistency memory (now ${tmCount()} strings). The approved fix auto-fills whenever that source recurs.`, 'good');
}
function lrnSys() {
  return 'You improve a TikTok English→Hebrew (he-IL) localization brain by learning from CONFIRMED past mistakes. ' +
    'Each item is a segment a proofreader marked as a REAL error: "src" (English), "wrong" (the rejected Hebrew a machine/GPT produced), "correct" (the approved Hebrew fix), and optionally "why" (the reviewer/checker reason). ' +
    'Infer GENERALIZABLE, reusable conventions that would have PREVENTED the mistake — never anything specific to one string. Prefer: exact EN→HE term mappings (when "correct" fixes a wrong word choice) and short imperative rules (register, punctuation, translate-vs-keep-in-Latin, translating country/region names, placeholder/number handling). ' +
    'Put term equivalences in "glossary" (en, he, short note); put everything else in "rules" (≤ ~30 words each, categorized as one of: ' + BRAIN_CATS.join(' | ') + '). ' +
    'Extract ONLY high-confidence patterns that several items or a clear reason support. Do NOT restate anything already in the EXISTING BRAIN. If a pattern CONTRADICTS an existing brain rule/term, put it in "conflicts" with "conflictsWith" naming the clash — never silently override. ' +
    'Keep Hebrew in Hebrew; never translate the rule text. Return ONLY JSON: {"rules":[{"cat":"…","text":"…"}],"glossary":[{"en":"…","he":"…","note":"…"}],"conflicts":[{"cat":"…","text":"…","conflictsWith":"…"}]}.';
}
async function lrnDistill() {
  const key = await store.get('key', '');
  if (!key) { lrnInfo('Add your OpenAI key in Settings first.', 'err'); $('settings').open = true; return; }
  if (!LRN.rows.length) { lrnInfo('Add validated rows first.', 'err'); return; }
  const model = $('model').value;
  const capped = LRN.rows.slice(0, LRN_CAP);
  const existing = ((BRAIN.rules || []).map((r) => '- [' + r.cat + '] ' + r.text).join('\n') + '\n' + (BRAIN.glossary || []).map((g) => '- "' + g.en + '" → "' + g.he + '"').join('\n')).trim();
  const sys = lrnSys();
  const agg = { rules: [], glossary: [], conflicts: [] };
  if ($('lq-learn-distill')) $('lq-learn-distill').disabled = true; let dropTemp = false;
  try {
    for (let i = 0; i < capped.length; i += LRN_BATCH) {
      const chunk = capped.slice(i, i + LRN_BATCH);
      lrnInfo(`Distilling ${i + 1}–${Math.min(i + LRN_BATCH, capped.length)} of ${capped.length}…`);
      const doc = chunk.map((p, j) => `${j + 1}. EN: ${p.src}\n   WRONG: ${p.wrong}\n   CORRECT: ${p.final}${p.comment ? `\n   WHY: ${p.comment}` : ''}`).join('\n');
      const user = 'EXISTING BRAIN (already enforced — do NOT repeat; contradictions → "conflicts"):\n' + (existing || '(only the built-in base guide so far)') + '\n\nCONFIRMED MISTAKES TO LEARN FROM:\n' + doc;
      const callGpt = async () => {
        const body = { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
        if (!dropTemp) body.temperature = 0.1;
        const rr = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await rr.json();
        if (!rr.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + rr.status));
        return data;
      };
      let data;
      try { data = await callGpt(); }
      catch (e1) { if (!dropTemp && /temperature/i.test(e1.message || '')) { dropTemp = true; data = await callGpt(); } else throw e1; }
      let o = {}; try { o = JSON.parse(data.choices[0].message.content); } catch (e) { continue; }
      (o.rules || []).forEach((x) => agg.rules.push(x));
      (o.glossary || []).forEach((x) => agg.glossary.push(x));
      (o.conflicts || []).forEach((x) => agg.conflicts.push(x));
      if (i + LRN_BATCH < capped.length) await new Promise((r) => setTimeout(r, 200));
    }
    const seenR = new Set(), rules = [];
    for (const x of agg.rules) { const t = String(x.text || '').trim(); const kk = (x.cat || '') + '|' + wbNorm(t).toLowerCase(); if (!t || seenR.has(kk)) continue; seenR.add(kk); rules.push({ cat: x.cat || 'misc', text: t, accept: true }); }
    const seenG = new Set(), glossary = [];
    for (const x of agg.glossary) { const en = String(x.en || '').trim(), he = String(x.he || '').trim(); if (!en || !he) continue; const kk = en.toLowerCase(); if (seenG.has(kk)) continue; seenG.add(kk); glossary.push({ en, he, note: String(x.note || '').trim(), accept: true }); }
    const seenC = new Set(), conflicts = [];
    for (const x of agg.conflicts) { const t = String(x.text || '').trim(); const kk = wbNorm(t).toLowerCase(); if (!t || seenC.has(kk)) continue; seenC.add(kk); conflicts.push({ cat: x.cat || 'misc', text: t, conflictsWith: String(x.conflictsWith || '').trim(), accept: false }); }
    brainProposal = { rules, glossary, conflicts, sourceLabel: ('AI-check: ' + lrnSheetName()).slice(0, 60) };
    brainRenderReview(); if ($('brain-card')) $('brain-card').open = true; if ($('brain-review')) $('brain-review').scrollIntoView({ block: 'nearest' });
    lrnInfo(`Distilled ${rules.length} rule(s) · ${glossary.length} term(s)${conflicts.length ? ` · ⚠ ${conflicts.length} conflict ticket(s)` : ''} from ${capped.length} correction(s) — review & merge in 🧠 Style Brain above.`, 'good');
  } catch (e) { lrnInfo('Distill failed: ' + (e.message || e), 'err'); }
  finally { if ($('lq-learn-distill')) $('lq-learn-distill').disabled = false; }
}

// ---- CONFLICT ADJUDICATOR (orange ⚠) ---------------------------------------
// A glossary term or a remembered source can hold only ONE target. When a NEW pairing collides
// with a stored one (same EN term → different HE, or same source → different memory target), we
// do NOT silently overwrite (the old behaviour, "newest wins"): the clash is parked here and shown
// as an orange ⚠ card. You pick the wording to keep on the spot — the one you don't pick is deleted.
// Fed by: lrnToMemory (memory), brainMerge (distilled glossary), and the manual add fields.
let CONF = [];   // {kind:'mem'|'gloss'|'plural'|'lockmem', label?, en?, note?, source?, srcKey?, src?, oldVal?, newVal?, memVal?, lockEn?, lockHe?}
function confInfo(m, k) { info('conf-info', m, k || ''); }
// Persist the orange conflict tickets so unresolved ones survive closing the panel / reloading the extension.
function confSave() { try { store.set({ conflicts: CONF }); } catch (e) {} }
async function confLoad() { try { const c = await store.get('conflicts', []); if (Array.isArray(c)) CONF = c; } catch (e) {} return CONF; }
function confAdd(items) { for (const it of items) CONF.push(it); confSave(); confRender(); }
function confRender() {
  const box = $('conf-card'); if (!box) return;
  if (!CONF.length) { box.hidden = true; if ($('conf-list')) $('conf-list').innerHTML = ''; if ($('conf-count')) $('conf-count').textContent = ''; return; }
  box.hidden = false; box.open = true;
  // Values are EDITABLE — fix the wording before you pick; whichever side you click writes what's shown.
  const fmtSetEdit = (forms, i, side) => Object.keys(forms || {}).map((f) => `<span class="conf-form"><b>${esc(f)}</b> <span class="conf-val" contenteditable="true" spellcheck="false" dir="rtl" data-cf="${i}|${side}|${esc(f)}">${esc(forms[f])}</span></span>`).join('');
  const rows = CONF.map((c, i) => {
    if (c.kind === 'plural') {
      return `<div class="conf-item">
        <div class="conf-head">⚠ <span dir="ltr">${esc(c.label)}</span> <span class="hint">— plural set · ✎ editable</span></div>
        <div class="conf-opt"><button class="btn xs" data-i="${i}" data-keep="old">Keep current</button><span class="conf-vals">${fmtSetEdit(c.oldForms, i, 'old')}</span></div>
        <div class="conf-opt"><button class="btn xs" data-i="${i}" data-keep="new">Use new</button><span class="conf-vals">${fmtSetEdit(c.newForms, i, 'new')}</span></div>
      </div>`;
    }
    if (c.kind === 'lockmem') {
      // A locked term and a remembered target disagree — pick which brain wins; the other entry is removed.
      return `<div class="conf-item">
        <div class="conf-head">⚠ <span dir="ltr">${esc(c.label)}</span> <span class="hint">— 🔒 locked term vs 🧠 memory (pick which wins; the other is deleted)</span></div>
        <div class="conf-opt"><button class="btn xs" data-i="${i}" data-keep="lock">🔒 Keep locked</button><span dir="ltr">${esc(c.lockEn)}</span> → <span dir="rtl">${esc(c.lockHe)}</span> <span class="hint">(deletes the memory)</span></div>
        <div class="conf-opt"><button class="btn xs" data-i="${i}" data-keep="mem">🧠 Keep memory</button><span dir="rtl">${esc(c.memVal)}</span> <span class="hint">(removes the lock)</span></div>
      </div>`;
    }
    const head = c.kind === 'mem'
      ? `<span dir="ltr">${esc(c.label)}</span> <span class="hint">— remembered source · ✎ editable</span>`
      : `<span dir="ltr">${esc(c.en)}</span> <span class="hint">— glossary term · ✎ editable</span>`;
    return `<div class="conf-item">
      <div class="conf-head">⚠ ${head}</div>
      <div class="conf-opt"><button class="btn xs" data-i="${i}" data-keep="old">Keep current</button><span class="conf-val" contenteditable="true" spellcheck="false" dir="auto" data-cv="${i}|old">${esc(c.oldVal)}</span></div>
      <div class="conf-opt"><button class="btn xs" data-i="${i}" data-keep="new">Use new</button><span class="conf-val" contenteditable="true" spellcheck="false" dir="auto" data-cv="${i}|new">${esc(c.newVal)}</span></div>
    </div>`;
  }).join('');
  if ($('conf-list')) $('conf-list').innerHTML = rows;
  if ($('conf-count')) $('conf-count').textContent = `· ${CONF.length}`;
  box.querySelectorAll('#conf-list button[data-keep]').forEach((b) => b.addEventListener('click', () => confResolve(+b.getAttribute('data-i'), b.getAttribute('data-keep'))));
}
async function confResolve(i, keep) {
  const c = CONF[i]; if (!c) return;
  const box = $('conf-list');
  const rd = (sel, fallback) => { const el = box && box.querySelector(sel); const v = el ? String(el.innerText).trim() : ''; return v || fallback; };   // read the edited value (or fall back)
  if (c.kind === 'lockmem') {
    if (keep === 'lock') { delete TM.map[c.srcKey]; await tmSave(); tmRefresh(); }   // locked term wins → drop the stale memory
    else { LOCK.terms = (LOCK.terms || []).filter((t) => !((t.en || '').toLowerCase() === String(c.lockEn).toLowerCase() && wbFold(t.he) === wbFold(c.lockHe))); await lockSave(); lockRefresh(); }   // memory wins → remove the lock
  } else if (c.kind === 'plural') {
    const src = keep === 'new' ? c.newForms : c.oldForms, forms = {};
    for (const f of Object.keys(src || {})) forms[f] = rd(`[data-cf="${i}|${keep}|${f}"]`, src[f]);
    PM.map[c.plKey] = { srcForms: c.srcForms, forms, ts: Date.now(), n: 1 }; await pmSave();
  } else {
    const val = rd(`[data-cv="${i}|${keep}"]`, keep === 'new' ? c.newVal : c.oldVal);
    if (c.kind === 'mem') { TM.map[c.srcKey] = { src: c.src, tgt: val, ts: Date.now(), n: 1 }; await tmSave(); tmRefresh(); }
    else { BRAIN.glossary = (BRAIN.glossary || []).filter((g) => (g.en || '').toLowerCase() !== c.en.toLowerCase()); BRAIN.glossary.push({ id: brainUid(), en: c.en, he: val, note: c.note || '', source: c.source || 'adjudicated', ts: Date.now() }); await brainSave(); brainRefresh(); }
  }
  CONF.splice(i, 1); confSave(); confRender();
  confInfo(CONF.length ? `Saved. ${CONF.length} conflict(s) left.` : 'Saved. All conflicts resolved.', 'good');
}

async function brainGrab() {
  brainInfo('Reading the active tab…');
  try {
    const t = await activeTab();
    if (!t || !/^https:\/\/[^/]*\.(larkoffice\.com|feishu\.(cn|net))\//.test(t.url || '')) {
      brainInfo('Open the Lark/Feishu style-guide doc in the active tab, then click ⬇ Grab (or just paste the text).', 'err'); return;
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: t.id },
      func: () => {
        const pick = document.querySelector('.docx-page, .doc-render, .doc-content, [class*="docx-"] [class*="content"], main, article') || document.body;
        return (pick.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      }
    });
    const txt = (res && res.result) || '';
    if (txt.length < 40) { brainInfo('Could not read enough text from that tab — try select-all (Ctrl+A) + paste instead.', 'err'); return; }
    $('brain-input').value = txt;
    brainInfo(`Grabbed ${txt.length.toLocaleString()} characters. Skim it, then Distill.`, 'good');
  } catch (e) { brainInfo('Grab failed: ' + e.message + ' — paste the text instead.', 'err'); }
}

function brainExport() {
  const blob = new Blob([JSON.stringify(BRAIN, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'style-brain-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function brainImport(file) {
  try {
    const o = JSON.parse(await file.text());
    if (!o || !Array.isArray(o.rules) || !Array.isArray(o.glossary)) throw new Error('not a Style Brain JSON.');
    const haveR = new Set(BRAIN.rules.map((r) => r.text.toLowerCase()));
    o.rules.forEach((r) => { if (r && r.text && !haveR.has(String(r.text).toLowerCase())) BRAIN.rules.push({ id: brainUid(), cat: r.cat || 'misc', text: String(r.text), source: r.source || 'import', ts: r.ts || Date.now() }); });
    o.glossary.forEach((g) => { if (g && g.en && g.he) { BRAIN.glossary = BRAIN.glossary.filter((x) => x.en.toLowerCase() !== String(g.en).toLowerCase()); BRAIN.glossary.push({ id: brainUid(), en: String(g.en), he: String(g.he), note: g.note || '', source: g.source || 'import', ts: g.ts || Date.now() }); } });
    await brainSave(); brainRefresh();
    brainInfo(`Imported — brain now has ${BRAIN.rules.length} rules · ${BRAIN.glossary.length} terms.`, 'good');
  } catch (e) { brainInfo('Import failed: ' + e.message, 'err'); }
}

// ---- Consistency memory: UI glue ----
function tmRefresh() {
  const on = !!(TM && TM.enabled);
  const b = $('tm-badge'); if (b) b.textContent = (tmCount() ? `· ${tmCount()} string${tmCount() === 1 ? '' : 's'}` : '· empty') + (on ? '' : ' · off');
  const t = $('tm-toggle'); if (t) t.checked = on;
  const card = $('tm-card'); if (card) card.classList.toggle('tm-off', !on);
  const st = $('tm-state'); if (st) st.textContent = on ? '' : '— disabled (data kept; tick to re-enable)';
  const n = $('tm-count-n'); if (n) n.textContent = tmCount();
  tmRenderList($('tm-search') ? $('tm-search').value : '');
}
function tmRenderList(filter) {
  const box = $('tm-list'); if (!box) return;
  const q = (filter || '').toLowerCase().trim();
  const rows = Object.keys(TM.map).map((k) => ({ k, ...TM.map[k] }))
    .filter((e) => !q || (e.src || '').toLowerCase().includes(q) || (e.tgt || '').toLowerCase().includes(q))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 300);
  box.innerHTML = rows.length
    ? rows.map((e) => `<div class="bl-row"><button class="bl-del" data-tmk="${esc(e.k)}" title="Forget this string">✕</button><span class="bi-text"><span dir="ltr">${esc(e.src)}</span> → <span dir="rtl">${esc(e.tgt)}</span></span></div>`).join('')
    : '<div class="hint">No matches — write a segment and it lands here.</div>';
  box.querySelectorAll('.bl-del').forEach((btn) => btn.addEventListener('click', async () => {
    const k = btn.getAttribute('data-tmk'); if (k in TM.map) { delete TM.map[k]; await tmSave(); tmRefresh(); tmInfo('Forgot 1 string.', ''); }
  }));
}
function tmInfo(msg, cls) { const el = $('tm-info'); if (el) { el.textContent = msg || ''; el.className = 'info' + (cls ? ' ' + cls : ''); } }
function tmExport() {
  const blob = new Blob([JSON.stringify(TM, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'consistency-memory-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function tmImport(file) {
  try {
    const o = JSON.parse(await file.text());
    const src = o && o.map && typeof o.map === 'object' ? o.map : null;
    if (!src) throw new Error('not a consistency-memory JSON.');
    let n = 0;
    for (const k of Object.keys(src)) { const e = src[k]; if (e && e.src && e.tgt) { if (tmRecordOne(e.src, e.tgt)) n++; } }
    await tmSave(); tmRefresh();
    tmInfo(`Imported ${n} string(s) — memory now holds ${tmCount()}.`, 'good');
  } catch (e) { tmInfo('Import failed: ' + e.message, 'err'); }
}

// ---- LOCKED TERMS UI ------------------------------------------------------
function lockInfo(msg, cls) { const el = $('lock-info'); if (el) { el.textContent = msg || ''; el.className = 'info' + (cls ? ' ' + cls : ''); } }
function lockRefresh() {
  const b = $('lock-badge'); if (b) b.textContent = lockCount() ? `· ${lockCount()} term${lockCount() === 1 ? '' : 's'}` : '· empty';
  const n = $('lock-count-n'); if (n) n.textContent = lockCount();
  lockRenderList($('lock-search') ? $('lock-search').value : '');
  if (typeof runCoverage === 'function') runCoverage();   // keep the Run-button preview in sync
}
function lockRenderList(filter) {
  const box = $('lock-list'); if (!box) return;
  const q = (filter || '').toLowerCase().trim();
  const rows = (LOCK.terms || [])
    .filter((t) => !q || (t.en || '').toLowerCase().includes(q) || (t.he || '').toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  box.innerHTML = rows.length
    ? rows.map((t) => `<div class="bl-row"><button class="bl-del" data-lid="${esc(t.id)}" title="Remove this locked term">✕</button><span class="bi-text"><span dir="ltr">${esc(t.en)}</span> → <span dir="rtl">${esc(t.he)}</span>${t.note ? ` <span class="hint">— ${esc(t.note)}</span>` : ''}</span></div>`).join('')
    : '<div class="hint">No locked terms yet — add one above.</div>';
  box.querySelectorAll('.bl-del').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-lid'); LOCK.terms = (LOCK.terms || []).filter((t) => String(t.id) !== id);
    await lockSave(); lockRefresh(); lockInfo('Removed 1 locked term.', '');
  }));
}
function lockExport() {
  const blob = new Blob([JSON.stringify(LOCK, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'locked-terms-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function lockImport(file) {
  try {
    const o = JSON.parse(await file.text());
    const arr = o && Array.isArray(o.terms) ? o.terms : (Array.isArray(o) ? o : null);
    if (!arr) throw new Error('not a locked-terms JSON.');
    let n = 0;
    for (const t of arr) {
      const en = String(t.en || '').trim(), he = String(t.he || '').trim(); if (!en || !he) continue;
      LOCK.terms = (LOCK.terms || []).filter((x) => (x.en || '').toLowerCase() !== en.toLowerCase());
      LOCK.terms.push({ id: brainUid(), en, he, note: String(t.note || '').trim(), ts: Date.now() }); n++;
    }
    await lockSave(); lockRefresh();
    lockInfo(`Imported ${n} locked term(s) — ${lockCount()} total.`, 'good');
  } catch (e) { lockInfo('Import failed: ' + e.message, 'err'); }
}

// ---- AUTO-FIX UI ----------------------------------------------------------
function fixInfo(msg, cls) { const el = $('fx-info'); if (el) { el.textContent = msg || ''; el.className = 'info' + (cls ? ' ' + cls : ''); } }
function fixRefresh() {
  const on = !!(FIX && FIX.enabled);
  const b = $('fx-badge'); if (b) b.textContent = (fixCount() ? `· ${fixCount()} rule${fixCount() === 1 ? '' : 's'}` : '· empty') + (on ? '' : ' · off');
  const t = $('fx-toggle'); if (t) t.checked = on;
  const st = $('fx-state'); if (st) st.textContent = on ? '' : '— disabled (rules kept; tick to re-enable)';
  const n = $('fx-count-n'); if (n) n.textContent = fixCount();
  fixRenderList($('fx-search') ? $('fx-search').value : '');
}
function fixRenderList(filter) {
  const box = $('fx-list'); if (!box) return;
  const q = (filter || '').toLowerCase().trim();
  const rows = (FIX.rules || [])
    .filter((r) => !q || (r.from || '').toLowerCase().includes(q) || (r.to || '').toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  box.innerHTML = rows.length
    ? rows.map((r) => `<div class="bl-row"><button class="bl-del" data-fid="${esc(r.id)}" title="Remove this auto-fix rule">✕</button><span class="bi-text"><span dir="rtl">${esc(r.from)}</span> → <span dir="rtl">${esc(r.to)}</span>${r.note ? ` <span class="hint">— ${esc(r.note)}</span>` : ''}</span></div>`).join('')
    : '<div class="hint">No auto-fix rules — add one above.</div>';
  box.querySelectorAll('.bl-del').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-fid'); FIX.rules = (FIX.rules || []).filter((r) => String(r.id) !== id);
    await fixSave(); fixRefresh(); fixInfo('Removed 1 rule.', '');
  }));
}
function fixExport() {
  const blob = new Blob([JSON.stringify(FIX, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'auto-fix-rules-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function fixImport(file) {
  try {
    const o = JSON.parse(await file.text());
    const arr = o && Array.isArray(o.rules) ? o.rules : (Array.isArray(o) ? o : null);
    if (!arr) throw new Error('not an auto-fix JSON.');
    let n = 0;
    for (const r of arr) {
      const from = String(r.from || '').trim(), to = String(r.to || '').trim(); if (!from || !to) continue;
      FIX.rules = (FIX.rules || []).filter((x) => (x.from || '') !== from);
      FIX.rules.push({ id: fixUid(), from, to, note: String(r.note || '').trim(), ts: Date.now() }); n++;
    }
    await fixSave(); fixRefresh();
    fixInfo(`Imported ${n} rule(s) — ${fixCount()} total.`, 'good');
  } catch (e) { fixInfo('Import failed: ' + e.message, 'err'); }
}

// ---- TERM BASE UI ---------------------------------------------------------
function tbInfo(msg, cls) { const el = $('tb-info'); if (el) { el.textContent = msg || ''; el.className = 'info' + (cls ? ' ' + cls : ''); } }
function tbRefresh() {
  const on = !!(TB && TB.enabled);
  const b = $('tb-badge'); if (b) b.textContent = (tbCount() ? `· ${tbCount()} term${tbCount() === 1 ? '' : 's'}` : '· empty') + (on ? '' : ' · off');
  const t = $('tb-toggle'); if (t) t.checked = on;
  const st = $('tb-state'); if (st) st.textContent = on ? '' : '— off (terms kept; tick to use them again)';
  const n = $('tb-count-n'); if (n) n.textContent = tbCount();
  tbRenderList($('tb-search') ? $('tb-search').value : '');
  if (typeof runCoverage === 'function') runCoverage();   // keep the Run-button preview in sync
}
function tbRenderList(filter) {
  const box = $('tb-list'); if (!box) return;
  const q = (filter || '').toLowerCase().trim();
  const rows = (TB.terms || [])
    .filter((t) => !q || (t.en || '').toLowerCase().includes(q) || (t.he || '').toLowerCase().includes(q))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  box.innerHTML = rows.length
    ? rows.map((t) => `<div class="bl-row"><button class="bl-del" data-tid="${esc(t.id)}" title="Remove this term">✕</button><span class="bi-text"><span dir="ltr">${esc(t.en)}</span> → <span dir="rtl">${esc(t.he)}</span>${t.pos ? ` <span class="hint">— ${esc(t.pos)}</span>` : ''}</span></div>`).join('')
    : '<div class="hint">No terms yet — open a task and click ⬇ Grab term base.</div>';
  box.querySelectorAll('.bl-del').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-tid'); TB.terms = (TB.terms || []).filter((t) => String(t.id) !== id);
    await tbSave(); tbRefresh(); tbInfo('Removed 1 term.', '');
  }));
}
function tbExport() {
  const blob = new Blob([JSON.stringify(TB, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'term-base-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function tbImport(file) {
  try {
    const o = JSON.parse(await file.text());
    const arr = o && Array.isArray(o.terms) ? o.terms : (Array.isArray(o) ? o : null);
    if (!arr) throw new Error('not a term-base JSON.');
    let n = 0;
    for (const t of arr) {
      const en = String(t.en || '').trim(), he = String(t.he || '').trim(); if (!en || !he) continue;
      TB.terms = (TB.terms || []).filter((x) => (x.en || '').toLowerCase() !== en.toLowerCase());
      TB.terms.push({ id: tbUid(), en, he, pos: String(t.pos || '').trim(), def: String(t.def || '').trim(), ts: Date.now() }); n++;
    }
    await tbSave(); tbRefresh();
    tbInfo(`Imported ${n} term(s) — ${tbCount()} total.`, 'good');
  } catch (e) { tbInfo('Import failed: ' + e.message, 'err'); }
}

async function init() {
  $('key').value = await store.get('key', '');
  $('model').value = await store.get('model', 'gpt-5.4');
  $('plural').checked = await store.get('plural', false);   // default OFF = singular gender-neutral slashes (TikTok guide); ON = plural לשון רבים for other clients
  $('selectors').value = await store.get('selectorsRaw', '');
  $('run-model').textContent = $('model').value;

  $('key-save').addEventListener('click', async () => { await store.set({ key: $('key').value.trim() }); info('harvest-info', 'Key saved.', 'good'); });
  $('model').addEventListener('change', async () => { await store.set({ model: $('model').value }); $('run-model').textContent = $('model').value; if ($('lq-model')) $('lq-model').textContent = $('model').value; if ($('cw-model')) $('cw-model').textContent = $('model').value; if ($('mq-model')) $('mq-model').textContent = $('model').value; if ($('yc-model')) $('yc-model').textContent = $('model').value; });
  $('plural').addEventListener('change', async () => { await store.set({ plural: $('plural').checked }); });
  if ($('wb-engine')) {
    WB.engine = await store.get('wbEngine', 'api');
    $('wb-engine').value = WB.engine;
    $('wb-engine').addEventListener('change', async () => {
      WB.engine = $('wb-engine').value;
      await store.set({ wbEngine: WB.engine });
      // Drop any Check result captured by the other engine so they can't be mixed.
      WB.queue.forEach((q) => { q.live = null; q.decision = null; q.api = null; if (q.status === 'checked') q.status = 'searched'; });
      wbRenderQueue();
      wbLog(`[engine] switched to ${WB.engine.toUpperCase()} — re-Check any key you were mid-way through.`);
    });
  }

  $('sel-save').addEventListener('click', async () => {
    const raw = $('selectors').value.trim();
    let sel = {};
    if (raw) { try { sel = JSON.parse(raw); } catch (e) { $('diag-out').textContent = 'Invalid JSON: ' + e.message; return; } }
    await store.set({ selectors: sel, selectorsRaw: raw });
    try { const r = await send({ type: 'SET_SELECTORS', selectors: sel }); $('diag-out').textContent = 'Applied:\n' + JSON.stringify(r.cfg, null, 2); } catch (e) { $('diag-out').textContent = e.message; }
  });
  $('diag').addEventListener('click', doDiag);

  // Style Brain
  await brainLoad(); brainRefresh();
  $('brain-distill').addEventListener('click', brainDistill);
  $('brain-grab').addEventListener('click', brainGrab);
  if ($('hv-harvest')) $('hv-harvest').addEventListener('click', hvHarvest);
  if ($('hv-to-mem')) $('hv-to-mem').addEventListener('click', hvToMemory);
  if ($('hv-distill')) $('hv-distill').addEventListener('click', hvDistill);
  $('brain-export').addEventListener('click', brainExport);
  $('brain-import').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) brainImport(f); e.target.value = ''; });
  // Password gate for the two destructive "Clear" buttons — guards against an accidental wipe of
  // the brain / memory you've built up. Local-only (your own extension data); not auth against any service.
  const clearPass = (what) => {
    const p = prompt(`Enter your password to clear ${what}.\nThis erases everything you've accumulated and can't be undone.`);
    if (p == null) return false;                                   // cancelled
    if (p !== 'benjytrans') { alert('Wrong password — nothing was cleared.'); return false; }
    return true;
  };
  $('brain-clear').addEventListener('click', async () => {
    if (!clearPass('all ingested rules & glossary terms (the built-in guide stays)')) return;
    BRAIN.rules = []; BRAIN.glossary = []; await brainSave(); brainRefresh(); brainInfo('Cleared — back to the built-in guide only.', '');
  });

  // Manual add — type a rule/term straight into the brain (no GPT distillation)
  const bmCat = $('bm-cat');
  if (bmCat && !bmCat.options.length) BRAIN_CATS.forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; bmCat.appendChild(o); });
  const bmInfo = (m, k) => info('bm-info', m, k || '');
  if ($('bm-add-rule')) $('bm-add-rule').addEventListener('click', async () => {
    const cat = ($('bm-cat').value || 'misc'), text = ($('bm-rule').value || '').trim();
    if (!text) { bmInfo('Type the rule text first.', 'err'); return; }
    if ((BRAIN.rules || []).some((r) => (r.text || '').toLowerCase() === text.toLowerCase())) { bmInfo('That exact rule is already in the brain.', 'err'); return; }
    BRAIN.rules.push({ id: brainUid(), cat, text, source: 'manual', ts: Date.now() });
    await brainSave(); brainRefresh(); $('bm-rule').value = '';
    bmInfo(`Added rule (${cat}). Brain: ${BRAIN.rules.length} rules · ${BRAIN.glossary.length} terms — active on the next Run.`, 'good');
  });
  if ($('bm-add-term')) $('bm-add-term').addEventListener('click', async () => {
    const en = ($('bm-en').value || '').trim(), he = ($('bm-he').value || '').trim(), note = ($('bm-note').value || '').trim();
    if (!en || !he) { bmInfo('Both EN and HE are required for a term.', 'err'); return; }
    const clash = (BRAIN.glossary || []).find((g) => (g.en || '').toLowerCase() === en.toLowerCase() && wbFold(g.he) !== wbFold(he));
    if (clash) {   // same EN already maps to a DIFFERENT HE → adjudicate instead of silently overwriting
      confAdd([{ kind: 'gloss', en, oldVal: clash.he, newVal: he, note, source: 'manual' }]);
      $('bm-en').value = ''; $('bm-he').value = ''; $('bm-note').value = '';
      bmInfo(`"${en}" already maps to a different term — resolve the orange ⚠ conflict below.`, 'err'); return;
    }
    BRAIN.glossary = BRAIN.glossary.filter((g) => (g.en || '').toLowerCase() !== en.toLowerCase());   // same-en refresh
    BRAIN.glossary.push({ id: brainUid(), en, he, note, source: 'manual', ts: Date.now() });
    await brainSave(); brainRefresh(); $('bm-en').value = ''; $('bm-he').value = ''; $('bm-note').value = '';
    bmInfo(`Added term "${en}" → "${he}". Brain: ${BRAIN.rules.length} rules · ${BRAIN.glossary.length} terms.`, 'good');
  });

  // Consistency memory
  await tmLoad(); tmRefresh();
  await pmLoad();   // plural memory — read by the 🔢 Plurals tool
  $('tm-export').addEventListener('click', tmExport);
  $('tm-import').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) tmImport(f); e.target.value = ''; });
  $('tm-toggle').addEventListener('change', async (e) => {
    TM.enabled = e.target.checked; await tmSave(); tmRefresh();
    tmInfo(TM.enabled ? 'On — remembered wording is applied to matching sources.' : 'Off — memory is kept but not applied to new translations.', '');
  });
  // Fuzzy near-match suggestions (review-only)
  if (!TM.fuzzy) TM.fuzzy = { enabled: false, threshold: 0.8 };
  if ($('tm-fuzzy')) { $('tm-fuzzy').checked = !!TM.fuzzy.enabled; $('tm-fuzzy').addEventListener('change', async (e) => {
    TM.fuzzy.enabled = e.target.checked; await tmSave();
    tmInfo(TM.fuzzy.enabled ? `Near-match suggestions ON (≥${Math.round((TM.fuzzy.threshold || 0.8) * 100)}%) — shown for review on the next Run.` : 'Near-match suggestions off.', '');
  }); }
  if ($('tm-fuzzy-th')) { $('tm-fuzzy-th').value = TM.fuzzy.threshold || 0.8; $('tm-fuzzy-th').addEventListener('change', async (e) => {
    let v = parseFloat(e.target.value); if (isNaN(v)) v = 0.8; v = Math.min(0.95, Math.max(0.5, v)); TM.fuzzy.threshold = v; e.target.value = v; await tmSave();
    tmInfo(`Fuzzy threshold set to ${Math.round(v * 100)}%.`, '');
  }); }
  $('tm-search').addEventListener('input', (e) => tmRenderList(e.target.value));
  $('brain-search').addEventListener('input', brainRefresh);
  if ($('tm-add')) $('tm-add').addEventListener('click', async () => {
    const src = ($('tm-add-src').value || '').trim(), tgt = ($('tm-add-tgt').value || '').trim();
    if (!src || !tgt) { tmInfo('Enter both a source and your target.', 'err'); return; }
    const prev = tmLookup(src);
    if (prev && wbFold(prev.tgt) !== wbFold(tgt)) {   // same source already remembered with a DIFFERENT target → adjudicate
      confAdd([{ kind: 'mem', label: src, srcKey: tmKey(src), src, oldVal: prev.tgt, newVal: tgt }]);
      $('tm-add-src').value = ''; $('tm-add-tgt').value = '';
      tmInfo(`"${src}" is already remembered with a different target — resolve the orange ⚠ conflict below.`, 'err'); return;
    }
    const existed = !!prev;
    tmRecordOne(src, tgt); await tmSave(); tmRefresh();
    $('tm-add-src').value = ''; $('tm-add-tgt').value = '';
    tmInfo(`${existed ? 'Updated' : 'Remembered'} — "${src}" → "${tgt}". ${tmCount()} string(s).`, 'good');
  });
  $('tm-clear').addEventListener('click', async () => {
    if (!clearPass('every remembered string in the Consistency memory')) return;
    TM = { map: {}, enabled: TM.enabled, updatedAt: 0, defaultOffMigrated: true }; await tmSave(); tmRefresh(); tmInfo('Memory cleared.', '');
  });

  // Locked terms (mandatory "must" glossary)
  await lockLoad(); lockRefresh();

  // Restore unresolved conflict tickets + any pending review proposal (so they survive closing the panel).
  await confLoad(); confRender();
  await bpLoad(); if (brainProposal) { brainRenderReview(); if ($('brain-card')) $('brain-card').open = true; }
  await clsLoad(); if (CLS.result) { clsRender(); if ($('brain-card')) $('brain-card').open = true; if ($('brain-consolidate')) $('brain-consolidate').open = true; }
  if ($('lock-add')) $('lock-add').addEventListener('click', async () => {
    const en = ($('lock-en').value || '').trim(), he = ($('lock-he').value || '').trim(), note = ($('lock-note').value || '').trim();
    if (!en || !he) { lockInfo('Both EN and HE are required for a locked term.', 'err'); return; }
    const existed = (LOCK.terms || []).some((t) => (t.en || '').toLowerCase() === en.toLowerCase());
    LOCK.terms = (LOCK.terms || []).filter((t) => (t.en || '').toLowerCase() !== en.toLowerCase());   // same-EN refresh (last write wins)
    LOCK.terms.push({ id: brainUid(), en, he, note, ts: Date.now() });
    await lockSave(); lockRefresh();
    $('lock-en').value = ''; $('lock-he').value = ''; $('lock-note').value = '';
    lockInfo(`${existed ? 'Updated' : 'Locked'} "${en}" → "${he}". ${lockCount()} term(s) — mandatory on the next Run.`, 'good');
  });
  if ($('lock-export')) $('lock-export').addEventListener('click', lockExport);
  if ($('lock-import')) $('lock-import').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) lockImport(f); e.target.value = ''; });
  if ($('lock-search')) $('lock-search').addEventListener('input', (e) => lockRenderList(e.target.value));
  if ($('lock-clear')) $('lock-clear').addEventListener('click', async () => {
    if (!clearPass('every locked term')) return;
    LOCK = { terms: [], updatedAt: 0 }; await lockSave(); lockRefresh(); lockInfo('All locked terms cleared.', '');
  });

  // Auto-fix (deterministic post-GPT rewrites)
  await fixLoad(); fixRefresh();
  if ($('fx-add')) $('fx-add').addEventListener('click', async () => {
    const from = ($('fx-from').value || '').trim(), to = ($('fx-to').value || '').trim(), note = ($('fx-note').value || '').trim();
    if (!from || !to) { fixInfo('Both the word GPT returns and your replacement are required.', 'err'); return; }
    if (from === to) { fixInfo('The replacement is identical to the source — nothing to fix.', 'err'); return; }
    const existed = (FIX.rules || []).some((r) => (r.from || '') === from);
    FIX.rules = (FIX.rules || []).filter((r) => (r.from || '') !== from);   // same-source refresh (last write wins)
    FIX.rules.push({ id: fixUid(), from, to, note, ts: Date.now() });
    await fixSave(); fixRefresh();
    $('fx-from').value = ''; $('fx-to').value = ''; $('fx-note').value = '';
    fixInfo(`${existed ? 'Updated' : 'Added'} "${from}" → "${to}". ${fixCount()} rule(s) — active on the next Run.`, 'good');
  });
  if ($('fx-toggle')) $('fx-toggle').addEventListener('change', async (e) => {
    FIX.enabled = e.target.checked; await fixSave(); fixRefresh();
    fixInfo(FIX.enabled ? 'On — targets are auto-corrected after each Run.' : 'Off — rules kept but not applied.', '');
  });
  if ($('fx-export')) $('fx-export').addEventListener('click', fixExport);
  if ($('fx-import')) $('fx-import').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) fixImport(f); e.target.value = ''; });
  if ($('fx-search')) $('fx-search').addEventListener('input', (e) => fixRenderList(e.target.value));
  if ($('fx-clear')) $('fx-clear').addEventListener('click', async () => {
    if (!clearPass('every auto-fix rule')) return;
    FIX = { rules: [], enabled: FIX.enabled, seeded: true, updatedAt: 0 }; await fixSave(); fixRefresh(); fixInfo('All auto-fix rules cleared.', '');
  });

  // Term base (Starling's inline term references)
  await tbLoad(); tbRefresh();
  if ($('tb-grab')) $('tb-grab').addEventListener('click', async () => { $('tb-grab').disabled = true; try { await tbGrab(); } finally { $('tb-grab').disabled = false; } });
  if ($('tb-toggle')) $('tb-toggle').addEventListener('change', async (e) => {
    TB.enabled = e.target.checked; await tbSave(); tbRefresh();
    tbInfo(TB.enabled ? 'On — term references guide the next Run and DNT terms stay locked.' : 'Off — term base ignored on Run (terms kept).', '');
  });
  if ($('tb-export')) $('tb-export').addEventListener('click', tbExport);
  if ($('tb-import')) $('tb-import').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) tbImport(f); e.target.value = ''; });
  if ($('tb-search')) $('tb-search').addEventListener('input', (e) => tbRenderList(e.target.value));
  if ($('tb-clear')) $('tb-clear').addEventListener('click', async () => {
    if (!clearPass('every stored term reference')) return;
    TB = { enabled: TB.enabled, terms: [], updatedAt: 0 }; await tbSave(); tbRefresh(); tbInfo('Term base cleared (DNT terms already sent to Locked terms remain).', '');
  });

  // 📦 Corpus builder + full backup/restore
  CB.index = await store.get('corpusIndex', null);
  if (CB.index && CB.index.sources) { cbClassify(); cbRender(); }
  cbBadge();
  if ($('cb-build')) $('cb-build').addEventListener('click', () => cbBuild());
  if ($('cb-update')) $('cb-update').addEventListener('click', () => cbBuild({ force: false }));   // incremental-only, ignores "Rebuild from scratch"
  // 📅 date filter: clear resets to all tasks; changing the date re-checks the "new tasks" badge.
  if ($('cb-since-clear')) $('cb-since-clear').addEventListener('click', () => { if ($('cb-since')) $('cb-since').value = ''; cbNewCheck(); });
  if ($('cb-since')) $('cb-since').addEventListener('change', () => cbNewCheck());
  // Lazily re-count "new since last build" each time the Corpus card is expanded (needs a live
  // Starling tab; silently no-ops otherwise). Also check once now if it's already open.
  if ($('cb-card')) $('cb-card').addEventListener('toggle', (e) => { if (e.target.open) cbNewCheck(); });
  if ($('cb-card') && $('cb-card').open) cbNewCheck();
  if ($('cb-backup')) $('cb-backup').addEventListener('click', backupAll);
  if ($('cb-restore')) $('cb-restore').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) restoreAll(f); e.target.value = ''; });
  if ($('pm-run')) $('pm-run').addEventListener('click', pmRun);   // 🔤 phrase mining
  if ($('cl-run')) $('cl-run').addEventListener('click', clRun);   // 📚 learn from whole corpus
  if ($('cl-cancel')) $('cl-cancel').addEventListener('click', () => { CL.cancel = true; });
  clBadge();
  if ($('cls-run')) $('cls-run').addEventListener('click', clsRun);   // 🧹 consolidate rules
  if ($('cls-cancel')) $('cls-cancel').addEventListener('click', () => { CLS.cancel = true; });
  clsBadge();
  if ($('lk-q')) { let lkT = null; $('lk-q').addEventListener('input', (e) => { clearTimeout(lkT); const v = e.target.value; lkT = setTimeout(() => lkSearch(v), 180); }); }   // 🔎 lookup

  $('harvest').addEventListener('click', doHarvest);
  $('xliff-file').addEventListener('change', (e) => onXliffFile(e.target));
  $('run-gpt').addEventListener('click', doGpt);
  $('write').addEventListener('click', doWrite);
  $('write-confirm-submit').addEventListener('click', doWriteConfirmSubmit);
  $('confirm-all').addEventListener('click', doConfirmAll);
  $('submit-task').addEventListener('click', doSubmit);
  $('qa-read').addEventListener('click', doQaSummary);
  $('pl-scan').addEventListener('click', plScan);
  $('pl-write').addEventListener('click', plWrite);

  // Review VIEW filter (mutually exclusive) — mark the active one and re-render.
  const setRevFilter = (mode) => {
    revFilter = mode;
    ['view-changed', 'view-all', 'view-manual', 'view-memrev', 'view-consist', 'view-icdrift', 'view-termrev'].forEach((id) => { const b = $(id); if (b) b.classList.toggle('active', (id === 'view-' + mode)); });
    renderReview();
  };
  $('view-changed').addEventListener('click', () => setRevFilter('changed'));
  $('view-all').addEventListener('click', () => setRevFilter('all'));
  $('view-manual').addEventListener('click', () => setRevFilter('manual'));   // ✋ paste-by-hand only
  $('view-memrev').addEventListener('click', () => setRevFilter('memrev'));   // 🧠 memory — review only
  $('view-consist').addEventListener('click', () => setRevFilter('consist')); // ⚖ consistency flags only
  if ($('view-icdrift')) $('view-icdrift').addEventListener('click', () => setRevFilter('icdrift')); // ⚖ GPT drift flags only
  if ($('ic-sweep')) $('ic-sweep').addEventListener('click', icSweep);        // run the GPT internal-consistency sweep
  if ($('view-termrev')) $('view-termrev').addEventListener('click', () => setRevFilter('termrev')); // 🏷 term-base flags only
  // Approve selection (does NOT change the view). Manual/tagged rows are copy-by-hand and never auto-written.
  $('sel-all').addEventListener('click', () => { state.proposals.forEach((p) => p.approved = !p.manual && !sameRender(p.next, p.old)); renderReview(); });
  $('sel-none').addEventListener('click', () => { state.proposals.forEach((p) => p.approved = false); renderReview(); });

  // Feishu LQA mode
  $('lq-model').textContent = $('model').value;
  $('mode-starling').addEventListener('click', () => setMode('starling'));
  $('mode-lqa').addEventListener('click', () => setMode('lqa'));
  $('lq-load').addEventListener('click', () => { if (LQ.workbook && !$('lq-input').value.trim()) lqLoadSheet(); else lqLoad(); });
  $('lq-file').addEventListener('change', (e) => lqOnFile(e.target));
  $('lq-tab').addEventListener('change', lqLoadSheet);
  $('lq-lang').addEventListener('change', () => {
    if (!LQ.records.length) return;                 // nothing loaded yet
    LQ.results = {}; LQ.sel = [];
    lqBuildRows(); lqRenderMap();
    $('lq-review-card').hidden = true; $('lq-paste-card').hidden = true;
    $('lq-cards').innerHTML = ''; $('lq-legend').innerHTML = '';
    info('lq-info', `${LQ.rows.length} row(s)${LQ.langFiltered ? ` (Hebrew only, ${LQ.langFiltered} hidden)` : ''}${LQ.lvlFiltered ? ` · ${($('lq-level') && $('lq-level').value) || ''} only, ${LQ.lvlFiltered} hidden` : ''}.`, 'good');
  });
  $('lq-level').addEventListener('change', () => {
    if (!LQ.records.length) return;                 // nothing loaded yet
    LQ.results = {}; LQ.sel = [];
    lqBuildRows(); lqRenderMap();
    $('lq-review-card').hidden = true; $('lq-paste-card').hidden = true;
    $('lq-cards').innerHTML = ''; $('lq-legend').innerHTML = '';
    const lv = ($('lq-level') && $('lq-level').value) || 'all';
    info('lq-info', `${LQ.rows.length} row(s)${lv !== 'all' ? ` · ${lv} only${LQ.lvlFiltered ? `, ${LQ.lvlFiltered} hidden` : ''}` : ''}.`, 'good');
  });
  $('lq-run').addEventListener('click', lqRun);
  $('lq-valid-mean').addEventListener('change', (e) => { LQ.validYmeansReal = e.target.value === 'real'; if (LQ.sel.length) { lqRenderLegend(); lqRenderCards(); } });
  $('lq-copy-all').addEventListener('click', (e) => lqCopyAll(e.currentTarget));
  $('lq-copy-starling').addEventListener('click', (e) => lqCopyStarling(e.currentTarget));
  $('lq-copy-agree').addEventListener('click', (e) => lqCopyAgreeFixed(e.currentTarget));
  $('lq-dl-agree').addEventListener('click', (e) => lqDownloadAgreeFixed(e.currentTarget));
  document.querySelectorAll('#lq-paste-card [data-col]').forEach((b) => b.addEventListener('click', () => lqCopyCol(b.dataset.col, b)));
  if ($('lq-learn-add')) $('lq-learn-add').addEventListener('click', lrnAdd);
  if ($('lq-learn-clear')) $('lq-learn-clear').addEventListener('click', lrnClear);
  if ($('lq-learn-mem')) $('lq-learn-mem').addEventListener('click', lrnToMemory);
  if ($('lq-learn-distill')) $('lq-learn-distill').addEventListener('click', lrnDistill);

  // Sheet → Starling write-back (Mode 3)
  $('mode-wb').addEventListener('click', () => setMode('wb'));
  $('wb-file').addEventListener('change', (e) => wbReadFile(e.target));
  $('wb-load').addEventListener('click', wbLoad);
  $('wb-build').addEventListener('click', wbBuild);
  if ($('wb-export')) $('wb-export').addEventListener('click', wbExportForm);
  if ($('wb-resolve-all')) $('wb-resolve-all').addEventListener('click', () => {
    if ($('wb-resolve-all').textContent.indexOf('Stop') >= 0) { wbStopAll = true; return; }
    wbResolveAll();
  });
  $('wb-filter-todo').addEventListener('click', (e) => { WB.filter = 'todo'; e.target.classList.add('active'); $('wb-filter-all').classList.remove('active'); wbRenderQueue(); });
  $('wb-filter-all').addEventListener('click', (e) => { WB.filter = 'all'; e.target.classList.add('active'); $('wb-filter-todo').classList.remove('active'); wbRenderQueue(); });

  // Crowdin (API v2)
  $('cw-token').value = await store.get('cwToken', '');
  if ($('cw-model')) $('cw-model').textContent = $('model').value;
  $('cw-token-save').addEventListener('click', async () => { await store.set({ cwToken: $('cw-token').value.trim() }); info('cw-ctx', 'Crowdin token saved.', 'good'); });
  $('mode-crowdin').addEventListener('click', () => { setMode('crowdin'); cwDetect(); });
  $('cw-detect').addEventListener('click', cwDetect);
  $('cw-harvest').addEventListener('click', cwHarvest);
  $('cw-propose').addEventListener('click', cwPropose);
  $('cw-enter-all').addEventListener('click', cwEnterAll);

  // memoQ (editor API)
  if ($('mq-model')) $('mq-model').textContent = $('model').value;
  $('mode-memoq').addEventListener('click', () => { setMode('memoq'); mqDetect(); });
  $('mq-detect').addEventListener('click', mqDetect);
  $('mq-harvest').addEventListener('click', mqHarvest);
  $('mq-propose').addEventListener('click', mqPropose);
  $('mq-write-all').addEventListener('click', mqWriteAll);

  // YiCAT (segment API + copy / experimental DOM write)
  if ($('yc-model')) $('yc-model').textContent = $('model').value;
  $('mode-yicat').addEventListener('click', () => { setMode('yicat'); ycDetect(); });
  $('mode-pay').addEventListener('click', () => { setMode('pay'); if (!PC.rows) pcFetch(); });
  $('pc-run').addEventListener('click', pcFetch);
  $('pc-rate').addEventListener('input', () => { if (PC.rows) pcRender(); });
  $('pc-status').addEventListener('change', () => { if (PC.rows) pcRender(); });
  if ($('pc-datefield')) $('pc-datefield').addEventListener('change', (e) => { PC.dateField = e.target.value; if (PC.rows) pcRender(); });
  $('yc-detect').addEventListener('click', ycDetect);
  $('yc-harvest').addEventListener('click', ycHarvest);
  $('yc-propose').addEventListener('click', ycPropose);
  $('yc-copy-all').addEventListener('click', ycCopyAll);
  $('yc-write-all').addEventListener('click', ycWriteAll);
  $('yc-enable-write').addEventListener('change', (e) => {
    YC.write = e.target.checked;
    $('yc-write-bar').hidden = !YC.write;
    ycRender();
  });

  setMode(await store.get('mode_ui', 'starling'));

  refreshConn();
  $('conn').addEventListener('click', refreshConn);
  chrome.tabs.onActivated.addListener(refreshConn);
}
init();
