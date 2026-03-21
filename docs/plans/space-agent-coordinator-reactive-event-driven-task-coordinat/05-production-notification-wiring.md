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
2. Implement `SessionNotificationSink` class that:
   - Accepts a `sessionManager` and `sessionId` (the `spaces:global` session)
   - Implements `notify(event: SpaceNotificationEvent): Promise<void>`
   - Formats each event kind into a structured message with `[TASK_EVENT]` prefix and JSON payload
   - Includes human-readable context (e.g., "Task 'Fix login bug' in space 'MyProject' needs attention: agent reported error")
   - Uses `sessionManager.getSessionAsync()` + `session.injectMessage()` (or the equivalent pattern from room-runtime-service.ts sessionFactory)
3. Handle edge cases: session not found (log warning, do not throw), session busy (use delivery mode appropriate for non-blocking injection)
4. Write unit tests with a mock session that captures injected messages, verifying:
   - Each event kind produces the expected message format
   - Missing session logs a warning but does not throw
   - Message includes both structured JSON and human-readable text

**Acceptance criteria:**
- `SessionNotificationSink` correctly formats and injects messages for all event kinds
- Messages use `[TASK_EVENT]` prefix for reliable prompt parsing
- Graceful handling of missing/unavailable sessions
- Unit tests cover all event kinds and error cases

**Dependencies:** Task 2.1 (NotificationSink interface)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Wire NotificationSink into provision-global-agent.ts

**Description:** Connect the `SessionNotificationSink` to the SpaceRuntimeService during global agent provisioning so that runtime events flow to the Space Agent session.

**Agent type:** coder

**Subtasks:**
1. Update `ProvisionGlobalSpacesAgentDeps` to include dependencies needed for `SessionNotificationSink` (session factory/manager reference)
2. In `provisionGlobalSpacesAgent()`, create a `SessionNotificationSink` targeting the `spaces:global` session
3. Pass the sink to `SpaceRuntimeService` (or directly to the `SpaceRuntime` instance via a setter/config update)
4. Update `SpaceRuntimeService` to accept an optional `NotificationSink` and pass it through to the underlying `SpaceRuntime`
5. Update `SpaceRuntimeServiceConfig` to include `notificationSink?: NotificationSink`
6. Ensure the sink is wired AFTER the global session is created (ordering matters)
7. Write integration-style unit tests that verify:
   - After provisioning, the runtime has a non-null notification sink
   - A tick that produces a notification event results in a message being injected into the global session

**Acceptance criteria:**
- Global agent provisioning creates and wires the SessionNotificationSink
- SpaceRuntime events are delivered to the `spaces:global` session
- Wiring order is correct (session exists before sink is created)
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
