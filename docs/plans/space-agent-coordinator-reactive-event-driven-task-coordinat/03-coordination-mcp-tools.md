# Milestone 3: New Coordination MCP Tools

## Goal

Implement the five new coordination tools (`create_standalone_task`, `get_task_detail`, `retry_task`, `cancel_task`, `reassign_task`) in both the per-space and global-spaces tool layers. These give the Space Agent the ability to act on tasks, not just observe them.

## Scope

- New SpaceTaskManager methods for retry and reassign operations (note: `cancelTask()` already exists with cascade behavior — no new cancel logic needed)
- New tool handlers in `space-agent-tools.ts` and `global-spaces-tools.ts`
- MCP tool definitions with zod schemas
- Unit tests for all new handlers

**Important context:** `SpaceTaskManager.cancelTask()` already exists (lines 200-224 of `space-task-manager.ts`) and performs cascading cancellation of dependent tasks. The `cancel_task` MCP tool is a **wrapper** around this existing method, with one new behavior: an optional `cancel_workflow_run` flag. The genuinely new SpaceTaskManager methods are `retryTask()` and `reassignTask()` only.

---

### Task 3.1: Add retry and reassign methods to SpaceTaskManager

**Description:** Add `retryTask()` and `reassignTask()` methods to `SpaceTaskManager` that the new MCP tools will call. These encapsulate the state transition logic and field updates.

**Agent type:** coder

**Subtasks:**
1. Add `retryTask(taskId: string, options?: { description?: string }): Promise<SpaceTask>` to `SpaceTaskManager`:
   - Validates task is in `needs_attention` or `cancelled` status
   - Transitions to `pending` via `setTaskStatus`
   - Optionally updates description if provided
   - Clears error field (already handled by setTaskStatus transition logic)
2. Add `reassignTask(taskId: string, customAgentId: string | null, assignedAgent?: 'coder' | 'general'): Promise<SpaceTask>` to `SpaceTaskManager`:
   - Validates task is in `pending`, `needs_attention`, or `cancelled` status (not in_progress/completed)
   - Updates `customAgentId` and optionally `assignedAgent` via `updateTask()`
3. Write unit tests for both methods covering:
   - Valid transitions (needs_attention -> pending, cancelled -> pending)
   - Invalid transitions (in_progress -> retry should fail)
   - Reassign with custom agent ID, reassign to clear custom agent
   - Reassign blocked for in_progress tasks

**Acceptance criteria:**
- `retryTask()` resets a failed/cancelled task to pending, optionally with new description
- `reassignTask()` changes the agent assignment for non-active tasks
- Both methods throw clear errors for invalid state transitions
- Unit tests cover all valid and invalid paths

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.2: Add coordination tools to space-agent-tools.ts

**Description:** Add `create_standalone_task`, `get_task_detail`, `retry_task`, `cancel_task`, and `reassign_task` tool handlers and MCP tool definitions to the per-space Space Agent tools.

**Agent type:** coder

**Subtasks:**
1. Add `SpaceTaskManager` to `SpaceAgentToolsConfig` (needed for create/retry/reassign/cancel operations). The caller of `createSpaceAgentMcpServer()` should construct `SpaceTaskManager` externally (from `db` + `spaceId`) and pass it in, keeping the tools layer free of DB construction logic. This matches how `taskRepo` and `workflowRunRepo` are already passed in.
2. Add `spaceAgentManager` to `SpaceAgentToolsConfig` (needed for reassign validation)
3. Implement `create_standalone_task` handler: creates a task with no workflowRunId/workflowStepId, accepts title, description, priority, task_type, assigned_agent, custom_agent_id
4. Implement `get_task_detail` handler: fetches full task record by ID including all fields (error, result, prUrl, prNumber, progress, currentStep)
5. Implement `retry_task` handler: calls `SpaceTaskManager.retryTask()`, accepts task_id and optional description
6. Implement `cancel_task` handler: wraps the existing `SpaceTaskManager.cancelTask()` (which already cascades to dependent tasks), accepts task_id and optional `cancel_workflow_run` boolean. **New behavior:** If `cancel_workflow_run` is true and the task has a `workflowRunId`, also update the workflow run status to `cancelled` via `workflowRunRepo.updateStatus(runId, 'cancelled')`. The live `WorkflowExecutor` in SpaceRuntime's `executors` map will be cleaned up by `cleanupTerminalExecutors()` on the next tick (which already removes executors for terminal-state runs). Do NOT attempt to remove the executor directly — rely on the existing cleanup mechanism.
7. Implement `reassign_task` handler: calls `SpaceTaskManager.reassignTask()`, accepts task_id, custom_agent_id, assigned_agent
8. Add MCP tool definitions with zod schemas for all five tools
9. Write unit tests for all five tool handlers

**Acceptance criteria:**
- All five tools are registered in the MCP server
- `create_standalone_task` creates tasks without workflow association
- `get_task_detail` returns the complete task record
- `retry_task` resets failed tasks to pending
- `cancel_task` cancels tasks with optional workflow run cascade
- `reassign_task` changes agent assignment
- All handlers return `{ success: true/false, ... }` JSON responses
- Unit tests cover success and error paths for each tool

**Dependencies:** Task 3.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.3: Add coordination tools to global-spaces-tools.ts

**Description:** Mirror the five new coordination tools in the global-spaces-tools layer, adding space_id resolution via the active space context pattern.

**Agent type:** coder

**Subtasks:**
1. Add `create_standalone_task` handler with `space_id` parameter (uses `resolveSpaceId` pattern)
2. Add `get_task_detail` handler (task ID is globally unique, no space_id needed but validate task belongs to resolved space)
3. Add `retry_task`, `cancel_task`, `reassign_task` handlers (all need SpaceTaskManager, created via getOrCreate pattern similar to SpaceRuntime)
4. Add MCP tool definitions with zod schemas for all five tools
5. Update `GlobalSpacesToolsConfig` to include dependencies needed for task management (db for SpaceTaskManager creation)
6. Write unit tests for all five global tool handlers

**Acceptance criteria:**
- All five tools work in the global context with space_id resolution
- Active space context is used when no explicit space_id is provided
- Error messages are clear when no space context is available
- Unit tests cover the space resolution and all tool operations

**Dependencies:** Task 3.1 (needs `retryTask`/`reassignTask` methods; does NOT depend on Task 3.2 — `space-agent-tools.ts` and `global-spaces-tools.ts` are independent modules that can be built in parallel)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
