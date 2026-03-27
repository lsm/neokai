# Milestone 1: Bug A -- Usage Limit Re-Detection Guard

## Goal and Scope

Add a `!group.rateLimit` re-detection guard to the `usage_limit` handler in both `onWorkerTerminalState()` (line 729) and `onLeaderTerminalState()` (line 1094) of `room-runtime.ts`, matching the pattern already used for `rate_limit` at line 687. This prevents an infinite backoff loop when `recoverStuckWorkers()` re-triggers the handler after a usage limit has expired but the worker output still contains the old "You've hit your limit" text.

## Tasks

### Task 1.1: Add re-detection guard to worker usage_limit handler

**Title**: Add `!group.rateLimit` guard to `usage_limit` block in `onWorkerTerminalState()`

**Description**: In `room-runtime.ts`, the `usage_limit` handler at line 729 currently has no re-detection guard. Every time `onWorkerTerminalState` is called with old usage-limit text in the output, it re-applies the backoff and returns early -- even if the limit has already expired and the task should proceed. The fix follows the exact same pattern as the `rate_limit` guard at line 687.

**Subtasks**:
1. In `onWorkerTerminalState()`, at line 729, wrap the `usage_limit` block with the same guard pattern: when `group.rateLimit` is already set (non-null, even if expired), skip the `usage_limit` handler entirely and fall through to the worktree check / exit gate / normal routing. The same comment explaining the sentinel behavior should be added.
2. The guard check should be: if `group.rateLimit` is truthy (already set from a previous detection), skip the `usage_limit` fallback attempt and fall through. This matches the `rate_limit` pattern where `if (!group.rateLimit)` gates first-time-only backoff.

**Acceptance Criteria**:
- When `group.rateLimit` is already set (from a previous `usage_limit` or `rate_limit` detection), the `usage_limit` handler is skipped entirely.
- When `group.rateLimit` is null (first detection), the existing `usage_limit` behavior is preserved: try fallback, then fall through to backoff if no fallback.
- The code comment explains why the guard exists (sentinel for `recoverStuckWorkers` re-trigger).

**Dependencies**: None.

**Agent Type**: coder

---

### Task 1.2: Add re-detection guard to leader usage_limit handler

**Title**: Add `!group.rateLimit` guard to `usage_limit` block in `onLeaderTerminalState()`

**Description**: Same fix as Task 1.1 but for the leader path at line 1094. The leader `usage_limit` handler also lacks a re-detection guard. While there is currently no `recoverStuckLeaders()` mechanism (tracked as Gap F), adding the guard now is defensive and required before Milestone 6 can work.

**Subtasks**:
1. In `onLeaderTerminalState()`, at line 1094, wrap the `usage_limit` block with the same guard: when `group.rateLimit` is already set, skip the handler and fall through to normal completion.

**Acceptance Criteria**:
- When `group.rateLimit` is already set, the leader `usage_limit` handler is skipped.
- When `group.rateLimit` is null, existing behavior is preserved.

**Dependencies**: None (can be done in parallel with Task 1.1).

**Agent Type**: coder

---

### Task 1.3: Unit tests for usage_limit re-detection guard (worker path)

**Title**: Add tests verifying usage_limit re-detection guard prevents infinite loop in worker path

**Description**: Add unit tests to `packages/daemon/tests/unit/room/room-runtime-terminal-errors.test.ts` (or a new test file) that verify the re-detection guard works correctly for the worker `usage_limit` path. Follow the pattern of the existing test at line 232 ("does NOT re-set rate limit when group already has one").

**Subtasks**:
1. Test: First `usage_limit` detection sets backoff correctly (already tested, verify still passes).
2. Test: Re-trigger after `group.rateLimit` is set to expired -- handler is skipped, worker falls through to normal routing, `feedbackIteration` increments.
3. Test: Re-trigger with `group.rateLimit` still in the future (active) -- `isRateLimited` returns true so handler is never reached (existing `recoverStuckWorkers` guard).

**Acceptance Criteria**:
- Test "does NOT re-set usage limit backoff when group already has one (re-trigger after expiry)" passes.
- Test verifies `feedbackIteration` increments (worker output was routed to leader, not short-circuited).
- Existing usage_limit tests continue to pass.

**Dependencies**: Task 1.1

**Agent Type**: coder

---

### Task 1.4: Unit tests for usage_limit re-detection guard (leader path)

**Title**: Add tests verifying usage_limit re-detection guard in leader path

**Description**: Add unit tests to `packages/daemon/tests/unit/room/room-runtime-leader-terminal-errors.test.ts` for the leader `usage_limit` re-detection guard.

**Subtasks**:
1. Test: First `usage_limit` detection on leader sets backoff (existing behavior).
2. Test: Re-trigger after `group.rateLimit` is set to expired -- handler is skipped, leader completes normally.

**Acceptance Criteria**:
- Test "does NOT re-set usage limit when group already has rate limit" passes for leader path.
- Existing leader terminal error tests continue to pass.

**Dependencies**: Task 1.2

**Agent Type**: coder
