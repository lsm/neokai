#!/bin/bash
# P4-A: Enforce package dependency directions.
# Prevents architectural drift by ensuring packages don't import from forbidden peers.
#
# Allowed dependency flow:
#   cli → daemon → shared ← web
#   e2e is independent (browser-based only)
#
# Forbidden:
#   shared ↛ daemon, shared ↛ web
#   web ↛ daemon
#   daemon ↛ web
set -euo pipefail

ERRORS=0

# shared must not import from daemon or web
VIOLATIONS=$(grep -rl "from '@neokai/daemon\|from \"@neokai/daemon\|from '@neokai/web\|from \"@neokai/web" \
  packages/shared/src/ --include="*.ts" 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: packages/shared must not import from daemon or web."
  echo "FIX: shared is the base layer; move shared code here, not dependencies upward."
  echo "Violations:"
  echo "$VIOLATIONS" | sed 's/^/  /'
  ERRORS=$((ERRORS + 1))
fi

# web must not import from daemon
VIOLATIONS=$(grep -rl "from '@neokai/daemon\|from \"@neokai/daemon" \
  packages/web/src/ --include="*.ts" --include="*.tsx" 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: packages/web must not import from daemon."
  echo "FIX: Web communicates with daemon via MessageHub RPC, not direct imports."
  echo "Violations:"
  echo "$VIOLATIONS" | sed 's/^/  /'
  ERRORS=$((ERRORS + 1))
fi

# daemon must not import from web
VIOLATIONS=$(grep -rl "from '@neokai/web\|from \"@neokai/web" \
  packages/daemon/src/ --include="*.ts" 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: packages/daemon must not import from web."
  echo "FIX: Daemon should never depend on frontend code."
  echo "Violations:"
  echo "$VIOLATIONS" | sed 's/^/  /'
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "Found $ERRORS package dependency violation(s)."
  exit 1
fi

echo "Package dependency checks passed."
