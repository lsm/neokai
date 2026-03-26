# Fix Model Switching Bugs: Remove Silent Auto-Recovery, Fix RPC Routing, DB as Source of Truth

## Goal

Fix three interrelated bugs in model switching for room agent sessions:

1. **Remove silent auto-recovery** in `query-runner.ts` -- the `onStartupTimeoutAutoRecover` callback silently clears `sdkSessionId` and restarts the query, losing conversation context without user notice. Replace with fail-loud behavior: surface the error to the user and let them decide.
2. **Fix `trySwitchToFallbackModel` RPC routing** in `room-runtime.ts:359` -- calls `messageHub.request('session.model.get', ...)` which sends the request through WebSocket transport to browser clients instead of handling it server-side. The handler is registered server-side via `onRequest()`, but `request()` always goes over the wire. Add `getCurrentModel()` to `SessionFactory` for direct server-side access.
3. **DB as single source of truth** -- read current model/provider from the DB session record instead of relying on in-memory `AgentSession` cache. This avoids stale cache issues when model is switched externally.

## Approach

The three bugs share common dependencies. The plan addresses them in dependency order:

- **Milestone 1** (Bug 2): Fix RPC routing first because `trySwitchToFallbackModel` is a primary caller that needs to work correctly.
- **Milestone 2** (Bug 3): Add DB-as-source-of-truth to `SessionFactory.getCurrentModel()` so the fix from Milestone 1 reads from the canonical source.
- **Milestone 3** (Bug 1): Remove silent auto-recovery. This is the most impactful change because it modifies error handling behavior. It depends on Milestones 1 and 2 being in place so fallback model switching works correctly without silent retries.

---

## Milestone 1: Fix RPC Routing in `trySwitchToFallbackModel`

**Goal**: Replace `messageHub.request('session.model.get', ...)` in `room-runtime.ts` with direct server-side access via `SessionFactory.getCurrentModel()`.

### Task 1.1: Add `getCurrentModel()` to `SessionFactory` interface and implementations

**Description**: Add a `getCurrentModel(sessionId: string)` method to the `SessionFactory` interface in `packages/daemon/src/lib/room/runtime/task-group-manager.ts`. This method reads model/provider from the session in-memory cache (or DB as fallback) and returns it without going through the MessageHub RPC layer.

**Files to modify**:
- `packages/daemon/src/lib/room/runtime/task-group-manager.ts` -- Add `getCurrentModel(sessionId: string)` to `SessionFactory` interface:
  ```ts
  /**
   * Get the current model and provider for a session.
   * Reads from in-memory cache (fast path) or DB (fallback).
   * Returns null if session is not found.
   */
  getCurrentModel(sessionId: string): Promise<{ currentModel: string; currentProvider: string } | null>;
  ```
- `packages/daemon/src/lib/session/session-manager.ts` -- Implement `getCurrentModel()` that delegates to `SessionCache.getAsync()` and reads `session.config.model` and `session.config.provider`. Falls back to `db.getSession(sessionId)` if not in cache.

**Subtasks**:
1. Add the `getCurrentModel` method signature to the `SessionFactory` interface in `task-group-manager.ts`.
2. Implement `getCurrentModel` in `SessionManager` (which implements `SessionFactory`). Use `sessionCache.getAsync(sessionId)` to get the `AgentSession`, then call `agentSession.getCurrentModel()` and `agentSession.getSessionData().config.provider`. If not in cache, fall back to `db.getSession(sessionId)` to read `session.config.model` and `session.config.provider`.
3. Wire through the `session.model.get` handler logic: resolve model alias using `resolveModelAlias` and `getModelInfo` from `model-service`. This ensures consistency with the RPC handler's behavior.

**Acceptance criteria**:
- `SessionFactory.getCurrentModel(sessionId)` returns `{ currentModel, currentProvider }` or `null`.
- The method works both when the session is in cache and when it must be loaded from DB.
- All existing room-runtime unit tests that mock `SessionFactory` still compile (add `getCurrentModel` to mock in `room-runtime-test-helpers.ts`).

**Dependencies**: None

**Agent type**: coder

### Task 1.2: Replace `messageHub.request('session.model.get')` in `room-runtime.ts`

**Description**: Update `trySwitchToFallbackModel` in `packages/daemon/src/lib/room/runtime/room-runtime.ts` to call `this.sessionFactory.getCurrentModel(sessionId)` instead of `this.messageHub?.request('session.model.get', { sessionId })`.

**Files to modify**:
- `packages/daemon/src/lib/room/runtime/room-runtime.ts` -- In `trySwitchToFallbackModel()` (line ~358-371), replace:
  ```ts
  // BEFORE:
  const modelInfo = (await this.messageHub?.request('session.model.get', { sessionId })) as SessionModelGetResult | undefined;
  if (!modelInfo || !modelInfo.currentModel) {
    log.warn(`Could not get current model for session ${sessionId}`);
    return false;
  }
  currentModel = modelInfo.currentModel;
  currentProvider = modelInfo.modelInfo?.provider ?? 'anthropic';

  // AFTER:
  const modelInfo = await this.sessionFactory.getCurrentModel(sessionId);
  if (!modelInfo) {
    log.warn(`Could not get current model for session ${sessionId}`);
    return false;
  }
  currentModel = modelInfo.currentModel;
  currentProvider = modelInfo.currentProvider;
  ```
- Remove the `SessionModelGetResult` interface (line 108-112) since it is no longer used.
- Remove the `messageHub` from `RoomRuntimeConfig` and the constructor if no other code in room-runtime uses it. (Verify this with grep first -- if other code uses it, keep it.)

**Subtasks**:
1. Grep `room-runtime.ts` for all uses of `this.messageHub` to determine if it is only used for `session.model.get`. If so, remove the field and config option.
2. Replace the `messageHub.request('session.model.get', ...)` call with `this.sessionFactory.getCurrentModel(sessionId)`.
3. Remove the `SessionModelGetResult` interface if no longer referenced.
4. Update `createRuntimeTestContext` in `room-runtime-test-helpers.ts` to no longer require a `messageHub` mock (or keep it if other tests need it).

**Acceptance criteria**:
- `trySwitchToFallbackModel` no longer sends RPC requests over WebSocket.
- All existing room-runtime unit tests pass without modification (or with minimal mock updates).
- `messageHub` optional field can be removed from `RoomRuntimeConfig` if unused elsewhere.

**Dependencies**: Task 1.1

**Agent type**: coder

### Task 1.3: Update room-runtime unit test mocks

**Description**: Update the mock `SessionFactory` in `packages/daemon/tests/unit/room/room-runtime-test-helpers.ts` to include the new `getCurrentModel` method. Update all room-runtime tests that previously relied on the `messageHub` mock for `session.model.get` to use the new `sessionFactory.getCurrentModel` mock instead.

**Files to modify**:
- `packages/daemon/tests/unit/room/room-runtime-test-helpers.ts` -- Add `getCurrentModel` to `createMockSessionFactory()`:
  ```ts
  async getCurrentModel(sessionId: string) {
    return { currentModel: 'sonnet', currentProvider: 'anthropic' };
  },
  ```
  Also add configurable per-session overrides.

- `packages/daemon/tests/unit/room/room-runtime-model-fallback-map.test.ts` -- The `makeMessageHub` helper that mocks `session.model.get` is no longer needed for the runtime path. Instead, configure the mock `sessionFactory.getCurrentModel` to return the desired model. However, if `messageHub` is still used in the test context for other purposes (e.g., `createRuntimeTestContext` passes it), the mock may still be needed. Verify and simplify.

**Subtasks**:
1. Add `getCurrentModel` to the mock `SessionFactory` in `room-runtime-test-helpers.ts`.
2. Update `room-runtime-model-fallback-map.test.ts` to configure `getCurrentModel` on the mock factory instead of `makeMessageHub`.
3. Run all room-runtime unit tests to verify.

**Acceptance criteria**:
- All `packages/daemon/tests/unit/room/room-runtime-*.test.ts` tests pass.
- The `messageHub` mock for `session.model.get` is removed or simplified.

**Dependencies**: Task 1.2

**Agent type**: coder

---

## Milestone 2: DB as Single Source of Truth for Model Info

**Goal**: Make `SessionFactory.getCurrentModel()` read from the DB session record as the canonical source, rather than relying on the in-memory `AgentSession` cache which can become stale when model is switched externally.

### Task 2.1: Implement DB-first model info retrieval in `SessionFactory.getCurrentModel()`

**Description**: Update the `getCurrentModel` implementation in `SessionManager` to always read from the DB (`db.getSession(sessionId)`) as the primary source. The DB record is updated synchronously when `modelSwitchHandler.switchModel()` calls `db.updateSession()`, making it the most reliable source. The in-memory cache can be used as a performance optimization but should not be the authoritative source.

**Files to modify**:
- `packages/daemon/src/lib/session/session-manager.ts` -- In the `getCurrentModel` implementation:
  1. Read from DB first: `const session = this.db.getSession(sessionId)`.
  2. If not found in DB, return null.
  3. Return `{ currentModel: session.config.model, currentProvider: session.config.provider ?? 'anthropic' }`.
  4. Optionally resolve the model alias via `resolveModelAlias` for consistency with the RPC handler.

**Subtasks**:
1. Update `getCurrentModel` in `SessionManager` to read from DB.
2. Add optional model alias resolution using `resolveModelAlias` from `model-service` for consistency.
3. Ensure the method handles sessions with no provider configured (return `'anthropic'` as default).

**Acceptance criteria**:
- `getCurrentModel` reads from the DB and returns the current persisted model/provider.
- If a model switch happens externally (e.g., via a direct DB update or another process), `getCurrentModel` reflects the change.
- Unit test verifies DB is the source of truth.

**Dependencies**: Task 1.1

**Agent type**: coder

### Task 2.2: Add unit tests for DB-as-source-of-truth behavior

**Description**: Write unit tests verifying that `getCurrentModel()` reads from the DB and reflects model switches correctly.

**Files to create/modify**:
- `packages/daemon/tests/unit/room/room-runtime-model-fallback-db-source.test.ts` (new) -- Tests:
  1. `getCurrentModel` returns model from DB record.
  2. After a model switch (DB update), `getCurrentModel` reflects the new model even if the in-memory cache still has the old model.
  3. `getCurrentModel` returns null for non-existent sessions.
  4. `getCurrentModel` returns default provider when provider is not configured.

**Subtasks**:
1. Create test file with the above test cases.
2. Use `createRuntimeTestContext` with a real SQLite DB.
3. Directly update the DB session config and verify `sessionFactory.getCurrentModel()` reflects the change.

**Acceptance criteria**:
- All new tests pass.
- Tests use real DB (not mocks) to verify DB-read behavior.

**Dependencies**: Task 2.1

**Agent type**: coder

---

## Milestone 3: Remove Silent Auto-Recovery

**Goal**: Remove the `onStartupTimeoutAutoRecover` callback mechanism from `query-runner.ts` and `agent-session.ts`. Instead of silently retrying, surface the error immediately to the user with actionable recovery hints.

### Task 3.1: Remove auto-recovery logic from `query-runner.ts`

**Description**: Remove the entire auto-recovery code path from the catch block in `query-runner.ts`. This includes:

1. The `onStartupTimeoutAutoRecover` optional callback in `QueryRunnerContext` (line 117-118).
2. The `startupTimeoutAutoRecoverAttempts` tracking field (line 99-101).
3. The auto-recovery guard logic in the catch block (lines 356-415).
4. The env var functions and constants: `getStartupRecoveryDelayMs()`, `getStartupMaxRetries()`, `STARTUP_RECOVERY_DELAY_MS`, `STARTUP_MAX_RETRIES` (lines 29-31, 40-52, 58-59).
5. The conditional `messageQueue.clear()` logic that preserved queued messages for retry (lines 360-366). After this change, always clear the queue on error.

**Files to modify**:
- `packages/daemon/src/lib/agent/query-runner.ts`:
  - Remove `QueryRunnerContext.onStartupTimeoutAutoRecover` optional callback.
  - Remove `QueryRunnerContext.startupTimeoutAutoRecoverAttempts` field.
  - Remove env var reading: `getStartupRecoveryDelayMs()`, `getStartupMaxRetries()`, `STARTUP_RECOVERY_DELAY_MS`, `STARTUP_MAX_RETRIES`.
  - Simplify the catch block: always call `messageQueue.clear()`, always surface the error via `errorManager.handleError()`, never schedule retries.
  - Keep the `sdkSessionId` clearing logic (line 371-378) since it is still useful for the error message / next-attempt behavior when the user manually retries.

**Subtasks**:
1. Remove `onStartupTimeoutAutoRecover` from `QueryRunnerContext`.
2. Remove `startupTimeoutAutoRecoverAttempts` from `QueryRunnerContext`.
3. Remove the env var constants and reader functions for recovery delay and max retries.
4. Simplify the catch block: remove the `canAutoRecover` branch. On startup timeout or conversation-not-found, always clear the queue, always surface the error. The existing error message with recovery hints (lines 494-507) is already good -- keep it but simplify by removing "after N attempt(s)" language since there are no longer retries.
5. Remove the conditional `messageQueue.clear()` logic. Always call `messageQueue.clear()` on error.

**Acceptance criteria**:
- No auto-recovery code path remains in `query-runner.ts`.
- Startup timeout errors are surfaced immediately to the user.
- Conversation-not-found errors are surfaced immediately.
- The error message still includes actionable recovery hints.
- `sdkSessionId` is still cleared on startup timeout / conversation-not-found to allow fresh start on next user message.

**Dependencies**: None

**Agent type**: coder

### Task 3.2: Remove auto-recovery wiring from `agent-session.ts`

**Description**: Remove the `onStartupTimeoutAutoRecover()` method implementation and the `startupTimeoutAutoRecoverAttempts` field from `agent-session.ts`.

**Files to modify**:
- `packages/daemon/src/lib/agent/agent-session.ts`:
  - Remove the `startupTimeoutAutoRecoverAttempts = 0` field (line 224).
  - Remove the `onStartupTimeoutAutoRecover()` method (lines 806-810).
  - Remove the property from the `QueryRunnerContext` wiring (where `agent-session` passes itself as the context to `QueryRunner`). This is likely in the constructor where the context object is created.

**Subtasks**:
1. Remove `startupTimeoutAutoRecoverAttempts` field from `AgentSession`.
2. Remove `onStartupTimeoutAutoRecover()` method.
3. Find where the `QueryRunnerContext` is assembled in `agent-session.ts` and remove the `onStartupTimeoutAutoRecover` property.

**Acceptance criteria**:
- `AgentSession` no longer has `onStartupTimeoutAutoRecover` or `startupTimeoutAutoRecoverAttempts`.
- `QueryRunner` no longer receives these from its context.

**Dependencies**: Task 3.1

**Agent type**: coder

### Task 3.3: Update query-runner unit tests

**Description**: Update `packages/daemon/tests/unit/agent/query-runner.test.ts` to remove all auto-recovery tests and update the remaining tests.

**Files to modify**:
- `packages/daemon/tests/unit/agent/query-runner.test.ts`:
  - Remove the `startupTimeoutAutoRecoverAttempts` field from the test context (line 188).
  - Remove the `onStartupTimeoutAutoRecover` property from `createContext` (wherever it is passed).
  - Remove the entire `describe('startup timeout auto-recovery', ...)` test block (lines 720-895).
  - Update the test "should pass actionable user message to handleError when all retries exhausted" since retries no longer exist -- it should verify the error is surfaced on the first failure.
  - Update the test "should pass session-reset hint (no timeout mention) when conversation-not-found retries exhausted" similarly.
  - Add a new test: "should always call messageQueue.clear() on startup timeout" (replaces the old test that had the inverse condition).
  - Remove tests for `STARTUP_RECOVERY_DELAY_MS` and `STARTUP_MAX_RETRIES` env vars.

**Subtasks**:
1. Remove `onStartupTimeoutAutoRecover` and `startupTimeoutAutoRecoverAttempts` from the test context.
2. Remove all auto-recovery test cases.
3. Add test verifying immediate error surfacing on first startup timeout.
4. Add test verifying `messageQueue.clear()` is always called on startup timeout.
5. Remove env var constant tests that no longer exist.
6. Run `make test-daemon` to verify all tests pass.

**Acceptance criteria**:
- No auto-recovery test code remains.
- New tests verify that startup timeout errors are surfaced immediately on the first failure.
- All daemon unit tests pass.

**Dependencies**: Task 3.1, Task 3.2

**Agent type**: coder

### Task 3.4: Online test for startup timeout error surfacing

**Description**: Add an online test verifying that a startup timeout error is surfaced to the user (via `errorManager.handleError`) without any silent retry. This test can use the dev proxy to simulate a slow SDK startup.

**Files to create/modify**:
- `packages/daemon/tests/online/convo/startup-timeout-no-retry.test.ts` (new) -- Test:
  1. Set a very short `NEOKAI_SDK_STARTUP_TIMEOUT_MS` (e.g., 100ms).
  2. Start a session and send a message.
  3. Verify the SDK startup times out and the error is surfaced immediately (no retry).
  4. Verify the error message contains actionable recovery hints.
  5. Verify the session state returns to idle after the error.

**Subtasks**:
1. Create the test file using the existing online test patterns (e.g., `createDaemonServer` with dev proxy).
2. Configure a very short startup timeout.
3. Send a message and verify error surfacing.
4. Clean up the session after the test.

**Acceptance criteria**:
- The test verifies no retry occurs.
- The error is surfaced via `errorManager.handleError`.
- The test passes with `NEOKAI_USE_DEV_PROXY=1`.

**Dependencies**: Task 3.3

**Agent type**: coder

---

## Summary

| Milestone | Task | Description | Dependencies |
|-----------|------|-------------|-------------|
| 1 | 1.1 | Add `getCurrentModel()` to `SessionFactory` interface | None |
| 1 | 1.2 | Replace `messageHub.request()` in `room-runtime.ts` | 1.1 |
| 1 | 1.3 | Update room-runtime unit test mocks | 1.2 |
| 2 | 2.1 | Implement DB-first model info retrieval | 1.1 |
| 2 | 2.2 | Add unit tests for DB-as-source-of-truth | 2.1 |
| 3 | 3.1 | Remove auto-recovery logic from `query-runner.ts` | None |
| 3 | 3.2 | Remove auto-recovery wiring from `agent-session.ts` | 3.1 |
| 3 | 3.3 | Update query-runner unit tests | 3.1, 3.2 |
| 3 | 3.4 | Online test for startup timeout error surfacing | 3.3 |

**Total tasks**: 9
**Estimated complexity**: Medium -- the changes are localized to a few files with clear boundaries. The main risk is ensuring all existing tests are updated correctly.

## Risks and Edge Cases

1. **MessageHub still used elsewhere in room-runtime**: If `this.messageHub` is used by other code in `room-runtime.ts` (e.g., for broadcasting events), removing it from the config would break those features. Mitigation: grep thoroughly before removal; if still needed, keep the field but remove only the `session.model.get` usage.

2. **DB read latency**: Reading from DB on every `getCurrentModel()` call adds a small amount of latency vs. in-memory cache. Mitigation: SQLite reads are sub-millisecond for single-row lookups; this is negligible compared to the cost of an RPC round-trip.

3. **Stale in-memory cache elsewhere**: After removing auto-recovery, the `session.config.model` in the in-memory `AgentSession` may still be stale if the model was switched externally (e.g., via a direct DB update). This is acceptable because the DB is now the source of truth for `trySwitchToFallbackModel`. The in-memory cache is updated by `modelSwitchHandler.switchModel()` which is the only legitimate model-switch path.

4. **Test mocks that depend on `messageHub`**: Some room-runtime tests pass a `messageHub` mock to `createRuntimeTestContext`. If `messageHub` is removed from the config, these tests will need updating. Mitigation: Task 1.3 handles this.

5. **Backward compatibility for `NEOKAI_SDK_STARTUP_RECOVERY_DELAY_MS` and `NEOKAI_SDK_STARTUP_MAX_RETRIES`**: These env vars will no longer have any effect after Milestone 3. This is acceptable because they were undocumented debugging knobs. The `NEOKAI_SDK_STARTUP_TIMEOUT_MS` env var is kept.

## Testing Strategy

- **Unit tests**: Existing room-runtime tests, query-runner tests, and model-switch tests provide comprehensive coverage. All must pass after changes.
- **New unit tests**: Task 2.2 adds DB-source-of-truth tests. Task 3.3 adds immediate-error-surfacing tests.
- **Online tests**: Task 3.4 adds an online test for startup timeout behavior using the dev proxy.
- **E2E tests**: Not required for this change -- the bugs are server-side and do not affect the UI directly. The UI already handles error messages via `errorManager.handleError()`.
