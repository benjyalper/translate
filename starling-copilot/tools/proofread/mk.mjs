// Build the "📥 Import Claude results" file from any export (Starling, Crowdin, memoQ, YiCAT) + an edits list.
//   node tools/proofread/mk.mjs <export.json> <edits.mjs>   → ~/Downloads/<platform>-task-…-claude-result.json (or $OUT_DIR)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
import { loadExport, buildResult } from './formats.mjs';
const [exp, ed] = process.argv.slice(2);
const { edits } = await import(pathToFileURL(path.resolve(ed)).href);
const j = JSON.parse(fs.readFileSync(exp, 'utf8'));
const ex = loadExport(j);
const { file, out } = buildResult(j, ex, edits);
const f = path.join(process.env.OUT_DIR || path.join(os.homedir(), 'Downloads'), file);
fs.writeFileSync(f, JSON.stringify(out, null, 1));
console.log('wrote', f, '·', out.edits.length, 'edits');
