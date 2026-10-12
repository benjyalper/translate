// Wiring / ordering guarantees for panel.js (run: `node tests/pipeline.test.js`).
// BEHAVIOURAL logic (memory variants, confidence, dedupe, terminology, task context,
// placeholders) is tested for real in tests/core.test.js against pipeline-core.js. THIS file
// asserts that panel.js is wired to that logic and that the processing ORDER is correct —
// these are structural assertions over the actual shipped source, not mocks.
'use strict';
const fs = require('fs');
const path = require('path');
const PANEL = fs.readFileSync(path.join(__dirname, '..', 'panel.js'), 'utf8');
const RULEBOOK = fs.readFileSync(path.join(__dirname, '..', 'rulebook.js'), 'utf8');
const SRC = PANEL + '\n' + RULEBOOK;   // the prompt text moved to rulebook.js (2026-09-28); wiring asserts check both
const PC = require('../pipeline-core.js');   // sanity: the core loads in Node

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function sec(t) { console.log('\n' + t); }
const idx = (re) => { const m = SRC.match(re); return m ? m.index : -1; };

sec('Term matching sees through Starling tag tokens');
{
  const grab = (re) => PANEL.match(re)[0];
  const has = new Function(grab(/const TAG_TOK_G = [^\n]+\n/) + grab(/function lockEsc[\s\S]*?\n}\n/) + grab(/function lockSrcHas[\s\S]*?\n}\n/) + ';return lockSrcHas;')();
  ok('a term wrapped in tag tokens is found (O-1-0Family PairingC-1-0)', has('Daily screen time is also available in O-1-0Family PairingC-1-0.', 'Family Pairing'));
  ok('a term glued to a closing token is found (TapO-1-0 ProfileC-1-0)', has('1. TapO-1-0 ProfileC-1-0 at the bottom.', 'Profile'));
  ok('word boundaries still hold (Profiles is not Profile)', !has('Profiles here', 'Profile'));
}

sec('Tag tokens end at their last digit (a number right after a tag is text)');
{
  const grab = (re) => PANEL.match(re)[0];
  const edit = new Function('const sameRender = (a, b) => a === b; const sameText = sameRender;' + grab(/const TAG_SPLIT = [^\n]+\n/) + grab(/function taggedPartsEdit[\s\S]*?\n}\n/) + ';return taggedPartsEdit;')();
  const runs = new Function(grab(/function stripTags[\s\S]*?\n}\n/) + grab(/function splitTagRuns[\s\S]*?\n}\n/) + ';return splitTagRuns;')();
  // Task 530532593922 #14: "O-1-040%" was read as token O-1-040 + "%", so ✍ skipped the row.
  const old = "באפשרותך לאסוף עד O-1-040% מפרסי השידור החי שלך, C-1-0אשר יוצגו תחת 'פרסים זמינים'.";
  const next = 'באפשרותך לאסוף עד O-1-040% מפרסי השידור החי שלך, C-1-0אשר יוצגו תחת "פרסים זמינים".';
  const e = edit({ manual: true, seg: '14', old, next });
  ok('✍ writes a row whose tag is followed by a number (O-1-040%)', !!e && e.parts === 1 && e.oldPieces[1] === '40% מפרסי השידור החי שלך, ');
  ok('the tag itself is O-1-0, not O-1-040', (old.match(/[OC]-\d+-\d/g) || []).join('|') === 'O-1-0|C-1-0');
  ok('splitTagRuns keeps the number in the run', JSON.stringify(runs('עד O-1-013%* נוספיםC-1-0')) === JSON.stringify([{ id: null, text: 'עד' }, { id: '1', text: '13%* נוספים' }]));
  ok('two-digit tag ids still work (O-12-0)', (edit({ manual: true, seg: 'x', old: 'aO-12-0bC-12-0', next: 'aO-12-0cC-12-0' }) || {}).parts === 1);
  const files = ['panel.js', 'content.js', 'rulebook.js', 'tools/proofread/formats.mjs', 'tools/proofread/build-proofread-log.cjs'];
  ok('no greedy tag-token pattern ((?:-\\d+)+) left in the sources', files.every((f) => !/\[OC\]-[^/\n]*\(\?:-\\d\+\)\+/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))));
  const csv = (fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8').match(/const CS_VERSION = (\d+)/) || [])[1];
  ok('panel CS_EXPECT matches content.js CS_VERSION', !!csv && PANEL.includes('const CS_EXPECT = ' + csv + ';'));
}

sec('🏷 Tag check and Write tags (rows whose tags must be added or moved)');
{
  const grab = (re) => PANEL.match(re)[0];
  const lib = new Function('const sameRender = (a, b) => a === b; const sameText = sameRender;' + grab(/const TAG_SPLIT = [^\n]+\n/) + grab(/function taggedPartsEdit[\s\S]*?\n}\n/) +
    grab(/const TAG_TYPED = [^\n]+\n/) + grab(/function tagList[^\n]+\n/) + grab(/function tagCheck[\s\S]*?\n}\n/) + grab(/function tagFixEdit[\s\S]*?\n}\n/) +
    ';return { tagCheck, tagFixEdit };')();
  const src = 'Check out O-1-0Configure LIVE settings in LIVE StudioC-1-0';
  ok('a target that mirrors the source tags passes', lib.tagCheck(src, 'עיין/י במאמר O-1-0קביעת התצורה של הגדרות ב-LIVE StudioC-1-0') === null);
  const typed = lib.tagCheck(src, 'עיין/י במאמר <6|קביעת התצורה של הגדרות ב-LIVE Studio.|6>');
  ok('task 515492506370 #31: tags typed as text, none real', !!typed && typed.typed && typed.missing.length === 2 && /0 of 2 tags/.test(typed.note) && /typed as text/.test(typed.note));
  ok('an extra tag the source lacks is reported', (lib.tagCheck('aO-1-0bC-1-0', 'aO-1-0bC-1-0O-2-0cC-2-0') || {}).extra.join(' ') === 'O-2-0 C-2-0');
  ok('a closing tag before its opening tag is reported', (lib.tagCheck('O-1-0aC-1-0', 'C-1-0aO-1-0') || {}).broken.join(' ') === 'C-1-0');
  ok('tag pairs in a different order are fine (Hebrew word order)', lib.tagCheck('O-1-0aC-1-0 O-2-0bC-2-0', 'O-2-0בC-2-0 O-1-0אC-1-0') === null);
  ok('untagged rows are not checked', lib.tagCheck('plain', 'פשוט') === null);
  const p5 = { manual: true, seg: '5', src: 'introduce O-1-0Scaled LIVE rewards C-1-0—O-2-0 C-2-0an opportunity', old: 'להציג "פרסי שידור חי מותאמים" — הזדמנות', next: 'להציג O-1-0פרסי שידור חי מותאמים C-1-0—O-2-0 C-2-0הזדמנות' };
  const e5 = lib.tagFixEdit(p5);
  ok('task 530532593922 #5 (tags lost) qualifies for 🏷', !!e5 && e5.oldText === p5.old && e5.newText === p5.next);
  ok('a same-layout row is left to ✍ Write tagged parts', lib.tagFixEdit({ manual: true, seg: '14', src: 'aO-1-0bC-1-0', old: "אO-1-0בC-1-0 'x'", next: 'אO-1-0בC-1-0 "x"' }) === null);
  ok('new text that does not mirror the source tags is refused', lib.tagFixEdit({ manual: true, seg: '1', src: 'aO-1-0bC-1-0', old: 'אב', next: 'אO-1-0ב' }) === null);
  ok('a row already rebuilt is not offered again', lib.tagFixEdit(Object.assign({}, p5, { tagsDone: true })) === null);
  const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  ok('content.js answers WRITE_TAGS', /case 'WRITE_TAGS': sendResponse\(await writeTags\(/.test(CONTENT));
  ok('the writer registers the caret before clicking a source tag', /function caretToEnd[\s\S]*?selectionchange[\s\S]*?'mouseup', 'keyup', 'click'/.test(CONTENT));
  // Live 12 Oct: without a pause Starling still used the select-all from the clear, and the tag replaced the cell.
  ok('…and waits for Starling to pick the caret up before the click', /async function caretToEnd[\s\S]*?'mouseup', 'keyup', 'click'[^\n]*\n\s*await sleep\(\d+\);/.test(CONTENT) && /if \(!\(await caretToEnd\(ed\)\)\)/.test(CONTENT));
  ok('the writer restores the original cell on failure', /if \(restorable\) \{ await fillCell\(seg, cur\)/.test(CONTENT));
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'panel.html'), 'utf8');
  ok('panel has the 🏷 Write tags button and the tag-check line', /id="write-tags"/.test(HTML) && /id="wtg-info"/.test(HTML) && /id="tag-info"/.test(HTML));
  ok('harvest runs the tag check', /runCoverage\(\);[^\n]*\n\s*renderTagCheck\(\);/.test(PANEL));
}

sec('Invisible-mark-only edits are written (task 538298015746 #47: RLM after "STEM")');
{
  const grab = (re) => PANEL.match(re)[0];
  const sameRender = new Function(grab(/function renderNorm[\s\S]*?\n}\n/) + grab(/function sameRender[^\n]+\n/) + ';return sameRender;')();
  const lib = new Function('const sameRender = arguments[0];' + grab(/const TAG_SPLIT = [^\n]+\n/) + grab(/const sameText = [^\n]+\n/) + grab(/function taggedPartsEdit[\s\S]*?\n}\n/) +
    grab(/const TAG_TYPED = [^\n]+\n/) + grab(/function tagList[^\n]+\n/) + grab(/function tagCheck[\s\S]*?\n}\n/) + grab(/function tagFixEdit[\s\S]*?\n}\n/) +
    ';return { taggedPartsEdit, tagFixEdit };')(sameRender);
  const old = 'קבע/י אם בן/בת הנוער שלך יוכל/תוכל לצפות בO-1-0פיד STEM (מדעים, טכנולוגיה, הנדסה ומתמטיקה)C-1-0.';
  const next = 'קבע/י אם בן/בת הנוער שלך יוכל/תוכל לצפות בO-1-0פיד STEM‏ (מדעים, טכנולוגיה, הנדסה ומתמטיקה)C-1-0.';
  ok('the two texts render the same (why it slipped through)', sameRender(old, next));
  const e = lib.taggedPartsEdit({ manual: true, seg: '47', old, next });
  ok('✍ now offers the RLM-only row', !!e && e.parts === 1 && e.newPieces[1].includes('‏'));
  ok('…and an unchanged row is still skipped', lib.taggedPartsEdit({ manual: true, seg: '1', old, next: old }) === null);
  const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const pk = new Function(CONTENT.match(/  const pieceKey = [^\n]+\n/)[0] + CONTENT.match(/  const pieceExact = [^\n]+\n/)[0] + ';return { pieceKey, pieceExact };')();
  ok('content.js pieceExact keeps the RLM (so the write happens and is verified)', pk.pieceExact('STEM‏ (') !== pk.pieceExact('STEM ('));
  ok('…while pieceKey (the since-harvest check) still ignores it', pk.pieceKey('STEM‏ (') === pk.pieceKey('STEM ('));
}

sec('🏷 Place tags (the model only places tags; wording must not change)');
(async () => {
  const grab = (re) => PANEL.match(re)[0];
  const body = grab(/const TAG_SPLIT = [^\n]+\n/) + grab(/function taggedPartsEdit[\s\S]*?\n}\n/) + grab(/const TAG_TYPED = [^\n]+\n/) + grab(/function tagList[^\n]+\n/) +
    grab(/function tagCheck[\s\S]*?\n}\n/) + grab(/function tagFixEdit[\s\S]*?\n}\n/) + grab(/const TAG_TYPED_G = [^\n]+\n/) + grab(/function tagTextOnly[^\n]+\n/) +
    grab(/function tagPlaceOk[^\n]+\n/) + grab(/const TAG_PLACE_SYS =[\s\S]*?;\n/) + grab(/async function tagPlaceLLM[\s\S]*?\n}\n/) + grab(/async function doPlaceTags[\s\S]*?\n}\n/);
  const env = { infos: [], sent: null, confirmMsg: '' };
  const make = new Function('env', 'state', 'const sameRender = (a, b) => a === b; const sameText = sameRender; let revFilter = "changed";' +
    'const $ = (id) => (env.els[id] = env.els[id] || { hidden: true, disabled: false, value: id === "model" ? "claude-opus-5" : "" });' +
    'const info = (id, msg, cls) => env.infos.push([id, msg, cls]); const log = () => {}; const renderReview = () => { env.rendered = revFilter; };' +
    'const store = { get: async (k, d) => d }; const llmCost = () => 0.004; const isPromptCtx = () => false; const confirm = (m) => { env.confirmMsg = m; return true; };' +
    'const llmFetch = async (o) => { env.sent = JSON.parse(o.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ out: env.reply }) } }] }) }; };' +
    body + ';return { tagPlaceOk, tagTextOnly, doPlaceTags, tagFixEdit };');
  env.els = {};
  const t31 = 'למידע נוסף, עיין/י במאמר <6|קביעת התצורה של הגדרות ב-LIVE Studio.|6>';
  const s31 = 'For more information, check out O-1-0Configure LIVE settings in LIVE StudioC-1-0';
  const lib = make(env, {});
  ok('typed markers may go and tags may be added — words unchanged', lib.tagPlaceOk(s31, t31, 'למידע נוסף, עיין/י במאמר O-1-0קביעת התצורה של הגדרות ב-LIVE Studio.C-1-0'));
  ok('a reply that changes a word is rejected', !lib.tagPlaceOk(s31, t31, 'למידע נוסף, עיין/י במאמר O-1-0קביעת התצורה של ההגדרות ב-LIVE StudioC-1-0'));
  ok('a reply whose tags still do not mirror the source is rejected', !lib.tagPlaceOk(s31, t31, 'למידע נוסף, עיין/י במאמר O-1-0קביעת התצורה של הגדרות ב-LIVE Studio.'));
  const state = {
    proposals: [{ seg: '9', manual: true }],   // #9 already has a card (e.g. from an import) → not sent
    segments: [
      { seg: '31', src: s31, tgt: t31, key: '' },
      { seg: '9', src: 'aO-1-0bC-1-0', tgt: 'אב', key: '' },
      { seg: '12', src: 'Tap O-1-0SaveC-1-0.', tgt: 'הקש/הקישי על שמירה.', key: '' },
      { seg: '20', src: 'Go to O-1-0SettingsC-1-0.', tgt: 'עבור/עברי אל הגדרות.', key: '' }
    ],
    tagIssues: [{ seg: '31' }, { seg: '9' }, { seg: '12' }, { seg: '20' }]
  };
  const lib2 = make(env, state);
  env.reply = [
    { i: 0, text: 'למידע נוסף, עיין/י במאמר O-1-0קביעת התצורה של הגדרות ב-LIVE Studio.C-1-0' },
    { i: 1, text: 'הקש/הקישי על O-1-0"שמירה"C-1-0.' },                  // added quotes → rejected
    { i: 2, text: 'עבור/עברי אל O-1-0הגדרות.' }                         // closing tag missing → rejected
  ];
  await lib2.doPlaceTags();
  ok('rows that already have a card are not sent to the model', env.sent && JSON.parse(env.sent.messages[1].content.replace(/^[^{]*/, '')).items.map((x) => x.i).join(',') === '0,1,2');
  ok('the prompt forbids changing the wording', /Change NOTHING else/.test(env.sent.messages[0].content) && env.sent.temperature === 0);
  ok('the cost is shown before the call', /Estimated cost: about \$0\.004/.test(env.confirmMsg));
  const placed = state.proposals.filter((p) => p.tagPlaced);
  ok('only the faithful reply becomes a review card (#31)', placed.length === 1 && placed[0].seg === '31' && placed[0].manual && placed[0].old === t31);
  ok('…and 🏷 Write tags will take it', !!lib2.tagFixEdit(placed[0]));
  ok('the rejected rows are named', env.infos.some(([id, m]) => id === 'tag-info' && /2 rejected \(#12, #20\)/.test(m)));
  ok('the review opens on the ✋ view', env.rendered === 'manual');
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'panel.html'), 'utf8');
  ok('panel has the 🏷 Place tags button (hidden until rows are flagged)', /<button id="place-tags"[^>]*hidden/.test(HTML) && /\$\('place-tags'\)\.hidden = /.test(PANEL));
})().then(() => {

sec('Prompt guarantees (Tests A/B/C live in the model prompt)');
ok('term hints include the definition field', /if\s*\(t\.def\)\s*h\.definition/.test(SRC));
ok('prompt sends {en,he,pos,definition} shape', /"en","he","pos","definition"/.test(SRC));
ok('applicability rule present (surface match ≠ semantic match)', /surface word-match alone never proves a term applies/i.test(SRC));
ok('Test A — "due to" = because of example', /due to.*because of/i.test(SRC) && SRC.includes('עקב'));
ok('Test B — "verification application" example', /verification application/i.test(SRC));
ok('Test C — Highlight-as-verb example', /Highlight the relevant section/i.test(SRC));
ok('priority hierarchy preamble present', /PRIORITIES, in order/.test(SRC));

sec('Rulebook wiring (2026-09-28)');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'panel.html'), 'utf8');
ok('panel.html loads rulebook.js before panel.js', HTML.indexOf('rulebook.js') > 0 && HTML.indexOf('rulebook.js') < HTML.indexOf('src="panel.js"'));
ok('sysPrompt delegates to RB.systemPrompt', /function sysPrompt\(mode, plural, tiktok, srcs\)[\s\S]{0,80}RB\.systemPrompt/.test(PANEL));
ok('STYLE_GUIDE is the rulebook text', /const STYLE_GUIDE = RB\.STYLE;/.test(PANEL));
ok('brain glossary is relevance-filtered, rules opt-in', /BRAIN\.injectRules/.test(PANEL) && /lockSrcHas\(h, g\.en\)/.test(PANEL));
ok('lock checks use active (quarantined) terms', (PANEL.match(/RB\.activeLockTerms/g) || []).length >= 2);
ok('Auto-fix skips quarantined rules', /if \(!RB\.fixRuleActive\(r\)\) continue;/.test(PANEL));
ok('Auto-fix seed: נסו → נסה/נסי (ruling 1)', PANEL.includes("{ from: 'נסו', to: 'נסה/נסי' }") && !PANEL.includes("{ from: 'נסו', to: 'נסה/י' }"));
ok('Auto-fix seed version bumped to 4', /const SEED_VERSION = 4;/.test(PANEL));
ok('rbCheck runs after tbCheck', idx(/rbCheck\(proposals\);/) > idx(/tbCheck\(proposals\);   \/\/     … term-base/));
ok('Feishu LQA prompt: currency mirrors source', /POSITION \(ruling 2\)/.test(PANEL) && !/goes AFTER the number for every foreign currency/.test(PANEL));

sec('Processing ORDER (#4/#12/#13/#14) — asserted over the real chain');
const iTm = idx(/tmApply\(proposals\);\s*\/\/ 1\)/);
const iFix = idx(/fixApply\(proposals\);\s*\/\/ 2\)/);
const iRev = idx(/QA && QA\.enabled\).*await reviewPass\(proposals, key, model, taskCtxText/);
const iLock = idx(/lockCheck\(proposals\);\s*\/\/ 4\)/);
const iPh = idx(/phCheck\(proposals\);/);
ok('memory (tmApply) runs before the reviewer (#12)', iTm > 0 && iRev > iTm);
ok('Auto-fix (fixApply) runs before the reviewer (#12)', iFix > iTm && iRev > iFix);
ok('reviewer runs before the deterministic validators (#13)', iLock > iRev && iPh > iRev);
ok('placeholder validation is the LAST stage → inspects final text (#26)', iPh > iLock);
// No SEMANTIC (memory) stage runs after the reviewer. The only post-reviewer text change is the
// DETERMINISTIC Auto-fix re-pass (mechanical dictionary), which the spec permits after QA.
ok('no memory/dedupe (semantic) stage after the reviewer (#13)', !/reviewPass[\s\S]{0,4000}?tmApply\(proposals\)/.test(SRC.slice(iRev)));
ok('post-reviewer fixApply is deterministic-only (same curated dictionary)', /await reviewPass\([^;]*\); fixApply\(proposals\);/.test(SRC));

sec('Memory: multi-variant schema + call sites (#1/#6)');
ok('memory writes go through PC.memPut (multi-variant)', /return PC\.memPut\(TM\.map/.test(SRC));
ok('individual Write records key/context (#6)', /tmRecordOne\(p\.src, p\.next, p\.key, p\.context\)\) await tmSave/.test(SRC));
ok('bulk write records key/context', /tmRecordOne\(p\.src, p\.next, p\.key, p\.context\)\) n\+\+/.test(SRC));
ok('import is variant-aware', /PC\.memVariants\(e\)/.test(SRC) && /Imported \$\{n\} variant/.test(SRC));
ok('memory lookup uses contextual confidence (PC.memDecision)', /PC\.memDecision\(entry/.test(SRC));
ok('dedupe uses PC.planDedupe (context-aware)', /PC\.planDedupe\(elig\.map/.test(SRC));

sec('Screenshots reused by translator AND reviewer (#5/#15/#16/#17)');
ok('per-run screenshot cache exists', /const shotCache = new Map\(\)/.test(SRC));
ok('translator fetch passes the cache', /fetchShotsFor\(slice, at && at\.id, shotCache\)/.test(SRC));
ok('reviewer REUSES p.shotImg (no refetch) (#5)', /images\.push\(\{ i: j \+ 1, dataUrl: p\.shotImg \}\)/.test(SRC));
ok('reviewer receives fullSource', /it\.fullSource = String\(p\.fullSrc\)/.test(SRC));
ok('#17 base64 not persisted — memPut/tmRecordOne never touch shotImg', !/memPut[\s\S]{0,400}shotImg/.test(SRC) && !/tmRecordOne[\s\S]{0,200}shotImg/.test(SRC));
ok('#17 fetch failure logs no URL', /dbg\('shot fetch failed'\)/.test(SRC) && !/dbg\('shot fetch failed', /.test(SRC));
ok('#17 diagnostics log only image indices, never dataUrl', /dbg\('shots attached', images\.map\(\(x\) => x\.i\)\)/.test(SRC));

sec('Task-wide context (#6) reaches every batch + reviewer + diagnostics');
ok('task context built via PC.buildTaskContext', /PC\.buildTaskContext\(allSegs/.test(SRC));
ok('every translation batch gets taskCtxText as extraSys', /gptBatch\(items, gm, key, model, plural, taskCtxText \|\| null/.test(SRC));
ok('reviewer gets the same task context', /reviewPass\(proposals, key, model, taskCtxText \|\| null\)/.test(SRC));
ok('task context logged in diagnostics', /dbg\('task-context'/.test(SRC));

sec('Terminology applicability + risk (#7/#8)');
ok('terms classified before the prompt (PC.classifyTerms)', /PC\.classifyTerms\(String\(s\.src/.test(SRC));
ok('overlapped single words dropped from the prompt (PC.filterTermsForPrompt)', /PC\.filterTermsForPrompt\(classified\)/.test(SRC));
ok('per-segment semantic risk computed (PC.segRisk)', /PC\.segRisk\(String\(s\.src/.test(SRC));
ok('tbCheck uses applicability to soften false warnings (#8)', /PC\.tbApplicability\(p\.src, t, hasHe\)/.test(SRC));
ok('tbCheck still non-mutating (no EN→HE replacement)', !/p\.next\s*=\s*[^;]*t\.he/.test(SRC));

sec('Diagnostics never log secrets (#9)');
ok('scDebug is the opt-in switch', /window\.scDebug/.test(SRC));
ok('no Authorization header is ever passed to console', !/console\.[a-z]+\([^)]*Authorization/i.test(SRC));

sec('Core sanity (PC loads and is wired into panel.html)');
ok('pipeline-core exports the expected API', ['memPut', 'memDecision', 'planDedupe', 'ctxConfidence', 'classifyTerms', 'buildTaskContext', 'phDiff'].every((k) => typeof PC[k] === 'function'));
ok('panel.html loads pipeline-core before panel.js', (() => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'panel.html'), 'utf8');
  return html.indexOf('pipeline-core.js') >= 0 && html.indexOf('pipeline-core.js') < html.indexOf('panel.js');
})());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
}).catch((e) => { console.log('  ✗ test crashed: ' + (e && e.stack || e)); process.exit(1); });
