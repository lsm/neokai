#!/bin/bash
# P0-B: Mechanical enforcement of E2E test rules.
# These rules are documented in packages/e2e/CLAUDE.md and enforced here in CI.
set -euo pipefail

ERRORS=0
E2E_TESTS="packages/e2e/tests"

# Only check actual test files, not helpers/fixtures/setup
TEST_FILES=$(find "$E2E_TESTS" -name "*.e2e.ts" -not -path "*/fixtures/*" 2>/dev/null || true)

if [ -z "$TEST_FILES" ]; then
  echo "No E2E test files found, skipping checks."
  exit 0
fi

# Rule 1: E2E test files must not use direct RPC calls (hub.request / hub.event)
# Allowed only in helpers and global teardown (not in .e2e.ts files)
VIOLATIONS=$(grep -l 'hub\.request\|hub\.event' $TEST_FILES 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: E2E tests must not use direct RPC calls (hub.request/hub.event)."
  echo "FIX: Use UI interactions instead. See packages/e2e/CLAUDE.md for rules."
  echo "Violations:"
  echo "$VIOLATIONS" | sed 's/^/  /'
  ERRORS=$((ERRORS + 1))
fi

# Rule 2: E2E tests must not access internal state for assertions
VIOLATIONS=$(grep -l 'window\.sessionStore\|window\.globalStore\|window\.appState\|window\.__stateChannels' $TEST_FILES 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: E2E tests must not access internal state for assertions."
  echo "FIX: Assert on visible DOM state instead. See packages/e2e/CLAUDE.md."
  echo "Violations:"
  echo "$VIOLATIONS" | sed 's/^/  /'
  ERRORS=$((ERRORS + 1))
fi

# Rule 3: Must not use setOffline for WebSocket disconnection simulation
VIOLATIONS=$(grep -l 'setOffline' $TEST_FILES 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Use closeWebSocket()/restoreWebSocket() helpers instead of setOffline()."
  echo "FIX: Import from helpers/connection-helpers.ts. See packages/e2e/CLAUDE.md."
  echo "Violations:"
  echo "$VIOLATIONS" | sed 's/^/  /'
  ERRORS=$((ERRORS + 1))
fi

# Rule 4: Must not use connectionManager.simulateDisconnect
VIOLATIONS=$(grep -l 'simulateDisconnect' $TEST_FILES 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Use closeWebSocket() helper instead of connectionManager.simulateDisconnect()."
  echo "FIX: Import from helpers/connection-helpers.ts. See packages/e2e/CLAUDE.md."
  echo "Violations:"
  echo "$VIOLATIONS" | sed 's/^/  /'
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "Found $ERRORS E2E rule violation(s). See packages/e2e/CLAUDE.md for details."
  exit 1
fi

echo "E2E rule checks passed."
