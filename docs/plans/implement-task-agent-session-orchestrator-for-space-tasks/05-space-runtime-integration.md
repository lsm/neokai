# Milestone 5: SpaceRuntime Integration

## Goal

Modify the SpaceRuntime tick loop to spawn Task Agent sessions for pending tasks instead of directly advancing the workflow. The Task Agent takes over the full workflow lifecycle once spawned.

## Tasks

### Task 5.1: Add Task Agent Spawning to SpaceRuntime Tick Loop

**Description:** Modify `SpaceRuntime.processRunTick()` to detect pending tasks that need a Task Agent and spawn one via the `TaskAgentManager`. Once a Task Agent is running, SpaceRuntime no longer calls `advance()` directly -- the Task Agent drives the workflow through its MCP tools.

**Subtasks:**
1. Add `taskAgentManager: TaskAgentManager` to `SpaceRuntimeConfig` interface (optional field for backward compatibility; when not provided, the existing direct-advance behavior continues)
2. In `SpaceRuntime.processRunTick()`, add a new check before the existing `advance()` logic:
   - Find pending tasks for the current step that have no `taskAgentSessionId`
   - Check `taskAgentManager.isSpawning(taskId)` — if true, skip (spawn already in progress from a previous tick)
   - If a `taskAgentManager` is provided, call `taskAgentManager.spawnTaskAgent()` for each pending task (idempotent — safe to call multiple times)
   - After spawning, mark the task as `in_progress` and set the `taskAgentSessionId`
   - Skip the existing `advance()` call for runs that have an active Task Agent session
3. Add a guard in `processRunTick()`: if a task already has a `taskAgentSessionId`, check session liveness via `taskAgentManager.isTaskAgentAlive(taskId)`:
   - **If alive**: skip the tick entirely -- the Task Agent is handling advancement
   - **If NOT alive** (crashed/gone): The Task Agent session is gone but the task is not completed. Clear the `taskAgentSessionId` on the SpaceTask, set status back to `pending`, and log a warning. The next tick will spawn a fresh Task Agent that can resume from the workflow's current state (the workflow executor tracks progress in the DB, so no work is lost). This handles the crash recovery edge case.
4. When a Task Agent reports the task as completed (via `report_result` tool), the existing `processCompletedTasks` logic will pick up the completed task status and the workflow will be in a consistent state for the next Task Agent to be spawned for the subsequent step
5. Handle the transition: when a Task Agent completes and a new pending task is created by the workflow executor (via the Task Agent's `advance_workflow` tool), the next tick will spawn a new Task Agent for the new task
6. Update existing SpaceRuntime unit tests to verify the new behavior when `taskAgentManager` is provided
7. Write new tests covering:
   - Task Agent is spawned for pending tasks when `taskAgentManager` is configured
   - Direct advance behavior continues when `taskAgentManager` is not configured (backward compat)
   - Tasks with active Task Agent sessions are skipped
   - Completed tasks trigger normal workflow advancement
   - Crashed Task Agent recovery: task with `taskAgentSessionId` but dead session gets reset to `pending` and re-spawned on next tick
   - Concurrency guard: tick during active spawn is skipped (`isSpawning` check)
   - Idempotent spawn: multiple ticks for same pending task don't create duplicate sessions
8. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- When `taskAgentManager` is configured, SpaceRuntime spawns Task Agent sessions for pending tasks
- When `taskAgentManager` is not configured, existing direct-advance behavior is preserved
- Active Task Agent sessions prevent direct advancement by SpaceRuntime
- Crashed/dead Task Agent sessions are detected and the task is reset to `pending` for re-spawning
- Concurrent tick loop firings during spawn are safely handled via `isSpawning` guard
- Completed Task Agent tasks allow normal workflow progression
- All existing SpaceRuntime tests continue to pass
- New tests cover the Task Agent integration path including crash recovery and concurrency

**Dependencies:** Task 4.1 (needs TaskAgentManager class). Note: Does not depend on 4.3 (DaemonApp wiring) — SpaceRuntime accepts TaskAgentManager via its config interface, independent of how it's wired in app.ts. Can run in parallel with 4.2, 4.3, and 6.1.

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Update SpaceRuntimeService to Pass TaskAgentManager

**Description:** Wire the `TaskAgentManager` through `SpaceRuntimeService` to `SpaceRuntime` so the tick loop can spawn Task Agent sessions.

**Subtasks:**
1. Add `taskAgentManager?: TaskAgentManager` to `SpaceRuntimeServiceConfig`
2. Pass it through to `SpaceRuntime` constructor in the config
3. Update the `createOrGetRuntime()` and `getSharedRuntime()` methods to ensure the runtime has access to the manager
4. In `packages/daemon/src/app.ts`, pass the `TaskAgentManager` instance to `SpaceRuntimeServiceConfig` when constructing the service
5. Write tests verifying the wiring
6. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- `SpaceRuntimeService` forwards `TaskAgentManager` to the underlying `SpaceRuntime`
- `app.ts` passes the manager when constructing the service
- Tests verify the configuration is correctly propagated

**Dependencies:** Task 5.1 (needs SpaceRuntime changes), Task 4.3 (needs TaskAgentManager wired in DaemonApp)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.3: Task Agent Session Rehydration on Restart

**Description:** When the daemon restarts, Task Agent sessions need to be rehydrated. Add logic to `TaskAgentManager` and `SpaceRuntime.rehydrateExecutors()` to restore active Task Agent sessions from the database.

**Subtasks:**
1. In `TaskAgentManager`, add `async rehydrate(): Promise<void>` that:
   - Queries `space_tasks` for tasks with status `in_progress` or `needs_attention` that have a non-null `taskAgentSessionId` (DB query: `SELECT * FROM space_tasks WHERE status IN ('in_progress', 'needs_attention') AND task_agent_session_id IS NOT NULL`)
   - For each such task, loads the associated Space, Workflow, and WorkflowRun via their respective repositories
   - Recreates the Task Agent session using `createTaskAgentInit()` and `AgentSession.fromInit()`
   - Re-attaches the MCP server via `setRuntimeMcpServers()` and system prompt via `setRuntimeSystemPrompt()`
   - **Restarts the streaming query** by calling the session's `startStreamingQuery()` (or equivalent). The conversation history is already in the DB from the previous run — the SDK will resume from the last message.
   - **Injects a re-orientation message** into the Task Agent session: "You are resuming after a daemon restart. Your previous conversation state has been restored. Please use `check_step_status` to determine the current state of your workflow and continue from where you left off." This re-engages the LLM to take action rather than waiting passively.
   - Restores it to the `taskAgentSessions` map
   - Note: sub-sessions do NOT need rehydration — the Task Agent will re-spawn them via its MCP tools after receiving the re-orientation message and checking step status
2. Call `taskAgentManager.rehydrate()` in `SpaceRuntime.rehydrateExecutors()` after executor rehydration (so executors are ready when Task Agents try to use them)
3. Write unit tests verifying:
   - Rehydration restores Task Agent sessions for in_progress tasks
   - Rehydrated sessions have their streaming query restarted
   - Re-orientation message is injected after rehydration
   - Tasks without `taskAgentSessionId` are skipped
   - Completed/cancelled tasks are not rehydrated
   - Tasks with `needs_attention` status are rehydrated (they may resume after human input)
4. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- Active Task Agent sessions are restored on daemon restart
- Rehydrated sessions have MCP tools, system prompts, and streaming queries re-attached
- A re-orientation message is injected to re-engage the Task Agent after restart
- Sub-sessions are not rehydrated (Task Agent re-spawns them as needed via MCP tools)
- Tests verify rehydration behavior including streaming query restart and re-orientation

**Dependencies:** Task 5.1 (needs SpaceRuntime integration), Task 4.1 (needs TaskAgentManager)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
