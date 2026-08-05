# TikTok Hebrew (he-IL) Style Guide — working reference

Distilled from the official **Hebrew Style Guide** (Feishu / Lark:
`bytedance.sg.larkoffice.com/docx/AdLvdq9eOon3Bjxb0wHc16TXn5d`, last modified Jan 2026).
This is the reference the Starling Copilot bakes into its GPT prompts for the **TikTok**
modes only — **🐦 Starling** (proofread/translate + plural card), **⚖️ Feishu LQA**, and
the GPT/QA step of **↩ Sheet → Starling**. It is **not** applied to memoQ / Crowdin (those
are other clients). When the guide and a project's own approved "Suggested"/final conflicts,
the human-approved final wins.

---

## Voice & tone
- Inclusive, approachable, conversational, clear, **casual**. We're secondary to the content.
- Four principles: **keep it short · keep it natural · be consistent · be inclusive.**

## Register
- **Medium-low register** — always prefer the lower/natural option that still sounds natural.
- Avoid high-register words:
  | Avoid | Use |
  |------|-----|
  | אנו | **אנחנו** |
  | כעת | **עכשיו** |
  | אודות | **על** |
  | עבור | **ל־** |

## Form of address (default = singular, gender-neutral, slashes)
- Use the **singular** second person, gender-neutral, with a **slash** for both genders:
  `לחץ/י`, `את/ה`, `בחר/י`. **Do not** use the plural form of address, and **do not** use the
  masculine-singular alone.
- Put the **final letter (אות סופית) *before* the slash**: `לחץ/י` (not `לח/יץ`).
- If the masculine and feminine **suffixes differ, write both words in full** so the feminine
  isn't malformed: `התחל/התחילי` (not `התחל/י`).
- Use the **imperative** when the source is imperative (not the plural "cookbook" style):
  `Click here to start` → `לחץ/י כאן כדי להתחיל`.
- **Plural (לשון רבים)** remains a **toggle** in the panel for other clients that require it
  (`הצטרפו`, `לחצו`, `קראו`) — off by default for TikTok.

## Context overrides the address form
- **Buttons / labels / titles → gerund (שם פעולה)**, *not* infinitive, *not* imperative:
  `Save` → **שמירה** (not `לשמור`, not `שמור/שמרי`). Titles: short, **no trailing period**.
  `Save new items` → `שמירת פריטים חדשים`.
- **Tooltips / inline instructions → conjugated verb** (slash form for 2nd person):
  `Record your ending` → `הקלט/הקליטי את הסיום`.
- **UI-element references → bold** the element's name (don't wrap it in quotes):
  `Remove from Saved` → `הסרה מ**פריטים שמורים**`.
- **Error messages → neutral, helpful** tone. No blaming words like "failed"/`נכשל`; don't
  assign fault.

### Deciding the role (gerund vs imperative — the "Save" dilemma)
The same English verb maps to different Hebrew depending on where the string sits. The prompt now
decides in a **priority order**:

1. **Key + Context (🐦 Starling only, when harvested — see "Segment context" below).** A key suffix
   like `_title`/`_desc`/`_btn`/`_toast` or a translator note usually settles the role outright,
   and GPT does **not** flag when it does.
2. **Source signals** (the fallback, and the *only* path for ⚖️ Feishu LQA, which has no key/context):

| Signal in the source | Role | Hebrew | Example |
|---|---|---|---|
| Short Title-Case fragment naming an action/feature; no object, no "your", no sentence punctuation | title / button / label / menu / tab / setting | **gerund** | `Save` → `שמירה`; `Save new items` → `שמירת פריטים חדשים` |
| Has a direct object (often "your…"), a "to…" purpose clause, or is a full imperative sentence | tooltip / inline instruction / CTA / body | **imperative slash** | `Save your changes` → `שמור/שמרי את השינויים` |
| Bare verb, no other signal (`Save`, `Share`, `Follow` alone) | usually a button | **default to gerund** | `Save` → `שמירה` |

- **Proofread mode never flips a *valid* register** just because the source is a bare verb — if
  the existing target is defensible for a plausible role, keep it.
- **When neither key/context nor source signals settle it**, GPT returns its best guess **and flags
  it** rather than silently guessing (see "Adjudicating dilemmas" below).

### Segment context (🐦 Starling — harvested from the "Translation Information" panel)
The harvest joins each segment to the `getSourceTextListWithTargetText` API row (`seg` === `RankNo`)
and passes three extra fields into the GPT payload — so the model decides with the same context a
human sees, not just the English string:
- **`key`** — the resource key; its suffix hints at the UI role (`_title`/`_desc`→gerund,
  `_btn`/`_cta`→gerund button, `_toast`/`_tooltip`→imperative, an enum namespace like
  `reasonForDispute`→short noun option).
- **`context`** — the string owner's translator note (`sourceText.textComment`); treated as
  **authoritative** guidance (meaning, intent, what a term does/doesn't mean, which tokens are vars).
- **`fullSource`** — the complete original string when `src` is only a split fragment; GPT reads it
  for context but translates **only** the fragment.
- **Screenshot** — also harvested (byteimg CDN URL + crop rect) but shown to the *human* on the card
  (📷 link), not sent to GPT.

These are omitted when empty, and absent entirely for XLIFF/YiCAT/Crowdin and ⚖️ Feishu LQA, which
fall back to the source-signal path above.

### Adjudicating dilemmas (the `flag` escape hatch)
When the role can't be resolved (no key/context and the English is ambiguous), real coin-flips are
surfaced to the human instead of hidden:
- **🐦 Starling** response schema carries an optional `"flag"` field. When set, the review card
  shows a **`⚠ register`** chip whose tooltip is GPT's note (e.g. *"Save: gerund if a button,
  imperative if a tooltip — assumed button"*). You adjudicate with the on-screen context, then
  edit the card if the guess was wrong before writing back. With key/context now harvested, flags
  should be rare.
- **⚖️ Feishu LQA** (no key/context) doesn't mark a defensible register choice invalid when the role
  is unknowable (treats the flag as a false positive); when it *does* change register it writes the
  role reason into the comment column via `ai_diff_reason`.

## Grammar & numbers
- **Numerals, not spelled-out** numbers: `2`, not `שתיים`.
- **Space** between a number and its unit: `512 KB`.
- Negative numbers use the **minus sign** `–`: `–50%`.
- Figures are fine for dates, addresses, percentages, fractions, decimals, scores, stats,
  pages, IDs, and time.
- **Hebrew number position** for counted nouns: singular/`one` → noun *before* the number
  (`שעה {n}`, `אדם {n}`); plural → number *before* the noun (`{n} שעות`, `{n} אנשים`).
- **Currency**: copy the symbol + figure from source verbatim; price *ranges* use an en-dash:
  `$1–$20`.

## Punctuation (Hebrew rules)
- **Periods**: MIRROR the source's sentence-final `.`. Additionally, **no period** in:
  acronyms, abbreviations, buttons, email subjects, headings, menu items, short standalone
  sentences, titles, single-sentence toasts. `Save` → `שמירה` (not `שמירה.`).
- **Ampersand**: Hebrew has no `&` → use the word **ו** (`A & B` → `A ו-B`). Exception: DNTs.
- **Colons**: introduce a list; **no space before** a colon; use a colon to set off a
  notification title (`צוות TikTok: ה-#TikTokTest כאן`).
- **Commas**: follow Hebrew grammar; don't copy English commas that break it; split very long
  comma chains into shorter sentences. No comma before "and" unless it's a compound sentence.
- **Dashes/hyphens**: hyphen joins compounds (`חד-פעמי`) and number ranges (`12-15`); a dash
  `–` separates clauses (`הצעה מיוחדת – לא כדאי לפספס`).
- **Ellipsis** `…`: for an action in progress (`מתבצעת העלאה…`).
- **Exclamation marks**: sparingly — overuse dilutes impact.
- **Semicolons**: avoid — split into shorter sentences.
- **Slashes (between alternatives, *not* the gender slash)**: avoid; use **או**. A slash is OK
  only when space is very constrained.
- **Quotation marks**: straight double quotes `"…"` only — never curly/diagonal `“ ”`, never
  single quotes. Prefer **bold** over quotes for UI-element names.
- **Hashtags**: no spaces; camelCase per word (`#asktiktok` → `#שאלואתטיקטוק`).

## Placeholders & brackets
- **`{curly braces}` → never translate or modify** (code placeholders). Preserve `%s`, `%%d%%`,
  `{date}`, `{time}`, tags, and circled `①②③` byte-for-byte, same count/order.
- **`[square brackets]` → translate** the text inside them.
- **Brands** (`TikTok`, `TikTok LIVE`, `TikTok Lite`) stay in Latin script, exactly as source; a Hebrew
  prefix takes a maqaf **before** the name (`ב-TikTok Lite`), never inside it.

## Pluralization (CLDR: one / two / few / many / other)
- Hebrew has a real **dual** (`two`): `יום → יומיים`, `שנה → שנתיים`, `חודש → חודשיים`,
  `דקה → שתי דקות`; `few/many/other` use the plural (`X ימים`, `X שנים`, `X חודשים`, `X דקות`).
- The pluralization function isn't always available; some strings must serve all forms.

## RTL
- Hebrew is right-to-left; reorder the translation to fit the RTL reading order when needed.

## Glossary — handed-off terms (keep consistent across all TikTok tasks)
When a term's rule is **"keep in English"** leave it in Latin; when it's **"Translate"**, use the
approved Hebrew below. A brand kept inside a translated term (e.g. **TikTok**) still stays Latin.
If a translation is already **approved**, don't change it — only comment on a real error.

| Term (EN) | Rule | Hebrew | Status |
|-----------|------|--------|--------|
| **LIVE** (standalone feature/badge/action) | Translate — do NOT keep in Latin | `שידור חי` (e.g. "Go LIVE" → `התחל/י שידור חי`) | Approved 2026-08-04 (Benjy) |
| **TikTok LIVE** (product name) | Keep in Latin | `TikTok LIVE` | Approved 2026-08-04 (Benjy) |
| **Snap** | Transliterate | `סנאפ` | Approved 2026-08-04 (Benjy) |
| **Blink** | Transliterate | `בלינק` | Approved 2026-08-04 (Benjy) |
| **TikTok Membership** | Translate ("TikTok" stays Latin, translate "Membership") | `מנוי TikTok` / `חברות TikTok` — *pending Benjy's submission* | Handoff 2026-08-04, DDL 8/6 BJT (Hannah Wang / gientech) |

*(Source: TikTok's unified platform-wide paid membership — premium dramas + eligible paid
playlists; separate from individual Creator Subscriptions.)*

### Approved phrasings (whole strings — reproduce exactly, keep the `{placeholder}` in place)
| Source (EN) | Hebrew | Note |
|-------------|--------|------|
| `Commented on {s_user}'s post.` | `הגיב/ה על הפוסט של {s_user}.` | Possessive "X's post" → "הפוסט של X"; the `{s_user}` moves to the **end** (before the period), not the front — the RTL display just makes it look like it's leading. |
| `Get funds in 3 simple steps` | `קבל/י מימון ב-3 צעדים פשוטים` | Action CTA / promo headline led by an imperative verb → use the **imperative slash** (`קבל/י`), not the gerund (`קבלת מימון`). The gerund rule is for functional button/menu labels, not action headlines. |

## Normative references (when the guide is silent)
- Academy of the Hebrew Language punctuation rules; Hebrew grammar terms; the TikTok
  Multilingual Glossary; TikTok/LIVE Knowledge Base.

---

### Where this lives in the code
- `panel.js` → `STYLE_GUIDE` constant, injected by `sysPrompt(mode, plural, tiktok)` (Starling
  proofread/translate + plural card, gated by `tiktok=true`) and `lqSys(plural)` (Feishu LQA).
- Form of address: `plural` toggle → plural rule; default (off) → the singular-slash rule above.
- Register dilemmas: the `STYLE_GUIDE` "REGISTER DEPENDS ON THE UI ROLE" block + the optional
  `flag` field on the Starling schema (`gptBatch`) → `⚠ register` chip in `renderReview`; the LQA
  guard line in `lqSys` routes the reason into the comment column via `ai_diff_reason`.
- Not injected for memoQ / Crowdin / YiCAT (`tiktok` omitted).
