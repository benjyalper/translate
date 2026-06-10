#!/usr/bin/env python3
"""find-tool.py — locate the code for any admin tool by id or substring.

Reads tools-index.json from the same folder. No external deps.

Usage:
  python find-tool.py                      # list every tool
  python find-tool.py doc-screenshotter    # show locations for that tool
  python find-tool.py screen               # fuzzy substring match
  python find-tool.py doc-screenshotter -o # also open admin.html in VS Code at the card

Exit codes:
  0 — found exactly one match (or listed all tools)
  1 — script error (missing index file)
  2 — no match
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Force UTF-8 stdout so emoji print on Windows (cp1252 by default).
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

HERE = Path(__file__).resolve().parent
INDEX = HERE / "tools-index.json"


def load_index() -> dict:
    if not INDEX.exists():
        sys.stderr.write(f"X tools-index.json not found at {INDEX}\n")
        sys.exit(1)
    with INDEX.open("r", encoding="utf-8") as f:
        return json.load(f)


def list_tools(idx: dict) -> None:
    print(f"Tools in {INDEX.name} (emoji id title type):\n")
    for t in idx["tools"]:
        print(f"  {t['emoji']}  {t['id']:32s}  {t['title']}  [{t['type']}]")
    print("\nRun  python find-tool.py <id>  for locations.")


def print_tool(t: dict) -> None:
    print(f"{t['emoji']}  {t['title']}")
    print(f"    id:           {t['id']}")
    print(f"    type:         {t['type']}")
    print()
    print("  admin.html")
    print(f"       toolmap entry      -> line {t['toolmap_line']}")
    cf, ct = t["card_lines"]
    print(f"       tool-card UI       -> lines {cf}-{ct}")
    print(f"       JS functions ({t['js_prefix']}*)  -> starts around line {t['js_starts_around']}")

    eps = t.get("endpoints") or []
    if eps:
        print("\n  backend (transcriber/server.js)")
        for ep in eps:
            print(f"       {ep}")

    sa = t.get("standalone_app")
    if sa:
        print("\n  standalone app (launcher only on admin.html)")
        print(f"       folder: {sa['folder']}")
        print(f"       port:   {sa['port']}")

    needs = t.get("needs") or []
    if needs:
        print("\n  needs")
        for n in needs:
            print(f"       - {n}")


def open_in_editor(line: int) -> None:
    """Open admin.html at the given line in VS Code if available."""
    target = f"{HERE / 'admin.html'}:{line}"
    code = shutil.which("code") or shutil.which("code.cmd")
    if code:
        print(f"\nOpening admin.html at line {line}...")
        try:
            subprocess.run([code, "-g", target], check=False)
        except Exception as e:
            print(f"(failed to launch editor: {e})")
        return
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR")
    if editor:
        print(f"\nOpening with $EDITOR={editor} at line {line}...")
        subprocess.run([editor, target], check=False, shell=True)
        return
    print("\n(no editor found - install VS Code or set $VISUAL / $EDITOR)")


def main() -> int:
    args = sys.argv[1:]
    open_after = False
    query = None
    for a in args:
        if a in ("-h", "--help"):
            print(__doc__)
            return 0
        if a in ("-o", "--open"):
            open_after = True
        else:
            query = a

    idx = load_index()

    if not query:
        list_tools(idx)
        return 0

    q = query.lower()
    matches = [
        t for t in idx["tools"]
        if q in t["id"].lower() or q in t["title"].lower()
    ]

    if not matches:
        print(f'X No tool matches "{query}".')
        print("   Run with no args to list all tools.")
        return 2

    if len(matches) > 1:
        print(f'Multiple matches for "{query}":')
        for t in matches:
            print(f"  - {t['id']}  ({t['title']})")
        print("\nUse a more specific id.")
        return 0

    t = matches[0]
    print_tool(t)
    if open_after:
        open_in_editor(t["card_lines"][0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
