# Milestone 5: Gap E -- Real-Time Usage Limit Detection in Mirroring

## Goal and Scope

The real-time message mirroring callback in `setupMirroring()` (line 2242) only handles `rate_limit` class errors. Usage limits ("You've hit your limit") are not detected by mirroring and are only caught when the session reaches terminal state in `onWorkerTerminalState`/`onLeaderTerminalState`, which can be minutes later. Adding `usage_limit` handling to mirroring enables immediate fallback model switching, reducing downtime.

## Tasks

### Task 5.1: Add `usage_limit` handling to `setupMirroring()` callback

**Title**: Add `usage_limit` detection to the mirroring callback in `setupMirroring()`

**Description**: In `room-runtime.ts`, the `setupMirroring()` method (line 2225) has a mirroring callback that checks `classifyError()` for `rate_limit` class only (line 2242). Add `usage_limit` handling alongside it. When `usage_limit` is detected, immediately attempt `trySwitchToFallbackModel()`. If the fallback succeeds, the session continues with the new model. If it fails, set the backoff and task restriction (same as the terminal-state handler).

**Subtasks**:
1. In the `setupMirroring()` callback, after the existing `rate_limit` block (line 2242-2267), add a new `else if` block for `msgErrorClass?.class === 'usage_limit'`.
2. In the `usage_limit` block:
   a. Log the detection.
   b. Attempt `this.trySwitchToFallbackModel(groupId, sessionId, sessionRole)`. Use `.catch()` since this is inside a synchronous callback.
   c. If the fallback succeeds (`switched === true`), log a message and append a `model_fallback` event. Clear any existing task restriction.
   d. If the fallback fails (`switched === false`), set backoff and task restriction using the same pattern as the terminal-state `usage_limit` handler (create backoff, call `groupRepo.setRateLimit`, append `rate_limited` event, call `persistTaskRestriction`, call `scheduleTickAfterRateLimitReset`).

**Acceptance Criteria**:
- Mirroring detects `usage_limit` errors in real-time.
- On detection, `trySwitchToFallbackModel()` is attempted.
- Successful fallback: model_fallback event appended, task restriction cleared.
- Failed fallback: backoff set, task restriction persisted, tick scheduled.
- Existing `rate_limit` mirroring behavior is unchanged.

**Dependencies**: None (independent of Milestone 1-4).

**Agent Type**: coder

---

### Task 5.2: Unit tests for real-time usage_limit mirroring

**Title**: Add tests for usage_limit detection in mirroring callback

**Description**: Add tests that verify `usage_limit` is detected by the mirroring callback and triggers the correct behavior (fallback attempt, backoff, events).

**Subtasks**:
1. Test: Simulate a `sdk.message` event on the daemon hub containing usage_limit text. Verify `trySwitchToFallbackModel` was called. If no fallback configured, verify backoff was set and `rate_limited` event appended.
2. Test: With fallback configured, verify model_fallback event appended and no backoff set.
3. Test: Existing `rate_limit` mirroring tests still pass.

**Acceptance Criteria**:
- Test "mirroring detects usage_limit and attempts fallback" passes.
- Test "mirroring sets backoff when usage_limit detected and no fallback available" passes.
- Test "mirroring switches model when usage_limit detected and fallback available" passes.

**Dependencies**: Task 5.1

**Agent Type**: coder
