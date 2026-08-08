# 🐦 Starling Copilot (he-IL)

A Chrome extension (Manifest V3) with a **side panel** that automates the mechanical parts of
English→Hebrew (he-IL) localization work across **several platforms**, switchable at the top of the
panel:

| Mode | What it does |
|---|---|
| **🐦 Starling** | Harvest a Starling (ByteDance CAT) task → proofread/translate with GPT-5.4 → review → write back cell-by-cell. |
| **⚖️ Feishu LQA** | Adjudicate a Feishu/Lark "AI-check" LQA sheet: paste rows, pick ranges, GPT-5.4 marks each AI-flagged error valid/invalid + corrected Hebrew. |
| **↩ Sheet → Starling** | Take the adjudicated sheet and apply each valid fix **into Starling by Key** — one key at a time, or a read-only batch pass. |
| **🌐 Crowdin** | Harvest a Crowdin Enterprise file via the official **API v2** → GPT-5.4 cards → enter translations (unapproved) for you to submit. |
| **🅜 memoQ** | Harvest a memoQ web-editor doc via memoQ's own editor API → GPT-5.4 cards → write back as unconfirmed drafts. |
| **🐱 YiCAT** | Harvest a YiCAT (self-hosted Tmxmall) task via its segment API → GPT-5.4 cards → **copy** each proposal, or opt-in **auto-write** through YiCAT's own in-cell editor (verified). |
| **💰 Word count** | Sum the **weighted word count** across your Starling *My tasks* and price it (× your editing rate), with a per-status breakdown and the number of tasks summed. |

Two cross-cutting aids apply across the CAT modes: a **🧠 Style Brain** (house-style rules +
glossary you can grow) and a **🧩 Consistency memory** (a source→target TM that overrides GPT
post-hoc). Both are documented below.

Everything runs in **your** logged-in browser with **your** OpenAI key. No server. **The tool never
submits/approves** on any platform — it stops at the point where a human decision is required.

---

## Install (unpacked)

1. Go to `chrome://extensions` → toggle **Developer mode** (top-right).
2. **Load unpacked** → select this `starling-copilot` folder.
3. Pin the 🐦 icon; click it to open the side panel.
4. Panel → **⚙️ Settings** → paste your **OpenAI API key** (stored only in this browser, in
   `chrome.storage.local`). For Crowdin, also paste a **Crowdin API token** (see that section).

> **Reloading after an update:** the **side panel** (`panel.html/js`) reloads when you close and
> reopen it. The **content script** (`content.js`) self-heals on the next page load or Ctrl+R. But
> the **background service worker** (`background.js`) only reloads when you reload the **extension**
> at `chrome://extensions` (↻). If a Crowdin call says *"background worker not reachable,"* reload
> the extension.

### Version lockstep
`content.js` carries a `CS_VERSION`; `panel.js` a matching `CS_EXPECT`. They are **bumped together
on every content.js change** (currently **35**). The panel checks the page's live `window.__wb.ver`
and re-injects `content.js` if a tab is stale, so tabs self-heal without a manual reload.

---

## 🐦 Starling mode — harvest → proofread → write

1. Open a Starling task (String or Document editor) in a tab.
2. Load segments — **either** **⬇ Harvest from this tab** (drives the virtualized list) **or**
   **📄 Load exported XLIFF** (more reliable for big tasks — exact tags, no scroll-scraping;
   write-back still uses the live tab, matched by segment number).
3. Pick **Proofread** or **Translate** → **Run gpt-5.4** (plural gender-neutral house style; every
   `{placeholder}` / `%s` / `<tag>` / `①` preserved).
4. **Review**: edit any target inline, untick anything you don't want.
5. **Write approved to Starling** → results logged; failures show a reason.
6. Optionally **Confirm all (ignore normal QA)** → post-confirm summary.
7. **📋 Read QA warnings** groups issues Critical → Punctuation → Spacing → other *(beta)*.

### Chips vs. string placeholders + empty-target fill (v22)
"Tagged" used to lump together two different things and force **both** to copy-by-hand: real
inline-tag **objects** (chips) and **string placeholders** like `{0}`, `%s`, `<g id="1">…</g>` that
are just literal text. Typing over a chip clobbers the object, but a string placeholder is plain
text that GPT preserves byte-for-byte — safe to auto-write. Harvest now emits a separate **`chip`**
flag (`!!tagEl`, a real DOM tag element) and copy-by-hand keys off `chip`, not `tagged`:
- **Chips** → unchanged: Copy buttons, "✋ paste by hand", ⚠ chip badge.
- **String placeholders** → normal auto-writable rows (editable + apply checkbox), with a ⚠
  placeholder badge so you can eyeball the token survived.
- **Per-row "✍ Write"** button on every auto-writable row writes that one segment into Starling
  in a single click (respects any inline edit; no confirm).

Also: in **proofread** mode, segments with an **empty target** (non-empty source) are now
**translated** from the source and written in with the proofread ones (toggle "Translate empty
targets", default on). Filled rows get a "＋ new" badge and auto-approve. Empty sources that carry a
real chip still route to copy-by-hand.

**v22.1 — numbered wrapping tags (O-/C- tokens) + Copy & Write on every card.** The first cut only
knew about DOM chips and the `{x}/%s/<g>` placeholder text; it wrongly classified segments carrying
Starling's **numbered wrapping tags** — `O-<id>`/`C-<id>` tokens (rendered ①②③) like
`O-1-0…C-1-0O-2-0…` — as safe "placeholder" and auto-wrote them, which types the literal tokens and
**destroys the real tag chips**. Fix (panel-side, no content-script change):
- `hasTags()` detects `O-/C-` tokens (and ①②③); such segments are now **copy-by-hand** (`tagWrapped`),
  badged **⚠ tag**, excluded from auto-write/auto-approve.
- `splitTagRuns()` splits the target into the **text runs between the tags** and renders a **Copy
  button per run** (badge = the enclosing tag's id), so you paste each run between its ①…①.
- **Every card now has a whole-segment Copy button AND a ✍ Write button** (previously copy-only or
  write-only). The Write button works on tagged cards too but **confirms first** (it would replace
  the chips — the per-part copies are the safe path).

### Markdown **bold** preservation (v22.2)
Source strings sometimes carry markdown emphasis — `Powered by **PIPO MY SDN BHD** and supervised
by **Bank Negara Malaysia**` — and the model/TM drops the `**` in the target. `fixBold(src,out)` (in
the `polish()` chain) restores any `**X**` whose inner text appears unwrapped in the target (X is
usually a Latin brand kept verbatim, so it's matched literally); already-wrapped spans and
translated-away terms are left alone. A **⚠ bold** review badge flags any source `**…**` still
missing in the target. The GPT prompt also now has an explicit "keep every **bold**/*italic* marker,
same count, same term" rule.

### Edge-whitespace preservation (v20 · v21)
A source string that ends in a trailing **space** (Starling's blue `·`) or **newline** (blue `↵`)
must carry the same edge whitespace in the target, or Starling flags a Punctuation/Space QA error.
GPT drops these. At **write time** `mirrorRowEdges` reads the source row's **raw** text (no
normalization, so newlines survive) and mirrors its exact leading/trailing whitespace onto what's
typed — applied in **both** the Starling write and the Sheet→Starling hybrid write. Safe by
construction: no source edge → text unchanged.

**v21 — the proposal itself now carries the edges (fixes copy/tagged/display paths).** The DOM-write
mirror above only fixed segments the tool *types*; **copied** proposals (tagged segments are
copy-by-hand) and the on-screen text still lost the edge space/newline because harvest's `readCell`
→ `norm()` trims edges. Two fixes: (1) harvest **re-attaches the source's real edge whitespace** onto
the segment's `src` (via the same raw `.render-text` read the write mirror uses); (2) the panel's
`mirrorEdges` now mirrors **both** trailing space *and* newline (`\s`, matching `mirrorRowEdges`,
not `[^\S\n]`). So `polish()` carries the blue `·`/`↵` onto every proposal — copy, display, and all
modes — not only DOM writes.

### Assisted mode — tagged / bullet-list segments
Segments with real inline tag objects (yellow `①②` markers) can't be safely typed over — a
whole-cell write destroys the tag objects — so the panel treats them as **copy-by-hand**: still
run through GPT, shown with a **✋ paste by hand** badge and **no** auto-write checkbox. Bullet
lists (`A • B • C`, each item in its own `①…①` pair) are split into **numbered parts** with a Copy
button each. Everything **without** tags is written automatically.

---

## ⚖️ Feishu LQA mode

Adjudicates a Feishu/Lark "AI-check" sheet (e.g. `TT 历史文案AI检查情况汇总_KO_JV_HE`): the task
owners run a global AI translation check that flags a suspected error per string; you mark each
**Valid = Y** (real error → fix it) or **invalid** (false positive).

Feishu sheets render to a `<canvas>` (cells aren't real HTML), so this **can't** scrape them — you
**paste** the rows and GPT-5.4 works on the text.

1. Select rows in Feishu (with header) → **Ctrl+C** → paste (or drop a **CSV/TSV**), **or load an
   `.xlsx`** and pick the **Sheet tab** to adjudicate (e.g. `8.5 sync`; an LQA/sync/he tab is
   auto-selected) → **Load rows**. The `.xlsx` is read locally by the bundled SheetJS — nothing is
   uploaded. The sync tabs stack **he / jv / ko** in one sheet, so the **Language** selector defaults
   to **Hebrew only** (`he`) and hides the other locales' rows (e.g. 142 he of 374); switch it to
   *All languages* to see everything.
2. Check the auto-detected **column mapping** (skips the merged "AI" banner row; maps *Suggested
   Target by AI* before the plain *Target*).
3. Type which **segments** to adjudicate — `1, 3, 1-10, 5-8` or `all` — → **Adjudicate with gpt-5.4**.
4. Review verdict cards (filter **All / 🔴 Valid / 🟢 Invalid**): source, current target, AI
   suggestion, the AI's error claim, category, corrected Hebrew, rationale + confidence. A
   **Yes/No toggle** overrides GPT's call and updates the paste-back.
5. **Paste back** the 5 **Linguists** columns aligned to your selection (use a contiguous range):
   **Valid** · **Category** (only when Valid=Y) · **Final Translation** (only for valid) · **Updated
   on Starling** (blank; you tick) · **Comments** (invalid reason, deduped). **⬇ Fill all 5 (TSV)**
   copies the whole block; **🐦 Copy valid fixes (Key→JSON)** hands corrections to Starling mode.

Only the text columns go to GPT — **never the Feishu doc**. Keep shared-account credentials out.

---

## ↩ Sheet → Starling mode (write-back)

Closes the loop: takes the **adjudicated sheet** and applies each valid fix **into Starling by
Key** — the step you were doing by hand.

1. **Load** — drop the `.xlsx` (pick the `he` tab) / `.csv` / `.tsv`, or paste rows. Reads **Key +
   Valid + Final Translation** (+ **Source** to guard stale rows). xlsx is read locally by a bundled
   SheetJS — nothing is uploaded.
2. **Build queue** — keeps **Valid = Yes** rows with a Final + Key, **he only**, de-dupes by key
   (conflicting finals flagged ⚠ and skipped).
3. **Apply, one key at a time:**
   - **1 · Search** navigates to the en→he *All tasks* filter for that key (hard reload). Open the
     right task with 👁.
   - **2 · Check** reads the **live** segment (via the API) and shows **live source vs. sheet
     source** and **current target vs. final**, plus flags: *ready / already correct / Valid=No
     revision / no matching revision / 🔒 blocked / 💬 comment*. It **scrolls the editor to the
     segment and places the caret** (fast binary-search seek, below).
   - **3 · Write + confirm** — see the hybrid write below.

**It never blind-pastes and never submits.** It stops at *confirmed*; **you** resubmit the task.

### Two sheet shapes — sync sheet vs. old LQA report
The loader auto-detects which of two layouts you dropped, keyed on whether an **Updated on Starling**
column is present (`WB.map.updated >= 0`):

| | **Sync sheet** (has *Updated on Starling*) | **Old LQA report** (Column I = agree) |
|---|---|---|
| "Done" for restore-progress | the **Updated on Starling** column | the **Valid** column |
| Write-back stamps | **Updated on Starling = Yes** *and* **Comments**, plus Column I | Column I (agree) only |

This split fixes two bugs that showed up on sync sheets:

- **Queue vanished after adjudication.** Restore-progress used to treat a row as already handled when
  its **Valid** column was filled — but on a sync sheet *every* adjudicated row has a Valid, so the
  whole queue read as "done" (e.g. *"39 already marked done"*). It now judges done-ness by **Updated
  on Starling**, so only rows you've actually written back are skipped.
- **Updated on Starling not written.** Write-back only injected Column I, silently dropping the
  sync stamps. The styled export now injects the **union** of the *Valid*, *Comments*, and *Updated
  on Starling* columns, so Write + confirm stamps **Updated on Starling = Yes** (and the comment) as
  you go.

### The engine — API **Check**, editor **Write** (hybrid)

The default engine reads via Starling's JSON API but **types the fix into the editor** (not a
server-only write). This combination was reached after two problems with a pure-API write surfaced
live:

- **`updateTextTaskTarget` / `confirmTextTaskTargetV2` write server-only** → the editor (a separate
  React app) stayed stale, and resubmitting from it could clobber the write.
- **`confirmTextTaskTargetV2` returned `status_code 1024` (no permission)** because the confirm
  targets a workflow step the user may not own.

Both vanish by typing through the editor UI, which respects your assignment exactly like manual
editing. So:

| Step | How |
|---|---|
| **Check** | `GET /api/text/getSourceTextListWithTargetText?taskId=…&limit=10000` — whole task as JSON. Matches each segment by **exact folded source** against an index of **every** sheet tab, so it resolves *which revision* a task holds (a `Valid=No` revision is skipped, not guessed). Pins the segment by `sourceTextId` + rank. |
| **Write** | Confirms the open task == the one Check resolved, then **types the Final into the editor** at the pinned segment (`wbWriteBySeg`, addressed by rank). A **source sanity-check before typing** refuses if the row's source no longer matches — a rank drift can never write the wrong row. Mirrors the source's edge whitespace (v20). Optionally clicks the row's **✓✓ proofread-confirm**. |
| **Verify** | Re-reads the task via the API and confirms the value persisted. |

> ⚠️ **Reload before you resubmit.** The write types into the editor, but if the editor was showing
> a stale cache, reload the task (Switch task away & back, or Ctrl+R) before submitting so it picks
> up the value — the success note reminds you.

**Fast scroll (v18):** revealing/writing a segment binary-searches the scroll position by segment
number (~9 jumps vs ~41 linear steps for a 500-row task), backed by the original linear scan as a
guaranteed fallback — it can only speed up, never fail to find a segment.

**Confirm targeting (v19):** the proofread-confirm click targets **the row that was written** and
no longer blanket-hovers icon buttons (which used to spawn a cascade of Semi tooltips); a `finally`
hides any lingering tooltip.

### ⚡ Resolve all (read-only batch)

Instead of Search → 👁 → Check per key, **⚡ Resolve all** walks the whole queue: for each key it
enumerates its en→he tasks (`/api/task/getAllTasks`), reads each task once (cached — tasks repeat
heavily), and fills in every verdict. Ends with a tally like:

```
Resolved 91/91 · ✅ 38 ready · ✔ 22 already correct · ⤫ 19 Valid=No revision
 · ? 9 no matching revision · 3 no task · 🔒 2 blocked · 💬 5 with comments
 · read 27 task(s). Nothing written — review, then Write per key.
```

**Read-only — it never writes.** You still approve each write with **Write + confirm**. Has a
**Stop** button; requests are paced.

> The editor's `taskid=` is the task list's **`subtaskId`**, not its `taskId` field (a different id,
> often `"0"`). Reads/writes must use `subtaskId`.

**Multi-task keys:** a key often needs the same fix in several tasks; Resolve all keeps surfacing a
written card while another task still needs writing, and stops once only irrelevant revisions remain.

### Engine fallback & rollback
**⚙️ Settings → *Sheet → Starling engine*** switches to the old **DOM** engine (scrapes rows,
source-matches, types + clicks ✓✓). A full snapshot of the last stable build is kept alongside the
folder (`starling-copilot-STABLE-v18-2026-07-24/`, plus the older `…-WORKING-v13-…`).

> ⚠️ Only **Hebrew** rows are indexed. Per-locale tabs (`ko_KR`/`km_KH`/`jv_ID`) repeat the same keys
> and English sources with **foreign** finals — indexing them would let a Korean string match a
> Hebrew segment. Tabs with a Language column are filtered per row; tabs without one by name.
> **Don't relax that guard.**

> ⚠️ Beta — dry-run on **1–2 keys** and watch each step before a bulk run.

---

## 🌐 Crowdin mode (official API v2)

Harvests a Crowdin **Enterprise** file, proposes Hebrew with GPT-5.4, and **enters** translations
**unapproved** — they appear in the editor for **you** to approve/submit. The tool never approves.

### Why API v2 (not the internal editor API)
The internal `/backend/*` editor endpoints are CSRF- and AWS-WAF-defended and undocumented (a naive
same-origin replay of `phrases/bilingual` returned **403**). The documented **API v2** is stable,
sanctioned, and uses **your own** personal access token — so that's what this uses. Calls run
through the extension **background worker** (`CROWDIN_API` proxy) so there's no page CORS; the token
is passed per-call and never persisted in the background.

### Token — one-time setup
Create a **Personal Access Token** in Crowdin → **Account Settings → API → Personal Access Tokens**,
**inside the same organization** as the editor (a token from another org/account → **401**). Scopes:

| Scope | Access | Why |
|---|---|---|
| **Source files and strings** | **Read** | harvest source strings (`GET /projects/{id}/strings`) — *this*, not "Projects", gates strings |
| **Translations** | **Read & write** | read current translations + add new ones |
| **Projects** | **Read** | project access |

> "Translation **status**" is a *different*, read-only scope (progress info) — **not** what's needed.
> Missing "Source files and strings" → **403** on Harvest.

Paste the token into **⚙️ Settings → Crowdin API token → Save** (stored in `chrome.storage.local`).

### Flow
1. Open the Crowdin editor tab (`…/editor/<project>/<file>/<src>-<tgt>/…`) → **🌐 Crowdin →
   🔌 Detect the open file** (parses org, project, file, target language from the URL).
2. **⬇ Harvest** — `GET /projects/{p}/strings?fileId={f}` (paged) + current Hebrew via
   `GET /projects/{p}/languages/{tgt}/translations`. Filter: *only strings with no Hebrew yet*.
3. **✨ Propose** — GPT-5.4 per card (reuses the house style: plural, brand/placeholder preservation).
4. **Review & Enter** — per card or **Enter all reviewed**. Enter = `POST /projects/{p}/translations
   {stringId, languageId, text}`, which creates an **unapproved** translation. **You** approve in the
   editor.

Enterprise base `https://<org>.api.crowdin.com/api/v2`, `Authorization: Bearer <token>`. Only source
text goes to OpenAI; the token only talks to `api.crowdin.com`.

---

## 🐱 YiCAT mode (self-hosted Tmxmall)

Harvests a **YiCAT** task (self-hosted Tmxmall CAT, e.g. `http://129.226.170.49/yizhe/yicat/…`),
proposes Hebrew with GPT-5.4, and lets you **copy** each proposal — or **auto-write** it through
YiCAT's own in-cell editor. YiCAT reads cleanly over REST but **commits edits over a WebSocket**
(`ws://<host>/yizhe/editMessageWs<group>`), so there is no REST write endpoint; the write instead
drives the page's own editor (below).

### Flow
1. Open a YiCAT task in the editor (`…/yicat/group/<id>/editor?…&taskId=<id>`) → **🐱 YiCAT →
   🔌 Detect the open task** (parses group + task from the URL).
2. **⬇ Harvest** — `GET /yizhe/cat/segment?group_id=<g>&task_id=<t>&seg_range=1-N` (chunked), in your
   logged-in session. Skip-confirmed / skip-locked filters like the other modes.
3. **✨ Propose** — GPT-5.4 per card (same house style: plural, brand/placeholder preservation).
4. **Review, copy or write** — **⧉ Copy** puts the proposal on the clipboard (plain text) to paste
   in; or enable **auto-write** to push it into the cell directly. You confirm each segment yourself.

### The atom / tag model
Each segment is a list of atoms (`srcSegmentAtoms` / `tgtSegmentAtoms`): text runs verbatim, tags
are one of two kinds —

- **Whole-segment `<g1>…</g1>` style wrapper** (`color/font-size`, wrapping the entire segment, ~60%
  of segments): cosmetic, **not** a real tag. It's stripped on decode and the segment counts as
  **untagged** (writable). *(Early builds wrongly flagged all of these as tags.)*
- **Real placeholder** (`placeholder:true`, e.g. `<Xpt1/>`) or a mid-text tag: shown as `①②③`
  markers, segment flagged **⚑ tags** and **excluded from auto-write** (copy/paste it by hand).

### Auto-write (opt-in, verified)
YiCAT's cells are **Tiptap/ProseMirror** editors, so a raw `execCommand`/DOM write is silently
discarded, and its **track-changes** schema rejects a plain-text insert. The working write (found by
inspecting the live editor) runs in the extension's **MAIN world** (`yicat-main.js`, a
`"world":"MAIN"` content script) so it can reach the cell's real editor object, and for each segment:

1. locate the **target** cell's editor via `.tgt-table-cell … p[segid="<_id>"]` (**never** the
   source cell — those are editable too);
2. write in one of two modes and **read the cell back to verify** (it reports failure rather than
   claiming a write it can't confirm), skipping tagged/locked segments and never confirming:
   - **Tracked (default)** — keep tracking on and replace the selection, so the editor marks the
     old text deleted and the new text inserted (`track-change` is a *mark* with
     `{op-uid, type:"insert"|"delete", …}`), exactly like manual editing. Verified by the
     "effective" text (all non-deleted runs) equalling the proposal.
   - **Untracked** — `setTrackChangeDisableStatus(true)`, then `clearContent()` +
     `insertContent(text)` (a plain replace, valid with tracking off), restore tracking. Verified
     by `getText()`.
   If a tracked write can't be verified it **falls back to the untracked clean write**, so a cell is
   never left half-applied. Each transaction fires YiCAT's own WebSocket save.

> **Rendered-only:** the write needs the segment's row on screen (YiCAT virtualizes the grid).
> **Write all approved** writes the on-screen ones and tells you how many to scroll to and re-run.
> Only source/target text ever goes to OpenAI.

> The IP/host is pinned in `manifest.json` (`http://129.226.170.49/*` + the `yicat.js` and
> `yicat-main.js` content-script matches). If your YiCAT instance moves, broaden those and the host
> check in `sendYC()`.

---

## 💰 Word count mode (pay estimate)

Sums the **Weighted word count** across your Starling **My tasks** and prices it — the number you
need for editing invoices.

1. Open any Starling tab (logged in) → **💰 Word count**. It auto-loads on first open; **🔄 Refresh**
   re-fetches.
2. It pulls your task list from `GET /api/task/getMyTasks?offset=0&limit=5000&progress=all` (the
   pagination is **offset + limit** — `pageNum/pageSize` are ignored server-side) and reads each
   task's **`weightingWordCountV2`** (the float behind the displayed *Weighted word count*).
3. **Rate** (default **0.04**) × the summed weighted words = the estimate. Change the rate and it
   re-computes live.
4. **Status filter** scopes the sum — *All*, *Submitted (2)*, *In progress (1)*, *Closed (3)*. The
   output shows **the number of tasks summed**, the total weighted words, the pay, and a per-status
   breakdown table.

> Sums **translation** tasks. Runs entirely off the API in your session — no page scraping, nothing
> sent to OpenAI.

---

## 🧠 Style Brain (house-style memory)

A growable set of **house-style rules** and a **glossary** that get folded into the GPT prompt in the
CAT modes (Starling proofread/translate and Feishu LQA), so recurring style decisions stick without
re-explaining them each run.

- **Structure:** `{ rules:[{cat,text,…}], glossary:[{en,he,note,…}] }`, stored in
  `chrome.storage.local` under `styleBrain`. Rule categories: *register, address, punctuation, tone,
  numbers, format, placeholders, glossary, misc*.
- **Add manually** (the panel's Style Brain block): pick a category + type a rule → **add**; or type
  **en / he / note** → **add** a glossary term. Rules de-dupe by text; terms de-dupe by English
  (newest wins). Entries added this way are tagged `source: manual`.
- **Import / export:** load a `.json` of the same shape to bulk-add (e.g. the duration-plural pack),
  or export the current brain.
- **Applied** via `brainText()`, which serializes the brain into the system prompt for each card.

## 🧩 Consistency memory (source→target TM)

A translation memory that enforces a **fixed target for a given source**, overriding GPT after the
fact so the same string always lands the same way.

- **Structure:** `{ map:{ <foldedSource>: <target> }, enabled, updatedAt }`, key = `wbFold(source)`
  (the full folded source string).
- **How it overrides:** after GPT proposes, `tmApply` swaps in the remembered target when the source
  matches. When the remembered target **differs** from GPT's, the row's **🧠 memory — review**
  checkbox is left **unticked** so you eyeball the swap before writing.
- **Add manually:** the Consistency-memory block takes a **source** + **target** → **add**
  (`tmRecordOne`). Writes also record what you confirmed, so the memory grows as you work.
- **Toggle:** the memory can be enabled/disabled without clearing it.

> **Brain vs. memory — which wins?** They operate at different stages. The **Style Brain** is
> *advisory* — it shapes the prompt, so GPT may still choose a fitting inflection (e.g. brain glossary
> `add → הוסף`, but GPT renders `להוסיף` where the grammar calls for the infinitive). The
> **Consistency memory** is *mandatory* — a matching source is **force-replaced** with its stored
> target after GPT runs. So if the brain says `add = הוסף` and the memory maps that source to
> `להוסיף`, the **memory's `להוסיף` wins** in the output (and, because it differs from GPT, it's
> surfaced unticked for review).

---

## ⚠️ Calibration (Starling DOM)

Starling is a React app; its DOM is **not a stable API**. The content script ships with best-known
selectors + auto-detection, but class names can change on any deploy. Before a bulk run:

- Panel → **⚙️ Settings → Advanced → Run diagnostics**. Check the reported counts and `sampleRows`.
- Patch anything wrong in **selector overrides (JSON)** → **Apply selectors**:

  ```json
  {
    "targetCell": ".render-text-target, .cat-content__target",
    "sourceCell": ".render-text-source, .cat-content__source",
    "editor": "[contenteditable=\"true\"]",
    "segNo": ".item-no, .cat-content__number, .sentenceKey.semi-table-row-cell",
    "confirmAllText": "confirm all"
  }
  ```

**Always dry-run on one or two segments first.** The write-back is the riskiest part because the
segment list is virtualized and re-renders asynchronously.

### Two Starling editors, one extension
Default selectors are **unions** covering both editors; hidden measurement-clone rows are filtered:

| | String editor (`#/editor/…`) | Document editor (`#/doc/editor/…`) |
|---|---|---|
| Target cell | `.render-text-target` (mounts a child editor on click) | `.cat-content__target` — **is** the `contenteditable` |
| Seg # | `.item-no` | `.cat-content__number` / `.sentenceKey` |
| List | virtualized row list | Semi virtual table in `.cat-content__virtual` |

### Known limits
- **Real tag objects (`①②`, chips) can't be recreated by typing** — those stay manual (flagged ⚠).
- Chip round-trip on harvest is best-effort; fix odd placeholders inline before writing.
- Pace bulk runs sensibly — it's your authorized account and your own work.

---

## Files
| File | Role |
|---|---|
| `manifest.json` | MV3 config: side panel + content script on `starling.bytedance.com`; host permission for `*.crowdin.com` (covers `api.crowdin.com`) |
| `background.js` | Opens the side panel; **Crowdin API v2 proxy** (`CROWDIN_API` → `<org>.api.crowdin.com`) |
| `content.js` | Starling DOM/API engine — harvest, hybrid write (`wbWriteBySeg`), reveal/caret, confirm, diagnostics, JSON-API client (`window.__wb`) |
| `memoq.js` | memoQ web-editor content script — harvest/write via memoQ's editor REST API (`window.__mq`) |
| `yicat.js` | YiCAT content script (isolated) — REST segment harvest + atom/tag decode; bridges writes to the MAIN world (`window.__yc`) |
| `yicat-main.js` | YiCAT MAIN-world bridge (`"world":"MAIN"`) — drives each target cell's Tiptap editor to write + read-back verify |
| `panel.html/.css/.js` | Side-panel cockpit — GPT-5.4 calls, review UI, all four modes' orchestration |
| `vendor/xlsx.mini.min.js` | Bundled SheetJS (0.18.5) — reads `.xlsx` locally for Sheet → Starling |
| `icons/` | Generated by `tools/gen-icons.js` |
| `tools/test-harness.html` | Offline test: shims `chrome.*` + OpenAI to exercise the panel |

## Version history (highlights)
| v | Change |
|---|---|
| 9 | Direct-call bridge (`executeScript` → `window.__wb`) — fixes a stale-listener messaging hijack |
| 10–13 | Tiered source matching; `wbSrcOf` digit-strip fix; `miniDiff` near-miss diagnostics |
| 14 | Starling JSON-API engine (read/confirm/task-list) |
| 15 | ⚡ Resolve all batch (read-only) |
| 16–17 | Check **reveals + places caret**; near-miss similarity picker for split segments |
| — | **Hybrid write**: API check + **editor typing** (replaces server-only confirm; fixes stale-editor & `1024`) |
| 18 | Binary-search scroll seek (fast, fallback-backed) |
| 19 | Confirm targets the written row; tooltip-spam fix |
| 20 | Edge-whitespace mirroring (trailing space/newline) at write time |
| — | **🌐 Crowdin mode** on API v2 (background proxy, detect/harvest/propose/enter) |
| — | **🅜 memoQ** + **🐱 YiCAT** modes (editor-API / Tiptap write-back) |
| 21 | Edge-whitespace now carried onto the **proposal** too — harvest re-attaches the source's edge space/newline and the panel mirror includes newlines, so copy/tagged/display paths keep the blue `·`/`↵` |
| 22–35 | Chip vs. string-placeholder split + empty-target fill; numbered wrapping-tag (`O-/C-`) copy-by-hand; markdown **bold** preservation; **🧠 Style Brain** + **🧩 Consistency memory** (with manual-add); Sheet→Starling **sync-sheet** handling (restore-progress on *Updated on Starling*; write-back stamps *Updated on Starling* + *Comments*); **💰 Word count** pay-estimate tab |

## Test the panel offline
```bash
node -e "require('http').createServer((q,s)=>{const fs=require('fs'),p=require('path');let u=q.url.split('?')[0];if(u=='/')u='/tools/test-harness.html';fs.readFile(p.join(process.cwd(),u),(e,d)=>{if(e){s.writeHead(404);s.end()}else{s.writeHead(200);s.end(d)}})}).listen(8802)"
# open http://localhost:8802/tools/test-harness.html
```
