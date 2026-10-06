# Proofreading helpers (Claude-side of "Export task for Claude")

Used when a Claude session proofreads a whole Starling task from the extension's **⬇ Export task for Claude** file and hands back a file for **📥 Import Claude results**. Run from `starling-copilot/`.

| Script | What it does |
|---|---|
| `check.mjs <export.json> <edits.mjs>` | Validates the edits: Starling tags (`O-1-0`/`C-1-0`) preserved exactly, text really changed, no control characters; prints `rulebook.js` findings on each new text. |
| `mk.mjs <export.json> <edits.mjs>` | Writes `starling-task-<id>-claude-result.json` (kind `starling-claude-result`) to `~/Downloads`, or `$OUT_DIR`. |
| `log-record.cjs <result.json> <segmentsTotal> "<title>" "<note>"…` | Saves the task's record for the proofreading log (`$PROOFREAD_LOG_DIR/tasks/`). |
| `build-proofread-log.cjs` | Rebuilds the Word log `Starling proofreading.docx` from all records (needs the `docx` npm package). |

`edits.mjs` exports the edits list:

```js
export const edits = [
  [63, 'מעבר להיסטוריית ההזמנות … בתוכן שבחרת.', 'Final period mirrors the source (ruling 17).'],
  // [segment number, new full target text with tag tokens kept, reason]
];
```

Defaults: log records in `G:/My Drive/תכנות/adar1/tranlation-code/proofreading-log/`, Word file next to that folder. Override with `PROOFREAD_LOG_DIR` / `PROOFREAD_LOG_OUT`.

Proofreading rules (Benjy): no additions beyond the source; don't unify two correct forms without counting them (or asking); drop any segment he fixed by hand from pending imports; use term-base hints by sense. Full workflow and rulings: `tranlation-code/STARLING-COPILOT-HANDOFF.md`.
