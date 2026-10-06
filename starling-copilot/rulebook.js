/* rulebook.js — the ONE authoritative he-IL TikTok rulebook: prompt text + deterministic checks.
 *
 * PURE module (no DOM, no chrome.*, no network). Loaded in the browser BEFORE panel.js as the
 * global `RB`, and `require`d by Node (tests/rulebook.test.js and the offline model-comparison
 * harness), so the prompt the extension ships is byte-identical to the prompt that was evaluated.
 *
 * Precedence (highest first): per-segment Starling context note → Benjy's rulings (below,
 * dated 2026-09-28) → locked terms → the TikTok Hebrew Style Guide (Jan 2026, as distilled) →
 * everything else. Rulings marked PROVISIONAL are in force but open for future judgment.
 *
 * checkSegment() implements the deterministic side of the rulings. It NEVER rewrites text — it
 * only returns findings {rule, severity, msg} for the review UI and the evaluation harness.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RB = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const VERSION = '2026-10-06.1';

  // ---- The rulings (Benjy, 2026-09-28) — machine-readable index ------------------------------
  const RULINGS = [
    { id: 1, topic: 'Gender slash form' },
    { id: 2, topic: 'Currency position', provisional: true },
    { id: 3, topic: 'Ranges' },
    { id: 4, topic: 'Thresholds' },
    { id: 5, topic: 'UI names in running text', provisional: true },
    { id: 6, topic: 'Prefix before a {placeholder}' },
    { id: 7, topic: 'unlock' },
    { id: 8, topic: 'Buttons vs CTAs' },
    { id: 9, topic: 'Loading / system / bot messages' },
    { id: 10, topic: 'Instructions: slash vs יש ל' },
    { id: 11, topic: 'Place and venue names' },
    { id: 12, topic: 'Latin product names' },
    { id: 13, topic: 'teen / highlights / subscription', provisional: ['13c'] },
    { id: 14, topic: '{num}k / {num}m', provisional: true },
    { id: 15, topic: 'Bidi marks' },
    { id: 16, topic: 'Disputed reviewer points (precedents)', provisional: true },
    { id: 17, topic: 'Final period' },
    { id: 18, topic: 'Hashtags' },
    { id: 19, topic: 'Slash scope' }
  ];

  // Global Latin allow-list (ruling 12). Starling DNT/Brand tags and context notes add task-scoped ones.
  const LATIN_ALLOW = ['TikTok', 'TikTok LIVE', 'TikTok Lite', 'TikTok Shop', 'TikTok Pay', 'TikTok GO', 'TikTok Go',
    'Story', 'Stories', 'PayPal', 'PayLater', 'Google Play', 'App Store', 'Wi-Fi', 'AI', 'QR', 'ID', 'OTP', 'PIN', 'URL', 'PDF', 'PNG', 'JPG', 'JPEG', 'GIF', 'MB', 'GB', 'KB', 'TB'];

  // Mandatory terms that follow from the rulings (merged with the user's own 🔒 Locked terms by the panel).
  const RULED_TERMS = [
    { en: 'unlock', he: 'לשחרר', note: 'ruling 7 — every sense (שחרר/י, שחרור, שוחרר/ה, משוחרר); never לפתוח / לקבל' },
    { en: 'teen', he: 'בן/בת הנוער', note: 'ruling 13a — "your teen" → בן/בת הנוער שלך; "teens" → בני נוער (no slash); never מתבגר/ת, נער/ה' }
  ];

  // Terms from OTHER clients that must never be applied to TikTok (found in the live 🔒 Locked
  // terms / Auto-fix on 2026-09-28 — crane-manual glossary leaked into the global store).
  const FOREIGN_CLIENT_TERMS = ['track', 'platform', 'failure', 'boom', 'button'];
  const FOREIGN_CLIENT_FIXES = ['סרן', 'משטח', 'כשל', 'בום', 'boom', 'כפתור'];

  // ---- Prompt text ------------------------------------------------------------------------------
  const STYLE =
    '\nTIKTOK HEBREW RULEBOOK (he-IL, v' + VERSION + ' — overrides older style notes, glossary entries and house rules below when they conflict):\n' +
    '- VOICE: inclusive, approachable, conversational, clear, casual; short and natural. REGISTER medium-low: אנחנו (not אנו), עכשיו (not כעת), על (not אודות).\n' +
    '- INTERNAL CONSISTENCY: when the same word, verb or fixed phrase recurs in this batch, render it ONE way throughout (same meaning + same UI role → same Hebrew). Never alternate synonyms arbitrarily.\n' +
    '- GENDER SLASH — WHO GETS ONE: use the slash ONLY for a single person of unknown gender: the user (את/ה, לחץ/י, שלך) or ONE other person (הוסיף/ה, עוקב/ת חדש/ה, singular "their" → שלו/שלה). A GROUP of people takes the plain masculine plural with NO slash: יוצרים דומים, עוקבים חדשים, בני נוער, אפוטרופוסים — never יוצרים/ות, חדשים/ות, בני/בנות. This includes the two/many/other branches of ICU plurals.\n' +
    '- GENDER SLASH — HOW TO WRITE IT: the short form "masculine/י" is correct ONLY when the feminine is exactly the masculine + י (a final letter becomes its regular form): לחץ/י (לחצי), בחר/י, שתף/י (שתפי), שלח/י, התחבר/י, הישאר/י, השתמש/י. In EVERY other case write BOTH words in full: ל״ה verbs נסה/נסי, גלה/גלי, צפה/צפי, ראה/ראי, קנה/קני, פנה/פני, העלה/העלי, תיהנה/תיהני; hif\'il verbs הקש/הקישי, השלם/השלימי, הוסף/הוסיפי, הזן/הזיני, הפעל/הפעילי, הצג/הציגי, הורד/הורידי, הסר/הסירי, החזק/החזיקי, הגדר/הגדירי; holam verbs בדוק/בדקי, שמור/שמרי, כתוב/כתבי, עבור/עברי, זכור/זכרי, משוך/משכי, אסוף/אספי. NEVER נסה/י, צפה/י, גלה/י, הקש/י, השלם/י, בדוק/י. Conversely, do NOT write both in full when the short form is correct (שתף/י, not שתף/שתפי). The final letter goes BEFORE the slash (לחץ/י, never לח/יץ).\n' +
    '- UI ROLE decides the verb form (decide the role FIRST from "key", "context", then source signals):\n' +
    '  • BUTTON / LABEL / TAB / MENU / TITLE — a key ending _btn/_button/_label/_tab/_title, or any short action label of ≤3 words ("Upgrade", "Check status", "Contact us", "Retry", "Save") → GERUND (שם פעולה): שדרוג, בדיקת סטטוס, יצירת קשר, ניסיון חוזר, שמירה. Never the infinitive on a button, never an imperative on a button. Titles have no invented period.\n' +
    '  • CTA / PROMO HEADLINE with an object or benefit — typically a _cta key or marketing line ("Get funds in 3 simple steps", "Join now and win rewards") → IMPERATIVE slash: קבל/י מימון ב-3 צעדים פשוטים.\n' +
    '  • INSTRUCTION / TOOLTIP / BODY telling the user what to do → IMPERATIVE slash (הפעל/הפעילי Wi-Fi בהגדרות). Use impersonal יש ל…/נא ל… ONLY for requirements, validation rules and legal/policy text ("Bookings must be made through TikTok" → יש לבצע הזמנות דרך TikTok). Keep one choice across parallel strings.\n' +
    '  • BANNERS may use the imperative or the infinitive (לערוך כתוביות…), not the gerund.\n' +
    '  • LOADING / PROGRESS status — any short "-ing…" header or label ("Searching…", "Converting units...", "Planning the next step...", "Thinking", Tako thinking/tool headers) → ALWAYS מתבצע/מתבצעת + noun (מתבצע חיפוש תמונות…, מתבצעת המרת יחידות…, מתבצעת חשיבה), even when a bot produces it. Masculine FIRST person (אני מחפש מידע על {query}.) ONLY for a full chat-bubble sentence in which the bot talks to the user about itself — never for a short status header. Never a user slash here (never מחפש/ת, יוצר/ת). The system acts, not the user.\n' +
    '  • MACHINE-DIRECTED AI PROMPT (item marked "machinePrompt": true) → masculine-singular imperative addressed to the model, NO slash (הפוך, השתמש, צור); keep the slash only for a verb the end user performs in the app.\n' +
    '- ERROR MESSAGES: neutral and helpful; avoid "נכשל/נכשלו" and blaming wording — describe the situation (לא הצלחנו…, אי אפשר…).\n' +
    '- PUNCTUATION: straight double quotes only (" "), never “ ” or single quotes. No "&" — use ו. Avoid semicolons. Few exclamation marks; never add one the source lacks. The sentence-final period MIRRORS the source exactly (added if the source has it, absent if not — no exceptions). Ellipsis: keep the source\'s form (… or ...).\n' +
    '- UI ELEMENT NAMES inside a sentence: if the source marks the name with <b>…</b> or **…**, keep that markup around the Hebrew name and add no quotes. If the source has NO markup, translate the name and wrap it in straight double quotes, with the prefix attached directly: עבור/עברי לכרטיסייה "סדרות", מעבר ל"כולם", בלחיצה על "שליחה", אל "פרופיל" > "ההזמנות שלך". Never leave a UI element name in English.\n' +
    '- HEBREW PREFIX BEFORE A {placeholder}: decide by what the placeholder will contain, judged from its NAME. Hebrew-valued placeholders (names containing link, policy, settings, setting, page, tab, section, type, category, reason, guidelines, cg, terms, center, title, feature) → prefix attached WITHOUT hyphen: ב{s_privacyPolicy}, ל{agreementLink}, ב{s_privacySettings}. Latin- or number-valued placeholders (user, username, nickname, name, creator, author, num, count, amount, price, value, date, time, year, app, percent, id, code) → prefix WITH hyphen: ל-{s_username}, ב-{issue_date}, מ-{s_startDate}. Month, city, region and country names are localized into Hebrew at runtime → no hyphen (ב{s_month}, ב{s_city}). If unsure, use the hyphen. The same no-hyphen rule applies before a bolded or quoted HEBREW word: ב<b>פרופיל</b>, ל"כולם". A Latin word keeps the maqaf: ב-TikTok.\n' +
    '- NUMBERS: digits, never spelled-out numbers (5 שנים, not חמש שנים). {num}k / {num}m / 5k / 2M shorthand is NOT used in Hebrew: expand to {num},000 / {num},000,000 (5,000); if the value can be a decimal, use words instead ({num} אלף, {num} מיליון). Space between a number and its unit. Hebrew dual for an exact 2 written as a word (יומיים, שעתיים) — never a numeral plus a dual ("2 יומיים").\n' +
    '- RANGES: a HYPHEN with no spaces between the two ends — $20-$30, 10-15, {s_time1}-{s_time2}, Rp70,000-Rp150,000. In a sentence, a date/time span may be written with words: מ-{s_startDate} עד {s_endDate}. Never an en-dash in a range.\n' +
    '- THRESHOLDS: "X+" → "X ומעלה" (inclusive: $100 ומעלה); "Under X" → "פחות מ-X" (פחות מ-$20). Never "מעל ל-" or "מתחת ל-".\n' +
    '- CURRENCY: keep the currency symbol/code exactly where the SOURCE puts it, with the same digits and grouping: $20 stays $20, Rp70,000 stays Rp70,000, 20 kr stays 20 kr. Never move a symbol from one side of the number to the other.\n' +
    '- PERCENT: the % sign stays AFTER the number/placeholder exactly as in the source: ({s_percent}%), 50%. Never %{s_num}.\n' +
    '- HASHTAGS: keep every hashtag EXACTLY as in the source (Latin letters, same casing, # on the left) — they are working campaign links. Translate a hashtag only when a context note or approved term says so.\n' +
    '- LATIN vs HEBREW NAMES: keep in Latin ONLY (a) terms Starling marks DNT/Brand name or a context note says are DNT, and (b) this global list: ' + LATIN_ALLOW.slice(0, 12).join(', ') + ', and third-party brand names (PayPal, Google Play, Wi-Fi). Everything else is translated — feature names, tab/menu/button names (Reposts → פרסומים מחדש, Promote → קידום, Beans → עדשים, Everyone → כולם, Top {num} → מקום {num}). Keep a DNT exactly as given, including its casing (e.g. lowercase "giftee"). A Hebrew prefix attaches to a Latin name with a maqaf (ב-TikTok).\n' +
    '- PLACE, NEIGHBOURHOOD AND VENUE NAMES: transliterate proper names into Hebrew letters — never leave them in Latin and never translate them (South Ozone Park → סאות\' אוזון פארק, Lake View Terrace → לייק ויו טראס). Only a generic venue-type word that is not part of a brand is translated: Stadium/Stade/Estadio → אצטדיון, Square → כיכר. Park/Field/Arena/Dome stay transliterated when part of the name. Render the same place the same way throughout a task.\n' +
    '- RULED TERMS: unlock → לשחרר in every sense (שחרר/י, שחרור, שוחרר/ה — never לפתוח, never לקבל). teen → בן/בת הנוער ("your teen" → בן/בת הנוער שלך; "teens" → בני נוער). highlights: sports/video → רגעי שיא; the Story "Highlights" profile feature → נקודות שיא; the verb → להדגיש. subscription (the plan) → מינוי; subscriber / "Subscribed" → מנוי/ה; subscribe to notifications → הרשמה. Last updated → עודכן לאחרונה. repost → פרסום מחדש / פרסם/ה מחדש. administrative → מינהלי. cast (a video) → ללהק. disclaimer → הצהרת אחריות / הבהרה. right of withdrawal → זכות ביטול. Weighing scale → משקל. blouse → חולצה. tracking shot → צילום מעקב.\n' +
    '- GRAMMAR PRECEDENTS: keep את before a definite direct object (נהל/י את {s_settings} שלך). An ICU "one" branch stays singular (מקום, not מקומות). Never hard-code a value a placeholder carries (keep {s_month}). Keep an impersonal source impersonal (מומלץ לך, not אנחנו ממליצים). Do not add words the source lacks ("Others" → אחר, not סיבות אחרות, unless the UI makes it explicit).\n' +
    '- BIDI: when a Latin word or a {placeholder} is directly followed by "(" or ":" inside a Hebrew sentence, put an RLM (U+200F) right after it: ל-TikTok‏ ({{ticket.id}}), {s_name}:‏ {s_volume}. Put an LRM (U+200E) before a Latin #hashtag that sits in Hebrew text. Add no other invisible marks.\n';

  // The full system prompt (moved here from panel.js sysPrompt so the evaluated prompt === the shipped prompt).
  // opts: { mode: 'translate'|'proofread', plural: bool, tiktok: bool, extra: string (locked terms / context / brain, TikTok only) }
  function systemPrompt(opts) {
    const o = opts || {};
    const mode = o.mode === 'translate' ? 'translate' : 'proofread';
    const plural = !!o.plural, tiktok = !!o.tiktok;
    const base =
      'You are a professional English→Hebrew (he-IL) localization specialist for TikTok product UI and help-center content.\n' +
      'PRIORITIES, in order (a higher rule wins when they conflict): (1) MEANING — translate the actual meaning of "src" IN CONTEXT; no omissions, no additions; never mistranslate an ambiguous English word from a glossary surface-match alone. (2) CONTEXT — use "key", "context", "comments", "fullSource", and the UI role they imply. (3) LOCKED TERMS — the mandatory glossary below is non-negotiable. (4) PREFERRED TERMS — the per-item "terms" apply ONLY when their sense/POS match the occurrence. (5) NATURAL HEBREW — idiomatic professional localization, not literal word-for-word. (6) PROJECT STYLE — the rulebook (gender, register, punctuation, placeholders, numbers, brands). The preservation and style rules are how to EXECUTE these priorities, not a licence to bury meaning under formatting.\n' +
      'STRICT PRESERVATION (applies to every item):\n' +
      '- Keep EVERY placeholder and tag byte-for-byte and in the same order and count: {x}, {{x}}, %s, %1$s, HTML like <b>…</b> / <p> / <ul> / <li> / <br>, XLIFF inline tags like <g id="1">…</g> / <x/>, and circled markers ①②③. Never translate, rename, reorder, add, or drop any of them.\n' +
      '- MARKDOWN EMPHASIS: keep every **bold** and *italic* marker from the source — same count, wrapping the corresponding Hebrew term. Never drop or add asterisks.\n' +
      '- NUMBERS & DATES: keep every number, amount and date value from the SOURCE with the same digits; never convert, round or use a stale figure from the old target.\n' +
      '- HEBREW NUMBER POSITION for counted nouns: CLDR "one" / singular → noun BEFORE the placeholder ("{s_num} hour" → "שעה {s_num}", "1 person" → "אדם {s_number}"); plural → placeholder FIRST ("{s_num} hours" → "{s_num} שעות"). Compounds per noun: "{s_num} hour {s_num} min" → "שעה {s_num} ו-{s_num} דקות".\n' +
      '- STATUS-LABEL VERBS: past-participle status labels are Hebrew VERB phrases: "Last updated" → "עודכן לאחרונה", "Last edited" → "נערך לאחרונה", "Last synced" → "סונכרן לאחרונה".\n' +
      '- NO ADDITIONS: render ONLY what the source says. Never add names, facts, titles or clauses the source lacks; remove any such addition from an existing target.\n' +
      '- NO SPACE BEFORE PUNCTUATION: no space before . , : ; ! ?; no double spaces; no leading/trailing spaces.\n' +
      '- SEGMENT CONTEXT (each item MAY include "key", "context", "comments", "fullSource", "terms" — USE them, NEVER echo them):\n' +
      '  • "key" = the resource key; its suffix hints the UI role (see UI ROLE in the rulebook). A list/enum namespace (e.g. "reasonForDispute") ⇒ a selectable option → short noun phrase.\n' +
      '  • "context" and "comments" = notes from the string owner / PM (meaning, intent, DNTs, casing, corrections). Treat them as AUTHORITATIVE for THIS item: they outrank any general rule, glossary entry or remembered translation.\n' +
      '  • "fullSource" = the complete string when "src" is a split fragment; read it for context, translate ONLY "src".\n' +
      '  • "terms" = Starling term references {"en","he","pos","definition"?,"dnt"?}. A term is EVIDENCE for ONE sense, not search-and-replace: apply it ONLY when this occurrence has the same meaning and part of speech as its definition (Story → Story is the feature; "a love story" → סיפור). A "dnt": true term is kept exactly as written. When an idiom or a different sense makes a term inapplicable, translate by meaning and set "flag" briefly (e.g. "content: idiom \'to your heart\'s content\' — term not applied"). A surface word-match alone never proves a term applies. Longer, more specific terms win over a single word they contain. EXAMPLES: (a) term {"en":"Due","he":"לתשלום","pos":"adjective","definition":"owed or expected to be paid"} does NOT apply to "unavailable due to their privacy settings" — here "due to" means "because of" → עקב / בשל. (b) term {"en":"Application","he":"הגשת בקשה"} must NOT force "הגשת" into "verification application" when the meaning is the request itself → בקשת האימות. (c) a NOUN term for "Highlight" must NOT be forced onto "Highlight the relevant section", where it is a VERB → הדגש/י.\n' +
      (plural
        ? '- FORM OF ADDRESS: this client uses לשון רבים — plural, gender-neutral imperatives (הצטרפו, לחצו, שלמו) — never masculine singular and never slash forms.\n'
        : '- FORM OF ADDRESS: SINGULAR gender-neutral second person with a slash (לחץ/י, את/ה, בחר/י) — never the plural form of address and never the masculine singular alone, even when the source is ambiguous. Convert plural imperatives to the correct slash form per the rulebook (הצטרפו → הצטרף/י, נסו → נסה/נסי, צפו → צפה/צפי, בדקו → בדוק/בדקי).\n') +
      (tiktok ? STYLE + (o.extra ? o.extra : '') : '') +
      '- Return ONLY the JSON object requested. No commentary, no markdown, no code fences.';
    if (mode === 'translate') return base + '\nTASK: Translate each item\'s English "src" into natural, idiomatic Hebrew.';
    return base + '\nTASK: Proofread and correct each item\'s Hebrew "tgt" (use "src" as the reference meaning): fix meaning, grammar, spelling, terminology, punctuation and every rulebook violation' +
      (plural ? ', and convert second person to plural gender-neutral' : ', and convert second person to the singular gender-neutral slash form') +
      '. Preserve correct wording — change only what is wrong. If an item is already correct, return it unchanged.';
  }

  // The mandatory-terms block (user's 🔒 Locked terms + RULED_TERMS), identical for panel and harness.
  // Entries the stored-state audit rejects (other clients' glossaries, known-wrong forms) are skipped.
  // The locked terms that are ACTIVE in a TikTok flow: RULED_TERMS first, then the user's own, minus
  // entries the audit quarantines (other clients' glossaries, known-wrong forms). Non-destructive —
  // the stored list is untouched, so a crane-manual term still works in its own (non-TikTok) flow.
  function activeLockTerms(userTerms) {
    const bad = new Set(auditStoredState({ lockedTerms: { terms: userTerms || [] } }).map((a) => String(a.en || '').toLowerCase()));
    const seen = new Set(), terms = [];
    for (const t of [...RULED_TERMS, ...(userTerms || [])]) {
      const en = String(t.en || '').trim(), k = en.toLowerCase();
      if (!en || seen.has(k) || bad.has(k)) continue;
      seen.add(k); terms.push(t);
    }
    return terms;
  }
  // Is a stored Auto-fix rule safe to run in a TikTok flow? (false = quarantined, see auditStoredState)
  function fixRuleActive(rule) { return auditStoredState({ autoFix: { rules: [rule] } }).length === 0; }

  function lockBlock(userTerms) {
    const terms = activeLockTerms(userTerms);
    if (!terms.length) return '';
    let s = '- LOCKED TERMS (MANDATORY — NON-NEGOTIABLE): each source term below MUST be rendered with EXACTLY the Hebrew given. You may ONLY attach a Hebrew prefix (ב/ל/ה/מ/ו/ש/כ — with a maqaf before a Latin term, e.g. ב-TikTok) and let it inflect for grammar; NEVER substitute a synonym, reorder its words, or reword it. This OVERRIDES any other glossary or house rule — except a per-item context note.\n';
    for (const t of terms) s += '  • "' + t.en + '" → "' + t.he + '"' + (t.note ? ' — ' + t.note : '') + '\n';
    return s;
  }

  // The user-message contract shared by every provider.
  function userMessage(items, mode) {
    return (mode === 'translate' ? 'Translate the "src" of each item. ' : 'Proofread the "tgt" of each item. ') +
      'Return JSON exactly as {"out":[{"i":<number>,"text":"<hebrew>","flag":"<optional: a SHORT note ONLY for a genuine ambiguity (UI role, term sense, idiom); omit otherwise>"}]}, one entry per input item, same "i" numbers.\n' +
      JSON.stringify({ items });
  }

  // ---- Deterministic checks ---------------------------------------------------------------------
  const FINAL = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
  const REGULAR_TO_FINAL = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
  const unfinal = (w) => w.replace(/[ךםןףץ]$/, (c) => FINAL[c]);
  const HEB = 'א-ת';
  const PREFIXES = /^(?:[ובכלמשה]|וש|שב|שה|וה|וב|ול|ומ|כש|לכש)?/;
  // Strip a leading conjunction/preposition cluster so "ונסה" is judged as "נסה".
  function stem(w) {
    const m = w.match(/^([ושבכלמה]{0,2})(.+)$/);
    return m ? m[2] : w;
  }

  // Is "masc/י" malformed? True when the feminine is NOT masc+י.
  function shortSlashWrong(masc) {
    const one = masc.replace(/^[ושבכלמ]/, '');   // strip ONE prefix too — stem() eats "וה" of והפעל and loses the hif'il ה
    const cands = [masc, stem(masc), one];
    return cands.some((m) => {
      if (m.length < 2) return false;
      if (/ה$/.test(m) && m.length >= 3) return true;                                          // ל״ה: נסה/י, צפה/י, תיהנה/י
      if (/^ה(?!ת|י|שת|סת|צט|זד)[א-ת]{2,3}$/.test(m) && !/י/.test(m.slice(1))) return true;  // hif'il: הקש/י, השלם/י, הורד/י
      if (/^[א-ת]{2}ו[א-ת]$/.test(m) && !/^ה/.test(m)) return true;                             // holam: בדוק/י, שמור/י, עבור/י
      return false;
    }) && !/^(הישאר|היכנס|הירשם|השתמש|התחבר)$/.test(stem(masc)) && !/^(הישאר|היכנס|הירשם|השתמש|התחבר)$/.test(one);
  }

  // Placeholder name classes for ruling 6.
  const PH_HEBREW = /(link|polic|setting|page|tab|section|type|categor|reason|guideline|(^|_)cg($|_)|terms|center|title|feature|menu|label)/i;
  const PH_LATIN = /(user|nick|creator|author|num|count|amount|price|value|date|time|year|app|percent|(^|_)id($|_)|code|brand|(^|_)name)/i;
  // Month, city, region and country names are usually localized at runtime → neither class (no flag).
  const PH_LOCALIZED = /(month|city|region|country|weekday)/i;

  const CURRENCY_BEFORE = /(US\$|MX\$|R\$|\$|£|€|₪|₩|¥|฿|Rp|kr)\s?(\d[\d,.]*|\{[^}]+\})/g;

  function checkSegment(src, tgt, meta) {
    const s = String(src == null ? '' : src), t = String(tgt == null ? '' : tgt), m = meta || {};
    const out = [];
    const add = (rule, severity, msg) => out.push({ rule, severity, msg });
    if (!t.trim()) return out;
    const tNoPh = t.replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, ' ');

    // R1 — slash form, both directions; final letter before slash.
    for (const mm of tNoPh.matchAll(new RegExp('([' + HEB + ']+)/([' + HEB + ']+)', 'g'))) {
      const masc = mm[1], fem = mm[2];
      if (fem === 'י' && shortSlashWrong(masc)) add('R1-slash-short', 'error', masc + '/י → write both words in full');
      if (fem !== 'י' && fem.length > 1 && fem === unfinal(masc) + 'י') add('R1-slash-long', 'warn', masc + '/' + fem + ' → ' + masc + '/י (same suffix)');
      if (/[כמנפצ]$/.test(masc) && fem === 'י' && REGULAR_TO_FINAL[masc.slice(-1)]) add('R1-final-letter', 'error', masc + '/י → final letter before the slash (' + masc.slice(0, -1) + REGULAR_TO_FINAL[masc.slice(-1)] + '/י)');
    }
    // ICU plural: Hebrew (CLDR) needs the one/two/many/other branches — never collapse to one/other.
    if (/\{\s*\w+\s*,\s*plural\s*,/.test(s) && /\{\s*\w+\s*,\s*plural\s*,/.test(t)) {
      const br = new Set((t.match(/(?:^|[\s{}])(zero|one|two|few|many|other)\s*\{/g) || []).map((x) => x.replace(/^[\s{}]+/, '').replace(/\s*\{$/, '')));
      if (!br.has('two') || !br.has('many')) add('R-icu-branches', 'error', 'ICU plural lost Hebrew branches — he-IL needs one/two/many/other');
    }
    // R19 — slash on a plural (group) form.
    if (new RegExp('[' + HEB + ']+(ים|ות)/(ות|יות|ים)(?![' + HEB + '])').test(tNoPh) || /בני\/בנות/.test(tNoPh))
      add('R19-plural-slash', 'error', 'gender slash on a plural/group form — use the plain masculine plural');
    // R6 — prefix + placeholder hyphen.
    for (const mm of t.matchAll(/(^|[\s"'(])([ובכלמשה]{1,3})(-?)(\{\{?([^{}]+)\}?\})/g)) {
      const hy = mm[3] === '-', name = mm[5];
      if (PH_LOCALIZED.test(name)) continue;
      const heb = PH_HEBREW.test(name) && !PH_LATIN.test(name.replace(PH_HEBREW, ''));
      const lat = PH_LATIN.test(name) && !PH_HEBREW.test(name);
      if (hy && heb) add('R6-prefix-hyphen', 'error', mm[2] + '-' + mm[4] + ' → ' + mm[2] + mm[4] + ' (Hebrew-valued placeholder)');
      else if (!hy && lat) add('R6-prefix-hyphen', 'error', mm[2] + mm[4] + ' → ' + mm[2] + '-' + mm[4] + ' (Latin/number-valued placeholder)');
    }
    if (/(^|[\s(])[ובכלמשה]{1,3}-(<b>|\*\*)[א-ת]/.test(t)) add('R6-prefix-hyphen', 'error', 'no hyphen before a bolded Hebrew word');
    // R2 — currency side must mirror the source.
    const srcCur = [...s.matchAll(CURRENCY_BEFORE)].map((x) => x[1]);
    for (const c of new Set(srcCur)) {
      const esc = c.replace(/[$]/g, '\\$');
      if (new RegExp('(\\d|\\})\\s?' + esc + '(?![\\d{])').test(t) && !new RegExp(esc + '\\s?(\\d|\\{)').test(t)) add('R2-currency', 'error', c + ' moved after the number — keep it where the source has it');
    }
    // R3 — ranges: no en-dash / spaced dash between numeric ends.
    if (/(\d|\}|\$)\s*–\s*(\$|Rp|\d|\{)/.test(t) || /(\d|\})\s+-\s+(\d|\{|\$)/.test(t)) add('R3-range', 'error', 'range → hyphen without spaces ($20-$30, {a}-{b})');
    // R4 — thresholds.
    if (/מעל ל-|מתחת ל-/.test(t)) add('R4-threshold', 'error', 'use "X ומעלה" / "פחות מ-X", never "מעל ל-" / "מתחת ל-"');
    // R14 — k/m shorthand.
    if (/(\}|\d)[kKmM](?![A-Za-z])/.test(t)) add('R14-km', 'error', '{num}k/m shorthand → {num},000 / {num},000,000 (or אלף/מיליון)');
    // Percent after the number (LQA ×19).
    if (/%\{|%\d/.test(t) && !/%\{|%\d/.test(s)) add('R-percent', 'error', '% must stay after the number/placeholder');
    // R18 — hashtags verbatim.
    for (const h of (s.match(/#[A-Za-z][\w]*/g) || [])) if (!t.includes(h)) add('R18-hashtag', 'error', h + ' must stay exactly as in the source');
    // R9 — loading labels.
    if (/^\s*[A-Z][a-z]+ing\b/.test(s) && /(\.\.\.|…)\s*$/.test(s) && !/(^|\s)(מתבצע|מתבצעת|אני)\s/.test(t)) add('R9-loading', 'warn', 'progress label → מתבצע/ת + noun… (bot speaking → first person)');
    if (/^\s*[A-Z][a-z]+ing\b/.test(s) && new RegExp('[' + HEB + ']/(ת|ה)(?![' + HEB + '])').test(t) && /(\.\.\.|…)\s*$/.test(s)) add('R9-loading', 'error', 'loading/system message must not use a user slash (מחפש/ת)');
    // R7 — unlock.
    if (/\bunlock/i.test(s) && !/שחרר|שחרור|שוחרר|משוחרר|לשחרר|ישוחרר|ישוחררו|שחררת/.test(t)) add('R7-unlock', 'error', 'unlock → לשחרר (every sense)');
    // R13a — teen.
    if (/\bteens?\b/i.test(s) && /מתבגר|הנער\/ה|נער\/ה/.test(t)) add('R13-teen', 'error', 'teen → בן/בת הנוער / בני נוער');
    // R8 — button register: short action label with an imperative slash.
    const k = String(m.key || '');
    if (/(_btn|_button|button_|btn_|_label|_tab)(\b|_|$)/i.test(k) && s.trim().split(/\s+/).length <= 3 && new RegExp('^[' + HEB + ']+/[' + HEB + ']+').test(t.trim()))
      add('R8-button', 'warn', 'button/label → gerund (שם פעולה), not an imperative');
    // Neutral errors — no נכשל.
    if (/נכשל/.test(t)) add('R-error-tone', 'warn', 'avoid נכשל/נכשלו in user-facing messages');
    // Curly quotes.
    if (/[“”„‟]/.test(t)) add('R-quotes', 'error', 'straight double quotes only');
    // R15 — RLM after Latin/placeholder before "(" or ":" (reviewer cases).
    const tNoTag = t.replace(/[OC]-\d+-\d+/g, '');   // Starling tag tokens (O-1-0/C-1-0) are not Latin text
    if (/[A-Za-z0-9}]\s\(/.test(tNoTag) && /[א-ת]/.test(t) && !/‏/.test(t)) add('R15-rlm', 'warn', 'Latin word/placeholder before "(" in Hebrew text → add RLM');
    // R17 — period mirror (the pipeline enforces it; this catches raw model output).
    const endP = (x) => { const y = x.replace(/(\s|\\n|<[^>]+>)+$/, ''); return /\.$/.test(y) && !/(\.\.\.|…)$/.test(y); };   // an ellipsis is not a full stop
    if (endP(s) !== endP(t)) add('R17-period', 'warn', 'final period must mirror the source');
    return out;
  }

  // Cleanup advice for the user's stored state (the panel shows it; nothing is deleted automatically).
  function auditStoredState(state) {
    const st = state || {}, issues = [];
    for (const t of ((st.lockedTerms || {}).terms || [])) {
      if (FOREIGN_CLIENT_TERMS.includes(String(t.en || '').toLowerCase())) issues.push({ kind: 'locked', en: t.en, he: t.he, why: 'another client\'s glossary (crane manual) — must not apply to TikTok' });
      if (/%\{|%\d/.test(t.he || '') && !/%\{|%\d/.test(t.en || '')) issues.push({ kind: 'locked', en: t.en, he: t.he, why: 'forces % before the number — contradicts LQA (×19)' });
      if (/^highlights$/i.test(t.en || '') && t.he === 'רגעי שיא') issues.push({ kind: 'locked', en: t.en, he: t.he, why: 'ruling 13b splits by sense (Story feature → נקודות שיא)' });
    }
    for (const r of ((st.autoFix || {}).rules || [])) {
      const to = String(r.to || '');
      const bad = to.match(/([א-ת]+)\/י$/);
      if (bad && shortSlashWrong(bad[1])) issues.push({ kind: 'autofix', from: r.from, to: r.to, why: 'writes a malformed short slash (ruling 1)' });
      if (FOREIGN_CLIENT_FIXES.includes(String(r.from || ''))) issues.push({ kind: 'autofix', from: r.from, to: r.to, why: 'another client\'s glossary rewrite — breaks TikTok text' });
    }
    return issues;
  }

  return { VERSION, RULINGS, LATIN_ALLOW, RULED_TERMS, FOREIGN_CLIENT_TERMS, FOREIGN_CLIENT_FIXES, STYLE, systemPrompt, userMessage, lockBlock, activeLockTerms, fixRuleActive, checkSegment, shortSlashWrong, auditStoredState };
});
