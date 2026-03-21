# Milestone 4: Task Agent Session Manager

## Goal

Create the `TaskAgentManager` class that handles the full lifecycle of Task Agent sessions: spawning them for pending tasks, attaching MCP tools, managing sub-session creation, tracking task-to-session mappings, and cleaning up completed sessions.

## Tasks

### Task 4.1: Implement TaskAgentManager Core

**Description:** Create the `TaskAgentManager` class that manages the lifecycle of Task Agent sessions. This is the central integration point that ties together the session init factory, MCP tools, and sub-session management.

**Key Design Decision — Sub-Session Lifecycle Strategy:**

Sub-sessions (the step agents spawned by Task Agent) are **first-class `SessionManager` sessions** — they are created via `SessionManager.createSession()`, persisted in the DB, and participate in the full SDK lifecycle (event emission, message persistence, cleanup).

This is chosen over the alternative of lightweight in-memory-only objects because:

| Concern | First-class SessionManager sessions (chosen) | Lightweight in-memory only (rejected) |
|---------|----------------------------------------------|---------------------------------------|
| **DB persistence** | Conversation history persisted automatically via SessionManager's DB wiring. Sub-session messages are recoverable after crash. | No persistence — all sub-session conversation history lost on crash. Task Agent would need to fully re-run workflow steps. |
| **Event lifecycle** | `session.completed`, `session.error` events emitted automatically. Completion listeners can use standard DaemonHub event patterns. | Must implement custom completion detection — polling, manual callbacks, or ad-hoc event emission. |
| **Cleanup** | `SessionManager.deleteSession()` handles DB record removal. Well-defined contract. | No DB records to clean up, but also no way to audit what happened in a sub-session after the fact. |
| **Crash recovery** | On daemon restart, sub-session records exist in DB. Task Agent's re-orientation message tells it to `check_step_status` — if a sub-session completed before the crash, its status is in the DB. If not, Task Agent re-spawns it. | On crash, all sub-session state is lost. Task Agent must re-run every step from scratch since there's no record of what completed. |
| **Visibility** | Must be filtered from user-facing session lists via `{ internal: true, parentTaskId }` metadata. | Invisible by default since they're not in SessionManager. |
| **Overhead** | Slightly more overhead (DB writes per message). Acceptable since sub-sessions are long-running workflow steps, not high-frequency operations. | Lower overhead but at the cost of durability and debuggability. |

The `TaskAgentManager` adds an in-memory `subSessions: Map` on top of SessionManager for fast lookup by taskId + stepId, but SessionManager remains the source of truth for lifecycle. The in-memory map is a cache — it is rebuilt during rehydration (Task 5.3) by querying SessionManager for sessions with `internal: true` metadata matching the task's space.

**Subtasks:**
1. Create `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
2. Define `TaskAgentManagerConfig` interface containing: `db`, `sessionManager`, `spaceManager`, `spaceAgentManager`, `spaceWorkflowManager`, `spaceRuntimeService`, `taskRepo`, `workflowRunRepo`, `daemonHub`, `messageHub`, `getApiKey`, `defaultModel`
3. Implement `TaskAgentManager` class with:
   - `private taskAgentSessions: Map<string, AgentSession>` -- maps taskId to the Task Agent's AgentSession
   - `private subSessions: Map<string, Map<string, AgentSession>>` -- maps taskId to a map of stepId to sub-session AgentSession. Sub-session IDs follow the convention: `space:${spaceId}:task:${taskId}:step:${stepId}` (uniqueness guaranteed by the combination of UUIDs)
   - `private spawningTasks: Set<string>` -- tracks taskIds currently being spawned (concurrency guard to prevent duplicate Task Agent sessions when the tick loop fires while `spawnTaskAgent` is in progress)
   - `async spawnTaskAgent(task: SpaceTask, space: Space, workflow: SpaceWorkflow, workflowRun: SpaceWorkflowRun): Promise<string>` -- creates the Task Agent session:
     a. **Concurrency guard**: Check if `taskId` is in `spawningTasks` or `taskAgentSessions` — if so, return the existing session ID (idempotent)
     b. Add `taskId` to `spawningTasks`
     c. Generate session ID: `space:${spaceId}:task:${taskId}` (uniqueness guaranteed by taskId being a UUID). For restarts/retries where a session with this ID already exists in the DB, append a monotonic suffix: `space:${spaceId}:task:${taskId}:${attempt}` (query existing sessions to determine the next attempt number)
     d. Call `createTaskAgentInit()` to get the session init
     e. Create the session via `SessionManager.createSession()` (NOT `AgentSession.fromInit()` directly) to ensure proper DB registration, event emission, and lifecycle management
     f. Create the Task Agent MCP server with a `sessionFactory` that delegates to `this.createSubSession()`, a `messageInjector` that delegates to `this.injectSubSessionMessage()`, and an `onSubSessionComplete` callback that updates the step's SpaceTask status to `completed` in the DB
     g. Attach the MCP server to the session via `setRuntimeMcpServers()`
     h. Update the SpaceTask with `taskAgentSessionId`
     i. Start the streaming query
     j. Inject the initial task message via `buildTaskAgentInitialMessage()`
     k. Store the session in `taskAgentSessions`, remove from `spawningTasks`
     l. Return the session ID
   - `async createSubSession(taskId: string, stepId: string, init: AgentSessionInit): Promise<string>` -- creates a sub-session for a workflow step agent:
     a. **Session registration**: Sub-sessions MUST be created via `SessionManager.createSession()` (not `AgentSession.fromInit()` directly) to ensure proper DB wiring, event emission, and SDK lifecycle management. This follows the same pattern as `RoomRuntimeService.setupRoomAgentSession()`.
     b. **Visibility control**: Sub-sessions are registered in SessionManager with a metadata flag `{ internal: true, parentTaskId: taskId }` so they can be filtered out of user-facing session lists. The `session.list` RPC handler should be updated to exclude sessions with `internal: true` metadata (or the existing session type filtering already handles this since sub-sessions use step agent types like `custom_agent`, not `space_task_agent`).
     c. **Tracking**: Store the sub-session in the in-memory `subSessions` map for fast lookup by taskId + stepId.
     d. **Completion listener**: Register a completion listener (using DaemonHub `session.completed` event or AgentSession's `onComplete` callback) that calls the `onSubSessionComplete` callback to update the step's SpaceTask status in the DB and inject a completion message into the Task Agent session (e.g., "Step '{stepId}' sub-session completed with result: {summary}").
     e. Start the streaming query and return the session ID.
   - **Cleanup contract**: `cleanup(taskId)` must:
     a. Stop all sub-sessions for the task via their `AgentSession.stop()` method
     b. Remove sub-sessions from `SessionManager` via `SessionManager.deleteSession()` to clean up DB records
     c. Remove the Task Agent session from `SessionManager`
     d. Clear in-memory maps (`taskAgentSessions`, `subSessions`, `spawningTasks`)
   - `async injectSubSessionMessage(sessionId: string, message: string): Promise<void>` -- injects a message into a sub-session using the message queue pattern from `room-runtime-service.ts`
   - `isSpawning(taskId: string): boolean` -- returns true if a Task Agent is currently being spawned for this task (used by SpaceRuntime tick loop guard)
   - `isTaskAgentAlive(taskId: string): boolean` -- checks if the Task Agent session exists and is still active (not completed/errored). Used by SpaceRuntime to detect crashed Task Agents.
   - `getTaskAgent(taskId: string): AgentSession | undefined` -- returns the Task Agent session for a task
   - `getSubSession(taskId: string, stepId: string): AgentSession | undefined` -- returns a sub-session
   - `async cleanup(taskId: string): Promise<void>` -- see "Cleanup contract" above for full specification
4. Write unit tests covering:
   - Spawning a Task Agent session
   - Idempotent spawning (calling `spawnTaskAgent` twice for the same task returns same session)
   - Concurrency guard (`isSpawning` returns true during spawn, false after)
   - Creating sub-sessions with completion callback wiring
   - Sub-session completion triggers SpaceTask status update and message injection into Task Agent
   - Injecting messages into sub-sessions
   - `isTaskAgentAlive` correctly reports session liveness
   - Cleanup behavior
   - Error handling (missing space, missing workflow, etc.)
5. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- Both Task Agent and sub-sessions are created via `SessionManager.createSession()` (not `AgentSession.fromInit()` directly) ensuring proper DB lifecycle
- `spawnTaskAgent` creates a fully wired Task Agent session with MCP tools
- `spawnTaskAgent` is idempotent — concurrent calls for the same task return the same session
- `spawningTasks` guard prevents duplicate sessions from tick loop races
- Session ID collision on restart/retry is handled via monotonic suffix
- Sub-session creation follows the same pattern as `room-runtime-service.ts`
- Sub-sessions are registered in SessionManager with `internal: true` metadata for visibility control
- Sub-session completion triggers automatic SpaceTask status update and notification to Task Agent
- Task Agent session ID follows a predictable naming convention (uniqueness guaranteed by UUID taskId)
- `isTaskAgentAlive` correctly detects crashed/completed sessions
- Cleanup properly stops all sessions AND removes them from SessionManager (no orphaned DB records)
- Unit tests cover the core lifecycle including concurrency, completion propagation, and cleanup

**Dependencies:** Task 2.2 (session init factory), Task 3.2 (MCP server factory)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.2: Add Human Message Routing to Task Agent

**Description:** Enable humans to send messages directly to a Task Agent session. When a human sends a message to a task's chat, it should be routed to the Task Agent session (not to sub-sessions).

**Subtasks:**
1. In `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts`, add a `space.task.sendMessage` RPC handler that:
   - Accepts `{ taskId: string, message: string }`
   - Looks up the task's `taskAgentSessionId`
   - Gets the Task Agent session from `TaskAgentManager`
   - Injects the message into the Task Agent session
   - Returns success/failure
2. Add a `space.task.getMessages` RPC handler that:
   - Accepts `{ taskId: string, cursor?: string, limit?: number }`
   - Returns a **one-shot paginated snapshot** of messages from the Task Agent session (not sub-sessions)
   - **Frontend rendering**: Task Agent sessions are `space_task_agent` type sessions — they appear in the existing session list and use the standard chat UI. No dedicated task chat panel is needed. The `request_human_input` tool result is visible in the Task Agent's chat conversation, and humans respond via `space.task.sendMessage`. This is intentionally the same UX as Space Chat Agent conversations.
3. Register the new RPC handlers in the handler setup
4. Write unit tests for the RPC handlers
5. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- Humans can send messages to a Task Agent via `space.task.sendMessage`
- Messages are routed to the Task Agent session (not sub-sessions)
- Error handling covers: task not found, no Task Agent session, session not started

**Dependencies:** Task 4.1 (needs TaskAgentManager)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.3: Wire TaskAgentManager into DaemonApp

**Description:** Create and register the `TaskAgentManager` as part of the daemon application context so it is available to RPC handlers and the SpaceRuntime integration.

**Subtasks:**
1. In `packages/daemon/src/app.ts`, instantiate `TaskAgentManager` with the required dependencies from the daemon context
2. Add `taskAgentManager: TaskAgentManager` to the `DaemonAppContext` interface
3. Pass the `TaskAgentManager` to the RPC handler setup so `space.task.sendMessage` can access it
4. Ensure the `TaskAgentManager` is available to `SpaceRuntimeService` (needed for Milestone 5)
5. Add cleanup logic: when the daemon shuts down, call `TaskAgentManager.cleanupAll()` to stop all Task Agent sessions
6. Write a minimal integration test verifying the wiring
7. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- `TaskAgentManager` is instantiated and available in `DaemonAppContext`
- RPC handlers can access the manager
- Cleanup on shutdown stops all Task Agent sessions
- Type checks pass

**Dependencies:** Task 4.1 (needs TaskAgentManager class). Note: Can run in parallel with Task 4.2 — wiring and RPC handlers are independent.

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
