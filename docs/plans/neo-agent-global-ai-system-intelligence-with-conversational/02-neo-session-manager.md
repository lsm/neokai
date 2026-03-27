# Milestone 2: Neo Session Manager

## Goal

Implement the singleton Neo session lifecycle: create, persist, restore, and integrate the persistent Neo agent session with the daemon application context.

## Tasks

### Task 2.1: Neo Session Service

- **Description**: Create `NeoSessionService` that manages the singleton Neo agent session. It handles creation on first use, restoration on app restart, and provides the session interface for sending/receiving messages.
- **Agent type**: coder
- **Depends on**: Task 1.1, Task 1.2, Task 1.3
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/neo-session-service.ts`
  2. Implement `NeoSessionService` class:
     - Constructor takes `Database`, `SessionManager`, `SettingsManager`, `DaemonHub`, `MessageHub`, config (workspace path)
     - `initialize(): Promise<void>` -- check if a Neo session exists in DB (by looking for session with type 'neo'), restore it or create a new one
     - `getOrCreateSession(): Promise<AgentSession>` -- lazy initialization, creates `AgentSession` with `sessionId: 'neo:global'`, `type: 'neo'`
     - `getSession(): AgentSession | null` -- returns current session if initialized
     - `sendMessage(content: string): Promise<void>` -- queue a user message to the Neo session
     - `getHistory(): NeoMessage[]` -- retrieve message history from DB
     - `clearSession(): Promise<void>` -- end current session, create a fresh one
     - `cleanup(): Promise<void>` -- graceful shutdown
  3. Build Neo system prompt in `packages/daemon/src/lib/neo/neo-system-prompt.ts`:
     - Define Neo's identity, role, personality (helpful chief-of-staff)
     - Describe available tool categories and when to use them
     - Include security tier behavior instructions (parameterized by current security mode)
     - Include instructions about action logging and undo support
  4. Create `packages/daemon/src/lib/neo/index.ts` barrel export
  5. Write unit tests in `packages/daemon/tests/unit/neo/neo-session-service.test.ts`:
     - Test session creation on first initialize
     - Test session restoration on subsequent initialize
     - Test sendMessage queues to the session
     - Test clearSession creates a fresh session
     - Test cleanup shuts down gracefully
- **Acceptance criteria**:
  - Neo session is created with correct `SessionType` and `sessionId`
  - Session persists across service restarts (restore from DB)
  - System prompt includes security tier instructions
  - Unit tests pass with mocked dependencies
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 2.2: Integrate Neo Session into DaemonAppContext

- **Description**: Wire `NeoSessionService` into the daemon application startup and expose it on `DaemonAppContext`.
- **Agent type**: coder
- **Depends on**: Task 2.1
- **Subtasks**:
  1. Add `neoSessionService: NeoSessionService` to `DaemonAppContext` interface in `packages/daemon/src/app.ts`
  2. Instantiate `NeoSessionService` in `createDaemonApp()` after `SessionManager` and `SettingsManager` are created
  3. Call `neoSessionService.initialize()` during app startup (after DB migrations, before server start)
  4. Add `neoSessionService.cleanup()` to the app cleanup handler
  5. Ensure the Neo session's MCP tools server is attached during initialization (placeholder -- tools will be added in Milestones 3-5)
  6. Write a focused integration test that verifies `NeoSessionService` is accessible from `DaemonAppContext`
- **Acceptance criteria**:
  - `DaemonAppContext` exposes `neoSessionService`
  - Neo session initializes during app startup without errors
  - Cleanup properly shuts down the Neo session
  - No regressions in existing app startup flow
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
