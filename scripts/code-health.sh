#!/bin/bash
# Code Health Report — lightweight quality indicators
# Runs as informational output (does not block CI)

set -uo pipefail

echo "=== Code Health Report ==="
echo ""

# Large files (>500 lines)
echo "📏 Large files (>500 lines):"
LARGE_COUNT=0
for f in $(find packages/*/src -name "*.ts" -o -name "*.tsx" 2>/dev/null); do
  lines=$(wc -l < "$f")
  if [ "$lines" -gt 500 ]; then
    echo "  $f: $lines lines"
    LARGE_COUNT=$((LARGE_COUNT + 1))
  fi
done
if [ "$LARGE_COUNT" -eq 0 ]; then
  echo "  (none)"
fi
echo ""

# Tech debt markers
echo "📌 Tech debt markers:"
TODO_COUNT=$(grep -r 'TODO' packages/*/src --include='*.ts' --include='*.tsx' 2>/dev/null | wc -l | tr -d ' ')
FIXME_COUNT=$(grep -r 'FIXME' packages/*/src --include='*.ts' --include='*.tsx' 2>/dev/null | wc -l | tr -d ' ')
HACK_COUNT=$(grep -r 'HACK' packages/*/src --include='*.ts' --include='*.tsx' 2>/dev/null | wc -l | tr -d ' ')
echo "  TODO:  $TODO_COUNT"
echo "  FIXME: $FIXME_COUNT"
echo "  HACK:  $HACK_COUNT"
echo ""

# any type usage (should be 0 with oxlint no-explicit-any)
echo "🔍 Explicit 'any' usage:"
ANY_COUNT=$(grep -rn ': any\b\|as any\b\|<any>' packages/*/src --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v 'node_modules' | wc -l | tr -d ' ')
echo "  $ANY_COUNT occurrences"
echo ""

echo "=== End Report ==="
