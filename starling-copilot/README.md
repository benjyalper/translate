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

Three cross-cutting aids apply across the CAT modes: a **🧠 Style Brain** (house-style rules +
glossary you can grow), a **🧩 Consistency memory** (a source→target TM that overrides GPT
post-hoc), and **🔒 Locked terms** (a *mandatory* EN→HE glossary — sent to GPT as non-negotiable,
then any segment missing the required Hebrew is flagged 🔒 after a Run). All three are documented below.

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
   *All languages* to see everything. An **Error level** selector (opt-in, defaults to *All levels*)
   filters to a single severity — e.g. **Minor only** — so you can adjudicate one band at a time.
2. Check the auto-detected **column mapping** (skips the merged "AI" banner row; maps *Suggested
   Target by AI* before the plain *Target*).
3. Type which **segments** to adjudicate — `1, 3, 1-10, 5-8` or `all` — → **Adjudicate with gpt-5.4**.
4. Review verdict cards (filter **All / 🔴 Valid / 🟢 Invalid**): source, current target, **Correct
   target** (labelled this way when the sheet has a *CorrectTarget* column, else *AI suggested*), the
   AI's error claim, category, corrected Hebrew, rationale + confidence. A **Yes/No toggle** overrides
   GPT's call and updates the paste-back. An explicit **Agree** toggle (starts pre-set to the accepted
   verdict) marks whether this row's Correct target is written as `agree` into **column J** of the
   download — click to include/exclude a row without changing the verdict.
5. **Paste back** the 5 **Linguists** columns aligned to your selection (use a contiguous range):
   **Valid** · **Category** (only when Valid=Y) · **Final Translation** (only for valid) · **Updated
   on Starling** (blank; you tick) · **Comments** (invalid reason, deduped). **⬇ Fill all 5 (TSV)**
   copies the whole block; **🐦 Copy valid fixes (Key→JSON)** hands corrections to Starling mode.
   For **reviewer-status sheets** (e.g. XBench LQA reports with a trailing status column),
   **⬇ Column J: agree** writes `agree` into column **J** and the **agreed Final translation** into
   column **K** for every **agreed** row — a two-column block you paste at the first adjudicated row's
   column J. **Column I is left untouched** (your reviewer-status notes are never overwritten);
   non-agreed rows stay blank in both columns. **📄 Download sheet (J = agree, K = final)** does the
   same write straight into the original `.xlsx` **via zip-surgery** — it injects only columns J and K
   into the target sheet's XML and copies every other zip entry verbatim, so the file is
   **byte-identical to the original except those columns** (all tabs, styles, and embedded newlines
   intact — no `XLSX.writeFile` re-serialize). It stamps the headers
   (`Validation feedback (from proofreader)` on J, `Final translation` on K) so **↩ Sheet → Starling**
   can find the agree column and the vetted final on re-upload. No pasting needed.

**Round-trip into Starling.** The downloaded file is a self-contained hand-off: load it in **↩ Sheet →
Starling**, which auto-detects the export (**key → `keys`, fix → `CorrectTarget`, gate on column J =
`agree`**) and queues **only the rows you agreed to**, each writing its Correct target into Starling by
Key. Every earlier flow stays selectable — the *All levels* default, the Yes/No paste-back columns, and
the Key→JSON hand-off are unchanged.

Only the text columns go to GPT — **never the Feishu doc**. Keep shared-account credentials out.

### 🧠 Learn from validated rows (teach the brain & memory)

A sync/AI-check sheet you've already worked is **ground truth**: the **Valid = Yes** column is your
call and **Final Translation** your fix, so every valid row is a *confirmed* MT/GPT mistake **plus**
its approved correction — the best learning signal there is. After **Load rows**, a **🧠 Learn from
validated rows** card appears (honours the **Hebrew** + **level** filters above):

1. **➕ Add this sheet's validated rows** collects every **Valid = Yes** row (fix = *Final*, or the
   *AI suggested* it accepted). It **accumulates** across tabs — Add on `8.7 sync`, switch the
   Sheet-tab to `8.12 sync`, Add again — deduped by source+fix.
2. **→ Consistency memory** stores each **source → your approved fix**, so the corrected wording
   auto-fills whenever that exact source recurs (exact-match, no GPT).
3. **→ Distill brain (rules & terms)** feeds GPT the **contrastive** `WRONG` vs `CORRECT` (+ the
   reviewer *why*) in batches and extracts **generalizable** rules (register, punctuation,
   translate country/region names, keep-in-Latin…) and **EN→HE term pairs** (e.g. *Cast* → להק,
   *Follow back* → לעקוב בחזרה) — routed through the Style-Brain **review → merge** flow so you vet
   everything first. Nothing here re-runs the adjudication; it reads the human marks you already made.

### ⚠ Conflict adjudicator (orange)

A glossary term or a remembered source can hold only **one** target. Whenever a *new* pairing would
overwrite a *different* stored one — same **EN term → different HE**, or same **source → different
memory target** — it is **not** silently replaced (the old "newest wins"). It's parked in an orange
**⚠ Conflicts to resolve** card with both wordings and **Keep current / Use new** buttons: you pick on
the spot and **the one you don't pick is deleted**. This fires from *→ Consistency memory*, from a
Style-Brain **merge**, and from the manual *Add term* / *Remember* fields. (Running the learn flow on
real sheets already surfaces genuine clashes — e.g. *Ask your guardian…* rendered both with **הורה**
and **אפוטרופוס/ית**, or *Terms and Conditions* as **תנאים וההגבלות** vs **תנאים והתניות** — for you to settle once.)

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

### ⚖️ Feishu LQA "agree" export (XBench / CAT QA report)
A third recognised shape: the `.xlsx` downloaded from **⚖️ Feishu LQA** (headers `SrcText` / `TgtText` /
`CorrectTarget` / … / `keys`, plus the injected columns J `Validation feedback (from proofreader)` and
K `Final translation`). The loader detects it and maps **key → `keys`, current → `TgtText`, fix →
`Final translation` (column K, the vetted final — falling back to `CorrectTarget` if K is absent)**,
gating on **column J = `agree`**. Because the agree marks *are* your adjudication, it defaults the *"queue every
row"* toggle **off** (agree-only) — untick nothing to write just the rows you agreed to, or re-tick it
to queue every row with a `CorrectTarget`. Interior-LQA reports keep their former default (queue all,
review each), so both flows stay selectable.

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
- **📚 Learn from a Starling task** (Style-Brain block): open a **submitted** task and **⬇ Harvest** —
  it reads every segment via `window.__wb.apiTask` (same-origin, your logged-in session) and keeps only
  **proofread-confirmed** pairs (`status === 3`), the approved source of truth. Two actions: **➕ Add
  pairs to memory** drops them straight into Consistency memory (exact, no GPT), and **🧠 Distill rules
  & terms** batches the pairs through GPT (`HV_BATCH`/`HV_CAP`), extrapolating generalizable rules,
  glossary terms, and tone — fed your existing brain so it won't repeat what's covered, and routing any
  pattern that **contradicts** the brain into the **conflicts** bucket as a decision ticket (unticked).
  Everything lands in the normal review→merge UI (`brainProposal` → `brainMerge`), tagged
  `source: harvested: <taskName>`; nothing overwrites the brain without your approval. Needs no
  `content.js` change — `apiTask` was already exposed. *(v1 = one open task; bulk over the my-task list
  is the planned next step.)*

## 🧩 Consistency memory (source→target TM)

A translation memory that enforces a **fixed target for a given source**, overriding GPT after the
fact so the same string always lands the same way.

- **Structure:** `{ map:{ <foldedSource>: <target> }, enabled, updatedAt }`, key = `wbFold(source)`
  (the full folded source string).
- **How it overrides:** after GPT proposes, `tmApply` swaps in the remembered target when the source
  matches. When the remembered target **differs** from GPT's, the row's **🧠 memory — review**
  checkbox is left **unticked** so you eyeball the swap before writing.
- **Tagged / copy-by-hand segments:** memory now seeds these too — the remembered wording lands in the
  per-part **Copy** text (it's still never auto-written; tagged rows stay copy-by-hand). Guarded by a
  **tag signature** (`tmTagSig` over `①…①` / `O-`/`C-` tokens): the stored target is only substituted
  when it carries the **same tag tokens in the same order** as the source, so the per-part splitter
  stays aligned — otherwise GPT's tag-carrying output is kept. Plain chip/placeholder segments
  (e.g. `{s_prizeName}`) have an empty signature and always qualify. (Intra-run alignment still skips
  manual rows.)
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
| 22–35 | Chip vs. string-placeholder split + empty-target fill; numbered wrapping-tag (`O-/C-`) copy-by-hand; markdown **bold** preservation; **🧠 Style Brain** + **🧩 Consistency memory** (with manual-add); Sheet→Starling **sync-sheet** handling (restore-progress on *Updated on Starling*; write-back stamps *Updated on Starling* + *Comments*); **💰 Word count** pay-estimate tab; Feishu LQA **xlsx + tab picker** + **Language filter**; XBench **agree** paste-back (column J) & zip-surgery download |
| — | *(panel-only, no CS bump)* House rule: **foreign-currency symbol/code goes AFTER the number in Hebrew** ("$20"→"20$", "Rp150,000"→"150,000Rp") in both Starling & LQA prompts; `amountIssue`/`fixAmounts` made order-insensitive so the house form isn't false-flagged or reverted (stale-TM protection kept) |
| — | *(panel-only, no CS bump)* Starling "Only segments" box also accepts a **term** (e.g. *Family Pairing*) matching source/target/key, mixable with numbers/ranges |
| — | *(panel-only, no CS bump)* **Consistency memory default OFF** + greyed-out card, re-enableable via the toggle |
| — | *(panel-only, no CS bump)* **📚 Learn from a Starling task** — harvest a submitted task's proofread-confirmed pairs (`apiTask`, status 3) → add to Consistency memory + GPT-distill rules/terms/tone into the brain's review→merge flow, with brain conflicts raised as decision tickets |
| — | *(panel-only, no CS bump)* Feishu LQA **run errors surfaced** + auto-retry without `temperature` when a model rejects it |
| — | *(panel-only, no CS bump)* Feishu LQA **Error-level filter** (opt-in, e.g. *Minor only*) + per-card **Agree** toggle → column **J** `agree` + column **K** *Final translation* (agreed rows only); column I untouched; download stamps J/K headers so **↩ Sheet → Starling** auto-detects the **XBench "agree" export** (key→`keys`, fix→column K *Final translation*→`CorrectTarget`, gate on J) and queues **agree-only** — every prior flow stays the default/selectable |
| — | *(panel-only, no CS bump)* **🧠 Learn from validated rows** in Feishu LQA — collects your **Valid = Yes** rows (fix = *Final*/*AI*) across sheet tabs → **→ Consistency memory** (source→approved-fix) and **→ Distill brain** (contrastive *WRONG* vs *CORRECT* + *why* → generalizable rules & EN→HE term pairs, via the brain review→merge flow). Maps the **Final Translation** column (col K) for auto-detect |
| — | *(panel-only, no CS bump)* **⚠ Conflict adjudicator** — a colliding **glossary term** (same EN → different HE) or **remembered source** (same source → different target) is parked in an orange card instead of silently overwriting ("newest wins" retired); **Keep current / Use new** deletes the unpicked wording. Fires from the learn flow, brain **merge**, and the manual *Add term* / *Remember* fields |
| — | *(panel-only, no CS bump)* **Password-gated Clear** — clearing the Style Brain or Consistency memory now prompts for a password (`clearPass`) before wiping |
| — | *(panel-only, no CS bump)* **Consistency memory now seeds tagged/copy-by-hand segments** — the remembered target fills the per-part Copy text (still never auto-written), guarded by a tag signature (`tmTagSig`) so it only substitutes when the stored target carries the same `①…①`/`O-`/`C-` tokens as the source |
| — | *(panel-only, no CS bump)* **Built-in guide (`STYLE_GUIDE`) hardened** — three house rules baked into the shared guide (reaches both 🐦 Starling and ⚖️ Feishu via `brainText()`): (1) slash form short-vs-long (same-stem → גלה/י, שתף/י; different spelling → בדוק/בדקי, אמור/אמרי, with the "בדוק/י→בדוקי" misread test); (2) **TikTok = DNT** (always Latin, maqaf prefix ב-TikTok); (3) currency symbol/code AFTER the number (20$, 40£, 1,000Rp). *(Number "k"-expansion and "+/-" range suffixes deferred — still under review.)* |
| — | *(panel-only, no CS bump)* **🔒 Locked terms — a mandatory "must" glossary.** A third list (`LOCK`, stored as `lockedTerms`) of EN→HE pairs enforced two ways: **(1) prompt tier** — `lockText()` injects them at the TOP of `brainText()` as **NON-NEGOTIABLE** (GPT may only add a Hebrew prefix), reaching both 🐦 Starling and ⚖️ Feishu; **(2) post-check tier (flag-only)** — after a Run, `lockCheck()` scans each proposal and any segment whose source contains the term but whose target is **missing** the required Hebrew gets a red **🔒 locked term** badge. It **never auto-edits** (so it can't corrupt Hebrew inflection); the match allows a fused prefix and the definite-ה drop (ההגדרות→בהגדרות), boundary-aware EN detection, and the flag clears live when you fix the row (blur re-check). Add / import / export / password-gated clear in the new **🔒 Locked terms** card |

## Test the panel offline
```bash
node -e "require('http').createServer((q,s)=>{const fs=require('fs'),p=require('path');let u=q.url.split('?')[0];if(u=='/')u='/tools/test-harness.html';fs.readFile(p.join(process.cwd(),u),(e,d)=>{if(e){s.writeHead(404);s.end()}else{s.writeHead(200);s.end(d)}})}).listen(8802)"
# open http://localhost:8802/tools/test-harness.html
```
