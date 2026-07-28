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
| **🐱 YiCAT** | Harvest a YiCAT (self-hosted Tmxmall) task via its segment API → GPT-5.4 cards → **copy** each proposal to paste in (YiCAT saves over a WebSocket, so there's no REST write-back). |

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
on every content.js change** (currently **20**). The panel checks the page's live `window.__wb.ver`
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

### Edge-whitespace preservation (v20)
A source string that ends in a trailing **space** (Starling's blue `·`) or **newline** (blue `↵`)
must carry the same edge whitespace in the target, or Starling flags a Punctuation/Space QA error.
GPT drops these. At **write time** `mirrorRowEdges` reads the source row's **raw** text (no
normalization, so newlines survive) and mirrors its exact leading/trailing whitespace onto what's
typed — applied in **both** the Starling write and the Sheet→Starling hybrid write. Safe by
construction: no source edge → text unchanged.

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

1. Select rows in Feishu (with header) → **Ctrl+C** → paste (or drop a CSV/TSV) → **Load rows**.
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
proposes Hebrew with GPT-5.4, and lets you **copy** each proposal into the target cell. YiCAT reads
cleanly over REST but **commits edits over a WebSocket** (`ws://<host>/yizhe/editMessageWs<group>`),
so there is **no safe REST write-back** — the default is copy-by-hand and you confirm each segment.

### Flow
1. Open a YiCAT task in the editor (`…/yicat/group/<id>/editor?…&taskId=<id>`) → **🐱 YiCAT →
   🔌 Detect the open task** (parses group + task from the URL).
2. **⬇ Harvest** — `GET /yizhe/cat/segment?group_id=<g>&task_id=<t>&seg_range=1-N` (chunked), in your
   logged-in session. Decodes each segment's atoms: text runs verbatim, inline `<g1>…</g1>` tags as
   `①②③` markers. Skip-confirmed / skip-locked filters like the other modes.
3. **✨ Propose** — GPT-5.4 per card (same house style: plural, brand/placeholder preservation).
4. **Review & copy** — **⧉ Copy** (per card or **Copy all approved**) puts the proposal on the
   clipboard with tag markers **stripped to plain text**; paste it into the segment's target cell.

### Experimental auto-write (off by default)
A checkbox reveals an **auto-write** path that simulates typing into the cell's `contenteditable`
(anchored by the segment's `_id` via `p[segid="…"]`) so YiCAT's own code fires the WebSocket save.
It is **uncalibrated** — locate-by-`_id` only works while the segment's row is rendered (YiCAT pages
~60 rows), it **skips tagged segments**, and it never confirms/delivers. **Test on a throwaway
segment first.** Only source/target text ever goes to OpenAI.

> The IP/host is pinned in `manifest.json` (`http://129.226.170.49/*` + the `yicat.js` content-script
> match). If your YiCAT instance moves, broaden both there and the host check in `sendYC()`.

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
| `yicat.js` | YiCAT content script — REST segment harvest + atom/tag decode; copy + experimental DOM write (`window.__yc`) |
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
| 20 | Edge-whitespace mirroring (trailing space/newline) |
| — | **🌐 Crowdin mode** on API v2 (background proxy, detect/harvest/propose/enter) |

## Test the panel offline
```bash
node -e "require('http').createServer((q,s)=>{const fs=require('fs'),p=require('path');let u=q.url.split('?')[0];if(u=='/')u='/tools/test-harness.html';fs.readFile(p.join(process.cwd(),u),(e,d)=>{if(e){s.writeHead(404);s.end()}else{s.writeHead(200);s.end(d)}})}).listen(8802)"
# open http://localhost:8802/tools/test-harness.html
```
