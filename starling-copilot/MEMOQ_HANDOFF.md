# memoQ mode — handoff / resume notes

**Status: first draft written, NOT yet tested in the loaded extension.** Everything below
was validated live against the memoQ web editor by inspecting its DOM/network, but the
packaged extension code (`memoq.js` + panel wiring) has **not been run yet**. Next step is
to load the unpacked extension and test Detect → Harvest → Propose → Write on a memoQ doc.

Date: 2026-07-27. Target server used for discovery: `memoq.terratranslations.com`.

---

## What this feature is
Add a 5th mode, **🅜 memoQ**, to Starling Copilot mirroring the Starling/Crowdin workflow:
**harvest → GPT-5.4 → write back**, for memoQ's newer web editor (memoQweb, React + ProseMirror).
Writes go in as **unconfirmed drafts**; the human confirms each segment (never auto-confirm/deliver).

## Why the API approach (not DOM)
memoQ's grid is **virtualized** (~5–13 of N segments in the DOM at once) and only advances on
**real** mouse/keyboard scroll — an extension can't fake that. But memoQ has an internal REST
API the editor itself uses, so we call that same-origin (session cookie rides along).

## The API (validated by capturing the editor's own traffic)
Base: `/memoqweb/editor/api/editor/projects/{projectId}/docs/{docId}`

- **Harvest:** `POST {base}/rows` body `{"rowIds":[0,1,…,N-1],"scope":"entireRow"}`
  → array of rows: `{ id, meta:{status,matchRate,isLocked,isReadonly}, source:{symbols}, target:{symbols} }`.
  - `id` is **0-based**; the editor's displayed segment number = `id + 1`.
  - `status` values include `manuallyConfirmed`, `partiallyEdited`, reviewer-confirm variants (match `/confirm/i` to detect "confirmed").
- **Write:** `PUT {base}/rows/{id}` body `{"side":"target","symbols":[…],"trackChanges":[]}`
  → writes the target as a **draft** (status becomes `partiallyEdited`). Does NOT confirm.
- **Auth:** session cookie (same-origin) **+ header `X-CSRF-TOKEN`** whose value is the
  `X-CSRF-TOKEN` cookie (memoQ echoes cookie→header). Also send `X-Requested-With: XMLHttpRequest`.
- **Symbols:** `{type:1, value:<unicode code point>}` = one text char. Any other `type` = an
  inline tag / structural marker — we **round-trip it opaquely** (keep the raw object, re-emit on write).
  In the panel, tags show as circled markers ①②③… (the GPT prompt already preserves those).
- Total segment count read from the DOM attribute `[aria-rowcount]`.
- Row count in this test doc: 57. Segment numbering: `aria-rowindex` (on the row's ancestor) = 1-based absolute number; `data-row-id` is a RELATIVE window index (don't use it as a key).

## ⚠️ Hard-won gotchas (don't repeat these)
- **Do NOT wrap `window.WebSocket` or make ad-hoc `fetch` calls to `/rows` from an injected
  console context** — during discovery that broke memoQ's save channel ("Saving row #N failed").
  A page reload fixed it. The real content script replicates the editor's exact request and is fine.
- **DOM-write fallback (if ever needed):** focus the target `.ProseMirror`, `document.execCommand('insertText', …)`;
  insert tags via memoQ **F9** ("Copy next tag sequence"); undo ONLY with real **Ctrl+Z**
  (`execCommand('undo')` desyncs ProseMirror and corrupts the cell). But the API path above is preferred.
- **Ctrl+Enter (confirm) is blocked** by the Claude Code auto-mode classifier as an irreversible
  control — the human must confirm segments themselves. (Consistent with the "never confirm" rule anyway.)

## Files added / changed (in `starling-copilot/`)
- **`memoq.js`** (NEW): content script for `memoq.terratranslations.com/memoqweb/*`. Does the API I/O.
  Message protocol: `MQ_PING` (ctx + row count + csrf presence), `MQ_HARVEST` (all segments),
  `MQ_WRITE` (`{edits:[{rowId,text,tags}]}`). Also exposes `window.__mq`.
  Contains the symbol⇄string codecs and the tag round-trip (`encodeTarget` refuses to write if GPT
  dropped/duplicated a tag — safety).
- **`manifest.json`**: added host permission `https://memoq.terratranslations.com/*` and a content_scripts
  entry injecting `memoq.js` on `…/memoqweb/*`.
- **`panel.html`**: added `🅜 memoQ` mode button + `#view-memoq` (Detect / Harvest / Propose / Review-Write, mirroring Crowdin).
- **`panel.js`**: added `sendMQ()` (messages the memoQ tab), `memoq` entry in `setMode`, the `MQ` module
  (`mqDetect / mqHarvest / mqPropose / mqWrite / mqWriteAll / mqRender`), init() wiring, and `mq-model` label updates.
  Reuses the existing `gptBatch` / `sysPrompt` / `polish` (same house style as Starling/Crowdin).

## How to test (resume here)
1. Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → select the
   `starling-copilot` folder. (If updating, hit ↻ reload so `background.js`/manifest changes take.)
2. Open a memoQ doc in the editor (must be logged in), open the side panel → **🅜 memoQ** tab.
3. **Detect** → should show "Connected · N segments". If it warns about no X-CSRF-TOKEN cookie, writes may fail.
4. **Harvest** → review the cards (source, current Hebrew, ⚑ tags flag). Skip-confirmed/skip-locked toggles.
5. **Propose** (needs OpenAI key in Settings) → GPT fills proposals.
6. On ONE segment first, click **⤵ Write** → confirm in memoQ that the Hebrew appears as an unconfirmed
   draft and tags are intact. Then try **Write all approved**.

## Things to verify / likely follow-ups
- **CSRF header name/value**: confirmed the cookie is `X-CSRF-TOKEN`; the code sends a header of the
  same name. If writes 400/403, capture the editor's own PUT request headers and match exactly.
- **Tagged-segment write**: round-tripping opaque tag symbols should be accepted, but test a tagged
  segment (e.g. one with ①②) end-to-end. If GPT reorders/drops a marker, the write is refused with a note.
- **`translate` mode with empty target + source tags**: uses `srcTags`; verify markers line up.
- **Other memoQ servers**: matches are hard-coded to `memoq.terratranslations.com`. To support other
  memoQ cloud domains, broaden the manifest `matches`/`host_permissions` and `sendMQ()` regex.
- **Symbol edge cases**: whitespace/segment-structure symbols, surrogate pairs (codecs use code points, should be fine).

## Git / repo layout note
The working tree has a **top-level `starling-copilot/`** (where this was developed) AND a copy at
**`translate/starling-copilot/`** which is the one inside the git repo `github.com/benjyalper/translate`.
Keep them in sync — the memoQ work must be committed under `translate/starling-copilot/`.
Other local project context lives in Claude memory at `~/.claude/projects/.../memory/memoq-integration.md`
(local only — this file is the portable version).
