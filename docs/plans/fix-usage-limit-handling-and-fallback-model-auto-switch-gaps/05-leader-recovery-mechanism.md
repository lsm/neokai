# Milestone 5: Gap F -- Leader Recovery Mechanism After Usage Limit

## Goal and Scope

Workers have `recoverStuckWorkers()` which re-triggers `onWorkerTerminalState` after a rate limit expires. But there is no equivalent `recoverStuckLeaders()` mechanism. If the leader hits a usage limit and no fallback is available, the group is permanently stuck because the worker output was already forwarded (feedbackIteration > 0) and the leader never completes its review.

The fix adds a `recoverStuckLeaders()` method that detects leaders stuck with expired rate limits and re-injects a message into the leader session to restart the review. Unlike `recoverStuckWorkers()` which re-triggers `onWorkerTerminalState` (which then calls `routeWorkerToLeader`), there is no equivalent `onLeaderTerminalState` re-trigger. The leader must receive a NEW message that causes it to produce output, reach terminal state, and have the observer fire `onLeaderTerminalState` again with fresh output.

## Tasks

### Task 5.1: Add `recoverStuckLeaders()` method to RoomRuntime

**Title**: Add `recoverStuckLeaders()` method mirroring `recoverStuckWorkers()`

**Description**: Add a private `recoverStuckLeaders()` method to `RoomRuntime` that detects leader sessions stuck with expired rate limits. When detected, it clears the rate limit and re-injects a message into the leader session to restart the review. This follows the same pattern as `recoverStuckWorkers()` (line 2548) but uses a different re-injection mechanism.

**Re-injection mechanism**: Unlike `recoverStuckWorkers()` which re-triggers `onWorkerTerminalState` (which internally calls `routeWorkerToLeader`), there is no equivalent `routeWorkerToLeader` for leaders. The leader recovery must:
1. Clear the expired rate limit and task restriction.
2. Construct a continuation message summarizing the last worker output (from `getWorkerMessages` since `lastForwardedMessageId`).
3. Inject this message into the leader session via `this.sessionFactory.injectMessage(group.leaderSessionId, continuationMessage)`.
4. The injected message causes the leader to produce a new response. When that response reaches terminal state, the session observer fires `onLeaderTerminalState` with the fresh output. If the fresh output still contains the old usage-limit text, the re-detection guard from Milestone 1 (Bug A) prevents re-applying the backoff — the handler falls through to normal completion.

**Subtasks**:
1. Add a `stuckLeaderRecoveryInFlight = new Set<string>()` field to `RoomRuntime` (parallel to `stuckWorkerRecoveryInFlight`).
2. Add `recoverStuckLeaders(): void` method to `RoomRuntime`.
3. Logic: iterate over active groups. For each group:
   a. Skip if `group.submittedForReview` (awaiting human).
   b. Skip if `group.waitingForQuestion` (intentional pause).
   c. Skip if leader session is not in the session factory (`!this.sessionFactory.hasSession(group.leaderSessionId)`).
   d. Skip if leader session is actively processing (`getProcessingState` is not `'idle'` or `'interrupted'`).
   e. Check if the leader has an expired rate limit: `group.rateLimit !== null && now >= group.rateLimit.resetsAt && group.rateLimit.sessionRole === 'leader'`.
   f. Guard against duplicate in-flight recovery: skip if `stuckLeaderRecoveryInFlight.has(group.id)`.
   g. If leader has expired rate limit:
      - Clear the rate limit: `this.groupRepo.clearRateLimit(groupId)`.
      - Clear task restriction: `this.clearTaskRestriction(group.taskId)`.
      - Construct a continuation message: use `this.getWorkerMessages(group.workerSessionId, group.lastForwardedMessageId)` to get the worker messages that were previously forwarded. Format as a brief summary: `[Auto-recovery] Resuming leader review after rate limit expired. Last worker output: <excerpt>`.
      - Inject into leader: `this.sessionFactory.injectMessage(group.leaderSessionId, continuationMessage)`.
      - Mark in-flight: `stuckLeaderRecoveryInFlight.add(group.id)`.
      - Append a group event: `this.appendGroupEvent(groupId, 'status', { text: 'Leader recovered from expired rate limit. Re-injecting worker message.' })`.
      - Schedule a follow-up tick: `this.scheduleTick()` (to clean up the in-flight flag).
4. Add cleanup for `stuckLeaderRecoveryInFlight` in the `executeTick` method (clear the set at the start of each tick, same as `stuckWorkerRecoveryInFlight`).
5. Call `recoverStuckLeaders()` from `executeTick()` alongside `recoverStuckWorkers()` (around line 2760).

**Acceptance Criteria**:
- `recoverStuckLeaders()` is called from `executeTick()`.
- Leader groups with expired rate limits are detected.
- The rate limit is cleared and task restriction is cleared.
- A continuation message is injected into the leader session via `sessionFactory.injectMessage()`.
- When the leader finishes processing the injected message, `onLeaderTerminalState` fires with fresh output.
- Duplicate in-flight recovery is prevented via `stuckLeaderRecoveryInFlight`.
- Groups with active rate limits or awaiting human review are skipped.

**Dependencies**: Task 1.2 (Milestone 1 -- the re-detection guard for the leader path must be in place so that if the re-injected leader response still contains old usage-limit text, the handler falls through to normal completion instead of re-applying the backoff).

**Agent Type**: coder

---

### Task 5.2: Unit tests for leader recovery mechanism

**Title**: Add tests for `recoverStuckLeaders()` behavior

**Description**: Add unit tests verifying the leader recovery mechanism works correctly.

**Subtasks**:
1. Test: Leader hits usage_limit, backoff set with `sessionRole: 'leader'`. Backoff expires. `tick()` is called. `recoverStuckLeaders()` detects the expired rate limit, clears it, clears task restriction, and calls `sessionFactory.injectMessage()` for the leader session with a continuation message.
2. Test: Leader with active (non-expired) rate limit is skipped by `recoverStuckLeaders()`.
3. Test: Leader with no rate limit is not affected.
4. Test: `recoverStuckLeaders()` does not interfere with `recoverStuckWorkers()` (both can run in the same tick).
5. Test: Re-injection causes `onLeaderTerminalState` to fire with fresh output. With the re-detection guard from Milestone 1, if the output still contains old usage-limit text, the handler falls through to normal completion.
6. Test: Duplicate in-flight recovery is prevented — two consecutive ticks do not inject twice.

**Acceptance Criteria**:
- Test "recoverStuckLeaders re-injects message after leader rate limit expires" passes.
- Test "recoverStuckLeaders skips groups with active rate limit" passes.
- Test "recoverStuckLeaders does not affect groups without rate limit" passes.
- Test "duplicate in-flight recovery is prevented" passes.
- Existing `recoverStuckWorkers` tests continue to pass.

**Dependencies**: Task 5.1

**Agent Type**: coder
