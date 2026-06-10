#!/usr/bin/env bash
# find-tool.sh — locate the code for any admin tool by id (or substring of id/title).
#
# Usage:
#   ./find-tool.sh                       # list every tool
#   ./find-tool.sh doc-screenshotter     # show locations for that tool
#   ./find-tool.sh screen                # fuzzy match
#   ./find-tool.sh doc-screenshotter -o  # open admin.html in your editor at the card
#
# Requires: jq (https://stedolan.github.io/jq/). On Windows / Git Bash:
#   winget install jqlang.jq
#
# Does not call the network. Reads tools-index.json from the same folder.

set -euo pipefail

DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
INDEX="$DIR/tools-index.json"

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq is required. Install:  winget install jqlang.jq   (or  brew install jq)"
  exit 1
fi

if [ ! -f "$INDEX" ]; then
  echo "❌ tools-index.json not found next to this script ($INDEX)"
  exit 1
fi

OPEN=""
QUERY=""
for arg in "$@"; do
  case "$arg" in
    -o|--open) OPEN=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) QUERY="$arg" ;;
  esac
done

# No query → list everything
if [ -z "$QUERY" ]; then
  echo "Tools in $(basename "$INDEX") (id · title · type):"
  echo
  jq -r '.tools[] | "  \(.emoji)  \(.id)  —  \(.title)  [\(.type)]"' "$INDEX"
  echo
  echo "Run  ./find-tool.sh <id>  for locations."
  exit 0
fi

# Match against id or title (case-insensitive substring)
MATCHES=$(jq -c --arg q "$QUERY" '
  .tools
  | map(select(
      (.id   | ascii_downcase | contains($q | ascii_downcase)) or
      (.title | ascii_downcase | contains($q | ascii_downcase))
    ))
' "$INDEX")

COUNT=$(echo "$MATCHES" | jq 'length')

if [ "$COUNT" -eq 0 ]; then
  echo "❌ No tool matches \"$QUERY\"."
  echo "   Run with no args to list all tools."
  exit 2
fi

if [ "$COUNT" -gt 1 ]; then
  echo "🔎 Multiple matches for \"$QUERY\":"
  echo "$MATCHES" | jq -r '.[] | "  - \(.id)  (\(.title))"'
  echo
  echo "Use a more specific id."
  exit 0
fi

# Single hit — print everything we know about it
TOOL=$(echo "$MATCHES" | jq -c '.[0]')

ID=$(echo "$TOOL"   | jq -r '.id')
TITLE=$(echo "$TOOL" | jq -r '.title')
EMOJI=$(echo "$TOOL" | jq -r '.emoji')
TYPE=$(echo "$TOOL"  | jq -r '.type')
TMLINE=$(echo "$TOOL" | jq -r '.toolmap_line')
CARDFROM=$(echo "$TOOL" | jq -r '.card_lines[0]')
CARDTO=$(echo "$TOOL"   | jq -r '.card_lines[1]')
JSPREFIX=$(echo "$TOOL" | jq -r '.js_prefix')
JSLINE=$(echo "$TOOL"   | jq -r '.js_starts_around')

echo "$EMOJI  $TITLE"
echo "    id:           $ID"
echo "    type:         $TYPE"
echo
echo "  📍 admin.html"
echo "       toolmap entry      → line $TMLINE"
echo "       tool-card UI       → lines $CARDFROM-$CARDTO"
echo "       JS functions (\"${JSPREFIX}*\")  → starts around line $JSLINE"

# Endpoints
ENDPOINTS=$(echo "$TOOL" | jq -r '(.endpoints // []) | .[]')
if [ -n "$ENDPOINTS" ]; then
  echo
  echo "  📡 backend (transcriber/server.js)"
  while IFS= read -r ep; do echo "       $ep"; done <<< "$ENDPOINTS"
fi

# Standalone app
SAFOLDER=$(echo "$TOOL" | jq -r '.standalone_app.folder // empty')
if [ -n "$SAFOLDER" ]; then
  SAPORT=$(echo "$TOOL" | jq -r '.standalone_app.port')
  echo
  echo "  ↗ standalone app"
  echo "       folder: $SAFOLDER"
  echo "       port:   $SAPORT"
fi

# Needs
NEEDS=$(echo "$TOOL" | jq -r '(.needs // []) | .[]')
if [ -n "$NEEDS" ]; then
  echo
  echo "  🔑 needs"
  while IFS= read -r n; do echo "       - $n"; done <<< "$NEEDS"
fi

if [ -n "$OPEN" ]; then
  EDITOR_CMD=""
  if [ -n "${VISUAL:-}" ]; then EDITOR_CMD="$VISUAL"
  elif [ -n "${EDITOR:-}" ]; then EDITOR_CMD="$EDITOR"
  elif command -v code >/dev/null 2>&1; then EDITOR_CMD="code -g"
  fi
  if [ -n "$EDITOR_CMD" ]; then
    echo
    echo "Opening admin.html at line $CARDFROM…"
    $EDITOR_CMD "$DIR/admin.html:$CARDFROM"
  else
    echo
    echo "(no editor found — set \$VISUAL or install VS Code)"
  fi
fi
