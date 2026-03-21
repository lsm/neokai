# Milestone 5: Production NotificationSink Wiring

## Goal

Wire the `NotificationSink` interface to the real Space Agent session so that SpaceRuntime events are delivered as `injectMessage()` calls to the `spaces:global` session. This is the integration layer that connects the mechanical tick loop to the LLM-driven coordinator.

## Scope

- `SessionNotificationSink` implementation that calls `injectMessage()` on the Space Agent session
- Wiring in `provision-global-agent.ts` to create the sink and pass it to SpaceRuntimeService
- Message formatting (structured `[TASK_EVENT]` messages)
- Space context resolution (fetch space name, task title for human-readable messages)

---

### Task 5.1: Implement SessionNotificationSink

**Description:** Create the production `NotificationSink` implementation that formats events into human+LLM-readable messages and injects them into the Space Agent session via `injectMessage()`.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/src/lib/space/runtime/session-notification-sink.ts`
2. **Audit `injectMessage` behavior (P0):** Before implementing, audit the existing `injectMessage` pattern in `RoomRuntimeService` / `AgentSession` (see `task-group-manager.ts` `SessionFactory` interface, `room-runtime-service.ts` implementation). Document: what happens when the session is actively streaming a response? Does `injectMessage` queue the message, wait, or drop it? The `MessageDeliveryMode` options should be examined. Choose the appropriate delivery mode for non-blocking notification injection and document the decision.
3. Implement `SessionNotificationSink` class that:
   - Accepts a `SessionFactory` interface (from `task-group-manager.ts`) and `sessionId` (the `spaces:global` session ID). **Do NOT use `sessionManager.getSessionAsync()` + `session.injectMessage()`** — the correct API is `sessionFactory.injectMessage(sessionId, message, opts)`.
   - Implements `notify(event: SpaceNotificationEvent): Promise<void>`
   - Formats each event kind into a structured message with `[TASK_EVENT]` prefix and JSON payload
   - Includes human-readable context (e.g., "Task 'Fix login bug' in space 'MyProject' needs attention: agent reported error")
   - Includes the space's `autonomyLevel` in the event message so the agent has context for decision-making
4. Handle edge cases: session not found (log warning, do not throw), session busy (use the delivery mode determined by the audit in subtask 2)
5. Write unit tests with a mock `SessionFactory` that captures injected messages, verifying:
   - Each event kind produces the expected message format
   - Missing session logs a warning but does not throw
   - Message includes both structured JSON, human-readable text, and autonomy level
   - Correct delivery mode is used

**Acceptance criteria:**
- `SessionNotificationSink` uses `sessionFactory.injectMessage(sessionId, message)` — NOT `session.injectMessage()`
- Messages use `[TASK_EVENT]` prefix for reliable prompt parsing
- Messages include the space's autonomy level for agent context
- `injectMessage` concurrency behavior is documented (what happens when session is streaming)
- Graceful handling of missing/unavailable sessions
- Unit tests cover all event kinds and error cases

**Dependencies:** Task 2.1 (NotificationSink interface)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Wire NotificationSink into provision-global-agent.ts

**Description:** Connect the `SessionNotificationSink` to the SpaceRuntimeService during global agent provisioning so that runtime events flow to the Space Agent session.

**Agent type:** coder

**Subtasks:**
1. Update `ProvisionGlobalSpacesAgentDeps` to include the `SessionFactory` interface reference (needed for `SessionNotificationSink`). The `SessionFactory` is available from `RoomRuntimeService` which implements it.
2. In `provisionGlobalSpacesAgent()`, AFTER the `spaces:global` session is created, create a `SessionNotificationSink` targeting that session ID.
3. **Use the `setNotificationSink()` setter** (added in Task 2.2) on `SpaceRuntimeService` to wire the sink. Do NOT add `notificationSink` to `SpaceRuntimeServiceConfig` — the sink cannot be available at construction time because `SpaceRuntimeService` is instantiated in `rpc-handlers/index.ts` (line ~242) BEFORE `provisionGlobalSpacesAgent()` is called (line ~285). The setter pattern resolves this circular dependency.
4. Ensure the wiring order is: (a) create global session → (b) create `SessionNotificationSink` with sessionFactory + sessionId → (c) call `spaceRuntimeService.setNotificationSink(sink)`.
5. Write integration-style unit tests that verify:
   - After provisioning, the runtime has a non-null notification sink
   - A tick that produces a notification event results in a message being injected into the global session

**Acceptance criteria:**
- Global agent provisioning creates and wires the `SessionNotificationSink` via the setter pattern
- SpaceRuntime events are delivered to the `spaces:global` session via `sessionFactory.injectMessage()`
- Wiring order is correct (session exists → sink created → setter called)
- No changes to `SpaceRuntimeServiceConfig` constructor signature (uses setter instead)
- Integration test verifies end-to-end flow from tick event to session message

**Dependencies:** Task 5.1, Task 2.2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.3: Wire new MCP tools into provision-global-agent.ts

**Description:** Ensure the five new coordination tools from Milestone 3 are registered in the MCP server created during global agent provisioning.

**Agent type:** coder

**Subtasks:**
1. Update `createGlobalSpacesMcpServer()` call in `provisionGlobalSpacesAgent()` to include the dependencies needed for the new tools (db reference for SpaceTaskManager creation)
2. Verify that `GlobalSpacesToolsConfig` now includes all fields needed by the new tool handlers
3. Test that the global session has access to all new tools by checking the MCP server tool list
4. Write a test verifying the provisioned session has all expected tools available

**Acceptance criteria:**
- All five new coordination tools are available to the `spaces:global` session
- No regressions in existing tool availability
- Test confirms tool registration

**Dependencies:** Task 3.3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
