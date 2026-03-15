#!/bin/bash
# Validates that all daemon online test files are covered by the CI matrix.
#
# The CI matrix in .github/workflows/main.yml splits some modules (rpc, room,
# features) into shards with explicit file lists. This script catches new test
# files that were added but not included in any shard.
#
# Usage: bash scripts/validate-online-test-matrix.sh

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

ONLINE_DIR="packages/daemon/tests/online"
ERRORS=0

# --- 1. Check split modules: every *.test.ts must appear in the matrix ---
# These arrays must stay in sync with the test_path values in
# .github/workflows/main.yml  test-daemon-online matrix.

RPC_FILES=(
  rpc-agent-handlers.test.ts
  rpc-config-handlers.test.ts
  rpc-draft-handlers.test.ts
  rpc-file-handlers.test.ts
  rpc-interrupt-handlers.test.ts
  rpc-mcp-toggle.test.ts
  rpc-message-handlers.test.ts
  rpc-model-handlers.test.ts
  rpc-model-switching.test.ts
  rpc-remove-output.test.ts
  rpc-rewind-handlers.test.ts
  rpc-session-filtering.test.ts
  rpc-session-handlers-extended.test.ts
  rpc-session-workflow.test.ts
  rpc-settings-handlers.test.ts
  rpc-state-sync.test.ts
  rpc-task-draft-handlers.test.ts
  session-handlers.test.ts
)

ROOM_FILES=(
  room-advanced-scenarios.test.ts
  room-chat-agent-tools.test.ts
  room-chat-constraints.test.ts
  room-multi-agent-flow.test.ts
  room-planner-two-phase.test.ts
  room-replan-recovery.test.ts
  room-reviewer-flow.test.ts
)

FEATURES_FILES=(
  auto-title.test.ts
  message-delivery-mode-queue.test.ts
  message-persistence.test.ts
)

PROVIDERS_FILES=(
  anthropic-provider.test.ts
  copilot-anthropic-provider.test.ts
  github-copilot-provider.test.ts
  model-switch-system-init.test.ts
  openai-provider.test.ts
)

check_split_module() {
  local module_name=$1
  shift
  local expected=("$@")

  local dir="$ONLINE_DIR/$module_name"
  if [ ! -d "$dir" ]; then
    echo "WARNING: Split module directory $dir does not exist"
    return
  fi

  # Build expected list as newline-separated string for grep matching
  local expected_list=""
  for f in "${expected[@]}"; do
    expected_list="$expected_list$f"$'\n'
  done

  # Check every actual test file is in the expected list
  while IFS= read -r file; do
    local name
    name=$(basename "$file")
    if ! echo "$expected_list" | grep -qxF "$name"; then
      echo "ERROR: $file is not in any CI matrix shard for '$module_name'"
      echo "  -> Add it to a '$module_name-*' entry in .github/workflows/main.yml"
      ERRORS=$((ERRORS + 1))
    fi
  done < <(find "$dir" -name "*.test.ts" -type f | sort)

  # Check no expected file is missing from disk (stale reference)
  for f in "${expected[@]}"; do
    if [ ! -f "$dir/$f" ]; then
      echo "ERROR: $dir/$f is listed in matrix but does not exist on disk"
      echo "  -> Remove it from the matrix in .github/workflows/main.yml"
      ERRORS=$((ERRORS + 1))
    fi
  done
}

check_split_module "rpc" "${RPC_FILES[@]}"
check_split_module "room" "${ROOM_FILES[@]}"
check_split_module "features" "${FEATURES_FILES[@]}"
check_split_module "providers" "${PROVIDERS_FILES[@]}"

# --- 2. Check for new module directories not in the CI matrix ---
# These are directories covered by directory-level test_path (auto-discover).
KNOWN_DIRS="agent components convo coordinator features git glm lifecycle mcp providers rewind room rpc sandbox sdk websocket"

for dir in "$ONLINE_DIR"/*/; do
  [ -d "$dir" ] || continue
  dirname=$(basename "$dir")
  if ! echo "$KNOWN_DIRS" | grep -qw "$dirname"; then
    echo "ERROR: New module directory '$dirname' is not in the CI matrix"
    echo "  → Add it to the test-daemon-online matrix in .github/workflows/main.yml"
    ERRORS=$((ERRORS + 1))
  fi
done

# --- Result ---
if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "FAILED: $ERRORS online test coverage issue(s) found."
  echo "See .github/workflows/main.yml test-daemon-online matrix."
  exit 1
fi

echo "All online test files are covered by the CI matrix."
