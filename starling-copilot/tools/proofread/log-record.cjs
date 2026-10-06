// Write a proofreading-log record from any result file (Starling, Crowdin, memoQ, YiCAT),
// then run build-proofread-log.cjs.
//   node tools/proofread/log-record.cjs <result.json> <segmentsTotal> "<title>" "<note 1>" "<note 2>" ...
const fs = require('fs');
const path = require('path');
const LOG_DIR = process.env.PROOFREAD_LOG_DIR || 'G:/My Drive/תכנות/adar1/tranlation-code/proofreading-log';
const [res, total, title, ...notes] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(res, 'utf8'));
const date = new Date().toISOString().slice(0, 10);
const kind = r.kind || 'starling-claude-result';
const platform = kind === 'crowdin-claude-result' ? 'Crowdin' : kind === 'cat-claude-result' ? (r.platform === 'memoq' ? 'memoQ' : 'YiCAT') : 'Starling';
const taskId = r.taskId || (kind === 'crowdin-claude-result' ? `${r.projectId}-${r.fileId}` : String((r.ctx && (r.ctx.task || r.ctx.doc)) || 'task'));
const rec = { platform, taskId, date, title, mode: 'Proofread', segmentsTotal: +total, rulebook: r.rulebook || '(TikTok rulebook not applied)',
  notes, edits: r.edits.map((e) => ({ seg: e.seg != null ? e.seg : (e.seq != null ? e.seq : e.id), src: e.src, old: e.old, text: e.text, reason: e.reason })) };
const f = path.join(LOG_DIR, 'tasks', `${date}_${platform.toLowerCase()}_${String(taskId).replace(/[^\w-]/g, '')}.json`);
fs.writeFileSync(f, JSON.stringify(rec, null, 1));
console.log('record', f, '·', rec.edits.length, 'edits');
