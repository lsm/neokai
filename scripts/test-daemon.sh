#!/bin/bash
# test-daemon.sh — Run daemon unit tests with parallel shards and failure summary.
#
# Requires: bun, python3 (for --show-failures)
#
# Usage:
#   ./scripts/test-daemon.sh                # All shards in parallel (fast, no coverage)
#   ./scripts/test-daemon.sh --coverage     # All shards with coverage
#   ./scripts/test-daemon.sh 2-handlers     # Run a single shard
#   ./scripts/test-daemon.sh --rerun        # Rerun only previously failing files
#   ./scripts/test-daemon.sh --show-failures # Show failure details from last run

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SHARDS=(0-shared 1-core 2-handlers 4-space-storage 5-space-agent 5-space-runtime 5-space-workflow 5-space-other)
RESULTS_DIR="$REPO_ROOT/test-results/daemon"
FAILURES_FILE="$RESULTS_DIR/failures.txt"
PRELOAD="$REPO_ROOT/packages/daemon/tests/unit/setup.ts"
TEST_ROOT="$REPO_ROOT/packages/daemon/tests/unit"

# Map shard name to directory path under TEST_ROOT
shard_path() {
	case "$1" in
	5-space-*) echo "5-space/${1#5-space-}" ;;
	*)         echo "$1" ;;
	esac
}

# Parse arguments
COVERAGE=false
RERUN=false
SHOW_FAILURES=false
TARGET_SHARD=""

for arg in "$@"; do
	case "$arg" in
	--coverage)       COVERAGE=true ;;
	--rerun)          RERUN=true ;;
	--show-failures)  SHOW_FAILURES=true ;;
	*)                TARGET_SHARD="$arg" ;;
	esac
done

mkdir -p "$RESULTS_DIR"

# --- Show failures from last run ---
if [ "$SHOW_FAILURES" = true ]; then
	shard_count=0
	for shard in "${SHARDS[@]}"; do
		junit="$RESULTS_DIR/junit-${shard}.xml"
		[ -f "$junit" ] || continue

		fail_count=$(grep '<testsuites' "$junit" | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*')
		[ "${fail_count:-0}" -eq 0 ] && continue

		shard_count=$((shard_count + 1))
		echo "--- $shard ---"

		python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('$junit')
for tc in tree.iter('testcase'):
    if tc.find('failure') is not None:
        print(f\"{tc.get('file', '?')}:{tc.get('line', '?')}\")
        print(f\"  {tc.get('name', '?')}\")
" 2>/dev/null
		echo ""
	done

	if [ "$shard_count" -eq 0 ]; then
		echo "No failures found in last run (or no junit files exist)."
		echo "Run ./scripts/test-daemon.sh first."
	else
		echo ""
		echo "To rerun failing tests:"
		echo "  ./scripts/test-daemon.sh --rerun"
	fi
	exit 0
fi

# --- Rerun mode ---
if [ "$RERUN" = true ]; then
	if [ ! -f "$FAILURES_FILE" ] || [ ! -s "$FAILURES_FILE" ]; then
		echo "No previous failures found. Run full tests first."
		exit 0
	fi
	FAILING_FILES=$(cat "$FAILURES_FILE")
	FILE_COUNT=$(echo "$FAILING_FILES" | wc -l | tr -d ' ')
	echo "Rerunning $FILE_COUNT failing test file(s)..."
	# shellcheck disable=SC2086
	NODE_ENV=test bun test --preload="$PRELOAD" --jobs=1 --dots $FAILING_FILES
	exit $?
fi

# --- Determine shards to run ---
if [ -n "$TARGET_SHARD" ]; then
	RUN_SHARDS=("$TARGET_SHARD")
else
	RUN_SHARDS=("${SHARDS[@]}")
fi

# Build coverage flags
COV_FLAGS=""
if [ "$COVERAGE" = true ]; then
	COV_FLAGS="--coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir=coverage"
fi

# --- Run shards in parallel ---
PIDS=()

WALL_START=$(date +%s)

echo "Running daemon unit tests (${#RUN_SHARDS[@]} shard(s))..."
echo ""

for shard in "${RUN_SHARDS[@]}"; do
	JUNIT_FILE="$RESULTS_DIR/junit-${shard}.xml"
	LOG_FILE="$RESULTS_DIR/output-${shard}.log"

	# 0-shared runs packages/shared/tests (separate process to avoid mock pollution)
	if [ "$shard" = "0-shared" ]; then
		# shellcheck disable=SC2086
		NODE_ENV=test bun test \
			--preload="$PRELOAD" \
			--jobs=1 \
			--dots \
			--reporter=junit \
			--reporter-outfile="$JUNIT_FILE" \
			$COV_FLAGS \
			"$REPO_ROOT/packages/shared/tests" \
			>"$LOG_FILE" 2>&1 &
	else
		SHARD_PATH=$(shard_path "$shard")

		# shellcheck disable=SC2086
		NODE_ENV=test bun test \
			--preload="$PRELOAD" \
			--jobs=1 \
			--dots \
			--reporter=junit \
			--reporter-outfile="$JUNIT_FILE" \
			--ignore='**/neo-daemon-lifecycle.test.ts' \
			$COV_FLAGS \
			"$TEST_ROOT/$SHARD_PATH" \
			>"$LOG_FILE" 2>&1 &
	fi

	PIDS+=($!)
done

# Wait for all shards
for pid in "${PIDS[@]}"; do
	wait "$pid" 2>/dev/null || true
done

# --- Parse results from junit XML ---
TOTAL_TESTS=0
TOTAL_FAILS=0
TOTAL_SKIPS=0
TOTAL_TIME_MS=0
HAD_FAILURE=0

: > "$FAILURES_FILE"

printf "%-22s %8s %8s %8s %8s\n" "Shard" "Tests" "Pass" "Fail" "Time"
printf "%-22s %8s %8s %8s %8s\n" "----------------------" "--------" "--------" "--------" "--------"

for shard in "${RUN_SHARDS[@]}"; do
	JUNIT_FILE="$RESULTS_DIR/junit-${shard}.xml"
	LOG_FILE="$RESULTS_DIR/output-${shard}.log"

	if [ ! -f "$JUNIT_FILE" ]; then
		printf "%-22s %8s %8s %8s %8s\n" "$shard" "ERROR" "-" "-" "-"
		HAD_FAILURE=1
		if [ -f "$LOG_FILE" ]; then
			echo "  Last output from $shard:"
			tail -5 "$LOG_FILE" | sed 's/^/    /'
		fi
		continue
	fi

	# Extract counts from the root <testsuites> element
	root_attrs=$(grep '<testsuites' "$JUNIT_FILE")
	tests=$(echo "$root_attrs" | grep -o 'tests="[0-9]*"' | grep -o '[0-9]*')
	failures=$(echo "$root_attrs" | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*')
	skipped=$(echo "$root_attrs" | grep -o 'skipped="[0-9]*"' | grep -o '[0-9]*')
	time_s=$(echo "$root_attrs" | grep -o 'time="[0-9.]*"' | sed 's/time="//;s/"//')
	time_ms=$(awk "BEGIN {printf \"%.0f\", ${time_s:-0} * 1000}")

	tests=${tests:-0}
	failures=${failures:-0}
	skipped=${skipped:-0}
	time_ms=${time_ms:-0}
	passed=$((tests - failures - skipped))

	TOTAL_TESTS=$((TOTAL_TESTS + tests))
	TOTAL_FAILS=$((TOTAL_FAILS + failures))
	TOTAL_SKIPS=$((TOTAL_SKIPS + skipped))
	TOTAL_TIME_MS=$((TOTAL_TIME_MS + time_ms))

	fmt_time=$(awk "BEGIN {printf \"%.1f\", $time_ms / 1000}")

	printf "%-22s %8s %8s %8s %7ss\n" "$shard" "$tests" "$passed" "$failures" "$fmt_time"

	if [ "$failures" -gt 0 ]; then
		HAD_FAILURE=1
		grep -B1 '<failure' "$JUNIT_FILE" | grep -o 'file="[^"]*"' | sed 's/file="//;s/"//' | sort -u >> "$FAILURES_FILE"
	fi
done

fmt_total=$(awk "BEGIN {printf \"%.1f\", $TOTAL_TIME_MS / 1000}")

printf "%-22s %8s %8s %8s %8s\n" "----------------------" "--------" "--------" "--------" "--------"
printf "%-22s %8s %8s %8s %7ss\n" "TOTAL" "$TOTAL_TESTS" "$((TOTAL_TESTS - TOTAL_FAILS - TOTAL_SKIPS))" "$TOTAL_FAILS" "$fmt_total"

WALL_END=$(date +%s)
WALL_SECS=$((WALL_END - WALL_START))

if [ "$HAD_FAILURE" -eq 1 ]; then
	echo ""
	FAIL_COUNT=$(sort -u "$FAILURES_FILE" | wc -l | tr -d ' ')
	echo "FAILURES ($FAIL_COUNT file(s)):"
	sort -u "$FAILURES_FILE" | while IFS= read -r file; do
		echo "  $file"
	done
	echo ""
	echo "To rerun failing tests:"
	echo "  ./scripts/test-daemon.sh --rerun"
else
	echo ""
	echo "All tests passed!"
fi

echo "Wall time: ${WALL_SECS}s"

exit "$HAD_FAILURE"
