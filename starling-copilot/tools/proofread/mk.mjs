// Build the import file ("📥 Import Claude results") from an export + edits list.
//   node tools/proofread/mk.mjs <export.json> <edits.mjs>   → ~/Downloads/starling-task-<id>-claude-result.json (or $OUT_DIR)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [exp, ed] = process.argv.slice(2);
const { edits } = await import(pathToFileURL(path.resolve(ed)).href);
const j = JSON.parse(fs.readFileSync(exp, 'utf8'));
const out = { kind: 'starling-claude-result', version: 1, taskId: j.taskId, mode: j.mode || 'proofread', rulebook: j.rulebook, createdAt: new Date().toISOString(),
  edits: edits.map(([n, text, reason]) => { const s = j.segments.find((x) => +x.seg === n); return { seg: s.seg, src: s.src, old: s.tgt, text, reason }; }) };
const f = path.join(process.env.OUT_DIR || path.join(os.homedir(), 'Downloads'), `starling-task-${j.taskId}-claude-result.json`);
fs.writeFileSync(f, JSON.stringify(out, null, 1));
console.log('wrote', f, '·', out.edits.length, 'edits ·', out.edits.filter((e) => /[OC]-\d+-\d+/.test(e.src)).length, 'tagged');
