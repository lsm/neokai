# Fix Model Switching Bugs in NeoKai

## Goal Summary

Fix two model switching bugs that prevent model changes from taking effect:

1. **Bug 1 (Task View)**: When switching models in the Task View, `session.model.switch` creates a NEW `AgentSession` via `SessionCache` (a separate instance from `RoomRuntimeService.agentSessions`), causing duplicate/conflicting concurrent queries for the same session.
2. **Bug 2 (Normal Session)**: When switching models on a normal session, `sdkSessionId` is NOT cleared during the restart, so the new query resumes the old SDK session file (created with the old model). The SDK may use the session-file model over the options model, making the switch ineffective.

## Approach

### Bug 1 Fix: Route task-view model switch through RoomRuntimeService

The root cause is that `session.model.switch` RPC handler in `session-handlers.ts` calls `sessionManager.getSessionAsync(sessionId)`, which for room worker/leader sessions creates a brand new `AgentSession` from DB via `SessionCache.loadSessionAsync()` -- because those sessions live in `RoomRuntimeService.agentSessions`, not in `SessionManager.sessionCache`.

**Fix**: Add `room.runtime.model.switch` and `room.runtime.model.get` RPC handlers that operate on `RoomRuntimeService.agentSessions` directly. The `TaskViewModelSelector` component should call these new RPCs when the session belongs to a room. The existing `session.model.switch` handler remains for non-room sessions.

### Bug 2 Fix: Clear sdkSessionId during model switch restart

The root cause is in `QueryLifecycleManager.restart()` (called by `ModelSwitchHandler.switchModel()`): it validates the SDK session file but does NOT clear `sdkSessionId`. Since `QueryOptionsBuilder.addSessionStateOptions()` sets `result.resume = session.sdkSessionId`, the new query resumes the old session file (created with the old model).

**Fix**: In `ModelSwitchHandler.switchModel()`, clear `session.sdkSessionId` and persist the change to DB before calling `lifecycleManager.restart()`. This ensures `addSessionStateOptions()` will not set `resume`, so the new query starts fresh with the new model.

---

## Tasks

### Task 1: Clear sdkSessionId during model switch (Bug 2)

**Description**: Modify `ModelSwitchHandler.switchModel()` to clear `sdkSessionId` before calling `lifecycleManager.restart()`. This prevents the SDK from resuming an old session file that was created with the previous model.

**File**: `packages/daemon/src/lib/agent/model-switch-handler.ts`

**Subtasks**:
1. In `ModelSwitchHandler.switchModel()`, after updating `session.config.model` and `session.config.provider` and persisting to DB (both the `!queryObject` and `queryObject` branches), clear `session.sdkSessionId`:
   ```ts
   session.sdkSessionId = undefined;
   db.updateSession(session.id, { sdkSessionId: undefined });
   ```
   This should be added in both branches (lines ~189 and ~228, after the existing `db.updateSession` calls that update model/provider) to ensure `sdkSessionId` is always cleared when switching models, regardless of whether a query is running.
2. The existing `restart()` method in `QueryLifecycleManager` already validates and repairs the SDK session file if `sdkSessionId` is set. Since we clear `sdkSessionId` before calling `restart()`, that validation block will be skipped (which is the desired behavior -- we want a fresh start, not a repair).

**Acceptance criteria**:
- After a model switch, `sdkSessionId` is `undefined` in both memory and DB.
- The new query starts without `resume` in its options (verified by `addSessionStateOptions`).
- Existing unit tests for `ModelSwitchHandler` still pass.
- New unit test confirms `sdkSessionId` is cleared on model switch.

**Dependencies**: None

**Agent type**: coder

---

### Task 2: Add unit tests for Bug 2 fix

**Description**: Add unit tests to verify that `sdkSessionId` is cleared during model switch.

**File**: `packages/daemon/tests/unit/agent/model-switch-handler.test.ts`

**Subtasks**:
1. Add a test case in the model switch handler tests that verifies `sdkSessionId` is set on the session before the switch, and is cleared (`undefined`) after a successful switch. The test should mock the `QueryLifecycleManager.restart()` method and the DB `updateSession` method.
2. Verify that `db.updateSession` is called with `{ sdkSessionId: undefined }` during model switch.
3. Verify that `restart()` is still called (the clearing does not prevent the restart).

**Acceptance criteria**:
- Test confirms `session.sdkSessionId` is cleared to `undefined` after model switch.
- Test confirms `db.updateSession` is called with the correct params.
- All existing model switch handler tests still pass.

**Dependencies**: Task 1

**Agent type**: coder

---

### Task 3: Add `room.runtime.model.switch` and `room.runtime.model.get` RPC handlers (Bug 1)

**Description**: Add new RPC handlers that operate on `RoomRuntimeService.agentSessions` directly, bypassing the `SessionManager.sessionCache`. These handlers will be used by the Task View model selector.

**Files**:
- `packages/daemon/src/lib/rpc-handlers/room-handlers.ts` (or a new file)
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`

**Subtasks**:
1. Add a `switchModel(sessionId, model, provider)` method to `RoomRuntimeService` that:
   - Looks up the `AgentSession` from `this.agentSessions` map
   - If found, calls `agentSession.handleModelSwitch(model, provider)` and returns the result
   - If not found, returns an error indicating the session is not managed by the room runtime
2. Add a `getModel(sessionId)` method to `RoomRuntimeService` that:
   - Looks up the `AgentSession` from `this.agentSessions` map
   - If found, returns `agentSession.getCurrentModel()` and the session's provider
   - If not found, returns null/undefined
3. Add `room.runtime.model.switch` and `room.runtime.model.get` RPC handler registrations. These should be registered in the RPC handlers setup, passing the `RoomRuntimeService` instance.

**Acceptance criteria**:
- `room.runtime.model.switch` operates on the correct `AgentSession` from `RoomRuntimeService.agentSessions`.
- `room.runtime.model.get` returns the current model from the correct instance.
- If the session is not in the runtime service's cache, appropriate error is returned.
- No duplicate `AgentSession` is created.

**Dependencies**: None

**Agent type**: coder

---

### Task 4: Update TaskViewModelSelector to use room.runtime.model.switch (Bug 1 UI fix)

**Description**: Modify the `TaskViewModelSelector` component (and the task view code that renders it) to use the new `room.runtime.model.switch` and `room.runtime.model.get` RPCs when the session belongs to a room's task view.

**File**: `packages/web/src/components/room/TaskViewModelSelector.tsx`

**Subtasks**:
1. Add a `roomId` prop to `TaskViewModelSelector`. When `roomId` is provided:
   - Use `room.runtime.model.switch` instead of `session.model.switch`
   - Use `room.runtime.model.get` instead of `session.model.get`
2. When `roomId` is not provided, fall back to the existing `session.model.switch` / `session.model.get` behavior.
3. Update the parent component that renders `TaskViewModelSelector` to pass the `roomId` prop. Check the task view rendering code to find where `TaskViewModelSelector` is instantiated and ensure `roomId` is available.

**Acceptance criteria**:
- Task view model switching uses `room.runtime.model.switch` when `roomId` is provided.
- The model switch operates on the correct `AgentSession` (the one in `RoomRuntimeService.agentSessions`).
- No duplicate queries are created.
- Fallback to `session.model.switch` works when `roomId` is not provided.

**Dependencies**: Task 3

**Agent type**: coder

---

### Task 5: Add unit tests for room.runtime.model.switch (Bug 1 tests)

**Description**: Add unit tests for the new `RoomRuntimeService.switchModel()` and `RoomRuntimeService.getModel()` methods.

**File**: `packages/daemon/tests/unit/room/room-runtime-service-wiring.test.ts` (or new test file)

**Subtasks**:
1. Test `switchModel()` with a session that exists in `agentSessions`: verify it calls `handleModelSwitch` on the correct `AgentSession` and returns the result.
2. Test `switchModel()` with a session that does NOT exist in `agentSessions`: verify it returns an error.
3. Test `getModel()` with a session that exists: verify it returns the current model info.
4. Test `getModel()` with a session that does NOT exist: verify it returns null/undefined.

**Acceptance criteria**:
- All tests pass.
- Tests cover the happy path and error paths.

**Dependencies**: Task 3

**Agent type**: coder

---

### Task 6: Add online integration test for model switch sdkSessionId clearing

**Description**: Add an online integration test that verifies model switch works end-to-end, specifically that `sdkSessionId` is cleared after switching models and the agent responds with the new model.

**File**: `packages/daemon/tests/online/rpc/rpc-model-switching.test.ts`

**Subtasks**:
1. Add a test that:
   - Creates a session
   - Sends a message to get a response (establishing an `sdkSessionId`)
   - Verifies `sdkSessionId` is set
   - Switches to a different model
   - Verifies `sdkSessionId` is cleared (via `session.get`)
   - Sends another message and verifies the agent responds (not stuck)

**Acceptance criteria**:
- Test verifies `sdkSessionId` is non-null after first query.
- Test verifies `sdkSessionId` is null after model switch.
- Test verifies agent responds after model switch (no stuck state).

**Dependencies**: Task 1, Task 2

**Agent type**: coder

---

### Task 7: Verify fix with E2E test

**Description**: Verify the model switching fix works end-to-end in the browser for both normal sessions and task view sessions.

**Files**:
- `packages/e2e/tests/` (new test file)

**Subtasks**:
1. Create an E2E test for normal session model switching:
   - Create a session
   - Switch model via the model selector
   - Send a message
   - Verify the agent responds (not stuck/silent)
2. If feasible based on test infrastructure complexity, add a basic smoke test for task view model switching. If the task view requires complex room setup, this can be deferred.

**Acceptance criteria**:
- Normal session model switch works without causing the agent to become unresponsive.
- Test passes consistently.

**Dependencies**: Task 1, Task 4

**Agent type**: coder
