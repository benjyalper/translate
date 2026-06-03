#!/usr/bin/env python3
"""
TikTok/GienTech localization test translator — runs LOCALLY (no browser, no
Railway, no cache). Reads the test paper + glossary directly, calls OpenAI's
API, writes a complete _HE.xlsx with all 39 segments filled.

Usage (Git Bash on Windows):
    export OPENAI_API_KEY="sk-..."
    python loctest-translate.py

Or pass the key as the first argument:
    python loctest-translate.py sk-...

Outputs: ./loctest_OUTPUT.xlsx (next to this script).
"""
import os, sys, json, re, time, zipfile, ssl, urllib.request, urllib.error
from xml.etree import ElementTree as ET

# ─── Paths (hardcoded for your machine) ──────────────────────────────────
TEST_PAPER = r"C:\Users\Benjy\Downloads\20251208_TikTok and LIVE translation test GienTech.xlsx"
GLOSSARY   = r"C:\Users\Benjy\Downloads\TikTok Multilingual Glossary_Hebrew.xlsx"
OUTPUT     = os.path.join(os.path.dirname(os.path.abspath(__file__)), "loctest_OUTPUT.xlsx")

# ─── OpenAI config ───────────────────────────────────────────────────────
PRIMARY_MODEL  = "gpt-5.4"      # tries this first for quality
FALLBACK_MODEL = "gpt-4o"       # always-works backup
API_KEY = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPENAI_API_KEY", "")
if not API_KEY:
    sys.exit("Set OPENAI_API_KEY env var, or pass key as first arg.\n"
             "Example: python loctest-translate.py sk-proj-xxxxx")

# Use Windows root CA bundle for HTTPS interception (matches other tools).
CA_PATH = r"C:\Users\Benjy\.certs\win-root-ca.pem"
SSL_CTX = ssl.create_default_context(cafile=CA_PATH) if os.path.exists(CA_PATH) else ssl.create_default_context()

# ─── Style guide (full v2, baked in) ─────────────────────────────────────
STYLE_GUIDE = """\
TikTok Hebrew Localization Style Guide (consolidated)

VOICE: inclusive, approachable, conversational, clear, casual.

REGISTER: medium-low. AVOID: אנו, כעת, אודות, עבור. USE: אנחנו, עכשיו, על, ל.

FORM OF ADDRESS: singular gender-neutral with slash (לחץ/י). Use final letter
before slash (התחל/י with final ל). If suffix differs, write both in full
(התחל/התחילי, not התחל/י). When one word covers all genders, no slash (אליך,
עליך). Never plural, never masculine-only.

TONE: Celebratory / Sympathetic / Helpful / Neutral (default) / Authoritative.
Match source tone.

KEEP IT SHORT: every word counts. שמירה not לשמור. Use this effect →
השתמש/י באפקט הזה (not להשתמש).

KEEP IT NATURAL: transcreate, no word-for-word. Split sentences if needed.

BE CONSISTENT: one term, one translation. Honor the glossary.

BE INCLUSIVE: gender-neutral wherever possible. Reword to avoid gender when
feasible (אפשר לשאול… not שאל/י…).

ABBREVIATIONS: prefer full words. Days = ראשון…שבת. Months = ינואר…דצמבר.
Never abbreviate TikTok, ByteDance.

ACRONYMS: only if no common word. Define on first use: API (ממשק תכנות יישומים).
All caps. File extensions: PNG name, .png extension.

ACTIVE VS PASSIVE: prefer active. אריק העלה סרטון, not הסרטון הועלה על ידי אריק.

NUMBERS: numerals not words (2 not שתיים). Comma over 4 digits (1,500). Range
with hyphen (4-5 אנשים). Negatives with minus (–50%).

CURRENCY: code + amount no space ($1.00). Don't replace USD with דולר.

PLURALIZATION (Hebrew):
 Day:    one=1 יום    two=יומיים     other=X ימים
 Year:   one=1 שנה    two=שנתיים     other=X שנים
 Month:  one=1 חודש   two=חודשיים    other=X חודשים
 Minute: one=1 דקה    two=שתי דקות   other=X דקות

PUNCTUATION:
 - Hebrew grammar rules. Don't import English commas.
 - Ampersand → word "and" (ו).
 - Colons: no space before. List intro or notification title.
 - Hyphen: compounds (חד-פעמי), ranges (12-15). Dash (–) for sentence breaks.
 - Ellipses for action in progress (...מתבצעת העלאה).
 - Exclamation: sparingly.
 - Hashtags: camelCase across words. #asktiktok → #לשאולאתטיקטוק.
 - Periods: NOT in buttons, titles, headings, menu items, short standalone
   sentences, single-sentence toasts. Save → שמירה (not שמירה.).
 - Semicolons: avoid, split sentences.
 - Quotation marks: straight " not curly.
 - **MIRROR THE SOURCE'S TERMINAL PUNCTUATION EXACTLY** (.,!,?,…) — except
   for the no-period contexts above.

UI ELEMENTS: buttons use gerund (שמירה). Tooltips use conjugated imperative
(הקלט/הקליטי). Titles use gerund, no trailing period.

TIMESTAMPS: keep {date}, {time} placeholders verbatim. Hebrew reorders —
time before date. Date format DDMMYY. 24-hour time.

RTL: reorder for Hebrew reading flow. UI element references use actual RTL
position in app.

EDM (emails): SubjectLine ≤50 chars · Preheader 6-11 words ≤90 chars ·
Headline short · Body short with one CTA · CTA 3-5 words encouraging app
open. No spam triggers.

BRACKETS/BRACES (CRITICAL):
 - [square brackets] → TRANSLATE the inside ([Privacy Policy] → [מדיניות הפרטיות])
 - {curly braces} → KEEP VERBATIM, never translate, never modify
 - Even nested: [Has {user} mutual friend] → [חברים משותפים: {user}]

PLACEHOLDERS like {s_num}, {s_friendsName}, %d%, %s, \\n — KEEP VERBATIM.
ICU plural keys (one:, other:) on their own line — keep verbatim.
"""

# ─── XLSX helpers ────────────────────────────────────────────────────────
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
T_TAG = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"

def col_letters(idx):
    n, s = idx + 1, ""
    while n > 0:
        r = (n - 1) % 26
        s = chr(65 + r) + s
        n = (n - 1) // 26
    return s

def col_to_idx(letters):
    n = 0
    for c in letters:
        n = n * 26 + (ord(c) - 64)
    return n - 1

def read_xlsx_rows(path):
    """Return list of dicts: rows[i] = {colLetter: cellValue}."""
    with zipfile.ZipFile(path) as z:
        sst = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("s:si", NS):
                sst.append("".join(t.text or "" for t in si.iter(T_TAG)))
        sheet_xml = z.read("xl/worksheets/sheet1.xml")
        root = ET.fromstring(sheet_xml)
        sd = root.find("s:sheetData", NS)
        rows = []
        for r in sd.findall("s:row", NS):
            row = {}
            for c in r.findall("s:c", NS):
                ref = c.get("r", "")
                t = c.get("t", "")
                v = c.find("s:v", NS)
                inline = c.find("s:is", NS)
                val = ""
                if t == "s" and v is not None:
                    try:
                        val = sst[int(v.text)]
                    except (ValueError, IndexError):
                        val = ""
                elif t in ("inlineStr", "str") and inline is not None:
                    val = "".join((tt.text or "") for tt in inline.iter(T_TAG))
                elif v is not None:
                    val = v.text or ""
                col = "".join(ch for ch in ref if ch.isalpha())
                row[col] = val
            rows.append(row)
    return rows, sheet_xml.decode("utf-8")

def xml_escape(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

def patch_target_cell(sheet_xml, row_num, col_letter, text):
    """Insert/replace an inline-string cell at row_num column col_letter."""
    cell_ref = f"{col_letter}{row_num}"
    escaped = xml_escape(text)
    # Try self-closed first.
    m = re.search(rf'<c\b([^/>]*?\br="{cell_ref}"[^/>]*?)/>', sheet_xml)
    if m:
        attrs = re.sub(r'\bt="[^"]*"', "", m.group(1)).strip()
        new = f'<c {attrs} t="inlineStr"><is><t xml:space="preserve">{escaped}</t></is></c>'
        new = re.sub(r"\s+", " ", new).replace(" >", ">")
        return sheet_xml[: m.start()] + new + sheet_xml[m.end():]
    # Open-close cell.
    m = re.search(rf'<c\b([^>]*?\br="{cell_ref}"[^>]*?)>[\s\S]*?</c>', sheet_xml)
    if m:
        attrs = re.sub(r'\bt="[^"]*"', "", m.group(1)).strip()
        new = f'<c {attrs} t="inlineStr"><is><t xml:space="preserve">{escaped}</t></is></c>'
        new = re.sub(r"\s+", " ", new).replace(" >", ">")
        return sheet_xml[: m.start()] + new + sheet_xml[m.end():]
    # Cell absent — insert before </row>.
    new_cell = f'<c r="{cell_ref}" t="inlineStr"><is><t xml:space="preserve">{escaped}</t></is></c>'
    rm = re.search(rf'(<row\b[^>]*\br="{row_num}"[^>]*>[\s\S]*?)</row>', sheet_xml)
    if rm:
        return sheet_xml[: rm.start()] + rm.group(1) + new_cell + "</row>" + sheet_xml[rm.end():]
    return sheet_xml.replace("</sheetData>", f'<row r="{row_num}">{new_cell}</row></sheetData>')

# ─── Glossary lookup ─────────────────────────────────────────────────────
def load_glossary():
    rows, _ = read_xlsx_rows(GLOSSARY)
    header_idx = next((i for i, r in enumerate(rows[:5]) if any("term" in (v or "").lower() for v in r.values())), 0)
    header = [(rows[header_idx].get(col_letters(j), "") or "").lower() for j in range(10)]
    def find_col(*names):
        for n in names:
            if n in header: return header.index(n)
        for n in names:
            for j, h in enumerate(header):
                if n in h: return j
        return -1
    col_term = find_col("terms", "term", "english", "en")
    col_he   = find_col("he-il (hebrew)", "he-il", "hebrew", "he")
    col_rule = find_col("translation rule", "rule")
    out = []
    for r in rows[header_idx + 1:]:
        term = (r.get(col_letters(col_term), "") or "").strip()
        he   = (r.get(col_letters(col_he), "") or "").strip()
        rule = (r.get(col_letters(col_rule), "") or "").strip()
        if term:
            out.append({"term": term, "he": he, "rule": rule})
    return out

def find_glossary_matches(src, glossary):
    lower = src.lower()
    hits = []
    for g in glossary:
        t = g["term"].lower()
        if len(t) < 2: continue
        if re.match(r"^[a-z0-9]+$", t) and len(t) <= 6:
            if re.search(rf"\b{re.escape(t)}\b", src, re.IGNORECASE):
                hits.append(g)
        elif t in lower:
            hits.append(g)
    hits.sort(key=lambda g: -len(g["term"]))
    return hits[:25]

# ─── Placeholder masking ─────────────────────────────────────────────────
def mask_placeholders(src):
    placeholders = []
    counter = [0]
    def sub(m):
        token = f"⟦PH{counter[0]}⟧"
        placeholders.append({"token": token, "original": m.group(0)})
        counter[0] += 1
        return token
    out = src
    out = re.sub(r"\{[^{}\n]+\}", sub, out)
    out = re.sub(r"%[0-9]*\$?[a-zA-Z]", sub, out)
    out = re.sub(r"%[a-zA-Z]%", sub, out)
    out = re.sub(r"\\n", sub, out)
    # ICU plural keys at line start
    def plural_sub(m):
        return m.group(1) + (lambda mm=m.group(2)+":": sub_simple(mm))()
    def sub_simple(s):
        token = f"⟦PH{counter[0]}⟧"
        placeholders.append({"token": token, "original": s})
        counter[0] += 1
        return token
    out = re.sub(r"(^|\n)(one|other|zero|two|few|many):", plural_sub, out)
    return out, placeholders

def unmask_placeholders(text, placeholders):
    for p in placeholders:
        text = text.replace(p["token"], p["original"])
    return text

# ─── OpenAI calls ────────────────────────────────────────────────────────
def call_openai(payload, attempt_desc=""):
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"    HTTP {e.code} on {attempt_desc}: {body[:200]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"    Error on {attempt_desc}: {e}", file=sys.stderr)
        return None

def strip_wrappers(text):
    text = text.strip()
    text = re.sub(r"^```[a-z]*\n?", "", text, flags=re.IGNORECASE).rstrip("`").strip()
    text = re.sub(r"^(translation|hebrew|target|תרגום|עברית)\s*[:：]\s*", "", text, flags=re.IGNORECASE).strip()
    if len(text) >= 2 and text[0] in "\"'“‘" and text[-1] in "\"'”’":
        text = text[1:-1]
    # Decode common HTML entities
    text = (text.replace("&#10;", "\n").replace("&#13;", "\r").replace("&#9;", "\t")
                .replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&"))
    return text

def translate_segment(source, context, key, glossary_matches):
    dnt = [g["term"] for g in glossary_matches
           if re.search(r"dnt|do\s*not\s*translate", g.get("rule", ""), re.IGNORECASE)
           or re.search(r"dnt|do\s*not\s*translate", g.get("he", ""), re.IGNORECASE)]
    fixed = [f'"{g["term"]}" → "{g["he"]}"' for g in glossary_matches
             if g.get("he") and g["term"] not in dnt]
    sys_msg = f"""You are a professional English→Hebrew localization translator for TikTok.

STYLE GUIDE (apply these rules — they are graded):
{STYLE_GUIDE}

{"GLOSSARY (binding):" + chr(10) + chr(10).join("  • " + s for s in fixed) if fixed else ""}
{"DO NOT TRANSLATE:" + chr(10) + chr(10).join("  • " + s for s in dnt) if dnt else ""}

PLACEHOLDERS: tokens like ⟦PH0⟧, ⟦PH1⟧ are masked placeholders. Output verbatim in natural Hebrew position. Never alter or remove.

OUTPUT RULES:
- Output ONLY the Hebrew translation.
- No prefix, no quotes, no commentary, no markdown.
- Preserve source newlines as actual newlines.
- MIRROR the source's terminal punctuation EXACTLY (.,!,?,…). Exception: no period on buttons/titles/menus/short toasts.
"""
    user_parts = []
    if key:     user_parts.append(f"KEY: {key}")
    if context.strip(): user_parts.append(f"CONTEXT:\n{context.strip()}")
    user_parts.append(f"ENGLISH:\n{source}")
    user_parts.append("HEBREW:")
    user_msg = "\n\n".join(user_parts)

    # Try gpt-5.4 with reasoning_effort low
    payload = {
        "model": PRIMARY_MODEL,
        "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}],
        "max_completion_tokens": 16000,
        "reasoning_effort": "low",
    }
    j = call_openai(payload, f"{PRIMARY_MODEL} primary")
    if j:
        content = (j.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
        if content:
            return strip_wrappers(content), PRIMARY_MODEL

    # Fallback: gpt-4o (non-reasoning, always produces output)
    payload = {
        "model": FALLBACK_MODEL,
        "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}],
        "max_tokens": 2000,
        "temperature": 0.2,
    }
    j = call_openai(payload, f"{FALLBACK_MODEL} fallback")
    if j:
        content = (j.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
        if content:
            return strip_wrappers(content), FALLBACK_MODEL

    return "", "FAILED"

# ─── Main ────────────────────────────────────────────────────────────────
def main():
    print(f"📖 Loading glossary from {GLOSSARY}...")
    glossary = load_glossary()
    print(f"   {len(glossary)} glossary entries loaded")

    print(f"📖 Loading test paper from {TEST_PAPER}...")
    rows, sheet_xml = read_xlsx_rows(TEST_PAPER)

    # Find header row
    header_idx = -1
    for i, r in enumerate(rows[:6]):
        vals = [(v or "").lower().strip() for v in r.values()]
        if "source" in vals and "target" in vals:
            header_idx = i
            break
    if header_idx < 0:
        sys.exit("Could not find header row with 'source' and 'target' columns")

    header = {col: (rows[header_idx].get(col, "") or "").lower().strip()
              for col in "ABCDEFGHIJ"}
    col_source = next(c for c, v in header.items() if v == "source")
    col_target = next(c for c, v in header.items() if v == "target")
    col_context = next((c for c, v in header.items() if v == "context"), None)
    col_keys    = next((c for c, v in header.items() if v in ("keys", "key", "string id")), None)
    print(f"   header at row {header_idx+1}: source={col_source}, target={col_target}, context={col_context}, keys={col_keys}")

    # Collect segments
    segments = []
    for i in range(header_idx + 1, len(rows)):
        r = rows[i]
        src = (r.get(col_source, "") or "").strip()
        if not src: continue
        segments.append({
            "row_num": i + 1,
            "source": (r.get(col_source, "") or ""),
            "context": (r.get(col_context, "") or "") if col_context else "",
            "key":     (r.get(col_keys, "") or "")    if col_keys else "",
        })
    print(f"   {len(segments)} segments to translate\n")

    # Translate each
    results = []
    fallback_rows, failed_rows = [], []
    for n, seg in enumerate(segments, 1):
        print(f"[{n:2}/{len(segments)}] row {seg['row_num']:>2} ({len(seg['source'])} ch, ctx={'yes' if seg['context'].strip() else 'NO '}): ", end="", flush=True)
        matches = find_glossary_matches(seg["source"], glossary)
        masked, placeholders = mask_placeholders(seg["source"])
        he_masked, model_used = translate_segment(masked, seg["context"], seg["key"], matches)
        he = unmask_placeholders(he_masked, placeholders) if he_masked else ""
        results.append({"row_num": seg["row_num"], "he": he, "model": model_used})
        if model_used == "FAILED":
            failed_rows.append(seg["row_num"])
            print("❌ FAILED")
        elif model_used == FALLBACK_MODEL:
            fallback_rows.append(seg["row_num"])
            print(f"✓ {he[:60]}  (via {FALLBACK_MODEL})")
        else:
            print(f"✓ {he[:60]}")
        time.sleep(0.3)  # gentle pacing

    # Write output
    print(f"\n💾 Writing output to {OUTPUT}...")
    for r in results:
        sheet_xml = patch_target_cell(sheet_xml, r["row_num"], col_target, r["he"])

    # Copy original xlsx and replace sheet1.xml
    import shutil
    shutil.copy(TEST_PAPER, OUTPUT)
    with zipfile.ZipFile(TEST_PAPER, "r") as zin:
        with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.namelist():
                if item == "xl/worksheets/sheet1.xml":
                    zout.writestr(item, sheet_xml)
                else:
                    zout.writestr(item, zin.read(item))

    print(f"\n✅ Done — {len(segments)} segments processed")
    print(f"   Primary model ({PRIMARY_MODEL}): {len(segments) - len(fallback_rows) - len(failed_rows)}")
    if fallback_rows:
        print(f"   Fallback ({FALLBACK_MODEL}, REVIEW MANUALLY): rows {fallback_rows}")
    if failed_rows:
        print(f"   FAILED: rows {failed_rows}")
    print(f"\nOutput: {OUTPUT}")

if __name__ == "__main__":
    main()
