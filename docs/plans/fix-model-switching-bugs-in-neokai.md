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

**Fix — two registration paths**: Room sessions enter `RoomRuntimeService.agentSessions` through two distinct code paths, both of which must register in `SessionCache`:

1. **New session creation** (`createAndStartSession` at line ~250): After `agentSessions.set(init.sessionId, session)`, call `ctx.sessionManager.registerSession(session)`.

2. **Session restoration after daemon restart** (`restoreSession` at line ~380): After `agentSessions.set(sessionId, session)`, call `ctx.sessionManager.registerSession(session)`. This is critical -- without it, the fix would only work until the first daemon restart.

**Cleanup — all teardown paths**: Room sessions are removed from `agentSessions` through multiple code paths, each of which must unregister from `SessionCache`:

1. **`stopSession()`** (line ~442, `finally` block): Called during task cancellation/completion. Add `ctx.sessionManager.unregisterSession(sessionId)`.

2. **`RoomRuntimeService.stop()`** (line ~197): Called during daemon shutdown. After `this.agentSessions.clear()`, iterate the previously-cleared entries and call `ctx.sessionManager.unregisterSession()` for each. Alternatively, refactor to iterate and unregister before clearing.

**Why add `unregisterSession` to `SessionManager`**: `SessionManager.sessionCache` is `private`. Adding `unregisterSession(sessionId: string): void` as a thin wrapper over `this.sessionCache.remove(sessionId)` mirrors the existing `registerSession()` which wraps `this.sessionCache.set()`, maintaining API symmetry.

**Race condition in `SessionCache.remove()`**: The current `remove()` method (line 141-143 of `session-cache.ts`) only calls `this.sessions.delete(sessionId)` but does **NOT** clear `this.sessionLoadLocks`. This creates a race: if a concurrent `getAsync()` call has already passed the `sessions.has()` check and is awaiting an in-flight load lock, the load will eventually resolve, check `if (!this.sessions.has(sessionId))` → true (since we just removed it), and re-insert a stale DB-loaded duplicate into the cache. The fix must also clear the load lock in `remove()`, mirroring how `set()` clears it (line 135). Since `SessionCache` is a private dependency of `SessionManager`, the implementer should update `SessionCache.remove()` to also call `this.sessionLoadLocks.delete(sessionId)`. Existing callers of `sessionCache.remove()` (in `SessionLifecycle.delete()`) will benefit from this fix as well.

**Space session collision risk**: Space session IDs use the `space:{uuid}:task:{uuid}` prefix, while Room session IDs use `{role}:{roomId}:{taskId}:{uuid}` or `room:chat:{roomId}`. These are structurally disjoint namespaces, making a collision practically impossible. `SessionCache.set()` has no overwrite guard, but the disjoint namespaces make this moot. No additional guard is needed.

**Namespace invariant**: The disjoint namespace guarantee relies on an invariant that must be preserved: **room role strings (e.g., `coder`, `general`, `planner`, `leader`) must never equal the literal string `"space"`**. If a role named `"space"` were introduced, session IDs like `space:{roomId}:...` could collide with Space session IDs like `space:{spaceId}:task:{taskId}`. This constraint should be documented in the role definition code (where roles are defined/enumerated) to prevent future violations.

### Bug 2 Fix: Use `forkSession: true` on model switch restart

**Revised root cause**: The original analysis assumed the SDK uses the model stored in the session file when resuming, but investigation reveals the model is **NOT** stored in the session file (`.jsonl` files contain only messages, not model metadata). The SDK receives both `--model` and `--resume` as CLI flags and **should** honor the new model. However, the agent still stops responding after a model switch, suggesting the issue is likely that:

1. The SDK's `setModel()` has a known issue: it doesn't update the cached `system:init` message (documented in `model-switch-handler.ts` lines 13-16). While NeoKai already restarts the query to work around this, the restart resumes the **same** session, and the SDK may still carry stale internal state from the old session.
2. The 100ms delay in `restart()` may not be sufficient for the old subprocess to fully exit before the new one starts, causing conflicts.

**Fix — use SDK's `forkSession: true` option**: The Claude Agent SDK supports `forkSession: true` as a query option (`packages/shared/src/sdk/sdk.d.ts:906`). When combined with `resume`, it forks the session to a **new session ID** while preserving the full conversation history. The old session file remains intact and resumable.

The fix modifies `QueryOptionsBuilder.addSessionStateOptions()` to set `forkSession: true` when a model switch has occurred. The mechanism:

1. In `ModelSwitchHandler.switchModel()`, after updating the model/provider config, set a transient flag on the session: `session._forkOnNextQuery = true`. This flag is NOT persisted to DB (it's a runtime-only signal).
2. In `QueryOptionsBuilder.addSessionStateOptions()` (line 323 of `query-options-builder.ts`), when building options:
   - If `session.sdkSessionId` is set AND `session._forkOnNextQuery` is true:
     - Set `result.resume = session.sdkSessionId` (carry forward conversation history)
     - Set `result.forkSession = true` (fork to new session, old one preserved)
     - Clear `session._forkOnNextQuery = false` (consume the flag)
   - Otherwise, behave as before (just set `resume` if `sdkSessionId` exists)
3. After the SDK starts the forked session, it emits a `system:init` message with a **new** session ID. The existing `sdk-message-handler.ts` (line 641) captures this new ID: `session.sdkSessionId = message.session_id` and persists it to DB.

**Why this preserves session resumability**:
- The old `sdkSessionId` remains valid — the old session file is untouched and can be resumed via `--resume <old-id>` at any time.
- The new `sdkSessionId` (from the fork) becomes the active session ID. Future queries resume the forked session (which has the full conversation history up to the fork point).
- `forkSession` is a first-class, documented SDK feature (`Options.forkSession?: boolean`).

**Why a transient flag instead of clearing sdkSessionId**:
- Clearing `sdkSessionId` would lose the ability to resume the old session (the reviewer's concern).
- Using `forkSession: true` preserves the old session AND starts a clean new session with the new model.
- The SDK handles the fork atomically — no race conditions between old and new sessions.

**Error handling edge case**: If `restart()` throws after the flag is set, the flag remains but is harmless — the next successful `startStreamingQuery()` call will see the flag and apply `forkSession: true`. If the user switches models again before a successful restart, the flag is already set (idempotent). The flag is consumed (cleared) when `addSessionStateOptions()` actually uses it, so it won't leak into subsequent queries.

**Naming the flag**: Use `session._forkOnNextQuery` with an underscore prefix to indicate it's a private/runtime-only field, consistent with how session objects carry transient state. An alternative is to add it to `session.metadata`, but that would persist to DB unnecessarily. The underscore prefix signals "do not serialize".

---

## Tasks

### Task 1: Add `forkSession: true` support on model switch (Bug 2)

**Description**: Modify `ModelSwitchHandler.switchModel()` to set a transient flag that causes the next query to fork the SDK session (instead of resuming the same session). Then modify `QueryOptionsBuilder.addSessionStateOptions()` to detect this flag and pass `forkSession: true` alongside `resume` to the SDK.

**Files**:
- `packages/daemon/src/lib/agent/model-switch-handler.ts` — set `_forkOnNextQuery` flag
- `packages/daemon/src/lib/agent/query-options-builder.ts` — read flag, add `forkSession: true` to options
- `packages/shared/src/types.ts` — add `_forkOnNextQuery` to `Session` interface (or use type assertion)

**Subtasks**:
1. In `ModelSwitchHandler.switchModel()`, after updating `session.config.model` and `session.config.provider` and persisting to DB (both the `!queryObject` and `queryObject` branches), set the transient flag:
   ```ts
   (session as any)._forkOnNextQuery = true;
   ```
   This is set in both branches (after the existing `db.updateSession` calls that update model/provider). The flag is NOT persisted to DB — it's a runtime-only signal.
2. In `QueryOptionsBuilder.addSessionStateOptions()` (line 323 of `query-options-builder.ts`), add logic after the `resume` block:
   ```ts
   // If a model switch requested a fork, use forkSession to create a new session
   // while preserving conversation history. The old session remains resumable.
   if (result.resume && (this.ctx.session as any)._forkOnNextQuery) {
       result.forkSession = true;
       (this.ctx.session as any)._forkOnNextQuery = false; // consume the flag
   }
   ```
   This ensures that when `restart()` calls `startStreamingQuery()` → `runQuery()`, the query options include both `resume` (old session for history) and `forkSession: true` (create new session with new model).
3. The existing `sdk-message-handler.ts` (line 641) captures the new session ID from the `system:init` message and updates `session.sdkSessionId` in memory and DB. This happens automatically — no change needed.
4. Verify that `session.config.model` is correctly read by `QueryRunner.runQuery()` (line 159) after the model update, ensuring the new model is passed to the SDK.

**Acceptance criteria**:
- After a model switch, the query options include both `resume` (old session ID) and `forkSession: true`.
- The `_forkOnNextQuery` flag is consumed (set to false) after being used, so it doesn't leak into subsequent queries.
- The old `sdkSessionId` remains in DB and can be used for resumption (not deleted).
- A new `sdkSessionId` is captured from the `system:init` message after the fork.
- Existing unit tests for `ModelSwitchHandler` still pass.
- New unit test confirms `forkSession: true` is set in options on model switch (see Task 2).

**Dependencies**: None

**Agent type**: coder

---

### Task 2: Add unit tests for Bug 2 fix (forkSession on model switch)

**Description**: Add unit tests to verify that `forkSession: true` is set in query options when a model switch occurs.

**File**: `packages/daemon/tests/unit/agent/model-switch-handler.test.ts` (existing file, ~615 lines)

**Subtasks**:
1. Add a new `describe('forkSession on model switch')` block within the existing test file.
2. Test that `_forkOnNextQuery` flag is set on the session after a successful model switch in both branches:
   - When `queryObject` is `null` (no running query): verify flag is set.
   - When `queryObject` is present (query running): verify flag is set and `restart()` is called.
3. Test that `QueryOptionsBuilder.addSessionStateOptions()` produces options with `forkSession: true` when the flag is set and `sdkSessionId` exists.
4. Test that `addSessionStateOptions()` produces options with `forkSession: true` AND `resume` set (both must be present for the fork to work).
5. Test that the `_forkOnNextQuery` flag is consumed (set to `false`) after `addSessionStateOptions()` uses it.
6. Test that when `_forkOnNextQuery` is NOT set, `forkSession` is NOT included in options (normal behavior).
7. Test error path: if `restart()` throws after the flag is set, verify the flag is still set (it will be consumed on the next successful query start).

**Acceptance criteria**:
- Test confirms `_forkOnNextQuery` is set on session after model switch.
- Test confirms `addSessionStateOptions()` sets `forkSession: true` when flag is present.
- Test confirms `resume` is also set (conversation history is preserved).
- Test confirms the flag is consumed after use.
- Test confirms normal queries (no model switch) do NOT include `forkSession`.
- All existing model switch handler tests still pass.

**Dependencies**: Task 1

**Agent type**: coder

---

### Task 3: Add `unregisterSession` to SessionManager and register room sessions in SessionCache (Bug 1)

**Description**: Add `unregisterSession()` to `SessionManager` for symmetry with the existing `registerSession()`, then register room worker/leader sessions in `SessionCache` through both creation paths and unregister them through all teardown paths.

**Files**:
- `packages/daemon/src/lib/session/session-cache.ts` — fix `remove()` to also clear `sessionLoadLocks`
- `packages/daemon/src/lib/session/session-manager.ts` — add `unregisterSession()` method
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` — add `registerSession` in `createAndStartSession()` AND `restoreSession()`, add `unregisterSession` in `stopSession()` and `stop()`

**Subtasks**:

0. **Fix `SessionCache.remove()` race condition**: In `session-cache.ts`, update the `remove()` method (line 141) to also clear the session load lock:
   ```ts
   remove(sessionId: string): void {
       this.sessions.delete(sessionId);
       this.sessionLoadLocks.delete(sessionId);
   }
   ```
   This mirrors `set()` (line 132-136) which already clears `sessionLoadLocks`. Without this fix, a concurrent `getAsync()` call awaiting a load lock would re-insert a stale DB-loaded duplicate after `remove()` deletes the session from `sessions`. Existing callers of `sessionCache.remove()` (e.g., `SessionLifecycle.delete()`) will also benefit from this fix.

1. Add `unregisterSession(sessionId: string): void` to `SessionManager` that delegates to `this.sessionCache.remove(sessionId)`. This mirrors `registerSession()` which delegates to `this.sessionCache.set()`.

2. **Registration path 1 — new session creation**: In `createSessionFactory().createAndStartSession()` (line ~250), after `agentSessions.set(init.sessionId, session)`, add:
   ```ts
   ctx.sessionManager.registerSession(session);
   ```

3. **Registration path 2 — daemon restart restoration**: In `createSessionFactory().restoreSession()` (line ~380), after `agentSessions.set(sessionId, session)`, add:
   ```ts
   ctx.sessionManager.registerSession(session);
   ```
   This is critical. Without this, sessions restored after a daemon restart would NOT be in SessionCache, and Bug 1 would reoccur on every restart. The `restoreSession()` path uses `AgentSession.restore()` instead of `AgentSession.fromInit()`, but the result is the same `AgentSession` instance that needs to be findable via `sessionManager.getSessionAsync()`.

4. **Teardown path 1 — individual session stop**: In `stopSession()` (line ~442, in the `finally` block after `agentSessions.delete(sessionId)`), add:
   ```ts
   ctx.sessionManager.unregisterSession(sessionId);
   ```

5. **Teardown path 2 — service shutdown**: In `RoomRuntimeService.stop()` (line ~197), before `this.agentSessions.clear()`, iterate all entries and unregister each:
   ```ts
   for (const sessionId of this.agentSessions.keys()) {
       ctx.sessionManager.unregisterSession(sessionId);
   }
   this.agentSessions.clear();
   ```
   This prevents stale room session references from remaining in SessionCache after daemon shutdown.

6. Verify that the `SessionCache.getAsync()` guard (line ~100 of `session-cache.ts`) correctly prefers the registered instance if a concurrent `getAsync()` call is in-flight during registration.
7. Document the namespace invariant: room role strings must never equal `"space"` (add a comment in the role definition code where roles are enumerated).

**Acceptance criteria**:
- `SessionCache.remove()` also clears `sessionLoadLocks` for the removed session ID (preventing concurrent `getAsync()` from re-inserting a stale duplicate).
- `SessionManager.unregisterSession()` is available and delegates to `sessionCache.remove()`.
- Room sessions are registered in `SessionCache` immediately after creation via `createAndStartSession()`.
- Room sessions are registered in `SessionCache` after restoration via `restoreSession()` (daemon restart path).
- Room sessions are unregistered from `SessionCache` when stopped via `stopSession()`.
- Room sessions are unregistered from `SessionCache` when the service shuts down via `stop()`.
- `sessionManager.getSessionAsync()` for a room session returns the live instance (same object reference as in `RoomRuntimeService.agentSessions`), not a DB-loaded duplicate.
- No duplicate `AgentSession` is created for room sessions when `session.model.switch` or any other RPC handler calls `getSessionAsync()`.
- Existing Space session tests still pass (no regression -- Space and Room session IDs use disjoint namespaces: `space:{uuid}:task:{uuid}` vs `{role}:{roomId}:{taskId}:{uuid}`).

**Dependencies**: None

**Agent type**: coder

---

### Task 4: Add unit tests for room session registration in SessionCache (Bug 1 tests)

**Description**: Add unit tests to verify that room sessions are properly registered/unregistered in SessionCache, covering both creation and restoration paths.

**File**: `packages/daemon/tests/unit/room/` (new test file or append to existing room test file)

**Subtasks**:
1. Test that `SessionManager.unregisterSession()` calls `sessionCache.remove()` with the correct session ID.
2. Test that `SessionCache.remove()` also clears `sessionLoadLocks` for the removed session ID.
3. Test the unregister race condition: if `getAsync()` has an in-flight load lock, and `remove()` is called concurrently, the load lock is cleared so the in-flight load does NOT re-insert a stale session into `sessions`.
4. Test that after `registerSession()` is called, `getSessionAsync()` returns the registered instance (not a DB-loaded duplicate).
5. Test that after `unregisterSession()` is called, `getSessionAsync()` falls through to DB loading (the session is no longer in cache).
6. Test the concurrent access guard: if `getAsync()` is called concurrently with `registerSession()`, the registered instance is preferred over the DB-loaded one (this tests the guard at `session-cache.ts:100`).
7. Test that restoring a session (simulating `restoreSession()` flow) also registers it in SessionCache.
8. If possible, add an integration test that simulates room session creation via `createAndStartSession()` and verifies the session is findable via `sessionManager.getSessionAsync()`.

**Acceptance criteria**:
- All tests pass.
- `unregisterSession` correctly removes from cache.
- Registered instances are returned by `getSessionAsync()`.
- Concurrent access guard works correctly.
- Restore path also registers sessions.
- No regression in existing SessionCache tests.

**Dependencies**: Task 3

**Agent type**: coder

---

### Task 5: Add online integration test for model switch with forkSession (Bug 2)

**Description**: Add an online integration test that verifies model switch works end-to-end, specifically that `sdkSessionId` is updated (forked) after switching models and the agent responds.

**File**: `packages/daemon/tests/online/rpc/rpc-model-switching.test.ts` (existing file)

**Subtasks**:
1. Add a test (using dev proxy via `NEOKAI_USE_DEV_PROXY=1`) that:
   - Creates a session and sends a message to establish an `sdkSessionId`.
   - Waits for the response, then calls `session.get` to verify `sdkSessionId` is non-null. Record the original ID.
   - Calls `session.model.switch` to switch to a different model.
   - Waits for the model switch to complete (restart finishes).
   - Calls `session.get` to verify `sdkSessionId` is still non-null but has CHANGED to a new value (the forked session ID).
   - Sends another message and waits for a response (verifying the agent is not stuck).

**Dev proxy considerations**: The dev proxy mock system does NOT distinguish between models -- all requests to the same endpoint get the same mock response regardless of the `model` field in the request body. This is fine for our test because we are verifying the `forkSession` behavior (observable via `session.get` showing a new `sdkSessionId`), not the actual model used by the SDK. The mock response is sufficient to confirm the agent starts a new forked query after the switch.

**Note on dev proxy `forkSession` support**: The dev proxy may not fully support the `forkSession` flow since it intercepts HTTP requests. If the SDK's `--resume` + `--fork-session` flags cause the subprocess to behave differently, the dev proxy mock may need adjustment. If the forkSession option causes issues with dev proxy, this test should be marked as requiring real credentials (like the GLM model switching test) or the dev proxy mocks may need to be updated. The unit tests (Task 2) provide adequate coverage regardless.

**Acceptance criteria**:
- Test verifies `sdkSessionId` is non-null after first query.
- Test verifies `sdkSessionId` changes (new ID) after model switch (fork occurred).
- Test verifies agent responds after model switch (no stuck state).
- Test passes with `NEOKAI_USE_DEV_PROXY=1` if possible, or documented as requiring real credentials.

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
2. This test covers Bug 2 (the `forkSession` fix). It does not need to verify the internal `sdkSessionId` state (which is invisible to the browser) -- it verifies the observable behavior: the agent continues to respond after a model switch.

**Task view E2E test**: A full task view E2E test for Bug 1 is deferred because it requires complex room setup (room creation, mission configuration, worker spawning, task view navigation). The Bug 1 fix (Task 3) is adequately covered by unit tests (Task 4) that verify `sessionManager.getSessionAsync()` returns the correct instance for room sessions, including the restoration path. If a regression occurs, it would be caught by those unit tests. A task view E2E test can be added in a follow-up if needed.

**Acceptance criteria**:
- Normal session model switch works without causing the agent to become unresponsive.
- The model indicator in the UI updates correctly.
- Test passes consistently.
- Test follows E2E rules (all actions through UI, no direct RPC calls for assertions).

**Dependencies**: Task 1

**Agent type**: coder
