# Milestone 2: Neo Session Provisioning

## Goal

Implement the singleton Neo session provisioning following the `provisionGlobalSpacesAgent()` pattern: a module-level function that creates/restores a persistent Neo session, attaches MCP tools, and integrates with `DaemonAppContext`.

## Design Notes

- **Pattern reuse**: The existing `provisionGlobalSpacesAgent()` in `packages/daemon/src/lib/space/provision-global-agent.ts` is the direct template. Neo follows the same module-level provisioning approach (NOT a service class) — check if session exists, create if not, attach MCP server and system prompt.
- **Concurrent messages**: A message queue ensures that if a second message arrives while Neo is processing, it waits. The queue is a simple `Promise` chain — each `sendMessage` call chains onto the previous. This matches how AgentSession already serializes turns internally, but the queue prevents callers from overlapping.
- **Session ID**: Always the literal string `'neo:global'` — it never changes. On `clearSession`, messages are deleted (`DELETE FROM sdk_messages WHERE session_id = 'neo:global'`) and the session row is reset (updated `created_at`, cleared runtime state). No alias/pointer mechanism is needed. This keeps LiveQuery filters (`WHERE session_id = 'neo:global'`), repository lookups, and provisioning logic simple. Message history is not preserved across clears (the action log is independent and IS preserved).
- **Tool attachment timing**: MCP tools server is created during provisioning but starts as a placeholder with no tools. Tools are added incrementally in Milestones 3-5 by updating the MCP server definition. The session does NOT need to be recreated when tools change — `setRuntimeMcpServers()` can be called at any time.

## Tasks

### Task 2.1: Neo Session Provisioning Function

- **Description**: Create `provisionNeoAgent()` function following the `provisionGlobalSpacesAgent()` pattern. This is a module-level function (not a class) that creates or restores the singleton Neo session.
- **Agent type**: coder
- **Depends on**: Task 1.1, Task 1.2, Task 1.3, Task 1.4
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/provision-neo-agent.ts`
  2. Define `ProvisionNeoAgentDeps` interface (following `ProvisionGlobalSpacesAgentDeps` pattern):
     - `sessionManager: SessionManager`
     - `settingsManager: SettingsManager`
     - `db: BunDatabase`
     - `daemonHub?: DaemonHub`
     - `appMcpManager?: AppMcpLifecycleManager`
  3. Implement `provisionNeoAgent(deps: ProvisionNeoAgentDeps): Promise<NeoAgentHandle>`:
     - Check if Neo session exists in DB (by session type `'neo'`)
     - If not, create via `sessionManager.createSession({ sessionId: 'neo:global', sessionType: 'neo', title: 'Neo Agent', createdBy: 'neo' })`
     - Attach MCP tools server placeholder (empty — tools added in Milestones 3-5)
     - Set runtime system prompt via `setRuntimeSystemPrompt()`
     - Return `NeoAgentHandle` with: `sendMessage(content: string): Promise<void>` (with queue), `getSession(): AgentSession`, `clearSession(): Promise<void>`, `cleanup(): Promise<void>`
  4. Implement message queue in `sendMessage`: chain each call as a Promise to prevent concurrent turns
  5. Implement `clearSession()`: delete messages (`DELETE FROM sdk_messages WHERE session_id = 'neo:global'`), reset the session row's runtime state, reattach MCP tools and system prompt. The session ID remains `'neo:global'` — no new session is created.
  6. Create `packages/daemon/src/lib/neo/neo-system-prompt.ts`:
     - Define Neo's identity, role, personality (helpful chief-of-staff)
     - Describe available tool categories and when to use them
     - Include security tier behavior instructions (parameterized by current security mode)
     - Include instructions about action logging and undo support
  7. Create `packages/daemon/src/lib/neo/index.ts` barrel export
  8. Write unit tests in `packages/daemon/tests/unit/neo/provision-neo-agent.test.ts`:
     - Test session creation on first provision
     - Test session restoration on subsequent provision
     - Test message queue serializes concurrent sends
     - Test clearSession deletes messages but preserves the same session ID (`'neo:global'`)
     - Test cleanup shuts down gracefully
- **Acceptance criteria**:
  - Neo session is created with correct `SessionType` and `sessionId`
  - Session persists across daemon restarts (restore from DB)
  - Concurrent `sendMessage` calls are serialized (queue)
  - `clearSession` deletes messages but keeps the same `'neo:global'` session ID
  - System prompt includes security tier instructions
  - Pattern matches `provisionGlobalSpacesAgent()` structure
  - Unit tests pass with mocked dependencies
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 2.2: Integrate Neo Session into DaemonAppContext

- **Description**: Wire `provisionNeoAgent()` into the daemon application startup and expose the handle on `DaemonAppContext`.
- **Agent type**: coder
- **Depends on**: Task 2.1
- **Subtasks**:
  1. Add `neoAgent: NeoAgentHandle` to `DaemonAppContext` interface in `packages/daemon/src/app.ts`
  2. Call `provisionNeoAgent(deps)` in `createDaemonApp()` after `SessionManager` and `SettingsManager` are created (similar to where `provisionGlobalSpacesAgent` is called)
  3. Store the returned `NeoAgentHandle` on the app context
  4. Add `neoAgent.cleanup()` to the app cleanup handler
  5. Ensure the MCP tools server placeholder is attached during provisioning (tools will be populated in Milestones 3-5)
  6. Write a focused integration test that verifies `neoAgent` is accessible from `DaemonAppContext`
- **Acceptance criteria**:
  - `DaemonAppContext` exposes `neoAgent: NeoAgentHandle`
  - Neo session initializes during app startup without errors
  - Cleanup properly shuts down the Neo session
  - No regressions in existing app startup flow
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
