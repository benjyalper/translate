# Admin Tools Map

A reference for everything inside `translate/admin.html` and the supporting code that powers it.

> **Live URL:** https://translate-production-4ac8.up.railway.app/admin.html
> **Password:** `benjytrans` (defined in `admin.html` near `const ADMIN_PW`)

---

## 1. Architecture at a glance

```
┌─ Railway service: "translate" (one container) ──────────────────────┐
│                                                                     │
│   nginx                Node tools server         JobScraper         │
│   ─────                ─────────────────         ───────────        │
│   listens on $PORT     listens on 3007           run-on-demand      │
│   serves static        receives /api/* via       (called by         │
│   files from           nginx reverse-proxy       /api/scrape)       │
│   admin.html root      Express + multer +                           │
│                        axios + docx + pg                            │
└─────────────────────────────────────────────────────────────────────┘
       ▲
       │  GitHub: github.com/benjyalper/translate  (auto-deploy on push)
```

Two extra standalone apps are **launched from admin.html** but live in **separate folders** and are **not on Railway** — they only work locally:

| App | Port | Folder |
|---|---|---|
| Hebrew Voice Cloner | 3018 | `hebrew-voice-tts/` |
| Text Checker | 3019 | `text-checker/` |

The admin page detects `localhost` vs Railway and either calls the Node API directly (`http://localhost:3007`) or uses relative URLs (which nginx proxies).

---

## 2. Where the code lives

| Concern | Path |
|---|---|
| **All tool UIs + most logic** | `translate/admin.html` (single file, ~12,800 lines) |
| **Tool map navigation** | `admin.html:583-700` |
| **Tool cards (UI panels)** | `admin.html:696-2304` (the `.tools-grid`) |
| **Tool JS logic** | `admin.html:2260-12800` (inside `<script>…</script>`) |
| **Backend API** | `translate/transcriber/server.js` |
| **Job scraper (sub-process)** | `translate/JobScraper/scraper.js` |
| **Deploy config** | `translate/Dockerfile`, `translate/nginx.conf` |
| **Resume / portfolio data** | `translate/transcriber/profile.json` |
| **Generated outputs (runtime)** | `translate/transcriber/output/` |
| **Uploaded files (runtime)** | `translate/transcriber/uploads/` |

---

## 3. The 21 tools

Tools are grouped by type:

- 🌐 **Browser-only** — pure client-side, work everywhere admin.html is served (including iPhone via Railway). No backend, no env vars.
- 🛰 **Backed by `/api/*`** — call the Node tools server. Needs `OPENAI_API_KEY` (and `pg` connection string for firm-memory sync).
- ↗ **Launcher** — opens a standalone app in a new tab. Only works when you're running that app locally.

| # | Emoji | Tool | Type | Toolmap btn | Tool card | JS prefix |
|---|---|---|---|---|---|---|
| 1 | 🎙 | Audio Transcriber | 🛰 `/api/transcribe`, `/api/whisper` | `admin.html:586` | `admin.html:699-924` | `tc*` |
| 2 | 🎬 | Audio Extractor (MP4 → audio) | 🌐 | `admin.html:592` | `admin.html:927-992` | `ax*` |
| 3 | 🎤 | Hebrew Voice Cloner (TTS) | ↗ port 3018 | `admin.html:598` | `admin.html:995-1019` | `hvcLaunch()` |
| 4 | 📦 | Trados SDLPPX Auto-Translator | 🛰 `/api/trados` (and OpenAI from browser) | `admin.html:604` | `admin.html:1022-1183` | `tr*`, `tm*` |
| 5 | 🟣 | memoQ Auto-Translator (.mqout → .mqback) | 🌐 (OpenAI calls from browser) | `admin.html:610` | `admin.html:1186-1245` | `mq*` |
| 6 | 🌐 | Document Translator (HE ↔ EN) | 🌐 + LocTest sub-mode | `admin.html:616` | `admin.html:1248-1360` | `dt*`, `dtLocTest*` |
| 7 | 🇮🇱→🇬🇧 | Hebrew Text → English (per-minute) | 🌐 | `admin.html:622` | `admin.html:1363-1465` | `ht*` |
| 8 | 📋 | VerboLabs Template Filler | 🌐 | `admin.html:628` | `admin.html:1468-1561` | `vl*` |
| 9 | 📖 | Glossary Manager | 🌐 (localStorage) | `admin.html:634` | `admin.html:1564-1656` | `gm*` |
| 10 | 🔧 | XBench QA Report Revisor | 🌐 | `admin.html:640` | `admin.html:1659-1717` | `qa*` |
| 11 | 📑 | Translation Proofreader (SDL) | 🌐 (OpenAI from browser) | `admin.html:646` | `admin.html:1720-1834` | `pr*` |
| 12 | 🟣 | memoQ Proofreader | 🌐 (OpenAI from browser) | `admin.html:652` | `admin.html:1838-1891` | `mqp*` |
| 13 | 📄 | Document Proofreader (Hebrew) | 🌐 (OpenAI from browser) | `admin.html:658` | `admin.html:1894-1965` | `dp*` |
| 14 | ✍️ | Text Checker (HE/EN) | ↗ port 3019 | `admin.html:664` | `admin.html:1968-1988` | `tcLaunch()` |
| 15 | 🎞️ | Subtitle Translator (EN → HE) | 🌐 | `admin.html:670` | `admin.html:1991-2042` | `st*` |
| 16 | 🔍 | Subtitle Proofreader | 🌐 | `admin.html:676` | `admin.html:2045-2131` | `sp*` |
| 17 | ✉️ | Email Response Generator | 🌐 (OpenAI from browser) | `admin.html:682` | `admin.html:2134-2234` | `er*` |
| 18 | 📁 | Client / Firm Memory | 🛰 `/api/firms` (Postgres) | `admin.html:688` | `admin.html:2237-2256` | `er*` (shared) |
| 19 | 📸 | Doc Screenshotter | 🌐 | `admin.html:697` | `admin.html:2259-2304` | `ds*` |
| 20 | 📚 | Ask My Docs (Knowledge Base) | 🌐 (OpenAI from browser) | `admin.html:703` | `admin.html:2311-2344` | `kb*` |
| 21 | 🐦 | Starling Copy Deck | 💻 client + GPT-5.4 (browser key) | `admin.html:708` | `admin.html:2367-2470` | `sk*` |

> Naming quirk: `tcLaunch()` (line 2550) opens the **Text Checker** standalone app. The Audio Transcriber also uses the `tc*` prefix for its own logic (`tcSetMode`, `tcSwitchTab`, etc.). They share a prefix only by coincidence — `tcLaunch` is the only `tc*` function that belongs to Text Checker.

---

## 4. Detailed tool reference

### 🎙 1. Audio Transcriber — `tool-audio-transcriber`
Upload audio/video → Whisper transcribes (HE/EN, optional translate-to-English mode) → .docx with timestamps.

- **Card UI:** `admin.html:699-924`
- **JS:** `admin.html` — `tc*` family starting at line 2776 (`tcSetMode`, `tcSwitchTab`, `tcSetLang`, `tcEncodeWav`, `tcBuildVerboLabsHTML`, `tcAlignBoth`, etc.)
- **Backend:** `transcriber/server.js`
  - `POST /api/transcribe` (line 350) — single audio chunk → Whisper
  - `POST /api/whisper` (line 298) — raw passthrough endpoint
- **Needs:** `OPENAI_API_KEY`
- **Limits:** Whisper hard cap 25 MB per chunk — client slices first via Web Audio API.

### 🎬 2. Audio Extractor — `tool-audio-extractor`
Strip audio from any video file → download as WAV. Done entirely in browser via `OfflineAudioContext`.

- **Card UI:** `admin.html:927-992`
- **JS:** `admin.html` — `ax*` family (`axResetRange`, `axOnRangeChange`, `axEncodeWav` around line 3068-3127)
- **Backend:** none

### 🎤 3. Hebrew Voice Cloner (TTS) — `tool-voice-cloner`
Card is a **launcher only**. Real app is the standalone `hebrew-voice-tts/` project on port 3018.

- **Card UI:** `admin.html:995-1019` (button + status text)
- **JS:** `hvcLaunch()` at `admin.html:2571` — just `window.open('http://localhost:3018')`
- **Real app:** `hebrew-voice-tts/server/app.js` + `hebrew-voice-tts/public/`
- **Storage:** SQLite at `hebrew-voice-tts/storage/hebrew-tts.db`
- **Won't work on Railway** (mixed-content + nothing listens on 3018 there).

### 📦 4. Trados SDLPPX Auto-Translator — `tool-trados-translator`
Drop a Trados return package → GPT translates every XLIFF segment → download. **Three output envelopes** (same translated content): **.sdlrpx** return package (`#tr-dl`), raw **.sdlxliff** (`#tr-dl-sdlxliff`), and a **bilingual .xlsx** (`#tr-dl-xlsx`) — File · Segment · Source · Target(HE), one row per segment.

- **Card UI:** `admin.html:1022-1183`
- **JS:** `admin.html` — `tr*` family (`trLangName`, `trSetLang`, `trExtractSegments`, `trInsertTranslation`, `trValidateXml`, etc., lines 4341-4992). Also `tm*` for translation-memory matches (`tmTokenize`, `tmSimilarity`, `tmFindMatches`).
  - Excel export: `trPlainText` (strips inline tags/`{{TAG_n}}` placeholders, decodes entities) + `trBuildExcelBlob` (SheetJS `aoa_to_sheet` → values-only .xlsx). Rows collected in `trTranslate` from each file's final content; **deduped by `unitId#mid`** because `trExtractSegments` matches the seg-mrk in `<source>`, `<seg-source>` AND `<target>` (keep first = source-side; the target-side match would read Hebrew as the source).
- **Backend:** `POST /api/trados` (`transcriber/server.js:397`) — wraps repackaging; actual translation calls go to OpenAI from the browser.

### 🟣 5. memoQ Auto-Translator — `tool-memoq-translator`
Same idea as Trados, but for memoQ `.mqout` → `.mqback`.

- **Card UI:** `admin.html:1186-1245`
- **JS:** `admin.html` — `mq*` family (`mqOnFile` at 10300, `mqDownload` at 10390)
- **Backend:** none — OpenAI called directly from browser.

### 🌐 6. Document Translator (HE ↔ EN) — `tool-doc-translator`
Drop .docx / .pdf / .rtf / .odt / .pptx / .xlsx / .mqxlz / .mqxliff / .txt / .md / .csv / .html → GPT translates → download in same format.

- **Card UI:** `admin.html:1248-1360`
- **JS:** `admin.html`
  - Main: `dt*` family (`dtCountWords`, `dtOnFile` at 9755, `dtDownload` at 10077, `dtRtfEncode`, `dtXmlEscape`, etc.)
  - Loc-test sub-mode: `dtLocTest*` family (`dtLocTestToggle` at 10819, `dtLocTestOnSgImages`, `dtLocTestFindGlossaryMatches`, `dtLocTestPatchTargetCell`, etc.)
- **Backend:** none — OpenAI from browser.

### 🇮🇱→🇬🇧 7. HE → EN Per-Minute — `tool-he-en-perminute`
Paste a Hebrew transcript → GPT-5.4 translates and segments into ~1-minute chunks.

- **Card UI:** `admin.html:1363-1465`
- **JS:** `admin.html` — `ht*` family (`htSplitIntoMinutes` at 9405, `htBucketsFromChunks`, `htRenderResults`, `htCopyEnglish`)
- **Backend:** none.

### 📋 8. VerboLabs Template Filler — `tool-verbolabs`
Paste an ivrit.ai transcript with timestamps + speakers → GPT translates → exports the exact VerboLabs 4-column template.

- **Card UI:** `admin.html:1468-1561`
- **JS:** `admin.html` — `vl*` family (`vlParseIvritAi` at 8981, `vlMapSpeakers`, `vlGroupByMinute`, `vlMergeBySpeaker`, `vlBuildTemplateHTML`)
- **Backend:** none.

### 📖 9. Glossary Manager — `glossary-manager`
Save and reuse per-client term bases. Auto-loaded into Trados translator.

- **Card UI:** `admin.html:1564-1656`
- **JS:** `admin.html` — `gm*` family (`gmLoadStore` at 5014, `gmSaveStore`, `gmRefreshDropdowns`, `gmRenderEditor`, `gmExport`, `gmImportPasted`, etc.)
- **Storage:** `localStorage` key (browser-only).

### 🔧 10. XBench QA Report Revisor — `tool-xbench`
Upload an XBench QA xlsx → auto-applies the corrections. **Two output modes** (radio toggle at the top of the card):
- **📦 SDLRPX / SDLXLIFF** (original): also upload the matching package → fixes applied into the XLIFF `<mrk>`s → revised package.
- **📊 Excel (blue text)** *(NEW)*: no package needed. Corrects **Key Term Mismatch** rows straight in the report's **Target column (D)**, writing the corrected target back as an inline rich string with the changed words (or the whole target) coloured **blue** — editing the `.xlsx` OOXML directly so all other formatting is kept. Download is `<report>_CORRECTED.xlsx`.

- **Card UI:** `admin.html:1659-1717` — mode toggle + `#qa-excel-opts` (blue-marking choice); `#qa-rpx-col` hidden in Excel mode.
- **JS:** `admin.html` — `qa*` family (`qaOnXlsx`, `qaParseAllIssues`, `qaClassifyFix`, `qaFixMrkInXliff`, `qaScanChinesePassthrough`, etc.).
  - Excel mode (`qaMode==='excel'`): `qaSetMode`, `qaExcelParseIssues` (captures each data row's Target cell ref), `qaExcelParseAndPreview` (reuses `qaClassifyFix`; drops direct no-ops where the term is already present), `qaExcelApply` (GPT fix-term-in-context, then blue OOXML write), `qaWordDiffRuns` (word-LCS diff → blue runs), `qaInlineIs` / `qaSetCellInline` (inline rich string, preserves the cell's `s="…"` style), `qaResolveSheetPath`.
  - Notes: XBench Target cells are **rich text** (it highlights the flagged term in light-blue `FF00B0F0`); SheetJS concatenates the runs to the real target (openpyxl only returns the first run). The correction blue is pure `FF0000FF`. Only source/target text goes to OpenAI (`gpt-5.4`).
- **Backend:** none.

### 📑 11. Translation Proofreader (SDL) — `tool-translation-proofreader`
Upload .sdlppx with translated segments → GPT reviews each → preview by severity → approve fixes → download revised .sdlrpx with native Trados track changes.

- **Card UI:** `admin.html:1720-1834`
- **JS:** `admin.html` — `pr*` family (`prRenderCostEstimate` at 6744, `prRenderResults`, `prApprove`, `prInsertWithTrackChanges`, `prAddRevDefs`, `prComputeGELScores`, `prBuildGELDocHTML`, etc.)
- **Backend:** none — OpenAI from browser.

### 🟣 12. memoQ Proofreader — `tool-memoq-proofreader`
Drop translated `.mqxlz`/`.mqxliff` → GPT reviews → auto-applies clear fixes → download.

- **Card UI:** `admin.html:1838-1891`
- **JS:** `admin.html` — `mqp*` family (`mqpOnFile` at 10409, `mqpDownload` at 10554)
- **Backend:** none.

### 📄 13. Document Proofreader (Hebrew) — `tool-document-proofreader`
Upload Hebrew .pdf/.docx → GPT reviews each paragraph → preview/approve → download .docx with native Word track changes.

- **Card UI:** `admin.html:1894-1965`
- **JS:** `admin.html` — `dp*` family (`dpRenderCostEstimate` at 7558, `dpRun` at 7925, `dpBuildDocumentXml`, `dpBuildStylesXml`, `dpParagraphXml`, `dpRenderResults`)
- **Backend:** none.

### ✍️ 14. Text Checker (HE / EN) — `tool-text-checker`
Card is a **launcher only**. Real app is standalone Next.js at `text-checker/` on port 3019.

- **Card UI:** `admin.html:1968-1988`
- **JS:** `tcLaunch()` at `admin.html:2550`
- **Real app:** `text-checker/` (Next.js)
- **Won't work on Railway.**

### 🎞️ 15. Subtitle Translator (EN → HE) — `tool-subtitle-translator`
Upload .srt/.vtt → GPT translates each cue → download with timecodes byte-identical.

- **Card UI:** `admin.html:1991-2042`
- **JS:** `admin.html` — `st*` family (`stOnFile` at 8064, `stParseSRT`, `stParseVTT`, `stBuildSRT`, `stBuildVTT`, `stDownload`)
- **Backend:** none.

### 🔍 16. Subtitle Proofreader (Hebrew) — `tool-subtitle-proofreader`
Upload Hebrew subtitle → GPT review + technical pass (CPS, line length, count, timing) → approve fixes → export.

- **Card UI:** `admin.html:2045-2131`
- **JS:** `admin.html` — `sp*` family (`spOnHeFile` at 8334, `spOnEnFile`, `spRunQA`, `spRenderResults`, `spBuildSRT`, `spDownload`)
- **Backend:** none.

### ✉️ 17. Email Response Generator — `tool-email-response`
Paste incoming email/job posting → GPT drafts a tailored reply in Benjy's voice.

- **Card UI:** `admin.html:2134-2234`
- **JS:** `admin.html` — `er*` family for generation (`erBuildSystemPrompt` at 11936, `erRegenerate`, `erCopy`, `erDownload`, `erOpenMail`)
- **Backend:** none for the GPT call (browser → OpenAI); but the firm-memory side does hit the backend (see next).

### 📁 18. Client / Firm Memory — `tool-firm-memory`
Per-client correspondence history with a GPT-distilled running memory. Optionally syncs across devices via the Node server + Postgres.

- **Card UI:** `admin.html:2237-2256`
- **JS:** `admin.html` — `er*` family for firm management (`erFirmsLoad`, `erFirmCreate`, `erFirmDelete`, `erFirmRename`, `erFirmsExport`, `erDetectFirm`, `erRecordExchange`, `erRenderFirms`, `erPushToServer`, `erInitSync`, lines 12151-12653)
- **Backend:** `transcriber/server.js`
  - `GET /api/firms` (line 776)
  - `PUT /api/firms` (line 791)
  - `DELETE /api/firms/:id` (line 822)
- **Sync auth:** `X-Admin-Token` header (stored in localStorage as `er_token`)
- **Needs:** Postgres connection. Server-side: `pg` package in `transcriber/package.json`.
- **Status check:** `GET /api/status` (line 696) — returns `{ firmsDb: true/false }`.

### 📸 19. Doc Screenshotter — `tool-doc-screenshotter` *(NEW)*
Upload .pdf or .docx → text re-rendered at 8pt → ZIP of page-sized PNG screenshots.

- **Card UI:** `admin.html:2259-2304`
- **JS:** `admin.html` — `ds*` family (`dsOnFile`, `dsSetStatus`, `dsExtract`, `dsRun`, lines 12665+)
- **CDN libs loaded in `<head>`:** mammoth.browser, html2canvas (pdf.js + JSZip already present).
- **Backend:** none.
- **Note:** the render stage is reparented to `<body>` at run time so parent flex layout doesn't zero out its dimensions.

### 📚 20. Ask My Docs (Knowledge Base) — `tool-ask-docs` *(NEW)*
Plain-language Q&A over ingested reference documents. Grounded only in the data: list/count/filter queries are exact, every answer cites source + page, and it refuses ("That isn't in the documents.") when the answer isn't present. First dataset is the TikTok Project Feature Briefing (61 feature records).

- **Card UI:** `admin.html:2311-2344`
- **JS:** `admin.html` — `kb*` family starting at line 12875 (`kbLoad`, `kbFilter`, `kbDetails`, `kbChat`, `kbAsk`, `kbInit`)
- **Backend:** none — OpenAI called from the browser with `getApiKey()`, model `gpt-5.4`.
- **Reliability design (a "router"):** `filter_features` / `get_feature_details` run as exact JS over the records (via OpenAI tool-calling), so enumeration/counting is deterministic; the model only does language. Mirrors the standalone `localization-bot/ask.py`.
- **Data:** `kb/features.json` — bundled knowledge base, format `{ datasets:[{ id, title, source_file, record_type, records:[…] }] }`. Loaded via `fetch('kb/features.json')`; served statically by nginx (and bundled by `COPY . /usr/share/nginx/html/`).
- **Ingestion (offline):** new source docs are turned into clean structured records by `../localization-bot/extract_llm.py` (LLM-based extraction). Re-run it, drop the updated `kb/features.json` here, and push. Not part of the deployed app.
- **Needs:** `OPENAI_API_KEY` (browser-side, via the global key bar).

### 🐦 21. Starling Copy Deck — `tool-starling` *(NEW)*
End-to-end tool for Starling (ByteDance CAT) tasks: drop a **raw exported XLIFF**, let **GPT-5.4 proofread or translate** it in-browser, then copy each segment into Starling. Starling has **no XLIFF re-import**, so edits only get back in by pasting each cell by hand — this tool makes that fast and lets Benjy paste segments while Claude edits others in the browser at the same time (agree who takes which segments/files first).

- **Card UI:** `admin.html:2367-2470` (self-contained; scoped `.sk-*` styles in an inline `<style>`). GPT action bar (`#sk-ai`) sits at the top of the built deck.
- **JS:** `admin.html` — `sk*` family before the final `</script>` (`skBuild`, `skNormalize`, `skParseXliff`, `skCardHtml`, `skRenderCards`, `skCopy`, `skDownloadHtml`, `skResetTicks`, **`skAI(mode)`** + **`skAiSys(mode)`**).
- **Backend:** none — pure client. **Proofread/Translate call `api.openai.com` directly with Benjy's browser-side `oai_key`** (same key as the other GPT tools; `promptApiKey()` if missing).
- **Inputs:** paste/drop (a) a **raw `.xliff`** exported from Starling (renders every `<trans-unit>`, then Proofread/Translate); (b) a ready **deck JSON** `{taskId,segments:[{seg,cat,note,src,tgt}]}` Claude produces; or (c) a **corr map** `{"<seg>":{cat,note,target}}`.
- **GPT step (`skAI`):** `gpt-5.4`, `response_format:json_object`, batches of 10. **📑 Proofread** rewrites each Hebrew `tgt` (fix grammar/terminology + convert to **plural gender-neutral**); **🌐 Translate source → HE** fills `tgt` from the English `src`. System prompt (`skAiSys`) enforces byte-for-byte preservation of `{x}`/`{{x}}`/`%s`/HTML/`<g>`/`①` and keeps "TikTok"/brands in Latin script. Changed segments get a `✎ proofread` / `✨ translated` note; status shows `Proofread N · M changed`.
- **Features:** per-segment Copy button (copies target verbatim; Starling re-chips `{tokens}`/`<tags>` on paste), category chips + filters (critical/minor/plural/html), **⚠ tag** warnings on segments holding real inline tag objects (`<g>/<x/>/<bpt>…`, `①②③`) — place those in the editor by hand, "pasted" checkbox + progress bar saved in `localStorage` (`sk-done-<taskId>`), and **⬇ Download as .html** for a standalone portable deck.
- **Per-part copy (`skSplitParts`):** segments that are bullet-delimited (`A • B • C`) — which in Starling are wrapped in numbered tag pairs `①…① ②…②` — render an extra **small Copy button per part**, each with a yellow index badge (1..N matching the tag number) + the English part as reference. Copy a part → paste it **between its tags** in Starling so the tag objects are never touched. The whole-segment button becomes **Copy all**. Applies in both the inline tool and the downloaded .html. Starling encodes tags as text tokens `O-<id>`/`C-<id>` (e.g. `O-1-0<text>C-1-0`); `skStripTags` removes them so the per-part copy is **only the inner text** and the badge shows the tag's own id (`skTagId`). `skHl` highlights any `O-/C-` tokens shown in the full target.
- **Token highlighting:** `{placeholders}`, `{{vars}}`, `%s`, and `<html tags>` are visually tagged in both source and target.
- **Helper (offline):** `copydeck-gen.mjs` — `node copydeck-gen.mjs <in.xliff> <corr.json> <out.html> <taskId>` builds the same deck as a standalone HTML file. Sample deck: `deck-354460046850.json`.
- **Workflow:** Benjy exports the task XLIFF from Starling → drops the **raw** file here → clicks **Proofread** or **Translate** (GPT-5.4, placeholders/tags/HTML preserved) → copies segment-by-segment into Starling. (Claude can still hand over a pre-built deck for the tagged segments it takes in the browser.)

---

> The **TikTok LQA Adjudicator** (Feishu AI-check sheet → GPT-5.4 valid/invalid + corrected target) lives in the **Starling Copilot extension** (`starling-copilot/`, ⚖️ Feishu LQA mode), **not** in admin.html — it was prototyped here and then removed to keep a single source of truth.

## 5. Backend API reference (`transcriber/server.js`)

Internal port **3007**. Mounted by nginx at `/api/*`.

| Method | Path | Line | Notes |
|---|---|---|---|
| POST | `/api/whisper` | 298 | Raw Whisper passthrough |
| POST | `/api/transcribe` | 350 | Audio chunk → text |
| POST | `/api/trados` | 397 | SDLPPX repackaging |
| GET | `/api/download/:filename` | 470 | Serve files from `output/` |
| POST | `/api/scrape` | 550 | Triggers JobScraper |
| POST | `/api/assist-apply` | 664 | Playwright-driven apply (localhost only) |
| GET | `/api/status` | 696 | Health + `firmsDb` flag |
| GET | `/api/firms` | 776 | Read firm memory (Postgres-backed) |
| PUT | `/api/firms` | 791 | Write firm memory |
| DELETE | `/api/firms/:id` | 822 | Delete one firm |

Auth: firm-memory endpoints require `X-Admin-Token` (validated by `requireAdminToken` middleware).

Env vars used by the server:
- `OPENAI_API_KEY` — Whisper + GPT calls
- `TOOLS_PORT` — overrides 3007
- `PORT` — set by Railway, used by nginx (not the Node server)
- (Postgres conn vars consumed by `pg`, e.g. `DATABASE_URL` or the discrete `PG*` vars)

---

## 6. Where everything else lives

| Thing | Path |
|---|---|
| Public landing page | `translate/index.html` |
| Resume/portfolio data | `translate/transcriber/profile.json` |
| Resume generator (Node script) | `translate/generate-resume.js` |
| Trial SDLPPX samples (testing) | `translate/trial.sdlppx`, `translate/trial2.sdlppx` |
| Localization test runner (Python) | `translate/loctest-translate.py` |
| Ad-hoc QA simulators | `translate/qa_simulate.mjs`, `qa_simulate2.mjs`, `qa_show_raw.mjs` |
| Verification scripts | `translate/__verify/` |
| Standalone Voice Cloner app | `hebrew-voice-tts/` (separate folder, port 3018) |
| Standalone Text Checker app | `text-checker/` (separate folder, port 3019) |
| Standalone Doc Screenshotter (Next.js dev copy) | `doc-screenshotter/` (port 3020, not deployed) |

---

## 7. Quick how-to

| I want to… | Open this |
|---|---|
| Add a new tool | `admin.html` — copy a tool-card block, add toolmap entry, append JS functions before the final `</script>` |
| Change the password | `admin.html:2319` (`const ADMIN_PW`) |
| Add a `/api/*` endpoint | `transcriber/server.js` |
| Change Railway port routing | `translate/nginx.conf` |
| Rebuild the deployed image | `translate/Dockerfile` |
| Find a tool's code by name | Run `./find-tool.sh <tool-id>` (uses `tools-index.json`) |

---

## 8. Companion files

- `tools-index.json` — machine-readable map of every tool, its line ranges, JS prefix, and backend endpoints. Source of truth that this MD file mirrors.
- `find-tool.sh` — small shell script that takes a tool id and prints the relevant code locations + line ranges.
