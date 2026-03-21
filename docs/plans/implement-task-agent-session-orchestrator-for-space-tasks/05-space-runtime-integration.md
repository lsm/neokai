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
   - If a `taskAgentManager` is provided, call `taskAgentManager.spawnTaskAgent()` for each pending task
   - After spawning, mark the task as `in_progress` and set the `taskAgentSessionId`
   - Skip the existing `advance()` call for runs that have an active Task Agent session
3. Add a guard in `processRunTick()`: if a task already has a `taskAgentSessionId` and the Task Agent session is still active (not completed), skip the tick entirely -- the Task Agent is handling advancement
4. When a Task Agent reports the task as completed (via `report_result` tool), the existing `processCompletedTasks` logic will pick up the completed task status and the workflow will be in a consistent state for the next Task Agent to be spawned for the subsequent step
5. Handle the transition: when a Task Agent completes and a new pending task is created by the workflow executor (via the Task Agent's `advance_workflow` tool), the next tick will spawn a new Task Agent for the new task
6. Update existing SpaceRuntime unit tests to verify the new behavior when `taskAgentManager` is provided
7. Write new tests covering:
   - Task Agent is spawned for pending tasks when `taskAgentManager` is configured
   - Direct advance behavior continues when `taskAgentManager` is not configured (backward compat)
   - Tasks with active Task Agent sessions are skipped
   - Completed tasks trigger normal workflow advancement
8. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- When `taskAgentManager` is configured, SpaceRuntime spawns Task Agent sessions for pending tasks
- When `taskAgentManager` is not configured, existing direct-advance behavior is preserved
- Active Task Agent sessions prevent direct advancement by SpaceRuntime
- Completed Task Agent tasks allow normal workflow progression
- All existing SpaceRuntime tests continue to pass
- New tests cover the Task Agent integration path

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
   - Queries `space_tasks` for tasks with status `in_progress` or `needs_attention` that have a non-null `taskAgentSessionId`
   - For each such task, loads the associated Space, Workflow, and WorkflowRun
   - Recreates the Task Agent session (AgentSession, MCP server, etc.)
   - Restores it to the `taskAgentSessions` map
   - Note: sub-sessions do NOT need rehydration -- the Task Agent will re-spawn them via its MCP tools if needed
2. Call `taskAgentManager.rehydrate()` in `SpaceRuntime.rehydrateExecutors()` after executor rehydration (so executors are ready when Task Agents try to use them)
3. Write unit tests verifying:
   - Rehydration restores Task Agent sessions for in_progress tasks
   - Tasks without `taskAgentSessionId` are skipped
   - Completed/cancelled tasks are not rehydrated
4. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- Active Task Agent sessions are restored on daemon restart
- Rehydrated sessions have MCP tools and system prompts re-attached
- Sub-sessions are not rehydrated (Task Agent re-spawns them as needed)
- Tests verify rehydration behavior

**Dependencies:** Task 5.1 (needs SpaceRuntime integration), Task 4.1 (needs TaskAgentManager)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
