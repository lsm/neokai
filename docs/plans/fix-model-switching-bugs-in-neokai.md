# Fix Model Switching Bugs in NeoKai

## Goal Summary

Fix two model switching bugs that prevent model changes from taking effect:

1. **Bug 1 (Task View)**: When switching models in the Task View, `session.model.switch` creates a NEW `AgentSession` via `SessionCache` (a separate instance from `RoomRuntimeService.agentSessions`), causing duplicate/conflicting concurrent queries for the same session.
2. **Bug 2 (Normal Session)**: When switching models on a normal session, `sdkSessionId` is NOT cleared during the restart, so the new query resumes the old SDK session file (created with the old model). The SDK may use the session-file model over the options model, making the switch ineffective.

## Approach

### Bug 1 Fix: Register room sessions in SessionCache (matching Space pattern)

The root cause is that `session.model.switch` RPC handler in `session-handlers.ts` calls `sessionManager.getSessionAsync(sessionId)`, which for room worker/leader sessions creates a brand new `AgentSession` from DB via `SessionCache.loadSessionAsync()` -- because those sessions live in `RoomRuntimeService.agentSessions`, not in `SessionManager.sessionCache`.

**Why `registerSession` over new RPC handlers**: Space sessions (via `TaskAgentManager`) already solve this exact problem by calling `sessionManager.registerSession()` after creating sessions via `AgentSession.fromInit()`. The `SessionCache.set()` method clears any pending load locks so new `getAsync()` callers immediately see the registered instance, and `getAsync()` has a guard that prefers the registered live instance over a DB-loaded duplicate. This approach:
- Fixes the bug for **all** RPC handlers that use `sessionManager.getSessionAsync()` (not just model switching -- also `message.send`, `message.sdkMessages`, etc.)
- Requires **zero** new RPC handlers, no new RPC method names, no UI changes
- Is consistent with the existing Space architecture (`task-agent-manager.ts:398`)

**Fix**: In `RoomRuntimeService.createSessionFactory().createAndStartSession()`, add `ctx.sessionManager.registerSession(session)` after storing in the local `agentSessions` Map (line ~250 of `room-runtime-service.ts`). In `stopSession()`, add `ctx.sessionManager.sessionCache.remove(sessionId)` in the `finally` block (since there is no `unregisterSession()` method on `SessionManager`, directly access the cache's `remove()`).

**Why not add `unregisterSession` to `SessionManager`**: `SessionManager.sessionCache` is `private`. We have two options: (a) make `sessionCache` accessible (e.g., add a public `unregisterSession` method), or (b) expose `sessionCache` via a getter. Option (a) is preferred for symmetry with `registerSession()`. However, since `stopSession` has access to the `ctx` closure which includes `sessionManager`, we can add `unregisterSession()` as a thin wrapper.

### Bug 2 Fix: Clear sdkSessionId during model switch restart

The root cause is in `QueryLifecycleManager.restart()` (called by `ModelSwitchHandler.switchModel()`): it validates the SDK session file but does NOT clear `sdkSessionId`. Since `QueryOptionsBuilder.addSessionStateOptions()` sets `result.resume = session.sdkSessionId`, the new query resumes the old session file (created with the old model).

**Fix**: In `ModelSwitchHandler.switchModel()`, clear `session.sdkSessionId` and persist the change to DB before calling `lifecycleManager.restart()`. This ensures `addSessionStateOptions()` will not set `resume`, so the new query starts fresh with the new model.

**SDK session file cleanup**: After clearing `sdkSessionId`, the old `.jsonl` session file at `~/.claude/projects/{key}/{old-sdkSessionId}.jsonl` becomes orphaned. It will NOT be deleted immediately. The existing `sdk.scan` / `sdk.cleanup` RPC handlers (on-demand user action) can identify and clean up these files. No automatic periodic cleanup exists. This is acceptable because: (a) orphan files are harmless (they consume disk space but don't affect behavior), (b) `identifyOrphanedSDKFiles()` can detect them by checking if the extracted `kaiSessionIds` match an active/archived session, (c) the session will get a new `.jsonl` file on the next query start (the old model's file is simply abandoned). The old file will be cleaned up on next `sdk.cleanup` invocation or `session.delete` (which calls `deleteSDKSessionFiles()`).

**Error handling edge case**: In the `queryObject` branch, `restart()` may throw. By this point, `sdkSessionId` is cleared in both memory and DB, and model/provider are already persisted. The session is in a consistent state: new model in DB, no `sdkSessionId`, but the old query is stopped. The next `ensureQueryStarted()` call will start a fresh query with the correct model and no resume. The error should propagate to the UI, but the session state is not corrupted. The `ModelSwitchHandler` already wraps the `restart()` call in a try/catch that returns `{ success: false, error }` (line ~266), so the UI will show the switch failed but the session remains usable.

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
3. The old SDK session `.jsonl` file becomes orphaned. Document this as intentional: it will be cleaned up by the next `sdk.cleanup` user action or `session.delete`. No immediate deletion is needed.

**Acceptance criteria**:
- After a model switch, `sdkSessionId` is `undefined` in both memory and DB.
- The new query starts without `resume` in its options (verified by `addSessionStateOptions`).
- Existing unit tests for `ModelSwitchHandler` still pass.
- New unit test confirms `sdkSessionId` is cleared on model switch (see Task 2).

**Dependencies**: None

**Agent type**: coder

---

### Task 2: Add unit tests for Bug 2 fix (sdkSessionId clearing)

**Description**: Add unit tests to verify that `sdkSessionId` is cleared during model switch.

**File**: `packages/daemon/tests/unit/agent/model-switch-handler.test.ts` (existing file, ~615 lines)

**Subtasks**:
1. Add a new `describe('sdkSessionId clearing')` block within the existing test file.
2. Test that `sdkSessionId` is set on the session before the switch, and is cleared (`undefined`) after a successful switch in both branches:
   - When `queryObject` is `null` (no running query): verify `sdkSessionId` is cleared.
   - When `queryObject` is present (query running): verify `sdkSessionId` is cleared and `restart()` is called.
3. Verify that `db.updateSession` is called with `{ sdkSessionId: undefined }` during model switch (check the additional call beyond the model/provider update).
4. Verify that `restart()` is still called (the clearing does not prevent the restart).
5. Test the error path: if `restart()` throws, verify `sdkSessionId` remains cleared (the clearing happens before `restart()` is called).

**Acceptance criteria**:
- Test confirms `session.sdkSessionId` is cleared to `undefined` after model switch.
- Test confirms `db.updateSession` is called with `{ sdkSessionId: undefined }`.
- Test confirms `restart()` is still called when query is running.
- Test confirms error in `restart()` does not revert `sdkSessionId` clearing.
- All existing model switch handler tests still pass.

**Dependencies**: Task 1

**Agent type**: coder

---

### Task 3: Add `unregisterSession` to SessionManager and register room sessions in SessionCache (Bug 1)

**Description**: Add `unregisterSession()` to `SessionManager` for symmetry with the existing `registerSession()`, then register room worker/leader sessions in `SessionCache` when they are created and unregister them when stopped. This follows the same pattern as Space sessions (`TaskAgentManager` at `task-agent-manager.ts:398`).

**Files**:
- `packages/daemon/src/lib/session/session-manager.ts` — add `unregisterSession()` method
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` — add `registerSession` call in `createAndStartSession()` and `unregisterSession` call in `stopSession()`

**Subtasks**:
1. Add `unregisterSession(sessionId: string): void` to `SessionManager` that delegates to `this.sessionCache.remove(sessionId)`. This mirrors `registerSession()` which delegates to `this.sessionCache.set()`.
2. In `RoomRuntimeService.createSessionFactory().createAndStartSession()` (line ~250), after `agentSessions.set(init.sessionId, session)`, add:
   ```ts
   ctx.sessionManager.registerSession(session);
   ```
   This ensures any RPC handler calling `sessionManager.getSessionAsync(sessionId)` for this room session will get the live instance with MCP tools, not a DB-loaded duplicate.
3. In `RoomRuntimeService.stopSession()` (line ~442, in the `finally` block after `agentSessions.delete(sessionId)`), add:
   ```ts
   ctx.sessionManager.unregisterSession(sessionId);
   ```
   This prevents stale references in the SessionCache after the room session is stopped.
4. Verify that the `SessionCache.getAsync()` guard (line ~100 of `session-cache.ts`) correctly prefers the registered instance if a concurrent `getAsync()` call is in-flight during registration.

**Acceptance criteria**:
- `SessionManager.unregisterSession()` is available and delegates to `sessionCache.remove()`.
- Room sessions are registered in `SessionCache` immediately after creation.
- Room sessions are unregistered from `SessionCache` when stopped.
- `sessionManager.getSessionAsync()` for a room session returns the live instance (same object reference as in `RoomRuntimeService.agentSessions`), not a DB-loaded duplicate.
- No duplicate `AgentSession` is created for room sessions when `session.model.switch` or any other RPC handler calls `getSessionAsync()`.
- Existing Space session tests still pass (no regression).

**Dependencies**: None

**Agent type**: coder

---

### Task 4: Add unit tests for room session registration in SessionCache (Bug 1 tests)

**Description**: Add unit tests to verify that room sessions are properly registered/unregistered in SessionCache.

**File**: `packages/daemon/tests/unit/room/` (new test file or append to existing room test file)

**Subtasks**:
1. Test that `SessionManager.unregisterSession()` calls `sessionCache.remove()` with the correct session ID.
2. Test that after `registerSession()` is called, `getSessionAsync()` returns the registered instance (not a DB-loaded duplicate).
3. Test that after `unregisterSession()` is called, `getSessionAsync()` falls through to DB loading (the session is no longer in cache).
4. Test the concurrent access guard: if `getAsync()` is called concurrently with `registerSession()`, the registered instance is preferred over the DB-loaded one (this tests the guard at `session-cache.ts:100`).
5. If possible, add an integration test that simulates room session creation via `createAndStartSession()` and verifies the session is findable via `sessionManager.getSessionAsync()`.

**Acceptance criteria**:
- All tests pass.
- `unregisterSession` correctly removes from cache.
- Registered instances are returned by `getSessionAsync()`.
- Concurrent access guard works correctly.
- No regression in existing SessionCache tests.

**Dependencies**: Task 3

**Agent type**: coder

---

### Task 5: Add online integration test for model switch sdkSessionId clearing (Bug 2)

**Description**: Add an online integration test that verifies model switch works end-to-end, specifically that `sdkSessionId` is cleared after switching models and the agent responds with the new model.

**File**: `packages/daemon/tests/online/rpc/rpc-model-switching.test.ts` (existing file)

**Subtasks**:
1. Add a test (using dev proxy via `NEOKAI_USE_DEV_PROXY=1`) that:
   - Creates a session and sends a message to establish an `sdkSessionId`.
   - Waits for the response, then calls `session.get` to verify `sdkSessionId` is non-null.
   - Calls `session.model.switch` to switch to a different model.
   - Calls `session.get` again to verify `sdkSessionId` is `null`/`undefined`.
   - Sends another message and waits for a response (verifying the agent is not stuck).

**Dev proxy considerations**: The dev proxy mock system does NOT distinguish between models -- all requests to the same endpoint get the same mock response regardless of the `model` field in the request body. This is fine for our test because we are verifying the `sdkSessionId` clearing behavior (observable via `session.get`), not the actual model used by the SDK. The mock response is sufficient to confirm the agent starts a new query after the switch.

**Acceptance criteria**:
- Test verifies `sdkSessionId` is non-null after first query.
- Test verifies `sdkSessionId` is null after model switch.
- Test verifies agent responds after model switch (no stuck state).
- Test passes with `NEOKAI_USE_DEV_PROXY=1` and does not require real API credentials.

**Dependencies**: Task 1, Task 2

**Agent type**: coder

---

### Task 6: E2E test for normal session model switching

**Description**: Add a Playwright E2E test that verifies normal session model switching works without causing the agent to become unresponsive.

**Files**:
- `packages/e2e/tests/` (new test file, e.g., `model-switching.e2e.ts`)

**Subtasks**:
1. Create an E2E test for normal session model switching:
   - Navigate to the app and create a new session via the UI.
   - Open the model selector dropdown.
   - Switch to a different model.
   - Verify the model indicator in the UI updates to show the new model.
   - Type and send a message.
   - Verify the agent responds (not stuck/silent) by waiting for a response message to appear in the chat.
2. This test covers Bug 2 (the `sdkSessionId` clearing fix). It does not need to verify the internal `sdkSessionId` state (which is invisible to the browser) -- it verifies the observable behavior: the agent continues to respond after a model switch.

**Task view E2E test**: A full task view E2E test for Bug 1 is deferred because it requires complex room setup (room creation, mission configuration, worker spawning, task view navigation). The Bug 1 fix (Task 3) is adequately covered by unit tests (Task 4) that verify `sessionManager.getSessionAsync()` returns the correct instance for room sessions. If a regression occurs, it would be caught by those unit tests. A task view E2E test can be added in a follow-up if needed.

**Acceptance criteria**:
- Normal session model switch works without causing the agent to become unresponsive.
- The model indicator in the UI updates correctly.
- Test passes consistently.
- Test follows E2E rules (all actions through UI, no direct RPC calls for assertions).

**Dependencies**: Task 1

**Agent type**: coder
