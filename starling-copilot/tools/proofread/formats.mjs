// Shared by check.mjs / mk.mjs: reads any "Export task for Claude" file and builds the matching
// "Import Claude results" file. Three export kinds:
//   starling-task-export  → segments[{seg,key,src,tgt,…}]            edits keyed by segment number
//   crowdin-task-export   → strings[{id,key,src,tgt,srcPlural?,…}]    edits keyed by Crowdin string id
//   cat-task-export       → segments[{id,seq,src,tgt,…}] + platform    edits keyed by editor # (seq)
// edits.mjs exports `edits` = [[key, newText, reason], …] using the key named above.

export function loadExport(j) {
  if (j.kind === 'starling-task-export') {
    return { kind: j.kind, platform: 'starling', label: `Starling task ${j.taskId}`,
      rows: j.segments.map((s) => ({ key: String(+s.seg), src: s.src, tgt: s.tgt, raw: s })) };
  }
  if (j.kind === 'crowdin-task-export') {
    return { kind: j.kind, platform: 'crowdin', label: `Crowdin project ${j.projectId} file ${j.fileId}`,
      rows: j.strings.map((s) => ({ key: String(s.id), src: s.src, tgt: s.tgt, plural: !!s.srcPlural, raw: s })) };
  }
  if (j.kind === 'cat-task-export') {
    return { kind: j.kind, platform: j.platform, label: `${j.platform} task`,
      rows: j.segments.map((s) => ({ key: String(s.seq), src: s.src, tgt: s.tgt, raw: s })) };
  }
  throw new Error('Not an "Export task for Claude" file (kind ' + j.kind + ')');
}

// Every tag / placeholder token as a sorted multiset string, so source and target can be compared:
// Starling O-/C- tag tokens, circled markers (memoQ/YiCAT tags), private-use tag characters,
// {x} / {{x}} placeholders, printf (%s, %1$s, %d) and markup tags (<b>, </g1>, <x2/>).
const TOKEN = /[OC]-\d+(?:-\d+)+|[①-⑳㉑-㉟-]|\{\{[^}]*\}\}|\{[^{}]*\}|%(?:\d+\$)?[sdif@]|<\/?[A-Za-z][^>]*>/g;
export const tokens = (s) => (String(s == null ? '' : s).match(TOKEN) || []).sort().join(' ');

export function buildResult(j, ex, edits) {
  const byKey = new Map(ex.rows.map((r) => [r.key, r]));
  const row = (k) => {
    const r = byKey.get(String(k));
    if (!r) throw new Error('no such ' + (ex.kind === 'crowdin-task-export' ? 'string id ' : 'segment ') + k);
    return r;
  };
  const stamp = new Date().toISOString();
  if (ex.kind === 'starling-task-export') {
    return { file: `starling-task-${j.taskId}-claude-result.json`, out: {
      kind: 'starling-claude-result', version: 1, taskId: j.taskId, mode: j.mode || 'proofread', rulebook: j.rulebook, createdAt: stamp,
      edits: edits.map(([k, text, reason]) => { const r = row(k); return { seg: r.raw.seg, src: r.src, old: r.tgt, text, reason }; }) } };
  }
  if (ex.kind === 'crowdin-task-export') {
    return { file: `crowdin-task-${j.projectId}-${j.fileId}-claude-result.json`, out: {
      kind: 'crowdin-claude-result', version: 1, projectId: j.projectId, fileId: j.fileId, mode: j.mode, createdAt: stamp,
      edits: edits.map(([k, text, reason]) => { const r = row(k); return { id: r.raw.id, key: r.raw.key, src: r.src, old: r.tgt, text, reason }; }) } };
  }
  const tag = String((j.ctx && (j.ctx.task || j.ctx.doc)) || 'task').replace(/[^\w-]/g, '').slice(0, 12);
  return { file: `${j.platform}-task-${tag}-claude-result.json`, out: {
    kind: 'cat-claude-result', version: 1, platform: j.platform, ctx: j.ctx, mode: j.mode, createdAt: stamp,
    edits: edits.map(([k, text, reason]) => { const r = row(k); return { id: r.raw.id, seq: r.raw.seq, src: r.src, old: r.tgt, text, reason }; }) } };
}
