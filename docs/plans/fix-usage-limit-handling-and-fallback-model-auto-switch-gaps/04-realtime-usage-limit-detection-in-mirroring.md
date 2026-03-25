# Milestone 4: Gap E -- Real-Time Usage Limit Detection in Mirroring

## Goal and Scope

The real-time message mirroring callback in `setupMirroring()` (line 2242) only handles `rate_limit` class errors. Usage limits ("You've hit your limit") are not detected by mirroring and are only caught when the session reaches terminal state in `onWorkerTerminalState`/`onLeaderTerminalState`, which can be minutes later. Adding `usage_limit` handling to mirroring enables immediate fallback model switching, reducing downtime.

## Tasks

### Task 5.1: Add `usage_limit` handling to `setupMirroring()` callback

**Title**: Add `usage_limit` detection to the mirroring callback in `setupMirroring()`

**Description**: In `room-runtime.ts`, the `setupMirroring()` method (line 2225) has a mirroring callback that checks `classifyError()` for `rate_limit` class only (line 2242). Add `usage_limit` handling alongside it. When `usage_limit` is detected, immediately attempt `trySwitchToFallbackModel()`. If the fallback succeeds, the session continues with the new model. If it fails, set the backoff and task restriction (same as the terminal-state handler).

**Important — re-detection guard**: The existing `rate_limit` mirroring handler at line 2242 has NO `!group.rateLimit` re-detection guard — it calls `groupRepo.setRateLimit()` every time a 429 message is observed. This works because mirroring sees every streaming token, and `createRateLimitBackoff()` only returns a backoff when a parseable reset time is found. However, `trySwitchToFallbackModel()` has side effects (calling `sessionFactory.switchModel` and appending events). Without a guard, repeated mirroring callbacks for the same usage-limit message could call `trySwitchToFallbackModel()` multiple times, causing duplicate `switchModel` calls and spurious events.

**Solution**: Track whether a fallback switch has already been attempted for a given session in this group using a local `Set<string>` (similar to `mirroredUuids`). Use `group.id` + `sessionId` as the key. Once `trySwitchToFallbackModel()` returns `true` for a session, add the session to this set and skip subsequent attempts. Alternatively, use a simpler approach: read fresh group state via `this.groupRepo.getGroup(group.id)` and skip if `group.rateLimit` is already set (meaning a previous mirroring callback already handled this).

**Important — stale closure reference**: The `setupMirroring(group)` method captures the `group` parameter in the callback closure. After `groupRepo.setRateLimit()` is called, the closure-captured `group` reference may or may not reflect the change depending on whether the reactive DB returns the same object or a new snapshot. All state reads inside the mirroring callback MUST use `this.groupRepo.getGroup(group.id)` to read fresh state, not the closure-captured `group` object. The `group.id` and `group.workerSessionId`/`group.leaderSessionId` values are immutable and safe to use from the closure.

**Subtasks**:
1. Add a `fallbackAttempted = new Set<string>()` inside `setupMirroring()`, parallel to `mirroredUuids`. This set tracks `(groupId, sessionId)` pairs for which a successful fallback switch has already occurred.
2. In the `setupMirroring()` callback, after the existing `rate_limit` block (line 2242-2267), add a new `else if` block for `msgErrorClass?.class === 'usage_limit'`.
3. In the `usage_limit` block:
   a. Read fresh group state: `const freshGroup = this.groupRepo.getGroup(group.id)`. If no group found, return early.
   b. **Re-detection guard**: if `freshGroup.rateLimit !== null` (a backoff is already set from a prior mirroring callback or terminal-state handler), skip — return early. The rate limit is already being handled.
   c. **Duplicate fallback guard**: if `fallbackAttempted.has(\`${group.id}:${sessionId}\`)`, skip — return early. A fallback was already attempted (and either succeeded or failed) for this session.
   d. Log the detection.
   e. Attempt `this.trySwitchToFallbackModel(group.id, sessionId, sessionRole)`. Use `.then()/.catch()` since this is inside a synchronous callback.
   f. If the fallback succeeds (`switched === true`), log a message, append a `model_fallback` event, mark `fallbackAttempted.add(...)`, and clear any existing task restriction via `this.clearTaskRestriction(freshGroup.taskId)`.
   g. If the fallback fails (`switched === false`), set backoff and task restriction using the same pattern as the terminal-state `usage_limit` handler (create backoff, call `groupRepo.setRateLimit`, append `rate_limited` event, call `persistTaskRestriction`, call `scheduleTickAfterRateLimitReset`). Also mark `fallbackAttempted.add(...)` to prevent retrying.
4. Add `fallbackAttempted` to the cleanup callback in `this.mirroringCleanups.set(group.id, ...)` — call `fallbackAttempted.clear()`.
5. For the existing `rate_limit` handler (line 2242-2267), also switch from using the closure-captured `group` object to `this.groupRepo.getGroup(group.id)` for the `group.id` and `group.taskId` references (these are immutable so this is safe, but using `freshGroup` is more consistent and avoids future confusion). Note: this is a minor cleanup, not a behavior change.

**Acceptance Criteria**:
- Mirroring detects `usage_limit` errors in real-time.
- On detection, `trySwitchToFallbackModel()` is attempted.
- **Re-detection guard**: duplicate usage_limit messages for the same session do NOT trigger multiple fallback switch attempts.
- **Fresh state reads**: all state reads in the mirroring callback use `this.groupRepo.getGroup()` rather than the closure-captured `group` object.
- Successful fallback: model_fallback event appended, task restriction cleared.
- Failed fallback: backoff set, task restriction persisted, tick scheduled.
- Existing `rate_limit` mirroring behavior is unchanged.
- Cleanup callback clears the `fallbackAttempted` set.

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
