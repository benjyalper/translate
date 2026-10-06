// Validate proofread edits against a Starling export: tags preserved, text actually changed,
// no control characters, and rulebook findings on the new text.
//   node tools/proofread/check.mjs <export.json> <edits.mjs>      (from starling-copilot/)
// edits.mjs exports `edits` = [[seg, newText, reason], ...]
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
const [exp, ed] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const RB = require('../../rulebook.js');
const { edits } = await import(pathToFileURL(path.resolve(ed)).href);
const j = JSON.parse(fs.readFileSync(exp, 'utf8'));
const tags = (s) => (s.match(/[OC]-\d+-\d+/g) || []).sort().join(',');
let bad = 0;
for (const [n, t] of edits) {
  const s = j.segments.find((x) => +x.seg === n);
  if (!s) { bad++; console.log('NO SUCH SEG', n); continue; }
  if (tags(s.src) !== tags(t)) { bad++; console.log('TAG MISMATCH', n, tags(s.src), '|', tags(t)); }
  if (t === s.tgt) { bad++; console.log('NO CHANGE', n); }
  if (/[\u0000-\u0008]/.test(t)) { bad++; console.log('CTRL CHAR', n); }
  const f = RB.checkSegment(s.src, t, { key: s.key }); if (f.length) console.log('RB', n, JSON.stringify(f));
}
console.log(edits.length, 'edits,', bad, 'hard problems');
