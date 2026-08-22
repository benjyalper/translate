# Starling Copilot — User Manual

**English → Hebrew (he-IL) translation assistant.** A Chrome side-panel that harvests a
CAT task's segments, proposes Hebrew with GPT (guided by *your* accumulated knowledge),
lets you review, and writes the approved text back. This manual explains **every button in
the brains and corpus**, and — most importantly — **how each one changes the Hebrew you get
and the judgments the tool makes.**

> Nothing here ever auto-submits a task. "Submit" is always a separate, deliberate click.

---

## 1. The mental model — five brains + one corpus

The copilot's intelligence is **six stores**. Five are hand-curated "brains"; one is a
read-only history mined from your finished work.

| Store | What it holds | When it acts |
|---|---|---|
| 🧠 **Style Brain** | House rules + a glossary (advisory EN→HE) | Injected into the GPT prompt — shapes what GPT writes |
| 🧩 **Consistency memory** | Every source you've written → the exact Hebrew you used | *After* GPT — swaps in your prior wording so identical sources stay identical |
| 🔒 **Locked terms** | Mandatory EN→HE pairs (non-negotiable) | Both in the prompt **and** as a post-check flag — outranks everything |
| 🩹 **Auto-fix** | Deterministic HE→HE find-and-replace rules | *After* GPT — mechanical corrections (e.g. plural imperative → your slash form) |
| ＃ **Plural memory** | Remembered CLDR form-sets (one/two/many/other) | Pre-fills the 🔢 Plurals tool so it doesn't re-ask GPT |
| 📦 **Corpus** | A concordance mined from all your Submitted tasks | Feeds 🔎 Lookup and can *promote* reliable pairs into memory/locked/glossary |

### How a translation is actually decided (the pipeline)

Every time you press **✨ Run**, each segment flows through this exact order. Knowing the
order tells you *who wins* when two brains disagree:

```
1. GPT proposes Hebrew         ← guided by Style Brain + Locked terms (in the prompt)
2. Consistency memory applied  ← if you've written this source before, your wording replaces GPT's
3. Auto-fix applied            ← deterministic HE rewrites run on the result
4. Locked-term post-check      ← flags any segment missing a mandatory term (never auto-edits)
5. Consistency sanity check    ← flags in-task term drift (never auto-edits)
   → the Review list, with badges telling you what happened to each row
6. You review / edit / approve
7. Write to Starling → each written segment is REMEMBERED (feeds step 2 next time)
```

**Precedence in one line:** 🔒 Locked **>** 🧩 Memory **>** 🩹 Auto-fix **>** GPT, with the Style
Brain glossary as advice GPT usually follows but can inflect. The 📦 Corpus never edits
anything live — it's history you consult and promote from.

---

## 2. ⚙️ Settings (top of the panel)

| Control | What it does | Effect |
|---|---|---|
| **OpenAI key** field + **Save** | Stores your API key locally (used only for your own tasks) | Required before any GPT Run |
| **Model** dropdown | `gpt-5.4` (default) or `gpt-5.4-mini (cheap draft)` | Mini is faster/cheaper, lower quality — use for rough drafts |
| **House style → Plural form (לשון רבים)** checkbox | **Off (default)** = singular gender-neutral slash forms (לחץ/י), the TikTok default. **On** = plural | Changes the register GPT targets and how Auto-fix normalizes |
| **↩ Sheet → Starling engine** | Which engine the write-back mode uses | Only relevant to the Sheet→Starling mode |
| **Crowdin token** + **Save** | Auth for the Crowdin mode | Only for 🌐 Crowdin |
| **Advanced · selector overrides (JSON)** + **Apply selectors** / **Run diagnostics** | Overrides the DOM selectors the content script uses; diagnostics reports what it can see on the page | Only touch if harvesting/writing breaks after a Starling UI change |

---

## 3. 🔎 Lookup — "how do I normally translate this?"

A live search box (**type ≥2 characters**, English or Hebrew) that shows how a word or
phrase is handled across **all six stores at once**. It **reads only** — it changes nothing.

### What each result block means

- **📦 Corpus** — the richest signal. Leads with a **stats bar** (see below), then example
  source→target pairs. Each example has a **↗ task** button that opens the actual Starling
  task the example came from.
- **🧩 Consistency memory** — an exact remembered pairing (if any) plus near matches.
- **🧠 Glossary / 🔒 Locked** — matching advisory and mandatory terms.
- **🩹 Auto-fix** — matching HE→HE rewrite rules.

### The corpus stats bar (variant distribution)

For an English term, the top of the corpus block shows **every Hebrew rendering and its %
share**, biggest first, e.g.:

```
family pairing → in 24 segment(s) · 11 task(s)
  חיבור משפחתי   ████████████  55% · 13
  קישור משפחה    ██████        30% · 7
  צימוד למשפחה   ██             8% · 2
  + 2 rarer variants
```

- **% = share of all occurrences** in the corpus. Use it to see which rendering is really
  your house norm before locking it in.
- **Clitic folding:** forms that differ only by a leading clitic (**ו ב ה ל כ מ ש**) are
  **counted as the same variant**. So `קישור משפחה` and `לקישור המשפחה` are one row (count 2),
  not two slivers. The clitic is shown in **orange** and not counted.
- The folding is **data-driven, not blind stripping**: a leading letter is folded/coloured
  only when the same word also appears *without* it elsewhere. So the definite **ה** of
  *המשפחה* folds to *משפחה*, but the root **מ** of *משפחה* (never seen as *שפחה*) is left
  completely alone. In rare cases where a term genuinely has both a מ/ש/כ-initial rendering
  and its stripped cousin as competing translations, they'd merge — this essentially never
  happens in real data.

### Set your preferred translation (buttons that appear for English queries)

At the bottom, a **preferred Hebrew** field (pre-filled with the corpus's dominant surface):

| Button | What it does | Effect on future work |
|---|---|---|
| **➕ Glossary** | Adds `EN → your Hebrew` to the Style Brain glossary | **Advisory** — GPT will prefer it and inflect it naturally. Best for slash forms (אפוטרופוס/ית). |
| **🔒 Lock** | Adds `EN → your Hebrew` to Locked terms | **Mandatory** — GPT must use it, and any run missing it is flagged. |

Both set the preference **going forward only** — they do **not** rewrite past corpus/memory.
A clash (the term already maps elsewhere) is reported instead of silently overwriting.

---

## 4. 🧠 Style Brain — rules + glossary

The Style Brain is **advice injected into the GPT prompt**. It's how you teach tone,
register, and preferred terminology so GPT writes the way you would. It does **not**
mechanically edit output (that's Auto-fix); it *steers* GPT.

Two parts: **rules** (free-text house style) and a **glossary** (advisory EN→HE terms).

| Button | What it does | Effect |
|---|---|---|
| **Distill & review** | Runs GPT over ingested source text to extract generalizable rules + term pairs, then shows them for you to merge | Grows the brain from examples; nothing is added without your review |
| **⬇ Grab from active tab** | Reads the text of a Lark/Feishu style doc open in the active tab, to distill from | Feeds the distiller from a live doc |
| **Export** | Downloads the whole brain as JSON | Back up / commit to git |
| **➕ Add a rule / term manually → Add rule** | Adds one free-text house rule | That rule goes into every GPT prompt from now on |
| **➕ Add a rule / term manually → Add term** | Adds one advisory EN→HE glossary pair | GPT prefers this Hebrew and inflects it |
| **Clear ingested brain** | Removes all ingested rules/terms (the built-in style guide stays) | Resets your additions; the baseline he-IL guide remains |

### 📚 Learn from a Starling task (inside the Style Brain card)

Turns a **finished, proofread-confirmed** task into training signal — your confirmed pairs
are the best learning data because they're *your* accepted wording.

| Button | What it does | Effect |
|---|---|---|
| **⬇ Harvest** | Reads a submitted task's confirmed source→target pairs | Loads them as candidate learning material |
| **➕ Add pairs to memory** | Puts every harvested approved pair into **Consistency memory** | Those exact sources will auto-fill your wording next time. A source already remembered with a *different* target is **not** overwritten — it's parked in **⚠ Conflicts** to adjudicate. |
| **🧠 Distill rules & terms (review)** | GPT generalizes rules + term pairs from the pairs, for review→merge | Grows the Style Brain from real work; clashes go to ⚠ Conflicts |

---

## 5. 🧩 Consistency memory — "same source, same Hebrew"

Every segment you **write** is remembered as *source → the exact Hebrew you used*. The next
time that identical source appears, your prior wording is filled in so the translation stays
identical across the whole app. This is the store that acts **after** GPT (pipeline step 2).

**How it affects a judgment:** if GPT proposes something **different** from what you
remembered, that row is left **unchecked** and badged **🧠 memory — review**, so you confirm
it deliberately. A remembered *mistake* never re-applies silently — and if you edit the row
and write your corrected version, the memory is **overwritten** with the new wording.

| Control | What it does | Effect |
|---|---|---|
| **Apply remembered wording to new translations** (toggle) | Master switch for the whole store. **Default: OFF** (data is kept, just not applied) | Off = GPT's wording stands; On = your remembered wording replaces GPT's on exact-source matches, and identical sources within one task are aligned |
| **🧠 Suggest near-matches (fuzzy)** (toggle) + **match threshold** | When there's no *exact* match, offer the closest prior translations (template + fuzzy Dice ≥ threshold, default 80%). **Default: OFF** | **Review-only** — near matches appear under a row with a **use** button; nothing is applied automatically |
| **➕ Add a remembered pair manually → Remember** | Manually store a source → target pairing | Same effect as if you'd written it |
| **Export** | Download the memory as JSON | Back up / move machines |
| **Clear memory** | Forget every remembered string (**password-gated**, can't be undone) | Wipes the store |

### Intra-task alignment (automatic, safe)

When the toggle is **On** and the *same full source* appears more than once in one task, all
its rows are aligned to **one** Hebrew by **majority vote** (the rendering GPT produced most
often; a remembered wording still outranks the vote; ties break to the earliest segment).
These rows are badged **🧠 same-as-above**. The run summary reports `🧠 N aligned` separately
from `🧠 N from memory`.

---

## 6. 🔒 Locked terms — the mandatory glossary

A "must" glossary of EN→HE pairs that **outranks every other store**. Enforced two ways:

1. **In the prompt** — each term is injected as **NON-NEGOTIABLE**: GPT may only add a Hebrew
   prefix (ב/ל/ה/מ/ו/ש/כ) and inflect for grammar; it may never substitute a synonym or reword.
2. **Post-check (flag-only)** — after a Run, any segment whose source contains the term but
   whose target is **missing** the required Hebrew gets a red **🔒 locked term** badge. It
   **never auto-edits** (so it can't corrupt Hebrew inflection); you fix the row by hand and
   the flag clears live. The match tolerates a fused prefix and the definite-ה drop
   (ההגדרות→בהגדרות).

**Locked beats memory:** if a stale remembered target would violate a locked term, the locked
term wins and the clash is parked in **⚠ Conflicts** for a one-time decision.

| Button | What it does |
|---|---|
| **Lock term** | Add one mandatory EN→HE pair |
| **Export** | Download locked terms as JSON |
| **Clear locked terms** | Remove all (password-gated) |

**Glossary vs Locked — which to use?** Glossary = *advisory* (GPT prefers it and inflects
freely — good for slash forms). Locked = *mandatory* (flags any run that's missing it — good
for brand names and fixed terminology that must never drift).

---

## 7. 🩹 Auto-fix — deterministic HE rewrites

A curated **dictionary** of Hebrew find-and-replace rules applied to every target **after**
GPT and after memory/locked checks (pipeline step 3). It's a dictionary, **not** morphology,
because Hebrew imperatives are irregular — you lock in both sides so each fix is correct by
construction (e.g. `שלמו → שלם/י`, `הצטרפו → הצטרף/י`, `נסו → נסה/י`).

- **Whole-word** (Hebrew-boundary) match; an optional leading **ו** is preserved
  (והצטרפו → והצטרף/י).
- Every change is badged **✎ auto-fixed** on the row and is reversible by editing the text.
- Seeded with a starter set on first load; stays cleared if you clear it.

| Control | What it does |
|---|---|
| **Auto-fix** master toggle | Turn the whole rewriter on/off |
| **Add rule** | Add one `from → to` HE rewrite |
| **Export** | Download rules as JSON |
| **Clear rules** | Remove all (password-gated) |

---

## 8. 📦 Corpus — the concordance from your finished work

The corpus batch-reads **every Submitted task's proofread-confirmed segments** and aggregates
them: for each source it records the distinct target variants, how often each occurred, and
across how many tasks. It's **read-only history** — building it never changes a live
translation. It powers 🔎 Lookup and 🔤 Phrase mining, and you can *promote* its reliable
findings into the acting brains.

| Button / control | What it does | Effect |
|---|---|---|
| **⟳ Update — add new Submitted** | Reads only the **newly** Submitted tasks; never re-reads what's already indexed (ignores "Rebuild from scratch") | The fast, routine way to keep the corpus current |
| **📦 Build corpus from Submitted tasks** | Same incremental read, but **honours** the "Rebuild from scratch" checkbox | Use for a normal build; tick Rebuild only to start over |
| **Rebuild from scratch** (checkbox) | Ignore everything already indexed and re-read every Submitted task | Slow; only when the index is stale/corrupt |
| **+ In-progress ≥95%** (checkbox) | Also harvest In-progress tasks that are ≥95% proofread-confirmed (only their confirmed segments) | Pulls in near-finished work; sub-95% tasks are re-checked on a later build |
| **🗄 Backup all brains** | Downloads a full JSON snapshot of **every** store — Style Brain, Consistency memory, Locked terms, Auto-fix, Plural memory, **and** the corpus index | Your rollback safety net; a Promote auto-downloads one first |

> **Yes — "Backup all brains" includes consistency, style, locked, auto-fix, plural, and the
> corpus.** It's a complete snapshot.

### 🔤 Phrase mining (inside the Corpus card)

| Button | What it does | Effect |
|---|---|---|
| **🔤 Mine phrases from the corpus** | Scans the corpus for EN phrases you translate consistently (≥3 tasks, dominant rendering) vs. ones that **drift**, and proposes short terms to promote | Turns raw history into candidate glossary/locked terms; **Promote** sends the reliable ones into memory/locked (with a backup first). Anything that clashes with an existing entry becomes a **⚠ Conflict**, never a silent overwrite |

---

## 9. ⚠ Conflicts to resolve

The single adjudication queue. Whenever two stores would disagree — a glossary/locked term
mapping the same English to a different Hebrew, or a remembered source gaining a second
target, or a locked-vs-memory clash — nothing is silently overwritten. It's parked here as an
orange card. The values are **editable**: fix the wording if neither side is quite right,
then pick the side that wins; the other entry is removed. ("Newest wins" is retired — you
always decide.)

---

## 10. The 🐦 Starling workflow (steps 1–5)

This is the main mode. The brains above all feed into it here.

### Step 1 · Load segments

| Control | What it does |
|---|---|
| **⬇ Harvest from this tab** | Reads the open Starling task's segments (via its API, so virtualized/off-screen rows are included) |
| **Only segments** filter | Restrict to numbers/ranges (`10-20`, `5,8,12`) **or** a term matching the source/target/key (`Family Pairing`), mixable |

### Step 2 · Process with GPT

| Control | What it does | Effect |
|---|---|---|
| **📑 Proofread targets** / **🌐 Translate src → HE** (radio) | Proofread existing Hebrew, or translate from scratch | Sets the task GPT performs |
| **Proofread ⚠ tagged too** (checkbox) | Include tagged/chip segments in proofreading | They're still copy-by-hand (never auto-written), but you get a suggestion |
| **Translate empty targets too** (checkbox) | In proofread mode, also translate empty targets and write them in | Fills blanks; badged **＋ new** |
| **✨ Run** | Runs the whole pipeline (§1) and opens the Review | Produces the proposals |

### Step 3 · Review & approve

Click any Hebrew target to **edit** it — your edited text (badged **✎ edited**) is what gets
written, confirmed, and remembered.

**View filters** (mutually exclusive):

| Filter | Shows |
|---|---|
| **Changed** | Only segments GPT changed (unchanged rows are dimmed/hidden) |
| **All** | Every segment (unchanged ones appear greyed at 50% — informational "no change needed") |
| **✋ Paste by hand** | Only tagged/chip rows you must copy in by hand |
| **🧠 Memory — review** | Only rows where your remembered wording differs from GPT (left unchecked to confirm) |
| **⚖ Consistency** | Only in-task term-drift flags (see below) |

**✓ all / ✓ none** tick or untick the *apply* boxes (tagged rows stay copy-by-hand either way).

**Review badge legend** — each badge tells you what the pipeline decided:

| Badge | Meaning |
|---|---|
| **🧠 memory** | GPT already matches your remembered wording — consistent |
| **🧠 memory — review** | Memory differs from GPT → set to your remembered version but **unchecked**; confirm or edit |
| **🧠 same-as-above** | Identical source repeated in this task → aligned to one wording by majority vote |
| **＋ new** | Target was empty → translated and will be written with the rest |
| **⚠ chip / ⚠ tag** | Real inline tags — **copy by hand**, never auto-written (use the per-part Copy buttons) |
| **⚠ placeholder** | Text placeholder ({0}, %s, \<g\>) kept byte-for-byte — safe to write; eyeball it |
| **⚠ number / ⚠ brand / ⚠ bold / ⚠ spacing** | Source detail (amount, product name, **bold**, spacing) not preserved — check it |
| **⚠ register** | GPT flagged a register issue (e.g. imperative where a button noun fits) |
| **🔒 locked term** | A mandatory locked term is missing from the target — fix by hand; clears live |
| **✎ auto-fixed** | An Auto-fix rule rewrote the text — edit to revert |
| **🧠 N near-matches** | No exact memory, but N fuzzy suggestions are shown below with **use** |
| **⚖ consistency: \<term\>** | This term was translated differently on its own elsewhere in the task — **flag only**, plus a **🔒 lock** button to fix it forever |

#### ⚖ In-task consistency sanity check

After every Run, the tool builds a mini-glossary from this task's **standalone-label**
segments (a short source translated on its own = the term's citation form), then flags any
*other* segment that uses that term but whose Hebrew doesn't match. It **never rewrites**
(Hebrew inflects — a blind swap could break grammar); it only flags, and only for multi-word
or ≥5-letter terms (single short words are too ambiguous). Each flag offers a **🔒 lock**
button that promotes the pairing to a mandatory Locked term so it can't drift in future tasks.

### Step 4 · Write back & confirm

| Button | What it does | Effect |
|---|---|---|
| **↩ Write approved to Starling** | Types each approved, non-tagged target into its cell, then **server-verifies** it persisted (re-reading the task uncached); any segment the DOM write didn't persist is **rescued via the API** | The write is honestly reported per segment (`dom` / `api` / failed); newly-written translations are called out. **Every written segment is remembered.** |
| **⚡ Write · Confirm · Submit** | Write, then confirm, then submit in one go | **Irreversible submit** — delivers the task to the requester. Use only when you're certain. |

### Step ✓ · Confirm all / Submit

| Button | What it does |
|---|---|
| **✔ Confirm all (ignore normal QA)** | Confirms every row, bypassing Starling's normal QA gate |
| **➤ Submit task** | Submits the task (irreversible delivery) |

### Step 5 · QA summary

| Button | What it does |
|---|---|
| **📋 Read QA warnings** | Reads Starling's own QA warnings for the task so you can clear them before confirming |

### ＃ Plural segments (one·two·many·other)

| Button | What it does | Effect |
|---|---|---|
| **🔢 Scan plurals** | Finds plural segments; a remembered CLDR form-set (from **Plural memory**) pre-fills straight in — no GPT | Fast, consistent plural handling |
| **✍ Write approved plural segments** | Writes each sub-form (one/two/many/other) into Starling | Only after you review |

---

## 11. 💰 Word count & pay

Reads your Starling **My tasks** list and sums the **Weighted word count** column, × your rate.

| Control | What it does |
|---|---|
| **Rate** | Your per-weighted-word rate |
| **Tasks** dropdown | All / Submitted / In progress (Closed is always excluded) |
| **By month of \<field\>** dropdown | Groups a **monthly breakdown** table (tasks · weighted words · pay per month) by a date column. The column is **auto-detected** (prefers a "first submitted"-style field); switch it here if the guess is wrong. Respects the Tasks filter. |
| **🔄 Compute from My Tasks** | Runs the read and renders the totals + status breakdown + monthly table |

So to see *all tasks submitted in July summed, August summed*, etc.: set **Tasks = Submitted**,
pick the first-submitted date column in **By month of**, and read the Month table.

---

## 12. Other CAT modes (same brains, different host)

The top row switches the host CAT tool. **⚖️ Feishu LQA**, **↩ Sheet → Starling**, **🌐 Crowdin**,
**🅜 memoQ**, and **🐱 YiCAT** each follow the same shape — *connect/detect → harvest → GPT
proposals → review → write/copy* — and they **reuse all the same brains** (Style Brain,
memory, locked terms, auto-fix) so your terminology and style stay identical everywhere. Each
has an **ℹ️ How … works** expander in-panel with its specifics. Feishu LQA additionally
**learns from your validated rows** (→ Consistency memory and → Distill brain), closing the
loop back into the brains.

---

## 13. Backups & restore

- **🗄 Backup all brains** (Corpus card) — one JSON with every store + the corpus. Keep these;
  a phrase-mining Promote auto-downloads one first, and Restore backs up the current state
  before overwriting.
- Each brain also has its own **Export** for a single-store backup.
- **Restore** (full-backup file) replaces every store with the snapshot — with a safety backup
  of the current state taken first.

---

## 14. Quick answers

- **How do finished tasks get into the corpus?** Submit them in Starling, then press **⟳
  Update — add new Submitted** (don't tick "Rebuild from scratch"). Optionally **Promote** via
  phrase mining to push reliable pairs into memory/locked.
- **Why is a review row greyed out?** It's *unchanged* — GPT's suggestion already matches the
  cell, so there's nothing to write. Switch to the **Changed** filter to hide these.
- **Memory vs Glossary vs Locked?** Memory = your exact past wording, applied after GPT.
  Glossary = advice GPT prefers and inflects. Locked = mandatory, outranks all and flags if
  missing.
- **Will anything auto-submit?** No. Writing and confirming are separate from submitting, and
  submitting is always a deliberate click.
