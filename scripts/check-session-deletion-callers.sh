#!/usr/bin/env bash
# Guard: Task #85 invariant.
#
# Only the two UI RPC paths may call:
#   - SessionManager.deleteSessionResources / SessionLifecycle.deleteResources
#   - SessionManager.archiveSessionResources / SessionLifecycle.archiveResources
# (plus the `ui_session_delete` / `ui_room_delete` / `ui_session_archive` /
# `ui_task_archive` trigger identifiers that document the caller.)
#
# Any other file reaching for these names is almost certainly reintroducing
# the data-loss path that #1566 / #1572 / Task #85 closed. When a new
# legitimate caller is added (e.g. another UI action), explicitly add it to
# the allowlist below.
#
# Exits with non-zero status when an unexpected caller is found.

set -euo pipefail

cd "$(dirname "$0")/.."

# Allow-listed files (relative to repo root). Extend with care.
ALLOWLIST=(
    # The primitives themselves
    "packages/daemon/src/lib/session/session-lifecycle.ts"
    "packages/daemon/src/lib/session/session-manager.ts"

    # The two UI RPC handlers
    "packages/daemon/src/lib/rpc-handlers/session-handlers.ts"
    "packages/daemon/src/lib/rpc-handlers/room-handlers.ts"

    # Task archive pipeline (UI-initiated via task.archive event cascade)
    "packages/daemon/src/lib/space/runtime/task-agent-manager.ts"

    # Guard itself
    "scripts/check-session-deletion-callers.sh"
)

# Pattern: function names + trigger identifiers.
PATTERN='archiveSessionResources|deleteSessionResources|archiveResources|deleteResources|ui_session_archive|ui_task_archive|ui_session_delete|ui_room_delete'

# grep -r the `packages` tree, excluding tests, docs, and node_modules.
RAW=$(grep -RnE "${PATTERN}" packages \
    --include='*.ts' \
    --include='*.tsx' \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=build \
    --exclude-dir=tests \
    --exclude-dir=__tests__ \
    --exclude='*.test.ts' \
    --exclude='*.spec.ts' \
    2>/dev/null || true)

if [[ -z "${RAW}" ]]; then
    echo "Task #85 guard passed: no references to UI-only session primitives outside of tests."
    exit 0
fi

# Build a regex that matches any allowlisted path as a prefix.
OFFENDERS=""
while IFS= read -r line; do
    file="${line%%:*}"
    allowed=0
    for allowed_path in "${ALLOWLIST[@]}"; do
        if [[ "${file}" == "${allowed_path}" ]]; then
            allowed=1
            break
        fi
    done
    if [[ "${allowed}" -eq 0 ]]; then
        OFFENDERS="${OFFENDERS}${line}"$'\n'
    fi
done <<< "${RAW}"

if [[ -n "${OFFENDERS}" ]]; then
    echo "Task #85 guard FAILED: found non-allowlisted references to UI-only session primitives:" >&2
    echo "" >&2
    printf '%s' "${OFFENDERS}" >&2
    echo "" >&2
    echo "Only UI-initiated RPC handlers may call archiveSessionResources / deleteSessionResources." >&2
    echo "If a new legitimate caller is needed, add its path to ALLOWLIST in" >&2
    echo "scripts/check-session-deletion-callers.sh AND re-run the tests that assert" >&2
    echo "the preserve-DB invariants." >&2
    exit 1
fi

echo "Task #85 guard passed: only allow-listed files call the UI-only session primitives."
