// Behavioral tests for pipeline-core.js — these exercise ACTUAL logic (memory variants,
// context confidence, dedupe grouping, terminology applicability, task context, placeholders),
// not just the presence of strings in panel.js. Run: `node tests/core.test.js`.
'use strict';
const PC = require('../pipeline-core.js');
const fold = PC.idFold;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function eq(name, a, b) { ok(name + '  (' + JSON.stringify(a) + ' == ' + JSON.stringify(b) + ')', JSON.stringify(a) === JSON.stringify(b)); }
function sec(t) { console.log('\n' + t); }

// ---------------------------------------------------------------------------
sec('Contextual memory — two variants of "Save" coexist (#1–#7)');
const map = {};
const K = fold('Save');
PC.memPut(map, K, 'Save', 'שמירה', { key: 'settings_save_button', context: 'Button label' }, fold);
PC.memPut(map, K, 'Save', 'שמור/שמרי', { key: 'settings_save_instruction', context: 'Instruction shown to the user' }, fold);
eq('both variants stored (not overwritten)', PC.memVariants(map[K]).length, 2);
ok('adding the 2nd did not overwrite the 1st', PC.memVariants(map[K]).some((v) => v.tgt === 'שמירה') && PC.memVariants(map[K]).some((v) => v.tgt === 'שמור/שמרי'));

const btnSeg = { src: 'Save', key: 'settings_save_button', context: 'Button label' };
const insSeg = { src: 'Save', key: 'settings_save_instruction', context: 'Instruction shown to the user' };
ok('button lookup retrieves שמירה', PC.memBest(map[K], btnSeg, fold).variant.tgt === 'שמירה');
ok('instruction lookup retrieves שמור/שמרי', PC.memBest(map[K], insSeg, fold).variant.tgt === 'שמור/שמרי');
ok('button match is HIGH confidence', PC.memBest(map[K], btnSeg, fold).confidence.name === 'HIGH');
ok('button context → auto-apply', PC.memDecision(map[K], btnSeg, fold).action === 'apply');

sec('Role-aware variant selection when confidence ties');
// Different note → not HIGH for either, but the button-role segment must still prefer the button variant.
ok('button-role seg (mismatched note) still selects the button variant', PC.memBest(map[K], { src: 'Save', key: 'other_button', context: 'Btn' }, fold).variant.tgt === 'שמירה');
ok('instruction-role seg still selects the instruction variant', PC.memBest(map[K], { src: 'Save', key: 'other_instruction', context: 'go' }, fold).variant.tgt === 'שמור/שמרי');

sec('Export/import preserves contextual variants (#7)');
const roundtrip = JSON.parse(JSON.stringify({ map })).map[K];   // simulate export→import of the store
eq('both variants survive a JSON round-trip', PC.memVariants(roundtrip).length, 2);
ok('targets intact after round-trip', PC.memVariants(roundtrip).map((v) => v.tgt).sort().join('|') === ['שמור/שמרי', 'שמירה'].sort().join('|'));

sec('Legacy context-free entry → suggestion-only for short strings (#1)');
const legacy = { 'save': { src: 'Save', tgt: 'שמירה', ts: 1, n: 1 } };   // old single-entry shape, no ctx
ok('legacy entry still reads', PC.memVariants(legacy['save']).length === 1);
const legDec = PC.memDecision(legacy['save'], { src: 'Save', key: 'x_button', context: 'Btn' }, fold);
ok('legacy short-string hit is suggestion-only, not auto-apply', legDec.action === 'suggest');
ok('legacy variant confidence capped ≤ LOW', PC.memBest(legacy['save'], { src: 'Save', key: 'x_button', context: 'Btn' }, fold).confidence.level <= PC.CONF.LOW);

sec('Long unambiguous sentence still matches strongly on source (#2)');
const longMap = {}; const LK = fold('This account was permanently disabled for policy violations.');
PC.memPut(longMap, LK, 'This account was permanently disabled for policy violations.', 'החשבון הושבת לצמיתות עקב הפרות מדיניות.', { key: '', context: '', ctxKnown: false }, fold);
const longDec = PC.memDecision(longMap[LK], { src: 'This account was permanently disabled for policy violations.', key: '', context: '' }, fold);
ok('long identical source → apply even with no context', longDec.action === 'apply');

sec('Context confidence tiers (#2)');
eq('same button key/context → HIGH', PC.ctxConfidence(btnSeg, { key: 'settings_save_button', context: 'Button label' }, fold).name, 'HIGH');
eq('button vs instruction role → LOW (role conflict)', PC.ctxConfidence(btnSeg, insSeg, fold).name, 'LOW');
eq('both empty → UNKNOWN (not compatible)', PC.ctxConfidence({ key: '', context: '' }, { key: '', context: '' }, fold).name, 'UNKNOWN');
eq('namespace-only shared → LOW (not enough)', PC.ctxConfidence({ key: 'a.b.foo' }, { key: 'a.b.bar' }, fold).name, 'LOW');

// ---------------------------------------------------------------------------
sec('Same-source deduplication (#3)');
const dd1 = PC.planDedupe([
  { i: 1, src: 'Save', key: 'a_button', context: 'btn' },
  { i: 2, src: 'Save', key: 'b_instruction', context: 'do it' }
], fold);
ok('#8 two short strings with different UI roles are NOT aligned', dd1.length === 0);
const dd2 = PC.planDedupe([{ i: 1, src: 'Save', key: '', context: '' }, { i: 2, src: 'Save', key: '', context: '' }], fold);
ok('#9 two short strings with no context are NOT auto-aligned', dd2.length === 0);
const dd3 = PC.planDedupe([
  { i: 1, src: 'Save', key: 'settings_save_button', context: 'Button label' },
  { i: 2, src: 'Save', key: 'settings_save_button', context: 'Button label' }
], fold);
ok('#10 short strings with same compatible context ARE aligned', dd3.length === 1 && dd3[0].length === 2);
const dd4 = PC.planDedupe([
  { i: 1, src: 'This item is unavailable right now, please try again.', key: 'x' },
  { i: 2, src: 'This item is unavailable right now, please try again.', key: 'y' }
], fold);
ok('#11 identical long sentences remain aligned', dd4.length === 1 && dd4[0].length === 2);

// ---------------------------------------------------------------------------
sec('Terminology applicability & overlap (#7/#8)');
const dueTerm = { en: 'Due', he: 'לתשלום', pos: 'adjective', definition: 'owed or expected to be paid' };
const dueToTerm = { en: 'Due to', he: 'עקב' };
const clsA = PC.classifyTerms('Unavailable due to privacy settings', [dueToTerm, dueTerm], null);
ok('#22 longer "Due to" outranks single "Due" (Due marked overlapped)', clsA.find((c) => c.term.en === 'Due').status === 'OVERLAPPED_BY_MORE_SPECIFIC_TERM');
ok('prompt term list drops the overlapped single word', PC.filterTermsForPrompt(clsA).every((t) => t.en !== 'Due'));
// With only the single "Due" term present, the collocation signal downgrades applicability.
eq('#21 "Due→לתשלום" is NOT a definite deviation in "due to …"', PC.tbApplicability('Unavailable due to privacy settings', dueTerm, false), 'uncertain');
eq('a real missing term IS a definite warn', PC.tbApplicability('Payment is Due', dueTerm, false), 'warn');
eq('#24 tbApplicability never returns a Hebrew replacement (only a label)', typeof PC.tbApplicability('Payment is Due', dueTerm, false), 'string');
// multiple senses stay candidates, not destructive
const clsB = PC.classifyTerms('Highlight the relevant section', [{ en: 'Highlight', he: 'נקודת שיא', pos: 'noun' }], { highlight: 2 });
ok('#23 multi-sense term is a CANDIDATE (not a substitution)', clsB[0].status === 'CANDIDATE');
ok('segRisk flags SHORT_AMBIGUOUS_SOURCE for "Save"', PC.segRisk('Save', [], { fold }).indexOf('SHORT_AMBIGUOUS_SOURCE') >= 0);
ok('segRisk flags CONTEXT_MISSING when no key/context', PC.segRisk('Save', [], { fold, hasKey: false, hasContext: false }).indexOf('CONTEXT_MISSING') >= 0);

// ---------------------------------------------------------------------------
sec('Task-wide context (#6)');
const segs = [
  { src: 'Strengthen your verification application', key: 'v_title' },
  { src: 'Submit your appeal', key: 'a_button' },
  { src: 'Payment method', key: 'p_title' },
  { src: 'Payment method', key: 'p2_title' }
];
const tc = PC.buildTaskContext(segs, {
  fold,
  lockTerms: [{ en: 'verification', he: 'אימות' }, { en: 'Bitcoin', he: 'ביטקוין' }],   // Bitcoin not in task
  tbTerms: [{ en: 'appeal', he: 'ערעור' }, { en: 'payment method', he: 'אמצעי תשלום' }, { en: 'nonsense-term', he: 'x' }],
  memMap: {}
});
ok('#18 task context text is produced', tc.text.length > 0);
ok('#19 irrelevant locked term (Bitcoin) excluded', tc.text.indexOf('Bitcoin') < 0);
ok('#19 irrelevant tb term excluded', tc.text.indexOf('nonsense-term') < 0);
ok('relevant terms included', tc.text.indexOf('verification') >= 0 && tc.text.indexOf('אמצעי תשלום') >= 0);
ok('#20 whole termbase not dumped (only occurring terms)', tc.terms.every((t) => segs.some((s) => PC.termSpans(s.src, t.en).length)));
ok('repeated multi-word expression detected as feature', tc.features.indexOf('payment method') >= 0);
const tcCap = PC.buildTaskContext(segs, { fold, tbTerms: Array.from({ length: 200 }, (_, i) => ({ en: 'appeal', he: 'ערעור' + i })), caps: { terms: 5 } });
ok('term cap respected', tcCap.terms.length <= 5);

// ---------------------------------------------------------------------------
sec('Placeholders (#12/F)');
ok('intact placeholder passes', PC.phDiff('by {s_username}', 'על ידי {s_username}').length === 0);
ok('dropped placeholder caught', PC.phDiff('by {s_username}', 'על ידי המשתמש').length === 1);
ok('altered placeholder caught', PC.phDiff('{s_username}', '{s_userName}').length > 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
