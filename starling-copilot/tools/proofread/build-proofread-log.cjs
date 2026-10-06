// Builds the running proofreading log: "Starling proofreading.docx".
//
//   node tools/proofread/build-proofread-log.cjs
//
// Needs the `docx` npm package: resolved normally, else from the eval harness's node_modules
// (C:/Users/Benjy/Desktop/adar1/starling-eval).
//
// One section per task, oldest first, from the records in LOG_DIR/tasks/*.json:
//   { platform, taskId, date:'YYYY-MM-DD', title, mode, segmentsTotal, rulebook, notes:[..],
//     edits:[{ seg, src, old, text, reason }] }
// To add a task: drop its record into tasks/ and run this again. The Word file is regenerated from the
// records, so a hand edit made directly in the .docx is lost on the next build — put it in the record.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType,
  AlignmentType, HeadingLevel, PageOrientation, BorderStyle, Footer, PageNumber, LevelFormat, PageBreak
} = (() => { try { return require('docx'); } catch (e) { return require('C:/Users/Benjy/Desktop/adar1/starling-eval/node_modules/docx'); } })();

const LOG_DIR = process.env.PROOFREAD_LOG_DIR || 'G:/My Drive/תכנות/adar1/tranlation-code/proofreading-log';
const OUT = process.env.PROOFREAD_LOG_OUT || path.join(LOG_DIR, '..', 'Starling proofreading.docx');

const FONT = 'Arial';
const ACCENT = '0F6F7A', RED = 'B42318', BLUE = '1F5FBF', GREY = '5A6875', LINE = 'D0D7DE';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

// Starling tag tokens → circled numbers (①…①), as the editor shows them; O-/C- codes scramble inside RTL text.
const tagify = (x) => String(x == null ? '' : x).replace(/[OC]-(\d+)(?:-\d+)+/g, (m, n) => String.fromCharCode(0x2460 + (+n - 1)));
const TAGGED = /[\u2460-\u2473]/;

// Word-level diff (LCS) → [{t, op:'eq'|'del'|'ins'}]
function toks(s) { return String(s).match(/\s+|[^\s]+/g) || []; }
function diff(a, b) {
  const A = toks(a), B = toks(b), n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: A[i], op: 'eq' }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ t: A[i], op: 'del' }); i++; }
    else { out.push({ t: B[j], op: 'ins' }); j++; }
  }
  while (i < n) out.push({ t: A[i++], op: 'del' });
  while (j < m) out.push({ t: B[j++], op: 'ins' });
  return out;
}

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 18, bold: o.bold, color: o.color, strike: o.strike, rightToLeft: o.rtl });
// Before: removed words red + struck through. After: new words blue + bold.
function heRuns(old, now, side) {
  return diff(old, now).filter((x) => x.op === 'eq' || (side === 'before' ? x.op === 'del' : x.op === 'ins'))
    .map((x) => x.op === 'eq' ? run(x.t, { rtl: true }) : run(x.t, { rtl: true, bold: side === 'after', strike: side === 'before', color: side === 'before' ? RED : BLUE }));
}
const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const borders = { top: border, bottom: border, left: border, right: border };
const cell = (children, width, o = {}) => new TableCell({
  width: { size: width, type: WidthType.DXA }, borders,
  shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
  margins: { top: 60, bottom: 60, left: 90, right: 90 },
  children: Array.isArray(children) ? children : [children]
});
const p = (runs, o = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [runs], bidirectional: !!o.rtl, alignment: o.rtl ? AlignmentType.RIGHT : (o.align || AlignmentType.LEFT), spacing: { after: o.after == null ? 0 : o.after } });

function taskSection(rec, first) {
  const edits = rec.edits.map((e) => ({ ...e, src: tagify(e.src), old: tagify(e.old), text: tagify(e.text) }));
  const taggedN = edits.filter((e) => TAGGED.test(e.src)).length;
  const facts = [
    ['Record date', longDate(rec.date)],
    ['Task ID', `${rec.taskId} (${rec.platform})`],
    ['Task', rec.title],
    ['Mode', rec.mode],
    ['Segments changed', `${edits.length} of ${rec.segmentsTotal}` + (taggedN ? ` (${edits.length - taggedN} written automatically, ${taggedN} pasted by hand because of tags)` : '')],
    ['Rulebook', rec.rulebook],
    ['Proofreading', rec.by || 'Claude proposed the changes; Benjy reviewed them and made the hand fixes listed below']
  ];
  const W1 = 3000, W2 = 11838;
  const factsTable = new Table({
    width: { size: W1 + W2, type: WidthType.DXA }, columnWidths: [W1, W2],
    rows: facts.map(([k, v]) => new TableRow({ children: [
      cell(p(run(k, { bold: true, size: 20, color: GREY })), W1, { fill: 'EEF3F5' }),
      cell(p(run(String(v), { size: 20 })), W2)
    ] }))
  });
  const CW = [520, 2900, 3700, 3700, 4018];   // sums to the 14,838 DXA text width (A4 landscape)
  const head = ['#', 'Source (EN)', 'Before', 'After', 'Why'];
  const rows = [new TableRow({ tableHeader: true, children: head.map((h, i) => cell(p(run(h, { bold: true, color: 'FFFFFF', size: 18 }), { align: i === 2 || i === 3 ? AlignmentType.RIGHT : AlignmentType.LEFT }), CW[i], { fill: ACCENT })) })];
  for (const e of edits) {
    const tagged = TAGGED.test(e.src);
    rows.push(new TableRow({ cantSplit: true, children: [
      cell(p(run(String(e.seg), { bold: true })), CW[0]),
      cell([p(run(e.src)), ...(tagged ? [p(run('pasted by hand (tags)', { size: 15, color: GREY }))] : [])], CW[1]),
      cell(p(heRuns(e.old, e.text, 'before'), { rtl: true }), CW[2]),
      cell(p(heRuns(e.old, e.text, 'after'), { rtl: true }), CW[3]),
      cell(p(run(tagify(e.reason))), CW[4])
    ] }));
  }
  const changes = new Table({ width: { size: CW.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: CW, rows });
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: !first, spacing: { after: 120 }, children: [new TextRun({ text: `Task ${rec.taskId} · ${longDate(rec.date)}`, font: FONT, size: 30, bold: true })] }),
    factsTable,
    ...((rec.notes || []).length ? [
      new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 100 }, children: [new TextRun({ text: 'Decisions and hand fixes', font: FONT, size: 24, bold: true })] }),
      ...rec.notes.map((t) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60 }, children: [run(tagify(t), { size: 20 })] }))
    ] : []),
    new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 60 }, children: [new TextRun({ text: `Changes (${edits.length} segments)`, font: FONT, size: 24, bold: true })] }),
    new Paragraph({ spacing: { after: 120 }, children: [run('In Before, removed words are red and struck through. In After, new words are blue and bold. ①…① mark Starling\'s formatting tags, as in the editor.', { size: 17, color: GREY })] }),
    changes
  ];
}

const recs = fs.readdirSync(path.join(LOG_DIR, 'tasks')).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'tasks', f), 'utf8')))
  .sort((a, b) => (a.date + a.taskId).localeCompare(b.date + b.taskId));
if (!recs.length) { console.error('No task records in ' + path.join(LOG_DIR, 'tasks')); process.exit(1); }
const totalEdits = recs.reduce((n, r) => n + r.edits.length, 0);

const doc = new Document({
  creator: 'Benjy Alper', title: 'Starling proofreading',
  styles: { default: { document: { run: { font: FONT, size: 20 } } } },
  numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }] }] },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }, margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run('Starling proofreading · page ', { size: 16, color: GREY }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: GREY })] })] }) },
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 80 }, children: [new TextRun({ text: 'Starling proofreading', font: FONT, size: 44, bold: true, color: ACCENT })] }),
      new Paragraph({ spacing: { after: 240 }, children: [run(`A running record of proofreading changes, one section per task: what changed in each segment and why. ${recs.length} task${recs.length === 1 ? '' : 's'}, ${totalEdits} segments changed. Last updated ${longDate(recs[recs.length - 1].date)}.`, { size: 20, color: GREY })] }),
      ...recs.flatMap((r, i) => taskSection(r, i === 0))
    ]
  }]
});
Packer.toBuffer(doc).then((b) => { fs.writeFileSync(OUT, b); console.log(`wrote ${OUT} · ${recs.length} task(s) · ${totalEdits} segments`); });
