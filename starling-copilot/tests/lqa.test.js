// LQA round-trip core (run: `node tests/lqa.test.js`). Synthetic rows only — no client data.
'use strict';
const LQ = require('../lqa-core.js');
const RB = require('../rulebook.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function sec(t) { console.log('\n' + t); }
const row = (o) => Object.assign({ n: 1, key: 'k_title', src: '', before: '', suggested: '', comment: '' }, o);
const ids = (p) => p.flags.map((f) => f.id);

sec('Reading the workbook');
const header = ['Key', 'Source', 'Before translation', 'Suggested translation', 'Error category ', 'Sub category', 'Severity', 'LQA comments', 'Validation feedback (from proofreader)', '2nd LQA comment', 'Source'];
const m = LQ.mapHeader(header);
ok('first "Source" column wins', m.src === 1);
ok('Column I is "Validation feedback (from proofreader)"', m.colI === 8);
const rows = LQ.readRows(header, [['a', 'Save', 'לשמור', 'שמירה', '', 'Style guide', 'Minor', 'gerund for buttons.', 'agree'], ['', '', '', '', '', '', '', '', '']]);
ok('blank records dropped, xlRow = header row + n', rows.length === 1 && rows[0].xlRow === 2 && rows[0].colI === 'agree');

sec('Placeholders, tags and ICU');
ok('plain placeholders counted', LQ.tokenDiff('Hi {s_name}', 'היי').length === 1);
ok('mustache {{x}} kept whole, not split into {x}', LQ.tokens('A ({{ticket.id}})').join() === '{{ticket.id}}');
ok('hard-coded month caught', LQ.tokenDiff('Submitted on {s_month} {s_day}', 'הוגש ב-{s_day} במרץ').some((d) => d.startsWith('{s_month}')));
const icuSrc = '{num, plural, one {{s_num} new follower} other {{s_num} new followers}}';
const icuHe = '{num, plural, one {עוקב/ת חדש/ה {s_num}} two {{s_num} עוקבים} many {{s_num} עוקבים} other {{s_num} עוקבים חדשים}}';
ok('ICU branches parsed', LQ.icuBlocks(icuSrc)[0].keys.join() === 'one,other');
ok('Hebrew may add two/many branches', LQ.tokenDiff(icuSrc, icuHe).length === 0);
ok('a dropped "other" branch is caught', LQ.tokenDiff(icuSrc, '{num, plural, one {{s_num} עוקב}}').some((d) => /other/.test(d)));
ok('a lost ICU block is caught', LQ.tokenDiff(icuSrc, '{s_num} עוקבים').length > 0);
ok('tags must mirror', LQ.tokenDiff('Tap <b>Save</b>', 'הקש/הקישי על "שמירה"').length === 2);

sec('Pre-pass on Suggested');
ok('Suggested equals Before → no-change', ids(LQ.prepass(row({ src: 'Save', before: 'שמירה', suggested: 'שמירה ' }), RB)).includes('no-change'));
ok('only bidi marks differ → bidi-only (not no-change)', ids(LQ.prepass(row({ src: 'TikTok (x)', before: 'TikTok (x)', suggested: 'TikTok‏ (x)' }), RB)).join() === 'bidi-only');
ok('added line break flagged', ids(LQ.prepass(row({ src: 'Copied! Share it.', before: 'הועתק! שתף/י.', suggested: 'הועתק!\r\nשתף/י.' }), RB)).includes('newlines'));
ok('trailing line breaks are not counted (the write step copies them from the source)', !ids(LQ.prepass(row({ src: 'Switch now.\r\n\r\n', before: 'החלף/החליפי.', suggested: 'החלפה עכשיו.' }), null)).includes('newlines'));
ok('fragment suggestion flagged', ids(LQ.prepass(row({ src: 'x', before: 'הוסף/הוסיפי את אמצעי התשלום שלך והשלם/השלימי את טופס המס.', suggested: 'מלא/י את טופס המס' }), null)).includes('partial'));
const intro = LQ.prepass(row({ src: 'Try it', before: 'נסה/נסי', suggested: 'נסה/י' }), RB);
ok('rulebook problem introduced by Suggested is reported', intro.introduced.length > 0 && intro.fixed.length === 0);
const fixd = LQ.prepass(row({ src: 'Try it', before: 'נסה/י', suggested: 'נסה/נסי' }), RB);
ok('rulebook problem fixed by Suggested is reported', fixd.fixed.length > 0 && fixd.introduced.length === 0);

sec('Clustering by reviewer comment');
const cl = LQ.clusters([row({ n: 1, comment: 'please see style guide for loading cell.' }), row({ n: 2, comment: 'Please see style guide for loading cell' }), row({ n: 3, comment: 'translated "recently updated"' })]);
ok('case and trailing punctuation ignored', cl.length === 2 && cl[0].rows.join() === '1,2' && cl[0].id === 'c1');

sec('Judged finals');
const r1 = row({ src: 'Hi {s_name}.', before: 'היי {s_name}', suggested: 'היי {s_name}.' });
ok('agree takes the Suggested text', LQ.normalizeVerdict(r1, { verdict: 'agree', final: 'x', reason: 'ok' }).final === 'היי {s_name}.');
ok('disagree without a final keeps Before', LQ.normalizeVerdict(r1, { verdict: 'disagree', reason: 'no' }).final === 'היי {s_name}');
let threw = false; try { LQ.normalizeVerdict(r1, { verdict: 'maybe' }); } catch (e) { threw = true; }
ok('unknown verdict rejected', threw);
ok('postcheck catches a lost placeholder', LQ.postcheck(r1, 'היי.', RB).some((p) => p.id === 'placeholders'));
ok('postcheck catches curly quotes', LQ.postcheck(row({ src: 'Tap Save', key: 'k_desc' }), 'הקש/הקישי על “שמירה”', null).some((p) => p.id === 'quotes'));
ok('clean final passes', LQ.postcheck(r1, 'היי {s_name}.', RB).length === 0);

sec('Column I wording (decision 1 default)');
ok('agree', LQ.columnI({ verdict: 'agree' }) === 'agree');
ok('agree (modified): <final>', LQ.columnI({ verdict: 'agree-modified', final: 'שמירה' }) === 'agree (modified): שמירה');
ok('Disagree. <reason>', LQ.columnI({ verdict: 'disagree', reason: 'Ruling 7: unlock → לשחרר.' }) === 'Disagree. Ruling 7: unlock → לשחרר.');

sec('Phase 0 — ledger and arming');
const L = LQ.ledgerNew();
LQ.ledgerMarkDone(L, 't1', 's9', '2026-10-06T00:00:00Z');
ok('done segment recorded per task', LQ.ledgerIsDone(L, 't1', 's9') && !LQ.ledgerIsDone(L, 't2', 's9'));
LQ.ledgerMarkSubmitted(L, 't1');
let twice = false; try { LQ.ledgerMarkSubmitted(L, 't1'); } catch (e) { twice = true; }
ok('a task can never be recorded as submitted twice', LQ.ledgerIsSubmitted(L, 't1') && twice);
ok('ledger survives JSON round-trip', LQ.ledgerIsDone(JSON.parse(JSON.stringify(L)), 't1', 's9'));
ok('dry run by default', !LQ.writeAllowed(null, 'sA') && !LQ.writeAllowed({ armed: false, session: 'sA' }, 'sA'));
ok('arming is per session', LQ.writeAllowed({ armed: true, session: 'sA' }, 'sA') && !LQ.writeAllowed({ armed: true, session: 'sA' }, 'sB'));

sec('Phase 2 — locating rows (read-only plan)');
const J = (o) => Object.assign({ n: 1, xlRow: 2, key: 'k1', src: 'Try again.', before: 'נסה/י שוב.', final: 'נסה/נסי שוב.', verdict: 'agree', problems: [] }, o);
const T = (id, segs, extra) => Object.assign({ subtaskId: id, taskName: 'task ' + id, taskStatus: 1, segs }, extra);
const S = (o) => Object.assign({ key: 'k1', source: 'Try again.', target: 'נסה/י שוב.', sourceTextId: 's1', rank: 4, modifiable: true, lock: 0 }, o);
ok('disagree needs no write', LQ.resolveRow(J({ verdict: 'disagree', final: 'נסה/י שוב.' }), []).bucket === 'no-write');
ok('a final that failed the checks is never planned', !LQ.needsWrite(J({ problems: [{ id: 'placeholders' }] })));
ok('no task → not-found', LQ.resolveRow(J(), []).bucket === 'not-found');
ok('exact source + live = Before → ready (with task and segment ids)', (() => { const r = LQ.resolveRow(J(), [T('t1', [S()])]); return r.bucket === 'ready' && r.placements[0].taskId === 't1' && r.placements[0].sourceTextId === 's1'; })());
ok('two open tasks → several (all get fixed)', LQ.resolveRow(J(), [T('t1', [S()]), T('t2', [S({ sourceTextId: 's2' })])]).bucket === 'several');
ok('live already equals the final → already', LQ.resolveRow(J(), [T('t1', [S({ target: 'נסה/נסי שוב.' })])]).bucket === 'already');
ok('live differs from Before and final → drifted', LQ.resolveRow(J(), [T('t1', [S({ target: 'נסו שוב.' })])]).bucket === 'drifted');
ok('submitted task → not-editable', LQ.resolveRow(J(), [T('t1', [S()], { taskStatus: 2 })]).bucket === 'not-editable');
ok('segment not modifiable → not-editable', LQ.resolveRow(J(), [T('t1', [S({ modifiable: false })])]).bucket === 'not-editable');
ok('same key, other source revision → not-found (never matched by key alone)', (() => { const r = LQ.resolveRow(J(), [T('t1', [S({ source: 'Try again later.' })])]); return r.bucket === 'not-found' && /another revision/.test(r.why); })());
ok('the report\'s Before is never used to find rows', LQ.resolveRow(J({ before: 'something else' }), [T('t1', [S()])]).placements.length === 1);
ok('tagged source → hand-edit, not ready', LQ.resolveRow(J({ src: 'Tap <b>Save</b>.' }), [T('t1', [S({ source: 'Tap <b>Save</b>.' })])]).bucket === 'hand-edit');
ok('ICU source → hand-edit', LQ.handEditReason({ src: '{num, plural, one {# day} other {# days}}' }) === 'ICU plural');
ok('trailing newline alone is not a hand-edit', LQ.handEditReason({ src: 'Switch now.\r\n\r\n' }) === '');
const dupe = [J({ n: 1 }), J({ n: 2, final: 'נסה/נסי שוב!' })];
ok('same key+source with different finals → conflict', LQ.conflicts(dupe).size === 1);
ok('lookupKeys dedupes and skips no-write rows', LQ.lookupKeys([J(), J({ n: 2 }), J({ n: 3, key: 'k2', verdict: 'disagree' })]).join() === 'k1');
ok('planByTask groups by task', (() => { const j = J(); const g = LQ.planByTask([{ j, res: LQ.resolveRow(j, [T('t1', [S()]), T('t2', [S()])]) }]); return g.length === 2 && g[0].rows[0].bucket === 'ready'; })());
ok('a segment listed twice in the report shows once, with both report rows', (() => { const j1 = J({ n: 1, xlRow: 10 }), j2 = J({ n: 2, xlRow: 11 }); const t = [T('t1', [S()])]; const g = LQ.planByTask([{ j: j1, res: LQ.resolveRow(j1, t) }, { j: j2, res: LQ.resolveRow(j2, t) }]); return g[0].rows.length === 1 && g[0].rows[0].xlRows.join() === '10,11'; })());
ok('planSig is stable and changes with a final', LQ.planSig([J()]) === LQ.planSig([J()]) && LQ.planSig([J()]) !== LQ.planSig([J({ final: 'x' })]));

sec('Phase 2 is read-only (panel source)');
const PANEL = require('fs').readFileSync(require('path').join(__dirname, '..', 'panel.js'), 'utf8');
const a = PANEL.indexOf('// ==== LQA round-trip (M2, read-only)'), b = PANEL.indexOf('// ==== end LQA round-trip');
const M2 = a >= 0 && b > a ? PANEL.slice(a, b) : '';
ok('the M2 section exists in panel.js', M2.length > 500);
ok('M2 uses the LQC global (panel.js already owns const LQ)', !/\bLQ\./.test(M2) && /\bLQC\./.test(M2));
ok('lqa-core exports LQC in the browser, and panel.js never redeclares it', /root\.LQC = api/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lqa-core.js'), 'utf8')) && !/(const|let|var)\s+LQC\b/.test(PANEL));
ok('M2 reads tasks only through API_TASK (getSourceTextListWithTargetText)', (M2.match(/wbCall\('([A-Z_]+)'/g) || []).every((c) => /API_TASKS?'/.test(c)) && /wbCall\('API_TASK'/.test(M2));
ok('M2\'s only direct request is the getMyTasks list (a GET)', (M2.match(/fetch\('([^'?]+)/g) || []).every((f) => /getMyTasks$/.test(f)) && !/method:\s*'POST'/i.test(M2));
ok('M2 never references a write, confirm or submit path', !/API_CONFIRM|apiWriteConfirm|WB_WRITE|WRITE_SEG|SUBMIT|domSubmit|confirmTextTaskTargetV2|apiConfirm|sendToTab\(/.test(M2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
