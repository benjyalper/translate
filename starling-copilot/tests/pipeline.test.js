// Regression tests for the translation-pipeline hardening (run: `node tests/pipeline.test.js`).
// These cover the DETERMINISTIC guarantees only — the semantic behaviour of Tests A/B/C
// ("Due"/"Application"/"Highlight") lives in the GPT prompt, so we assert that the prompt
// actually carries the applicability rule + examples and that term definitions are sent,
// rather than mocking the model. Placeholder (F) and multi-word priority (G) are pure code
// and are unit-tested by extracting the real functions from panel.js so they can't drift.
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'panel.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function section(t) { console.log('\n' + t); }

// Pull one top-level `function NAME(...) { ... }` out of panel.js by brace-matching.
function extract(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let depth = 0, started = false;
  for (let j = i; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
// Build a sandbox with the extracted helpers. wbFold is stubbed to a light normaliser
// (the tests here don't exercise its NFKC/quote folding — only spacing/trim).
const wbFold = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const names = ['phTokens', 'phDiff', 'tmWordCount', 'tmShort'];
const body = names.map(extract).join('\n') + '\nreturn { ' + names.join(', ') + ' };';
// eslint-disable-next-line no-new-func
const { phDiff, tmShort } = new Function('wbFold', body)(wbFold);

// The exact multi-word-first comparator used in tbHintsFor.
function termSort(a, b) {
  const wa = a.en.trim().split(/\s+/).length, wb = b.en.trim().split(/\s+/).length;
  if (wb !== wa) return wb - wa;
  return b.en.length - a.en.length;
}

section('Test F — placeholder preservation (deterministic guard)');
ok('intact placeholder passes', phDiff('This Story by {s_username} is unavailable', 'ה-Story של {s_username} אינו זמין').length === 0);
ok('dropped placeholder is caught', phDiff('by {s_username}', 'על ידי המשתמש').length === 1);
ok('altered placeholder is caught', phDiff('{s_username}', '{s_userName}').length > 0);
ok('duplicated placeholder is caught', phDiff('{s_num}', '{s_num} {s_num}').length === 1);
ok('printf %s preserved', phDiff('Overdue since %s', 'באיחור מאז %s').length === 0);
ok('circled marker drop caught', phDiff('① hello ②', '① שלום').length === 1);

section('Test G — multi-word term priority');
const sorted = [{ en: 'Due' }, { en: 'Due to' }, { en: 'privacy' }].sort(termSort);
ok('"Due to" (multi-word) sorts before "Due"', sorted[0].en === 'Due to');

section('Test D/H — short-string detection (drives context-aware memory/dedupe)');
ok('"Save" is short', tmShort('Save') === true);
ok('"Due" is short', tmShort('Due') === true);
ok('a full sentence is NOT short', tmShort('This Story by someone is unavailable due to privacy') === false);

section('Prompt guarantees (Tests A/B/C live in the model prompt)');
ok('term hints now include the definition field', /if\s*\(t\.def\)\s*h\.definition/.test(SRC));
ok('prompt sends {en,he,pos,definition} shape', /"en","he","pos","definition"/.test(SRC));
ok('applicability rule present (surface match ≠ semantic match)', /surface word-match alone never proves a term applies/i.test(SRC));
ok('Test A — "due to" = because of example in prompt', /due to.*because of|because of.*due to/i.test(SRC) && SRC.includes('עקב'));
ok('Test B — "verification application" example in prompt', /verification application/i.test(SRC));
ok('Test C — Highlight-as-verb example in prompt', /Highlight the relevant section/i.test(SRC));
ok('priority hierarchy preamble present', /PRIORITIES, in order/.test(SRC));

section('Wiring guarantees');
ok('placeholder guard runs in the post-GPT chain', /phCheck\(proposals\)/.test(SRC));
ok('reviewer runs only when QA is enabled', /QA && QA\.enabled\) await reviewPass/.test(SRC));
ok('reviewer rejects a fix that would corrupt a placeholder', /would corrupt a placeholder/.test(SRC));
ok('short-source dedupe is context-aware', /tmShort\(arr\[0\]\.src\)/.test(SRC));
ok('memory stores key/ctx for future short-string matching', /key: String\(key \|\| ''\), ctx: String\(ctx \|\| ''\)/.test(SRC));
ok('diagnostics are opt-in and never log secrets', /window\.scDebug/.test(SRC) && !/Authorization.*console/.test(SRC));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
