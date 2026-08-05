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
async function send(msg) {
  const t = await activeTab();
  if (!t || !/^https:\/\/starling\.bytedance\.com\//.test(t.url || '')) {
    throw new Error('Open a Starling task tab, then click Refresh.');
  }
  try {
    return await chrome.tabs.sendMessage(t.id, msg);
  } catch (e) {
    throw new Error('Content script not loaded on this tab — reload the Starling page.');
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
const TRAIL_TOK = /(?:\s+|<[^>]+>|\{\{[^{}]*\}\}|\{[^{}]*\}|%\d?\$?[sd]|&[a-zA-Z#0-9]+;|[OC]-\d+(?:-\d+)+|[①-⑳❶-➓⓪])+$/;
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
function amountIssue(src, out) { const o = String(out == null ? '' : out); for (const a of curAmounts(src)) if (!o.includes(a)) return a; return ''; }
function amountMismatch(src, out) { return numMismatch(src, out) || !!amountIssue(src, out); }
// Auto-fix the common case: exactly one currency amount on each side that differ → drop the
// source's amount verbatim into the target (position preserved). Multiple amounts → review-only.
function fixAmounts(src, out) {
  const o = String(out == null ? '' : out), sa = curAmounts(src), oa = curAmounts(o);
  if (sa.length === 1 && oa.length === 1 && sa[0] !== oa[0]) return o.replace(oa[0], sa[0]);
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
// Full output polish: fix internal spacing, restore brand spacing, restore **bold** markers,
// mirror the source's full stop, then mirror the source's leading/trailing whitespace.
function polish(src, out) { return mirrorEdges(src, matchTrailingPeriod(src, fixBold(src, fixAmounts(src, fixBrands(fixSpacing(out)))))); }

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
      const segs = sel ? all.filter((s) => sel(s.seg)) : all;
      if (sel && !segs.length) { info('harvest-info', `No segments matched "${$('seg-filter').value.trim()}" (file has ${all.length}). Clear the box for all.`, 'err'); return; }
      state.segments = segs;
      const filtered = sel && segs.length !== all.length;
      const tagged = segs.filter((s) => s.tagged).length;
      info('harvest-info', `Loaded ${segs.length}${filtered ? ` of ${all.length}` : ''} segments from ${f.name}${filtered ? ' (filtered)' : ''}${tagged ? ` · ⚠ ${tagged} with tags` : ''}.`, 'good');
      log(`xliff: ${segs.length}/${all.length} segments from ${f.name}${sel ? ' (filtered)' : ''}`);
      $('gpt-card').hidden = false;
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
  '- BRACKETS: translate text inside [square brackets]; NEVER translate or alter text inside {curly braces} (code placeholders).\n';

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
    '- NUMBERS & CURRENCY (do-not-translate): copy every number, amount, date and currency symbol from the SOURCE verbatim — the currency symbol and figure stay EXACTLY as written ("MX$67,000" stays "MX$67,000", "₩4,500,000" stays "₩4,500,000"). Never translate, convert, localize or reformat them, and never keep a different (stale TM) figure from the old target.\n' +
    '- HEBREW NUMBER POSITION for counted nouns (time units, people, items — any "{n} <noun>"): Hebrew places the number differently for 1 vs many. SINGULAR / CLDR-"one" form (count is exactly 1) → put the NOUN BEFORE the placeholder: "{s_num} hour" → "שעה {s_num}", "{s_num} day" → "יום {s_num}", "{s_num} min" → "דקה {s_num}", "1 person" → "אדם {s_number}" (mirrors שעה אחת / יום אחד / אדם אחד). PLURAL form → put the PLACEHOLDER FIRST with the plural noun: "{s_num} hours" → "{s_num} שעות", "{s_num} days" → "{s_num} ימים", "{s_num} people" → "{s_number} אנשים". Keep the {placeholder} byte-for-byte — only its POSITION changes. Compounds follow the same rule per noun, e.g. "{s_num} hour {s_num} min" → "שעה {s_num} ו-{s_num} דקות".\n' +
    '- STATUS-LABEL VERBS: translate English past-participle status labels as Hebrew VERB phrases, not noun phrases — "Last updated" → "עודכן לאחרונה" (NOT the noun "עדכון אחרון" / "עידכון אחרון", which also wrongly implies a final update), "Last modified" → "נערך לאחרונה", "Last edited" → "נערך לאחרונה", "Last synced" → "סונכרן לאחרונה", "Last seen" → "נצפה לאחרונה", "Last saved" → "נשמר לאחרונה". Keep any {placeholder}, its colon and position (e.g. "Last updated: {s_updateDate}" → "עודכן לאחרונה: {s_updateDate}").\n' +
    '- NO ADDITIONS: render ONLY what the source says. Never add names, facts, titles or clauses not present or implied in the source (e.g. do not insert a person\'s name like "דיוגו דאלוט" / "ראמי רביע" when the source has none). If the existing target contains such an addition, REMOVE it.\n' +
    '- NO SPACE BEFORE PUNCTUATION: no space before "." "," ":" ";" "!" "?"; no double spaces; no leading/trailing spaces.\n' +
    (plural
      ? '- FORM OF ADDRESS: Hebrew MUST be in לשון רבים — plural, gender-neutral forms (e.g. הצטרפו, שלמו, לחצו, קראו ואשרו) — never masculine singular and never slash forms like שלם/י.\n'
      : '- FORM OF ADDRESS: use the SINGULAR, gender-neutral second person with a slash for both genders (לחץ/י, את/ה, בחר/י). Put the final letter (אות סופית) BEFORE the slash. If the masculine and feminine suffixes differ, write BOTH words in full to avoid a malformed feminine (התחל/התחילי, not התחל/י). Use the imperative when the source is imperative. Do NOT use the plural form of address and do NOT use masculine-singular alone.\n') +
    (tiktok ? STYLE_GUIDE : '') +
    '- Return ONLY the JSON object requested. No commentary, no markdown, no code fences.';
  if (mode === 'translate') return base + '\nTASK: Translate each item\'s English "src" into natural, idiomatic Hebrew.';
  return base + '\nTASK: Proofread and correct each item\'s Hebrew "tgt" (use "src" as the reference meaning): fix grammar, spelling, terminology, and punctuation' +
    (plural ? ', and convert imperatives / second person to plural gender-neutral' : ', and convert imperatives / second person to the singular gender-neutral slash form (לחץ/י)') +
    '. Preserve the original meaning. If an item is already correct, return it unchanged.';
}

async function gptBatch(items, mode, key, model, plural, extraSys, tiktok) {
  const user = (mode === 'translate' ? 'Translate the "src" of each item. ' : 'Proofread the "tgt" of each item. ') +
    'Return JSON exactly as {"out":[{"i":<number>,"text":"<hebrew>"}]}, one entry per input item, same "i" numbers.\n' +
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
// Parse the "Only segments" box → a matcher fn, or null for ALL. Accepts "8",
// "10-20", "5,8,12", "3-6,10". Junk tokens are ignored; empty/unparseable → all.
function parseSegSel(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s || /^all$/i.test(s)) return null;
  const nums = new Set(), ranges = [];
  s.split(/[,\s]+/).filter(Boolean).forEach((tok) => {
    let m;
    if ((m = tok.match(/^(\d+)\s*[-–]\s*(\d+)$/))) ranges.push([Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])]);
    else if (/^\d+$/.test(tok)) nums.add(+tok);
  });
  if (!nums.size && !ranges.length) return null;
  return (seg) => { const n = parseInt(seg, 10); return !isNaN(n) && (nums.has(n) || ranges.some(([a, b]) => n >= a && n <= b)); };
}

async function doHarvest() {
  info('harvest-info', 'Harvesting… (scrolling the segment list)');
  $('harvest').disabled = true;
  try {
    const r = await send({ type: 'HARVEST' });
    if (!r || !r.ok) throw new Error(r && r.error || 'harvest failed');
    const all = r.segments || [];
    const sel = parseSegSel($('seg-filter').value);
    state.segments = sel ? all.filter((s) => sel(s.seg)) : all;
    const filtered = sel && state.segments.length !== all.length;
    if (sel && !state.segments.length && all.length) {
      info('harvest-info', `No segments matched "${$('seg-filter').value.trim()}" (task has ${all.length}). Clear the box for all.`, 'err');
      $('gpt-card').hidden = true; return;
    }
    const tagged = state.segments.filter((s) => s.tagged).length;
    const chips = state.segments.filter((s) => s.chip).length;
    info('harvest-info', `Harvested ${state.segments.length}${filtered ? ` of ${all.length}` : ''} segments${filtered ? ' (filtered)' : ''}${tagged ? ` · ⚠ ${tagged} tagged${chips ? ` (${chips} chip → copy-by-hand)` : ''}` : ''}.`, 'good');
    log(`harvest: ${state.segments.length}/${all.length} segments${sel ? ' (filtered)' : ''}, ${tagged} tagged, ${chips} chips`);
    $('gpt-card').hidden = state.segments.length === 0;
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
        const items = slice.map((s, j) => ({ i: j + 1, src: String(s.src || ''), tgt: String(s.tgt || '') }));
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
              proposals.push({ seg: s.seg, src: s.src, old: s.tgt, next: next, tagged: !!s.tagged || tagWrapped, chip: !!s.chip, tagWrapped: tagWrapped, manual: manual, filled: gm === 'translate' && wasEmpty, approved: !manual && next !== String(s.tgt) });
              done++;
              if (gm === 'translate' && wasEmpty) filled++;
            }
          });
        } catch (e) { failed += slice.length; log(`gpt ${gm} batch @${i} failed: ${e.message}`); }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    state.proposals = proposals;
    const changed = proposals.filter((p) => p.next !== p.old).length;
    const pf = done - filled;
    info('gpt-info', `✅ ${done} done${filled ? ` (${pf} proofread · ${filled} translated)` : ''} · ${changed} changed${failed ? ` · ${failed} failed` : ''}`, failed ? 'err' : 'good');
    renderReview();
    $('review-card').hidden = false;
    $('write-card').hidden = false;
  } finally {
    $('run-gpt').disabled = false;
  }
}

let onlyChanged = true;
function renderReview() {
  const box = $('review');
  const list = onlyChanged ? state.proposals.filter((p) => p.next !== p.old) : state.proposals;
  box.innerHTML = list.map((p) => {
    const idx = state.proposals.indexOf(p);
    const changed = p.next !== p.old;
    const cleanFull = stripTags(p.next);                        // whole target, inner text only (no tokens)
    const bulletParts = splitParts(p.next);
    const runParts = bulletParts ? null : splitTagRuns(p.next); // text runs between O-/C- tags
    // Per-part copy block: bullet items first, else each text run between two tags.
    // Copy a part → in Starling paste it BETWEEN its matching ①…① (tags untouched).
    let copyBlock = '';
    if (bulletParts) {
      const sparts = splitParts(p.src);
      copyBlock = `<div class="rc-parts" title="Paste each part between its matching ①…① tags in Starling — the tags stay untouched.">` +
        bulletParts.map((pt, i) => {
          const clean = stripTags(pt);                          // inner text only — no O-/C- tokens
          const id = tagId(pt) || String(i + 1);                // badge = the tag's own id when present
          const sclean = (sparts && sparts.length === bulletParts.length) ? stripTags(sparts[i]) : '';
          const sref = sclean ? `<div class="rc-psrc" dir="ltr">${hl(esc(sclean))}</div>` : '';
          return `<div class="rc-part"><span class="rc-pidx" title="tag ${esc(id)}">${esc(id)}</span><div class="rc-pbody">${sref}<div class="rc-ptxt" dir="rtl">${hl(esc(clean))}</div></div><button class="rc-copy" type="button" data-copy="${esc(clean)}">Copy</button></div>`;
        }).join('') + `</div>`;
    } else if (runParts) {
      copyBlock = `<div class="rc-parts" title="Each run of text between two tags — copy it and paste it BETWEEN the matching ①…① tags in Starling; the tags stay untouched.">` +
        runParts.map((r, i) => {
          const id = r.id || String(i + 1);
          return `<div class="rc-part"><span class="rc-pidx" title="tag ${esc(id)}">${esc(id)}</span><div class="rc-pbody"><div class="rc-ptxt" dir="rtl">${hl(esc(r.text))}</div></div><button class="rc-copy" type="button" data-copy="${esc(r.text)}">Copy</button></div>`;
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
    const newRow = p.manual
      ? `<div class="rc-new ro" dir="rtl">${hl(esc(p.next))}</div>`
      : `<div class="rc-new" dir="rtl" contenteditable="true" spellcheck="false">${esc(p.next)}</div>`;
    return `<div class="rc${p.tagged ? ' tagged' : ''}${p.manual ? ' manual' : ''}${changed ? '' : ' unchanged'}" data-i="${idx}">
      <div class="rc-top">
        <span class="rc-seg">#${esc(p.seg)}</span>
        ${p.filled ? '<span class="rc-warn" title="Target was empty — translated from the source and will be written in with the rest." style="background:#0a7a3f">＋ new</span>' : ''}
        ${p.chip ? '<span class="rc-warn" title="Real inline-tag object (chip) in the cell — copy-by-hand.">⚠ chip</span>' : (p.tagWrapped ? '<span class="rc-warn" title="Numbered wrapping tags (①②③ / O-/C- tokens) — copy-by-hand; writing would type the literal tokens and break the tags. Use the per-part Copy buttons.">⚠ tag</span>' : (p.tagged ? '<span class="rc-warn" title="Text placeholder ({0}, %s, &lt;g id&gt;…) — kept byte-for-byte; safe to write. Eyeball that the token survived.">⚠ placeholder</span>' : ''))}
        ${amountMismatch(p.src, p.next) ? '<span class="rc-warn" title="Number/currency differs from the source — the amount &amp; currency symbol must stay verbatim (may be a stale TM value).">⚠ number</span>' : ''}
        ${hasSpacingIssue(p.old) || edgeMismatch(p.src, p.old) ? '<span class="rc-warn" title="Spacing adjusted — space before punctuation, double spaces, or leading/trailing space to match the source.">⚠ spacing</span>' : ''}
        ${brandIssue(p.src, p.next) ? `<span class="rc-warn" title="A product name from the source (${esc(brandIssue(p.src, p.next))}) isn't kept verbatim — check the brand spelling/spacing.">⚠ brand</span>` : ''}
        ${boldIssue(p.src, p.next) ? `<span class="rc-warn" title="Markdown **bold** from the source (**${esc(boldIssue(p.src, p.next))}**) isn't wrapped in the target — the asterisks were dropped. Add ** around the matching term.">⚠ bold</span>` : ''}
        <div class="rc-ctl">${control}</div>
      </div>
      ${p.src ? `<div class="rc-src" dir="ltr">${hl(esc(p.src))}</div>` : ''}
      ${changed && String(p.old).trim() ? `<div class="rc-old" dir="rtl">${hl(esc(p.old))}</div>` : ''}
      ${newRow}
      ${copyBlock}
    </div>`;
  }).join('') || '<div class="info">No changes proposed.</div>';

  box.querySelectorAll('.rc-cb').forEach((cb) => cb.addEventListener('change', (e) => {
    const i = +e.target.closest('.rc').dataset.i; state.proposals[i].approved = e.target.checked; updateRevCount();
  }));
  box.querySelectorAll('.rc-new[contenteditable]').forEach((ed) => ed.addEventListener('input', (e) => {
    const i = +e.target.closest('.rc').dataset.i; state.proposals[i].next = e.target.innerText;
  }));
  box.querySelectorAll('.rc-copy').forEach((b) => b.addEventListener('click', () => panelCopy(b.getAttribute('data-copy'), b)));
  box.querySelectorAll('.rc-write').forEach((b) => b.addEventListener('click', () => doWriteOne(+b.dataset.i, b)));
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
    if (res && res.ok) { btn.textContent = '✓ written'; p.written = true; }
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
    const ok = results.filter((r) => r.ok).length;
    const bad = results.filter((r) => !r.ok);
    info('write-info', `✅ Wrote ${ok}/${results.length}${bad.length ? ` · ${bad.length} failed` : ''}`, bad.length ? 'err' : 'good');
    bad.forEach((b) => log(`write #${b.seg} failed: ${b.reason}`));
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
const LQ = { header: [], records: [], map: {}, rows: [], sel: [], results: {}, filter: 'all', validYmeansReal: true };
const LQ_FIELDS = [['src', 'Source (EN)'], ['tgt', 'Current target'], ['ai', 'AI suggested'], ['cat', 'Error type'], ['level', 'Level'], ['comment', 'AI comment'], ['key', 'Key'], ['valid', 'Valid col'], ['lang', 'Language']];
const LQ_BATCH = 8;

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
  map.ai = find(/suggest/i);                                   // "Suggested Target by AI" — claim before plain Target
  map.tgt = find(/target|译文|譯文/i);
  map.src = find(/source|原文/i);
  map.cat = find(/category|errortype|error\s*type|类型|類型/i);
  map.level = find(/level|severity|等级|等級/i);
  map.comment = find(/comment|说明|說明|备注|備註|reason/i);
  map.key = find(/^key$|\bkey\b|键|鍵/i);
  map.valid = find(/valid/i);
  return map;
}
function lqLoad() {
  LQ.results = {}; LQ.sel = [];
  const text = $('lq-input').value;
  if (!text.trim()) { info('lq-info', 'Paste rows copied from Feishu, or load a CSV/TSV.', 'err'); return; }
  const mode = $('lq-delim').value;
  const delim = mode === 'csv' ? ',' : mode === 'tsv' ? '\t' : (text.indexOf('\t') >= 0 ? '\t' : ',');
  const rows = lqSplitTable(text, delim).filter((r) => r.length);
  if (!rows.length) { info('lq-info', 'Nothing parsed — check the format.', 'err'); return; }
  let hi = rows.findIndex((r) => r.some((c) => /source/i.test(c)) && r.some((c) => /target/i.test(c)));
  if (hi < 0) hi = rows.findIndex((r) => r.some((c) => /source|target|error/i.test(c)));
  if (hi < 0) hi = 0;
  LQ.header = rows[hi].map((c) => String(c).trim());
  LQ.records = rows.slice(hi + 1).filter((r) => r.some((c) => String(c).trim().length));
  if (!LQ.records.length) { info('lq-info', 'Found a header but no data rows below it.', 'err'); return; }
  LQ.map = lqAutoMap(LQ.header);
  lqBuildRows(); lqRenderMap();
  $('lq-map-card').hidden = false; $('lq-run-card').hidden = false;
  $('lq-review-card').hidden = true; $('lq-paste-card').hidden = true;
  $('lq-cards').innerHTML = ''; $('lq-legend').innerHTML = '';
  info('lq-info', `Loaded ${LQ.rows.length} rows (header row ${hi + 1}). Check the mapping, then pick a range.`, 'good');
}
function lqBuildRows() {
  const m = LQ.map, g = (r, i) => (i >= 0 && i < r.length) ? String(r[i]).trim() : '';
  LQ.rows = LQ.records.map((r, idx) => ({ n: idx + 1, lang: g(r, m.lang), src: g(r, m.src), tgt: g(r, m.tgt), ai: g(r, m.ai), cat: g(r, m.cat), level: g(r, m.level), comment: g(r, m.comment), key: g(r, m.key), valid: g(r, m.valid) }));
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
    STYLE_GUIDE + '\n' +
    'PUNCTUATION: MIRROR the English "src" sentence-final full stop (.). If "src" ends with "." then "corrected" MUST end with "."; if "src" does NOT end with "." then "corrected" must NOT end with ".". Never add or drop it independently. Keep "?", "!", "…" as the meaning requires.\n' +
    'NUMBERS & CURRENCY (do-not-translate): "corrected" must copy every number, amount and currency symbol from "src" VERBATIM ("MX$67,000" stays "MX$67,000") — never translate/convert/reformat, never keep a different (stale TM) figure from "tgt". A differing figure IS a valid error → verdict "valid" and fix it.\n' +
    'ADDITIONS: if "tgt" contains a name, word or clause NOT present or implied in "src" (e.g. a player name like "ראמי רביע" the source omits), the Addition flag is VALID → verdict "valid" and "corrected" must REMOVE the added content. Never introduce content not in "src".\n' +
    'SPACING: "corrected" must have no space before "." "," ":" ";" "!" "?", no double spaces, and no leading/trailing spaces.\n' +
    'TERMINOLOGY SKEPTICISM: you do NOT have the project glossary / terminology reference. When the checker justifies an error ONLY by citing a "terminology reference", "approved target string", "terminology list" or "should remain in English" that you cannot see, do NOT assume it is correct — treat such unverifiable claims skeptically and lean "invalid" unless the Hebrew is independently wrong. Common English words/phrases ("for you", "tips", "settings", "learn more") are NOT brand names and are normally translated to Hebrew; only unmistakable product/feature proper nouns (e.g. TikTok, LIVE) must stay in Latin script.\n' +
    'Return ONLY JSON: {"out":[{"i":<n>,"verdict":"valid|invalid|partial","category":"<exactly one of: Typo | Punctuation/Space/Tag/Formatting | Grammar and syntax | Mistranslation | Preferential change | Term mismatch | Semantic addition | Semantic omission | Inconsistency>","corrected":"<hebrew, the corrected target>","reason":"<short invalid reason, ONLY when verdict is invalid, else empty>","rationale":"<one short line for the human reviewer>","confidence":<0..1>}]}.\n' +
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
  let done = 0, failed = 0;
  try {
    for (let i = 0; i < sel.length; i += LQ_BATCH) {
      const slice = sel.slice(i, i + LQ_BATCH);
      info('lq-run-info', `⚖️ Adjudicating ${i + 1}–${Math.min(i + LQ_BATCH, sel.length)} of ${sel.length}…`);
      const items = slice.map((n, j) => { const r = byN[n]; return { i: j + 1, src: r.src, tgt: r.tgt, ai_suggested: r.ai, error_type: r.cat, error_level: r.level, error_comment: r.comment }; });
      try {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: lqSys(plural) }, { role: 'user', content: 'Adjudicate these items. Return one entry per item with the same "i".\n' + JSON.stringify({ items }) }] })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error && data.error.message || ('GPT error ' + resp.status));
        const arr = JSON.parse(data.choices?.[0]?.message?.content || '{}').out || [];
        arr.forEach((o) => {
          const idx = (o.i | 0) - 1; if (idx < 0 || idx >= slice.length) return; const n = slice[idx]; const row = byN[n];
          const corrected = o.corrected != null ? polish(row ? row.src : '', o.corrected) : '';  // fix spacing + mirror the source's full stop
          LQ.results[n] = { verdict: String(o.verdict || '').toLowerCase().trim(), category: String(o.category || '').trim(), corrected: corrected, reason: o.reason ? String(o.reason) : '', rationale: o.rationale ? String(o.rationale) : '', confidence: (typeof o.confidence === 'number' ? o.confidence : null) };
          done++;
        });
      } catch (e) { failed += slice.length; log('lq batch @' + i + ' failed: ' + e.message); }
      if (i + LQ_BATCH < sel.length) await new Promise((r) => setTimeout(r, 250));
    }
    lqDedupeReasons();
    LQ.filter = 'all'; lqRenderLegend(); lqRenderCards();
    $('lq-review-card').hidden = false; $('lq-paste-card').hidden = false;
    info('lq-run-info', `✅ Adjudicated ${done} · ${lqCountYN('Yes')} valid · ${lqCountYN('No')} invalid` + (failed ? ` · ${failed} failed` : ''), failed ? 'err' : 'good');
  } finally { $('lq-run').disabled = false; }
}
function lqVerdict(r) { const v = r.verdict; if (v === 'valid' || v === 'invalid' || v === 'partial') return v; if (v === 'no' || v === 'false' || v === 'n') return 'invalid'; if (v === 'yes' || v === 'true' || v === 'y') return 'valid'; return 'valid'; }
const LQ_CATS = ['Typo', 'Punctuation/Space/Tag/Formatting', 'Grammar and syntax', 'Mistranslation', 'Preferential change', 'Term mismatch', 'Semantic addition', 'Semantic omission', 'Inconsistency'];
// A "real error to fix" = GPT's call, UNLESS you overrode Valid Yes/No on the card.
function lqReal(r) { return r.validOverride ? r.validOverride === 'Yes' : lqVerdict(r) !== 'invalid'; }
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
    if (!lqReal(r) && lqSpellingGrammar(r)) { const t = (r.category || 'other').toLowerCase(); if (seen.has(t)) r.comment = ''; else { seen.add(t); r.comment = r.reason || ''; } }
    else r.comment = '';
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
  const claim = (r.cat || r.comment) ? `<div class="lqc-claim"><b>${esc(r.cat || '')}</b>${r.comment ? ' — ' + esc(r.comment) : ''}</div>` : '';
  const changed = (real && res.corrected && res.corrected !== r.tgt);
  const cat = c.category ? `<div class="lqc-lbl">Category</div><span class="lqc-cat">${esc(c.category)}</span>` : '';
  const finalT = real ? `<div class="lqc-lbl">Final translation</div><div class="lqc-new" dir="rtl">${hl(esc(c.final || r.tgt))}</div>` : '';
  const comment = c.comments ? `<div class="lqc-lbl">Comment (invalid reason)</div><div class="lqc-reason" dir="auto">${esc(c.comments)}</div>` : '';
  const rat = res.rationale ? `<div class="lqc-rat">${esc(res.rationale)}${res.confidence != null ? ` · conf ${Math.round(res.confidence * 100)}%` : ''}</div>` : '';
  const acts = [];
  if (c.final) acts.push(`<button class="lqc-copy" type="button" data-copy="${esc(c.final)}">Copy final</button>`);
  if (c.category) acts.push(`<button class="lqc-copy ghost" type="button" data-copy="${esc(c.category)}">Copy category</button>`);
  acts.push(`<button class="lqc-copy ghost" type="button" data-copy="${esc(yn)}">Copy ${esc(yn)}</button>`);
  if (c.comments) acts.push(`<button class="lqc-copy ghost" type="button" data-copy="${esc(c.comments)}">Copy comment</button>`);
  return `<div class="lqc v-${eff}" data-verdict="${eff}" data-n="${n}">
    <div class="lqc-top"><span class="lqc-seg">#${n}</span><span class="lqc-badge b-${gv}" title="GPT's call">${gv}</span>${vset}${numWarn}${spWarn}${brWarn}${ovr}${lvl}${keyHtml}</div>
    ${r.src ? `<div class="lqc-lbl">Source</div><div class="lqc-src" dir="ltr">${hl(esc(r.src))}</div>` : ''}
    <div class="lqc-lbl">Current target</div><div class="lqc-tgt${changed ? ' old' : ''}" dir="rtl">${hl(esc(r.tgt))}</div>
    ${r.ai ? `<div class="lqc-lbl">AI suggested</div><div class="lqc-tgt" dir="rtl">${hl(esc(r.ai))}</div>` : ''}
    ${claim}${cat}${finalT}${comment}${rat}
    <div class="lqc-acts">${acts.join('')}</div>
  </div>`;
}
function lqRenderCards() {
  const wrap = $('lq-cards'); if (!wrap) return;
  wrap.innerHTML = LQ.sel.map(lqCardHtml).join('');
  wrap.querySelectorAll('.lqc-copy').forEach((b) => b.addEventListener('click', () => panelCopy(b.getAttribute('data-copy'), b)));
  wrap.querySelectorAll('.lqc-vbtn').forEach((b) => b.addEventListener('click', () => lqSetOverride(+b.dataset.n, b.dataset.set)));
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
function lqTsvCell(v) { v = String(v == null ? '' : v); return /[\t\n\r"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
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
function lqOnFile(input) {
  const f = input.files && input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { $('lq-input').value = r.result; if (/\.csv$/i.test(f.name)) $('lq-delim').value = 'csv'; else if (/\.(tsv|tab)$/i.test(f.name)) $('lq-delim').value = 'tsv'; lqLoad(); };
  r.readAsText(f); input.value = '';
}
// ══════════ SHEET → STARLING WRITE-BACK (Mode 3) ═══════════════════════════
// Ingest the adjudicated sheet (xlsx/csv/paste), build a queue of Valid=Yes rows
// (Key + Final Translation), then per key: filter All tasks by key (en→he, HARD
// RELOAD — the URL param only applies on a real load), open the task, read the
// live segment, write the Final Translation, and proofread-confirm that one row.
// It guards on source-match and shows live-vs-sheet before every write. NEVER submits.
const WB = { header: [], records: [], map: {}, rows: [], queue: [], filter: 'todo', workbook: null, tabNames: [], engine: 'api', index: new Map(), indexTabs: [], lqa: false, sheetName: '', fileName: '', rawBytes: null };

// Join normaliser for sheet-source ↔ live-source comparison. The API returns the TRUE
// characters, and real content uses fullwidth punctuation ("Man United defender｜…") and
// trailing spaces — both visually identical to their ASCII/absent counterparts. Fold
// fullwidth→ASCII, unify quotes/dashes, collapse whitespace, trim.
const wbFold = (s) => String(s == null ? '' : s)
  .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[　 ]/g, ' ')
  .replace(/[‘’ʼ′]/g, "'")
  .replace(/[“”″]/g, '"')
  .replace(/[‐-―−]/g, '-')
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
const WB_FIELDS = [['key', 'Key'], ['valid', 'Valid (Y/N)'], ['final', 'Final Translation'], ['src', 'Source (EN)'], ['tgt', 'Current target'], ['lang', 'Language']];
const STAR_KEY_URL = 'https://starling.bytedance.com/#/all-task?pageNum=1&pageSize=10&progress=all&translateTypeList=%5B%5D&sortType=1&order=0&sourceLocales=en&targetLocales=he-IL&textKeys=';
const CS_EXPECT = 31;   // must match content.js CS_VERSION

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
function wbIsLqaReport(header) {
  const h = header.map((x) => String(x).toLowerCase());
  const has = (re) => h.some((x) => re.test(x));
  return has(/suggested translation/) && has(/before translation|lqa comment|validation feedback/);
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
  if (wbIsLqaReport(header)) {
    map.key   = find(/^key$|\bkey\b/i);
    map.src   = find(/^source$|source/i);                 // first "Source" (col B), not the far-right "Source"
    map.tgt   = find(/before translation|^before/i);      // current Hebrew = the "Before"
    map.final = find(/suggested translation|suggest/i);   // the LQA fix to write into Starling
    map.valid = find(/validation feedback/i);             // col I (proofreader) — your "agree"
    map.lang  = find(/^lang(uage)?$/i);   // exact "Language"/"Lang" only — NOT "Validation feedback (from Language Leads)"
    return map;
  }
  map.key = find(/^key$|\bkey\b|键|鍵/i);
  map.final = find(/final/i);                                  // "Final Translation (only for valid…)"
  map.valid = find(/valid/i);
  map.src = find(/source|原文/i);
  map.tgt = find(/suggest/i); map.tgt = find(/^target$|\btarget\b|译文|譯文/i) >= 0 ? find(/^target$|\btarget\b|译文|譯文/i) : map.tgt;
  map.lang = find(/^lang|language|语言|語言/i);
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
  WB.sheetName = WB.workbook ? (($('wb-tab').value) || WB.tabNames[0]) : '';
  wbBuildRowObjs(); wbRenderMap(); wbBuildIndex();
  $('wb-map-card').hidden = false; $('wb-build-card').hidden = false;
  $('wb-queue-card').hidden = true; $('wb-queue').innerHTML = ''; if ($('wb-log')) $('wb-log').textContent = '';
  if ($('wb-lqa-row')) $('wb-lqa-row').hidden = !WB.lqa;                 // "queue all with a fix" toggle
  if ($('wb-export')) $('wb-export').hidden = !(WB.lqa && WB.workbook);  // export needs the original .xlsx
  const idxNote = WB.index.size
    ? ` · cross-tab index: ${WB.index.size} keys from ${WB.indexTabs.join(', ')}`
    : ' · no cross-tab index (paste/CSV input — API engine will match against this tab only)';
  const lqaNote = WB.lqa ? ' · 📋 LQA report detected — mapped Before→current, Suggested→fix, Column I→"agree".' : '';
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
function wbStampAgreeForKey(key) {
  if (typeof XLSX === 'undefined' || !WB.workbook || !WB.sheetName) return 0;
  const ws = WB.workbook.Sheets[WB.sheetName];
  const colI = WB.map.valid, colKey = WB.map.key;
  if (!ws || !ws['!ref'] || colI == null || colI < 0 || colKey == null || colKey < 0) return 0;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const want = String(key == null ? '' : key).trim();
  let n = 0;
  for (let R = range.s.r; R <= range.e.r; R++) {
    const kc = ws[XLSX.utils.encode_cell({ r: R, c: colKey })];
    if (!kc || String(kc.v == null ? '' : kc.v).trim() !== want) continue;
    const addr = XLSX.utils.encode_cell({ r: R, c: colI });
    const cur = ws[addr] && ws[addr].v;
    if (cur == null || String(cur).trim() === '') { ws[addr] = { t: 's', v: 'agree' }; n++; }
  }
  return n;
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
  const done = {}, skipped = [];
  for (const q of WB.queue) {
    if (q.doneTasks && q.doneTasks.length) done[q.key] = q.doneTasks.slice();
    else if (q.status === 'done') skipped.push(q.key);   // marked done without a write = skipped
  }
  try { const all = await store.get('wbProgress', {}); all[wbFileSig()] = { done, skipped }; await store.set({ wbProgress: all }); } catch (e) {}
}
// Does the LOADED sheet already carry a non-empty Column I for this key? Lets progress ride
// along INSIDE the .xlsx: re-loading an exported/with-agrees file restores done-state with no
// storage at all (portable across machines).
function wbColIFilledForKey(key) {
  if (typeof XLSX === 'undefined' || !WB.workbook || !WB.sheetName) return false;
  const ws = WB.workbook.Sheets[WB.sheetName];
  const colI = WB.map.valid, colKey = WB.map.key;
  if (!ws || !ws['!ref'] || colI == null || colI < 0 || colKey == null || colKey < 0) return false;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const want = String(key == null ? '' : key).trim();
  for (let R = range.s.r; R <= range.e.r; R++) {
    const kc = ws[XLSX.utils.encode_cell({ r: R, c: colKey })];
    if (!kc || String(kc.v == null ? '' : kc.v).trim() !== want) continue;
    const vc = ws[XLSX.utils.encode_cell({ r: R, c: colI })];
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
  let doneMap = {}; const skipSet = new Set();
  for (const rec of recs) {
    if (rec.done || rec.skipped) { Object.assign(doneMap, rec.done || {}); (rec.skipped || []).forEach((k) => skipSet.add(k)); }
    else Object.assign(doneMap, rec);   // old flat {key:[tasks]} = all-done
  }
  let nDone = 0, nSkip = 0, nFile = 0;
  for (const q of WB.queue) {
    if (q.status === 'conflict') continue;
    const tasks = doneMap[q.key];
    if (tasks && tasks.length) {
      q.doneTasks = tasks.slice(); q.status = 'done'; q.agreed = true; wbStampAgreeForKey(q.key); nDone++;
    } else if (skipSet.has(q.key)) {
      q.status = 'done'; q.note = 'Skipped last session (not written).'; nSkip++;
    } else if (wbColIFilledForKey(q.key)) {
      q.status = 'done'; q.agreed = true; q.note = 'Already filled in the sheet (Column I).'; nFile++;
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
  const colI = WB.map.valid, colLetter = zipColLetter(colI);
  const stampMap = {};
  for (let R = range.s.r; R <= range.e.r; R++) {
    const cell = ws[XLSX.utils.encode_cell({ r: R, c: colI })];
    const val = cell && cell.v != null ? String(cell.v).trim() : '';
    if (val) stampMap[R + 1] = val;
  }
  const res = injectCol(xml, colLetter, stampMap);
  const nb = new TextEncoder().encode(res.xml);
  const te = byName[sheetPath];
  te.usize = nb.length; te.crc = crc32(nb); te.method = 8; te.cdata = await zipDeflateRaw(nb);
  const out = zipBuild(entries);
  const url = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return res.n;
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
  if (WB.map.valid == null || WB.map.valid < 0 || WB.map.key == null || WB.map.key < 0) { info('wb-queue-info', 'Column I ("Validation feedback") or Key isn\'t mapped — fix the mapping.', 'err'); return; }
  // Re-stamp anything written THIS session first, then gate on what's actually in Column I —
  // so a file whose agrees were restored from the sheet (no doneTasks) still exports.
  const wroteKeys = [...new Set(WB.queue.filter((q) => q.doneTasks && q.doneTasks.length).map((q) => q.key))];
  for (const k of wroteKeys) wbStampAgreeForKey(k);
  let filled = 0;
  const ws0 = WB.workbook.Sheets[WB.sheetName];
  if (ws0 && ws0['!ref']) {
    const rg = XLSX.utils.decode_range(ws0['!ref']);
    for (let R = rg.s.r + 1; R <= rg.e.r; R++) { const c = ws0[XLSX.utils.encode_cell({ r: R, c: WB.map.valid })]; if (c && c.v != null && String(c.v).trim()) filled++; }
  }
  if (!filled) { info('wb-queue-info', 'Nothing in Column I to export yet — write/agree to some rows (or load a file that already has agrees) first.', 'err'); return; }
  const base = WB.fileName ? WB.fileName.replace(/\.xlsx?$/i, '') : (WB.sheetName || 'LQA');
  const fname = base + ' with-agrees.xlsx';
  if (WB.rawBytes && typeof DecompressionStream !== 'undefined' && typeof CompressionStream !== 'undefined') {
    info('wb-queue-info', 'Building the formatted file…', 'good');
    wbStyledExport(fname)
      .then((n) => info('wb-queue-info', `⬇ Exported ${fname} — ${n} "agree"(s) in Column I, original formatting kept. Ready to submit.`, 'good'))
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
    const r = await wbCall('WB_WRITE', { edit: { key: q.key, text: q.final, confirm, expectSource: q.src } });
    if (!r || !r.ok) { wbSetStatus(i, 'checked', '⚠ ' + (r && r.reason || 'write failed')); return; }
    const tid = (q.live && q.live.taskId) || r.taskId || '?';
    q.doneTasks = q.doneTasks || [];
    if (!q.doneTasks.includes(tid)) q.doneTasks.push(tid);
    wbLog(`wrote ${q.key} @task ${tid}: "${r.after}"${r.confirmed ? ' [confirmed]' : ''}`);
    // A key can live in several tasks — DON'T mark the card fully done after one write.
    // Clear the live read so the next task must be Checked, and keep the buttons live so
    // you can Search → open another 👁 → Check → Write again. "Done" ends the card.
    q.live = null; q.decision = null; q.status = 'written';
    if (WB.lqa && WB.workbook) { q.agreed = true; const st = wbStampAgreeForKey(q.key); if (st) wbLog(`📋 Column I → "agree" for ${q.key} (${st} row) — Export form to download`); wbPersistProgress(); }
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
    const hit = entries.find((e) => wbFold(e.source) === wbFold(s.source));
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
  if (a.verdict !== 'ready') { wbSetStatus(i, 'checked', `Nothing to write here (${a.verdict}). Skip this task.`); return; }
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
    wbSetStatus(i, 'writing', 'Writing the Final via the Starling API…');
    const ar = await wbCall('API_CONFIRM', {
      taskId: a.taskId, key: q.key, sourceTextId: a.sourceTextId,
      flowSequence: a.flowSequence, text: a.final, ignoreQa: WB.lqa === true && doConfirm
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
    const ok2 = seg2 && wbFold(seg2.target) === wbFold(a.final);
    wbLog(`API-wrote ${q.key} @task ${a.taskId} id=${a.sourceTextId} (${why}) — server=${ok2 ? 'matches ✓' : (seg2 ? 'not-yet(status ' + seg2.status + ')' : 're-read failed')}`);
    q.doneTasks = q.doneTasks || []; if (!q.doneTasks.includes(a.taskId)) q.doneTasks.push(a.taskId);
    q.live = null; q.decision = null; q.api = null; q.status = 'written';
    if (WB.lqa && WB.workbook) { q.agreed = true; const st = wbStampAgreeForKey(q.key); if (st) wbLog(`📋 Column I → "agree" for ${q.key} (${st} row) — Export form to download`); wbPersistProgress(); }
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
    if (WB.lqa && WB.workbook) { q.agreed = true; const st = wbStampAgreeForKey(q.key); if (st) wbLog(`📋 Column I → "agree" for ${q.key} (${st} row) — Export form to download`); wbPersistProgress(); }
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
  }));
  const done = WB.queue.filter((q) => q.status === 'done').length;
  if ($('wb-qcount')) $('wb-qcount').textContent = `${done}/${WB.queue.length} done`;
}
function wbCardHtml(q, i) {
  const live = q.live, dec = q.decision;
  const decBadge = dec === 'already' ? '<span class="lqc-badge b-invalid" title="Live target already equals the Final Translation">already correct</span>'
    : dec === 'mismatch' ? '<span class="lqc-warn" title="Live task source differs from the sheet source — the sheet fix may not apply here (line 121).">⚠ source mismatch</span>'
      : dec === 'ready' ? '<span class="lqc-badge b-valid">ready</span>' : '';
  const liveBlock = live && live.found ? `
    <div class="lqc-lbl">Live source</div><div class="lqc-src" dir="ltr">${hl(esc(live.source))}</div>
    <div class="lqc-lbl">Current target</div><div class="lqc-tgt${wbNorm(live.target) !== wbNorm(q.final) ? ' old' : ''}" dir="rtl">${hl(esc(live.target))}</div>`
    : (live && !live.found ? `<div class="info err">${live.noSourceMatch
      ? `Key found here (${live.visible} segment${live.visible === 1 ? '' : 's'}), but its source doesn’t match the sheet — nothing written.`
      : live.ambiguous
        ? `Key matched ${live.visible} segments — too ambiguous to pick one safely.`
        : 'Segment not found in the open task.'}</div>` : '');
  const canWrite = !!(live && live.found) && dec !== 'already';
  const done = q.status === 'done';
  const written = q.status === 'written';
  const acts = q.conflict
    ? '<span class="rc-manual">Resolve in the sheet</span>'
    : done
      ? `<button class="lqc-copy ghost" data-act="copy-final" data-i="${i}">Copy final</button>`
      : `<button class="lqc-copy" data-act="search" data-i="${i}">1 · Search</button>
         <button class="lqc-copy ghost" data-act="check" data-i="${i}">2 · Check</button>
         <button class="lqc-copy${canWrite ? '' : ' ghost'}" data-act="write" data-i="${i}">3 · Write + confirm</button>
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
    <div class="lqc-lbl">Final translation (from sheet)</div><div class="lqc-new" dir="rtl">${hl(esc(q.final))}</div>
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
  const views = { starling: 'view-starling', lqa: 'view-lqa', wb: 'view-wb', crowdin: 'view-crowdin', memoq: 'view-memoq', yicat: 'view-yicat' };
  const btns = { starling: 'mode-starling', lqa: 'mode-lqa', wb: 'mode-wb', crowdin: 'mode-crowdin', memoq: 'mode-memoq', yicat: 'mode-yicat' };
  if (!views[m]) m = 'starling';
  Object.keys(views).forEach((k) => { $(views[k]).hidden = k !== m; $(btns[k]).classList.toggle('active', k === m); });
  store.set({ mode_ui: m });
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
    PL.segs = sel ? all.filter((s) => sel(s.rank)) : all;
    if (sel && !PL.segs.length) {
      info('pl-info', `No plural segments matched "${$('seg-filter').value.trim()}" (task has ${all.length} plural segment(s)). Clear the box for all.`, 'err');
      plRender(); return;
    }
    info('pl-info', PL.segs.length ? `Found ${PL.segs.length} plural segment(s)${sel ? ' (filtered)' : ''}. Propose each, review, then write.` : 'No plural segments in this task.', PL.segs.length ? 'good' : '');
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
        <div class="rc-ctl">${s.forms ? `<label><input type="checkbox" class="pl-cb" data-i="${idx}" ${s.approved ? 'checked' : ''}/> write</label>` : ''}<button class="rc-write pl-propose" type="button" data-i="${idx}">✨ Propose</button></div>
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

  $('harvest').addEventListener('click', doHarvest);
  $('xliff-file').addEventListener('change', (e) => onXliffFile(e.target));
  $('run-gpt').addEventListener('click', doGpt);
  $('write').addEventListener('click', doWrite);
  $('confirm-all').addEventListener('click', doConfirmAll);
  $('submit-task').addEventListener('click', doSubmit);
  $('qa-read').addEventListener('click', doQaSummary);
  $('pl-scan').addEventListener('click', plScan);
  $('pl-write').addEventListener('click', plWrite);

  $('only-changed').addEventListener('click', (e) => { onlyChanged = true; e.target.classList.add('active'); renderReview(); });
  $('sel-all').addEventListener('click', () => { state.proposals.forEach((p) => p.approved = true); $('only-changed').classList.remove('active'); onlyChanged = false; renderReview(); });
  $('sel-none').addEventListener('click', () => { state.proposals.forEach((p) => p.approved = false); renderReview(); });

  // Feishu LQA mode
  $('lq-model').textContent = $('model').value;
  $('mode-starling').addEventListener('click', () => setMode('starling'));
  $('mode-lqa').addEventListener('click', () => setMode('lqa'));
  $('lq-load').addEventListener('click', lqLoad);
  $('lq-file').addEventListener('change', (e) => lqOnFile(e.target));
  $('lq-run').addEventListener('click', lqRun);
  $('lq-valid-mean').addEventListener('change', (e) => { LQ.validYmeansReal = e.target.value === 'real'; if (LQ.sel.length) { lqRenderLegend(); lqRenderCards(); } });
  $('lq-copy-all').addEventListener('click', (e) => lqCopyAll(e.currentTarget));
  $('lq-copy-starling').addEventListener('click', (e) => lqCopyStarling(e.currentTarget));
  document.querySelectorAll('#lq-paste-card [data-col]').forEach((b) => b.addEventListener('click', () => lqCopyCol(b.dataset.col, b)));

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
