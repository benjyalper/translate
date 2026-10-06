# Proofreading helpers (Claude-side of "Export task for Claude")

Used when a Claude session proofreads a whole task from any tab's **⬇ Export task for Claude** file (Starling, 🌐 Crowdin, memoQ, 🐱 YiCAT) and hands back a file for that tab's **📥 Import Claude results**. Run from `starling-copilot/`.

| Script | What it does |
|---|---|
| `check.mjs <export.json> <edits.mjs> [--rules]` | Validates the edits: every tag and placeholder mirrors the source (Starling `O-1-0`/`C-1-0`, memoQ/YiCAT ①②, `{x}`, `%s`, `<g1>`…), the text really changed, no control characters; flags Crowdin plural strings. Starling exports also get the TikTok `rulebook.js` findings (`--rules` forces them elsewhere). |
| `mk.mjs <export.json> <edits.mjs>` | Writes the import file to `~/Downloads` (or `$OUT_DIR`): `starling-claude-result`, `crowdin-claude-result` or `cat-claude-result`, matching the export. |
| `log-record.cjs <result.json> <segmentsTotal> "<title>" "<note>"…` | Saves the task's record for the proofreading log (`$PROOFREAD_LOG_DIR/tasks/`); works for all four platforms. |
| `build-proofread-log.cjs` | Rebuilds the Word log `Starling proofreading.docx` from all records (needs the `docx` npm package). |
| `formats.mjs` | Shared reader/writer for the three export kinds. |

`edits.mjs` exports the edits list, keyed by what you see in that platform's editor:

```js
export const edits = [
  [63, 'מעבר להיסטוריית ההזמנות … בתוכן שבחרת.', 'Final period mirrors the source (ruling 17).'],
  // Starling: segment number · Crowdin: string id · memoQ / YiCAT: the editor's segment # (seq)
];
```

Defaults: log records in `G:/My Drive/תכנות/adar1/tranlation-code/proofreading-log/`, Word file next to that folder. Override with `PROOFREAD_LOG_DIR` / `PROOFREAD_LOG_OUT`.

Proofreading rules (Benjy): no additions beyond the source; don't unify two correct forms without counting them (or asking); drop any segment he fixed by hand from pending imports; use term-base hints by sense. The TikTok rulings apply to Starling only — other platforms have their own client rules (see the local handoff).
