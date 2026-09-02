// Wiring / ordering guarantees for panel.js (run: `node tests/pipeline.test.js`).
// BEHAVIOURAL logic (memory variants, confidence, dedupe, terminology, task context,
// placeholders) is tested for real in tests/core.test.js against pipeline-core.js. THIS file
// asserts that panel.js is wired to that logic and that the processing ORDER is correct —
// these are structural assertions over the actual shipped source, not mocks.
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'panel.js'), 'utf8');
const PC = require('../pipeline-core.js');   // sanity: the core loads in Node

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function sec(t) { console.log('\n' + t); }
const idx = (re) => { const m = SRC.match(re); return m ? m.index : -1; };

sec('Prompt guarantees (Tests A/B/C live in the model prompt)');
ok('term hints include the definition field', /if\s*\(t\.def\)\s*h\.definition/.test(SRC));
ok('prompt sends {en,he,pos,definition} shape', /"en","he","pos","definition"/.test(SRC));
ok('applicability rule present (surface match ≠ semantic match)', /surface word-match alone never proves a term applies/i.test(SRC));
ok('Test A — "due to" = because of example', /due to.*because of/i.test(SRC) && SRC.includes('עקב'));
ok('Test B — "verification application" example', /verification application/i.test(SRC));
ok('Test C — Highlight-as-verb example', /Highlight the relevant section/i.test(SRC));
ok('priority hierarchy preamble present', /PRIORITIES, in order/.test(SRC));

sec('Processing ORDER (#4/#12/#13/#14) — asserted over the real chain');
const iTm = idx(/tmApply\(proposals\);\s*\/\/ 1\)/);
const iFix = idx(/fixApply\(proposals\);\s*\/\/ 2\)/);
const iRev = idx(/if \(QA && QA\.enabled\) await reviewPass\(proposals, key, model, taskCtxText/);
const iLock = idx(/lockCheck\(proposals\);\s*\/\/ 4\)/);
const iPh = idx(/phCheck\(proposals\);/);
ok('memory (tmApply) runs before the reviewer (#12)', iTm > 0 && iRev > iTm);
ok('Auto-fix (fixApply) runs before the reviewer (#12)', iFix > iTm && iRev > iFix);
ok('reviewer runs before the deterministic validators (#13)', iLock > iRev && iPh > iRev);
ok('placeholder validation is the LAST stage → inspects final text (#26)', iPh > iLock);
ok('no semantic text-mutating stage after the reviewer (#13)', !/reviewPass[\s\S]{0,4000}?(tmApply|fixApply)\(proposals\)/.test(SRC.slice(iRev)));

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
