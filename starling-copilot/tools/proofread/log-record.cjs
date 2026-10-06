// Write a proofreading-log record from a result file, then run build-proofread-log.cjs.
//   node tools/proofread/log-record.cjs <result.json> <segmentsTotal> "<title>" "<note 1>" "<note 2>" ...
const fs = require('fs');
const path = require('path');
const LOG_DIR = process.env.PROOFREAD_LOG_DIR || 'G:/My Drive/תכנות/adar1/tranlation-code/proofreading-log';
const [res, total, title, ...notes] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(res, 'utf8'));
const date = new Date().toISOString().slice(0, 10);
const rec = { platform: 'Starling', taskId: r.taskId, date, title, mode: 'Proofread', segmentsTotal: +total, rulebook: r.rulebook,
  notes, edits: r.edits.map((e) => ({ seg: e.seg, src: e.src, old: e.old, text: e.text, reason: e.reason })) };
const f = path.join(LOG_DIR, 'tasks', `${date}_starling_${r.taskId}.json`);
fs.writeFileSync(f, JSON.stringify(rec, null, 1));
console.log('record', f, '·', rec.edits.length, 'edits');
