// Validate proofread edits against any "Export task for Claude" file (Starling, Crowdin, memoQ, YiCAT):
// tags and placeholders mirror the source exactly, text really changed, no control characters.
// Starling (TikTok) exports also get the rulebook.js findings; pass --rules to force them elsewhere.
//   node tools/proofread/check.mjs <export.json> <edits.mjs> [--rules]      (from starling-copilot/)
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
import { loadExport, tokens } from './formats.mjs';
const [exp, ed, flag] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const RB = require('../../rulebook.js');
const { edits } = await import(pathToFileURL(path.resolve(ed)).href);
const j = JSON.parse(fs.readFileSync(exp, 'utf8'));
const ex = loadExport(j);
const useRules = ex.platform === 'starling' || flag === '--rules';
const byKey = new Map(ex.rows.map((r) => [r.key, r]));
let bad = 0;
for (const [k, t] of edits) {
  const r = byKey.get(String(k));
  if (!r) { bad++; console.log('NO SUCH ROW', k); continue; }
  if (tokens(r.src) !== tokens(t)) { bad++; console.log('TAGS/PLACEHOLDERS DIFFER', k, '| source:', tokens(r.src) || '-', '| new:', tokens(t) || '-'); }
  if (t === r.tgt) { bad++; console.log('NO CHANGE', k); }
  if (/[\u0000-\u0008]/.test(t)) { bad++; console.log('CTRL CHAR', k); }
  if (r.plural) console.log('PLURAL', k, '- Crowdin Enter writes plain text only; check this string by hand');
  if (useRules) { const f = RB.checkSegment(r.src, t, { key: (r.raw && r.raw.key) || '' }); if (f.length) console.log('RB', k, JSON.stringify(f)); }
}
console.log(`${ex.label}: ${edits.length} edits, ${bad} hard problems${useRules ? '' : ' (TikTok rulebook not applied: not a Starling export)'}`);
