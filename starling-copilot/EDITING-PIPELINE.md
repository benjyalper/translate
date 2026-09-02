# Starling Copilot — the editing & verification pipeline

A single-page reference for what happens to a translation between the moment a segment
is read and the moment it is confirmed & submitted in Starling. The emphasis is on the
**editing / QA transformations** — full stop, whitespace, the blue `↵` newline,
placeholders, and the Hebrew-specific rules.

> **Guiding principle:** *edges are mirrored from the source, interiors are cleaned.*
> Starling's QA panel penalises a target whose trailing period, edge spaces, or newline
> don't match the source — so the tool **forces** them to match rather than trusting GPT.

---

## The three layers

Every proposal passes through three independent layers, so a mistake at one layer is
caught by the next:

| Layer | Where | What it does |
|------|-------|--------------|
| **A · GPT rules** | system prompt | Instructs the model (spacing, number position, bold, brands…). |
| **B · `polish()`** | `panel.js`, deterministic | Cleans GPT's output *before you ever see it*. Runs regardless of what GPT did. |
| **C · Write-time** | `content.js`, at the keystroke | Re-reads the **live source** and re-mirrors edges/newlines as the text is typed in. |

Layer C means that even if GPT *and* the polish step both dropped a trailing space or `↵`,
the value written into Starling still matches the source.

---

## The full sequence, stage by stage

### 1 · Harvest (read)
- Reads the task's segments (source + current target).
- **"Only segments"** box scopes the run: blank/`all`, single (`8`), range (`10-20`),
  list (`5,8,12`), or a mix (`3-6,10`).
- **Plural segments are skipped here** — their cell renders all sub-forms as one blob, so
  they're handled exclusively by the Plural card (see §7).
- Source **edge whitespace is re-attached** at read time (Starling trims it in the DOM),
  so the proposal already carries the source's leading/trailing space and `↵`.

### 2 · GPT propose (Layer A)
Runs your OpenAI key over the segments to **proofread** or **translate**. In proofread mode
it also **fills empty targets**. The system prompt enforces the house style:

- Gender-neutral Hebrew plurals.
- Preserve every placeholder / tag byte-for-byte.
- Keep markdown `**bold**` markers.
- **No space before** `.` `,` `:` `;` `!` `?`; no double spaces; no stray edge spaces.
- **Hebrew number position** for counted nouns (see §A).
- **Status-label verbs** (e.g. "Last updated" → `עודכן לאחרונה`, not the noun form).

### 3 · `polish()` — deterministic cleanup (Layer B)
The raw GPT string is run through a fixed chain **before it is shown in the review list**.
Execution order (inner → outer):

```
polish(src, out) =
  mirrorEdges(src,
    matchTrailingPeriod(src,
      fixBold(src,
        fixAmounts(src,
          fixBrands(
            fixSpacing(out))))))
```

| # | Step | What it guarantees |
|---|------|--------------------|
| 1 | `fixSpacing` | No space before punctuation; no double spaces; **no stray spaces hugging a `\n`** (`"word \n"` → `"word\n"`). |
| 2 | `fixBrands` | Brand names restored to their canonical form. |
| 3 | `fixAmounts` | Numbers / currency normalised. |
| 4 | `fixBold` | If the source has `**bold**` markers, the target keeps them in place. |
| 5 | `matchTrailingPeriod` | **Mirrors the source's sentence-final `.`**, tag-aware: adds it if the source has one and the target doesn't; removes a stray one if the source has none. Placed *before* any trailing tag/space. |
| 6 | `mirrorEdges` | Strips the target's own edge whitespace and replaces it with the **source's exact leading + trailing whitespace** (spaces *and* newlines). |

### 4 · Review & the ⚠ badges
Each row shows the proposal with an *apply* checkbox and per-row **Copy** / **Write**
buttons (`Changed only` / `All` / `None` filters). Detection badges warn you *why* text
was adjusted, so nothing changes silently:

- **⚠ spacing** — fires when `hasSpacingIssue` sees a double space or a space-before-
  punctuation, **or** `edgeMismatch` sees an edge (space or newline) that differs from the
  source.

Tag-classification decides whether a row can be auto-written (see §6).

### 5 · Write-back (Layer C — the guarantees at the keystroke)
When you write an approved row into Starling:

- **Edge re-mirroring (`mirrorRowEdges`)** — the tool re-reads the row's **raw source
  cell** (no trim, so newlines survive) and re-applies its exact leading/trailing
  whitespace onto what it types. This is the last-line defence for the blue `·` space.
- **The blue `↵` newline (`insertText` + Enter-keydown)** — a trailing/internal `\n`
  **cannot** be typed through the normal insert path (Starling's editor discards it as an
  empty block). Instead the text is **split on `\n`** and the tool **presses Enter** (a real
  key event) between the parts, which makes the editor create a genuine newline token that
  **saves and persists** (the `↵` goes green in QA). Handles trailing *and* internal breaks.
- **Placeholders re-chip** — typed `{tokens}` / `<tags>` are auto-converted back into
  Starling's protected chips.

### 6 · Tag classification (what gets auto-written vs copied)
| Kind | Example | Behaviour |
|------|---------|-----------|
| **String placeholder** | `{0}`, `{s_number}`, `%s`, `<g id>` | Safe to **auto-write** (preserved byte-for-byte, re-chipped). |
| **Real chip object** | rendered tag chip in the cell | **Copy-by-hand** — typing would clobber the chip. |
| **Numbered tags** | `O-1-0` … `C-1-0` | **Per-run Copy** buttons (paste each run between its tags). |

### 7 · Plural segments (ICU `one/two/many/other`)
Handled by the dedicated **Plural card**, not the normal flow:
- **Scan** reads every sub-form via the data API (no blob problem).
- **Propose** is *form-aware*: it tells GPT which item is the CLDR `one` form vs the plural,
  because the English is often identical for both.
- **Write** fills each sub-form's box individually.
- Honours the "Only segments" filter.

### 8 · Confirm all (API, zoom-proof)
Standalone — **no Harvest/GPT needed**. Confirms every unconfirmed segment
(`targetText.status ≠ 3`, non-empty target) straight through Starling's API
(`confirmTextTaskTargetV2`), with "ignore normal QA errors" on. Then **auto-reloads the
tab** so the row `✓✓` re-read from the server and turn green.

### 9 · Submit task (DOM, zoom-proof)
The final submit has no capturable HTTP endpoint (it rides a WebSocket/internal channel),
but its UI is fully text-labelled, so it's driven by **text-matched DOM**:
`Submit task` → `Submit all translations` → confirm the *"Please carefully check…"* modal's
primary **Submit task** button. Verifies by polling for the header button to flip to
**"Task submitted."** Asks first (it delivers to the requester).

---

## Appendix A · Hebrew number position (counted nouns)
Correct word order around a count placeholder differs by grammatical number:

| Form | Order | Example |
|------|-------|---------|
| `one` / singular | **noun → number** | `שעה {n}` · `אדם {s_number}` |
| `two` / `many` / `other` | **number → noun** | `{n} שעות` · `{s_number} אנשים` |

Enforced both as a GPT rule and, in the Plural card, per-form (`plPropose` labels
item 1 = `one`, item 2 = plural).

## Semantic-accuracy layer (terminology · context · QA)

Layers A–C above protect *mechanics* (spacing, edges, placeholders). A separate set of
rules protects *meaning* — the principle is **terminology guides translation, it does not
override meaning**, and **consistency means "same meaning + same context → same target",
not "same English letters → same Hebrew everywhere".**

**Term base → GPT.** Each harvested term is sent to the model as
`{en, he, pos, definition}` (the Starling definition is now included when it exists).
The prompt tells the model a term applies **only** when the occurrence's *sense* and
*part of speech* match the definition/POS — a surface word-match is not proof. Multi-word
terms are listed first, so *"due to"* outranks *"Due"*. Worked examples baked into the
prompt: *Due→לתשלום* must not fire on *"due to"* (= because of → עקב); *Application→הגשת
בקשה* must not force *הגשת* into *"verification application"* (→ בקשת האימות); a **noun**
*Highlight* must not be forced onto *"Highlight the section"* (a verb → הדגש/י).

**Term enforcement is flag-only.** `lockCheck`, `tbCheck`, and `consistCheck` never rewrite
text — they raise review badges. The only text-mutating post-steps are memory, dedupe, and
the curated Hebrew→Hebrew `Auto-fix` dictionary. **No stage does EN→HE term substitution**,
so a correct contextual translation can never be turned into a surface-matched term.

**Context-aware memory & dedupe.** For a *short* source (≤ 3 words — "Save", "Due",
"Following") identical source text is **not** treated as identical meaning: a differing
memory becomes a review *suggestion* (it no longer overwrites GPT's contextual choice), and
same-source dedupe only auto-aligns occurrences that share a **context** (key module +
translator note). Long, unambiguous sentences still match on source alone. New memory
entries store `key`/`ctx` so future short-string matches can check compatibility; legacy
entries (no context) keep working as lower-confidence suggestions.

**Placeholder guard (`phCheck`).** After translation, a deterministic check compares the
protected-token multiset (`{x}`, `{{x}}`, `%s`, `<tag>`, ①②③) between source and target;
any drop/add/alteration raises a red **⚠ placeholder guard** badge. Corruption is never
silently accepted.

**Independent GPT QA (optional).** With **🔎 Independent GPT QA** on (Settings), a second
model reviews each translation against the same evidence and returns structured JSON
(`OK` / `FIX` + issue type). A `FIX` is applied only if it keeps every placeholder intact;
otherwise it's flagged, not applied. If the reviewer call fails, the original translation is
kept and marked **🔎 QA n/a** — a translation is never lost. Off by default (~doubles cost).

**Screenshots (optional, beta).** With **📷 Use screenshots as GPT context** on and a
vision model configured, a segment's Starling UI screenshot is fetched inside the Starling
tab (credentialed, base64-inlined — no token leaves the browser) and attached as extra
context. Any failure falls back to text-only.

**Diagnostics.** `scDebug(true)` in the panel console logs, per segment, the terms +
definitions supplied, context fields, screenshot availability, and reviewer outcome. Keys
and tokens are never logged.

## Appendix B · Net result
By the time a segment is written and confirmed, all of the following match the source or
the house style — i.e. exactly the set of things Starling's QA penalises:

- ✅ trailing full stop
- ✅ internal spacing (no space-before-punctuation, no double spaces)
- ✅ edge spaces (the blue `·`)
- ✅ trailing & internal newlines (the blue `↵`)
- ✅ `**bold**` markers and placeholders intact
- ✅ Hebrew counted-noun order
- ✅ status-label verbs

## Appendix C · Versioning / reload
`content.js` carries `CS_VERSION`; `panel.js` a matching `CS_EXPECT` — bumped together.
After a content-script change: reload the extension **and Ctrl+R the Starling page**
(an already-open tab keeps running the old content script until reloaded). The connection
badge shows the live version (e.g. `v29`) and warns when the tab is stale.
