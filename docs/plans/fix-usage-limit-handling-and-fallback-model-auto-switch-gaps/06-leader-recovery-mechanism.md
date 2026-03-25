# Milestone 6: Gap F -- Leader Recovery Mechanism After Usage Limit

## Goal and Scope

Workers have `recoverStuckWorkers()` which re-triggers `onWorkerTerminalState` after a rate limit expires. But there is no equivalent `recoverStuckLeaders()` mechanism. If the leader hits a usage limit and no fallback is available, the group is permanently stuck because the worker output was already forwarded (feedbackIteration > 0) and the leader never completes its review.

The fix adds a `recoverStuckLeaders()` method that detects leaders stuck with expired rate limits and re-injects the last worker message into the leader session, similar to how `recoverStuckWorkers` re-triggers `onWorkerTerminalState`.

## Tasks

### Task 6.1: Add `recoverStuckLeaders()` method to RoomRuntime

**Title**: Add `recoverStuckLeaders()` method mirroring `recoverStuckWorkers()`

**Description**: Add a private `recoverStuckLeaders()` method to `RoomRuntime` that detects leader sessions stuck with expired rate limits. When detected, it re-injects the last worker message (from `lastForwardedMessageId`) into the leader session to restart the review. This follows the same pattern as `recoverStuckWorkers()` (line 2548).

**Subtasks**:
1. Add `recoverStuckLeaders(): void` method to `RoomRuntime`.
2. Logic: iterate over active groups. For each group:
   a. Skip if `group.submittedForReview` (awaiting human).
   b. Skip if `group.waitingForQuestion` (intentional pause).
   c. Check if the leader has an expired rate limit (`group.rateLimit !== null && now >= group.rateLimit.resetsAt && group.rateLimit.sessionRole === 'leader'`).
   d. If leader has expired rate limit, clear it (`groupRepo.clearRateLimit(groupId)`), clear task restriction, and re-inject the last worker message into the leader session.
   e. Re-injection: use `this.getWorkerMessages(group.workerSessionId, null)` to get all worker messages, take the last one (or all since `lastForwardedMessageId`), and format it as a leader envelope. Inject via `this.taskGroupManager.routeWorkerToLeader()` or directly via `sessionFactory.injectMessage()`.
   f. Guard against duplicate in-flight recovery (similar to `stuckWorkerRecoveryInFlight` pattern).
3. Call `recoverStuckLeaders()` from `executeTick()` alongside `recoverStuckWorkers()` (around line 2760).

**Acceptance Criteria**:
- `recoverStuckLeaders()` is called from `executeTick()`.
- Leader groups with expired rate limits are detected.
- The rate limit is cleared and the last worker message is re-injected.
- Duplicate in-flight recovery is prevented.
- Groups with active rate limits or awaiting human review are skipped.

**Dependencies**: Task 1.2 (Milestone 1 -- the re-detection guard for the leader path must be in place so the re-triggered `onLeaderTerminalState` does not re-apply the backoff).

**Agent Type**: coder

---

### Task 6.2: Unit tests for leader recovery mechanism

**Title**: Add tests for `recoverStuckLeaders()` behavior

**Description**: Add unit tests verifying the leader recovery mechanism works correctly.

**Subtasks**:
1. Test: Leader hits usage_limit, backoff set. Backoff expires. `tick()` is called. `recoverStuckLeaders()` detects the expired rate limit, clears it, and re-injects the worker message into the leader session.
2. Test: Leader with active (non-expired) rate limit is skipped by `recoverStuckLeaders()`.
3. Test: Leader with no rate limit is not affected.
4. Test: `recoverStuckLeaders()` does not interfere with `recoverStuckWorkers()` (both can run in the same tick).

**Acceptance Criteria**:
- Test "recoverStuckLeaders re-injects worker message after leader rate limit expires" passes.
- Test "recoverStuckLeaders skips groups with active rate limit" passes.
- Test "recoverStuckLeaders does not affect groups without rate limit" passes.
- Existing `recoverStuckWorkers` tests continue to pass.

**Dependencies**: Task 6.1

**Agent Type**: coder
