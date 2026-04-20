# Milestone 3: Bug D + Gap H -- Skip Stale Envelope Routing and Clear Restriction After Fallback Switch

## Goal and Scope

After `trySwitchToFallbackModel()` succeeds in the `usage_limit` handler, the code currently falls through to normal routing (line 766). But the worker output text still contains the old "You've hit your limit" error text. This stale text gets sent to the leader in the envelope, creating confusing context. More importantly, `handleModelSwitch` starts a new streaming query, so `onWorkerTerminalState` will fire again with fresh output. The first envelope with stale text should not be sent.

Additionally, when `trySwitchToFallbackModel()` succeeds, the task's `restrictions` field and the group's `rateLimit` are NOT cleared. The task stays in `usage_limited`/`rate_limited` status even though it's now working with the fallback model, and the UI shows the wrong status/badge.

Both fixes are combined in this milestone because they modify the exact same code path (the `usage_limit` handler's success branch).

## Tasks

### Task 3.1: Return early after successful fallback switch in worker path

**Title**: Return early after successful `trySwitchToFallbackModel()` in `onWorkerTerminalState()`

**Description**: In `room-runtime.ts`, the `usage_limit` handler at line 729 currently falls through to normal routing after a successful `trySwitchToFallbackModel()`. Change the `// Fall through to normal routing` comment at line 766 to a `return` statement. Before returning, clear the task restriction and the group rate limit since the fallback model is now active.

**Subtasks**:
1. At line 766 (the fall-through after `trySwitchToFallbackModel` succeeds), change from falling through to returning early: `return;`.
2. Before returning, call `this.clearTaskRestriction(group.taskId)` to clear any stale restriction data. This restores the task status to `in_progress` and clears `restrictions`.
3. Call `this.groupRepo.clearRateLimit(groupId)` since the fallback model is now active and the original rate/usage limit no longer applies to this model.

**Acceptance Criteria**:
- After a successful `trySwitchToFallbackModel()`, `onWorkerTerminalState` returns immediately without routing to leader.
- Task restriction is cleared (task status restored to `in_progress`, `restrictions` is null).
- Group rate limit is cleared.
- When the new query completes with clean output, `onWorkerTerminalState` fires again and routes normally.

**Dependencies**: Task 1.1 (Milestone 1 -- the re-detection guard should be in place first to prevent the new return-from-success path from being confused with re-detection).

**Agent Type**: coder

---

### Task 3.2: Return early after successful fallback switch in leader path

**Title**: Return early after successful `trySwitchToFallbackModel()` in `onLeaderTerminalState()`

**Description**: Same fix as Task 3.1 but for the leader path at line 1094-1131. After a successful `trySwitchToFallbackModel()`, return early instead of falling through to normal completion. Clear task restriction and group rate limit before returning.

**Subtasks**:
1. At line 1130 (the fall-through after `trySwitchToFallbackModel` succeeds in the leader `usage_limit` handler), change to return early.
2. Clear task restriction and group rate limit before returning.

**Acceptance Criteria**:
- After a successful fallback switch in the leader path, `onLeaderTerminalState` returns immediately.
- Task restriction and group rate limit are cleared.

**Dependencies**: Task 1.2 (Milestone 1 -- the re-detection guard for leader path).

**Agent Type**: coder

---

### Task 3.3: Unit tests for fallback switch success path

**Title**: Add tests verifying correct behavior after successful fallback switch

**Description**: Add unit tests verifying that after a successful `trySwitchToFallbackModel()`: (1) no worker output is routed to the leader (no stale envelope), (2) task restriction is cleared, (3) group rate limit is cleared.

**Subtasks**:
1. Test: Configure fallback models in `getGlobalSettings`, mock `sessionFactory.switchModel` to return success. Simulate `usage_limit` detection in worker output. Verify `trySwitchToFallbackModel` was called and returned `true`. Verify NO `injectMessage` call for the leader session (no routing happened).
2. Test: Same for leader path.
3. Test: After fallback switch, `task.restrictions` is cleared and task status is restored to `in_progress`.
4. Test: After fallback switch, `group.rateLimit` is cleared.
5. Regression test: Simulate first `rate_limit` detection (sets backoff + restriction). Manually expire the backoff. Simulate re-trigger that detects `usage_limit`. Configure fallback model. Verify that after successful switch, task restriction is cleared (not still set from the earlier `rate_limit` cycle).

**Acceptance Criteria**:
- Test "does NOT route to leader after successful fallback model switch" passes.
- Test "clears task restriction after successful fallback switch" passes.
- Test "clears group rate limit after successful fallback switch" passes.
- Test "task restriction cleared after fallback switch even with prior rate_limit cycle" passes.
- Existing usage_limit tests continue to pass.

**Dependencies**: Task 3.1, Task 3.2

**Agent Type**: coder
