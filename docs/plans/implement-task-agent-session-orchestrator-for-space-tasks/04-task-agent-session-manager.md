# Milestone 4: Task Agent Session Manager

## Goal

Create the `TaskAgentManager` class that handles the full lifecycle of Task Agent sessions: spawning them for pending tasks, attaching MCP tools, managing sub-session creation, tracking task-to-session mappings, and cleaning up completed sessions.

## Tasks

### Task 4.1: Implement TaskAgentManager Core

**Description:** Create the `TaskAgentManager` class that manages the lifecycle of Task Agent sessions. This is the central integration point that ties together the session init factory, MCP tools, and sub-session management.

**Subtasks:**
1. Create `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
2. Define `TaskAgentManagerConfig` interface containing: `db`, `sessionManager`, `spaceManager`, `spaceAgentManager`, `spaceWorkflowManager`, `spaceRuntimeService`, `taskRepo`, `workflowRunRepo`, `daemonHub`, `messageHub`, `getApiKey`, `defaultModel`
3. Implement `TaskAgentManager` class with:
   - `private taskAgentSessions: Map<string, AgentSession>` -- maps taskId to the Task Agent's AgentSession
   - `private subSessions: Map<string, Map<string, AgentSession>>` -- maps taskId to a map of stepId to sub-session AgentSession
   - `async spawnTaskAgent(task: SpaceTask, space: Space, workflow: SpaceWorkflow, workflowRun: SpaceWorkflowRun): Promise<string>` -- creates the Task Agent session:
     a. Generate session ID: `space:${spaceId}:task:${taskId}`
     b. Call `createTaskAgentInit()` to get the session init
     c. Create `AgentSession.fromInit()` with the init
     d. Create the Task Agent MCP server with a `sessionFactory` that delegates to `this.createSubSession()` and a `messageInjector` that delegates to `this.injectSubSessionMessage()`
     e. Attach the MCP server to the session via `setRuntimeMcpServers()`
     f. Update the SpaceTask with `taskAgentSessionId`
     g. Start the streaming query
     h. Inject the initial task message via `buildTaskAgentInitialMessage()`
     i. Store the session in `taskAgentSessions`
     j. Return the session ID
   - `async createSubSession(taskId: string, stepId: string, init: AgentSessionInit): Promise<string>` -- creates a sub-session for a workflow step agent, stores it in `subSessions`, starts its streaming query, returns the session ID
   - `async injectSubSessionMessage(sessionId: string, message: string): Promise<void>` -- injects a message into a sub-session using the message queue pattern from `room-runtime-service.ts`
   - `getTaskAgent(taskId: string): AgentSession | undefined` -- returns the Task Agent session for a task
   - `getSubSession(taskId: string, stepId: string): AgentSession | undefined` -- returns a sub-session
   - `async cleanup(taskId: string): Promise<void>` -- stops and removes all sessions for a task
4. Write unit tests covering:
   - Spawning a Task Agent session
   - Creating sub-sessions
   - Injecting messages into sub-sessions
   - Cleanup behavior
   - Error handling (missing space, missing workflow, etc.)
5. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- `spawnTaskAgent` creates a fully wired Task Agent session with MCP tools
- Sub-session creation follows the same pattern as `room-runtime-service.ts`
- Task Agent session ID follows a predictable naming convention
- Cleanup properly stops all sessions
- Unit tests cover the core lifecycle

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
   - Accepts `{ taskId: string }`
   - Returns messages from the Task Agent session (not sub-sessions)
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
