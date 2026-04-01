# Plan: End Node Completion + Schema Cleanup

## Goal

The workflow graph currently has `startNodeId` but no `endNodeId`. Workflow completion relies on the Task Agent LLM calling `report_workflow_done`, which is fragile and architecturally incorrect — task completion is a workflow concern, not a task concern.

In addition, the current schema has accumulated dead fields, leaked workflow-internal columns on `space_tasks`, and a missing first-class `node_executions` table. This plan combines the `endNodeId` feature with a schema cleanup to produce a clean, well-separated data model.

## Approach

1. **Clean schema design**: Separate workflow-internal state (`node_executions`) from user-facing tasks (`space_tasks`). Remove dead/deprecated columns from all tables.
2. **`endNodeId` on `SpaceWorkflow`**: When the end node's execution calls `report_done`, `CompletionDetector` auto-completes the workflow run.
3. **Remove `report_workflow_done`**: The Task Agent focuses on spawning/monitoring/gates; the runtime handles completion.

## New Schema Design

### `space_tasks` — Cleaned Up

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | Primary key |
| `spaceId` | `string` (UUID) | Scope |
| `taskNumber` | `number` | Auto-incremented per space, human-friendly ID |
| `title` | `string` | Displayed everywhere |
| `description` | `string \| null` | Detail view |
| `status` | `SpaceTaskStatus` | `open` `in_progress` `done` `blocked` `cancelled` `archived` |
| `priority` | `0 \| 1 \| 2 \| 3` | P0–P3, default `2` |
| `labels` | `string[]` | Filtering, categorisation |
| `dependsOn` | `string[]` | Task IDs in same space (prerequisites) |
| `result` | `string \| null` | Final output from agent |
| `createdAt` | `number` | Unix ms, immutable |
| `startedAt` | `number \| null` | Stamped on `in_progress` |
| `completedAt` | `number \| null` | Stamped on `done` / `cancelled` |
| `updatedAt` | `number` | Every write |
| `archivedAt` | `number \| null` | Stamped on `archived` |

**Removed from `space_tasks`:** `workflowNodeId`, `agentName`, `customAgentId`, `taskAgentSessionId`, `taskType`, `goalId`, `error`, `assignedAgent`, `draft`/`pending`/`review`/`needs_attention`/`rate_limited`/`usage_limited` statuses.

**Status changes:** Old `SpaceTaskStatus` had 10 values: `draft`, `pending`, `in_progress`, `review`, `completed`, `needs_attention`, `cancelled`, `archived`, `rate_limited`, `usage_limited`. New `SpaceTaskStatus` has 6 values: `open`, `in_progress`, `done`, `blocked`, `cancelled`, `archived`. Mapping: `draft`/`pending` → `open`, `completed` → `done`, `review`/`needs_attention`/`rate_limited`/`usage_limited` → no equivalent (workflow-internal concerns move to `node_executions`).

### `node_executions` — New Table

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | Primary key |
| `workflowRunId` | `string` (UUID) | Links to `space_workflow_runs` |
| `workflowNodeId` | `string` | Which node in workflow definition |
| `agentName` | `string` | Channel routing address |
| `agentId` | `string` | Which agent runs this slot |
| `agentSessionId` | `string \| null` | Agent sub-session ID for liveness |
| `status` | `NodeExecutionStatus` | `pending` `in_progress` `done` `blocked` `cancelled` |
| `result` | `string \| null` | Output from `report_done(summary)` |
| `createdAt` | `number` | Unix ms |
| `startedAt` | `number \| null` | Stamped on `in_progress` |
| `completedAt` | `number \| null` | Stamped on terminal |
| `updatedAt` | `number` | Every write |

### `space_workflows` — Cleaned Up

Added: `endNodeId`. Removed: `rules`, `config`, `maxIterations`, `isDefault`.

### `space_workflow_runs` — Cleaned Up

Status values: `pending` `in_progress` `done` `blocked` `cancelled`. Removed: `config`, `goalId`, `failureReason`, `iterationCount`, `maxIterations`.

### `workflow_nodes` — Cleaned Up

Removed: `agentId` shorthand (always use `agents[]`), `model`/`systemPrompt` overrides on node, `orderIndex`, `config` blob.

### `space_agents` — Cleaned Up

Removed: `role`, `toolConfig`, `injectWorkflowContext`.

---

## Task 1: Schema type definitions

**Description:** Update all shared type definitions in `packages/shared/src/types/space.ts` and `packages/shared/src/types/space-utils.ts` to reflect the new schema design. This is the foundational task — all other tasks depend on it.

**Agent type:** coder

**Subtasks:**

1. **`SpaceTaskStatus` and `SpaceTask`:**
   - Change `SpaceTaskStatus` from `'draft' | 'pending' | 'in_progress' | 'review' | 'completed' | 'needs_attention' | 'cancelled' | 'archived' | 'rate_limited' | 'usage_limited'` to `'open' | 'in_progress' | 'done' | 'blocked' | 'cancelled' | 'archived'`.
   - Update `SpaceTask` interface: remove `workflowNodeId`, `agentName`, `customAgentId`, `taskAgentSessionId`, `taskType`, `goalId`, `error`, `assignedAgent`. Add `taskNumber: number`, `labels: string[]`, `dependsOn: string[]`, `result: string | null`, `startedAt: number | null`, `completedAt: number | null`, `archivedAt: number | null`. Keep `id`, `spaceId`, `title`, `description`, `status`, `priority`, `createdAt`, `updatedAt`.
   - Update `CreateSpaceTaskParams` and `UpdateSpaceTaskParams` accordingly.

2. **`NodeExecution` type (new):**
   - Add `NodeExecutionStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled'`.
   - Add `NodeExecution` interface with all fields from the schema table above.
   - Add `CreateNodeExecutionParams` and `UpdateNodeExecutionParams`.

3. **`SpaceWorkflow`:**
   - Add `endNodeId?: string` to `SpaceWorkflow` with JSDoc.
   - Add `endNodeId?: string` to `CreateSpaceWorkflowParams`.
   - Add `endNodeId?: string | null` to `UpdateSpaceWorkflowParams`.
   - Remove `rules`, `config`, `maxIterations`, `isDefault` from all three interfaces.
   - Add `endNode?: string` to `ExportedSpaceWorkflow` (optional, unlike required `startNode`).

4. **`SpaceWorkflowRun`:**
   - Change `WorkflowRunStatus` to `'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled'`.
   - Remove `config`, `goalId`, `failureReason`, `iterationCount`, `maxIterations` from `SpaceWorkflowRun` and its create/update params.
   - Add `startedAt: number | null`, `completedAt: number | null` if not already present.

5. **`WorkflowNode`:**
   - Remove `agentId` shorthand field — always use `agents: WorkflowNodeAgent[]`.
   - Remove `model`, `systemPrompt`, `orderIndex`, `config` from `WorkflowNode`.
   - Keep `id`, `name`, `agents`, `instructions`.
   - Update `resolveNodeAgents()` in `space-utils.ts`: remove the `agentId` fallback path. The function should expect `agents[]` to always be present. If called with legacy data that has `agentId` instead, throw a descriptive error.

6. **`SpaceAgent`:**
   - Remove `role`, `toolConfig`, `injectWorkflowContext` from `SpaceAgent` interface.
   - Keep `id`, `spaceId`, `name`, `description`, `model`, `provider`, `systemPrompt`, `tools`, `createdAt`, `updatedAt`.

7. **Update `TERMINAL_TASK_STATUSES`** (in `completion-detector.ts` or shared types): update to match new `NodeExecutionStatus` terminal values: `done`, `cancelled`. The old set (`completed`, `needs_attention`, `cancelled`, `rate_limited`, `usage_limited`) is replaced.

**Acceptance criteria:**
- `bun run typecheck` passes (expect many downstream errors initially — this task focuses on type definitions only; downstream fixes are in later tasks).
- All new types are exported from `@neokai/shared`.
- Old status values and removed fields are no longer in the type definitions.

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 2: DB migrations

**Description:** Create SQLite migrations to transform all tables to the new schema. This is a large migration task covering multiple tables. SQLite requires table recreation for column removal (cannot `ALTER TABLE DROP COLUMN` in all cases). Use the existing recreation pattern from migrations 51, 55, 60, 62.

**Agent type:** coder

**Subtasks:**

1. **`space_tasks` migration:**
   - Recreate `space_tasks` table with the new column set. Drop: `workflow_node_id`, `agent_name`, `custom_agent_id`, `task_agent_session_id`, `task_type`, `goal_id`, `error`, `assigned_agent`. Add: `task_number` (INTEGER, auto-increment per space), `labels` (TEXT, JSON array default `'[]'`), `depends_on` (TEXT, JSON array default `'[]'`), `result` (TEXT nullable), `started_at` (INTEGER nullable), `completed_at` (INTEGER nullable), `archived_at` (INTEGER nullable).
   - **Status migration:** Map old values: `draft` → `open`, `pending` → `open`, `completed` → `done`, `review` → `in_progress`, `needs_attention` → `blocked`, `rate_limited` → `blocked`, `usage_limited` → `blocked`. Keep `in_progress`, `cancelled`, `archived` as-is.
   - Update CHECK constraint on `status` column to new values.
   - Copy existing data with status mapping during table recreation.

2. **`node_executions` table (new):**
   - `CREATE TABLE node_executions (id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, workflow_node_id TEXT NOT NULL, agent_name TEXT NOT NULL, agent_id TEXT NOT NULL, agent_session_id TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','blocked','cancelled')), result TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, updated_at INTEGER NOT NULL)`.
   - Add indexes: `idx_node_executions_run` on `workflow_run_id`, `idx_node_executions_node` on `(workflow_run_id, workflow_node_id)`.
   - **Data migration from `space_tasks`:** For each existing task with `workflow_node_id IS NOT NULL`, create a corresponding `node_executions` row. Map fields: `workflow_node_id` → `workflow_node_id`, `agent_name` → `agent_name`, `custom_agent_id` → `agent_id`, `task_agent_session_id` → `agent_session_id`. Map status: `completed` → `done`, `needs_attention` → `blocked`, `rate_limited` → `blocked`, `usage_limited` → `blocked`, `draft` → `pending`, `pending` → `pending`, `review` → `in_progress`. Use task's `workflow_run_id` (looked up via the run that references this task, or stored directly if available). The `result` field can be populated from `space_tasks.description` or left null.

3. **`space_workflows` migration:**
   - Add column: `ALTER TABLE space_workflows ADD COLUMN end_node_id TEXT`.
   - Drop columns by table recreation: remove `config` JSON blob (which contains `rules`, `maxIterations`), `is_default`. Note: `is_default` may be a separate column or part of config — verify at implementation time.
   - **Note:** The next migration number is 70 (after the current latest, migration 69); always verify at implementation time in case a concurrent migration is merged first.

4. **`space_workflow_runs` migration:**
   - Recreate table dropping: `config`, `goal_id`, `failure_reason`, `iteration_count`, `max_iterations`.
   - Add `started_at` (INTEGER nullable), `completed_at` (INTEGER nullable) if not present.
   - Update `status` CHECK constraint to new values: `pending`, `in_progress`, `done`, `blocked`, `cancelled`.

5. **`space_workflow_nodes` migration:**
   - Drop `order_index` column.
   - If `agent_id` is stored as a top-level column, remove it (agents are stored in node config JSON as `agents[]`).
   - Remove `model`, `system_prompt` columns if they exist as top-level DB columns.

6. **`space_agents` migration:**
   - Recreate table dropping: `role`, `config` (which stores `toolConfig`), `inject_workflow_context`.

**Acceptance criteria:**
- All migrations run without errors on existing databases with data.
- Data is preserved: existing tasks, workflows, workflow runs, agents are migrated to new schema.
- Status values are correctly mapped (old → new).
- Node execution data is migrated from `space_tasks` to `node_executions`.
- Indexes exist on `node_executions` for query performance.

**Dependencies:** Task 1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 3: Repository layer updates

**Description:** Update all repository classes to read/write the new schema. Add the new `NodeExecutionRepository`.

**Agent type:** coder

**Subtasks:**

1. **`NodeExecutionRepository` (new):**
   - Create `packages/daemon/src/storage/repositories/node-execution-repository.ts`.
   - Implement CRUD: `create()`, `getById()`, `listByWorkflowRun()`, `listByNode()`, `updateStatus()`, `updateSessionId()`.
   - `listByWorkflowRun()` replaces the current `taskRepo.listByWorkflowRun()` for workflow-internal queries.

2. **`SpaceTaskRepository` updates:**
   - Update `TaskRow` interface to match new columns. Remove `workflow_node_id`, `agent_name`, `custom_agent_id`, `task_agent_session_id`, `task_type`, `goal_id`, `error`, `assigned_agent`.
   - Add `task_number`, `labels`, `depends_on`, `result`, `started_at`, `completed_at`, `archived_at`.
   - Update `rowToTask()` and `createTask()` / `updateTask()` methods.
   - Remove `listByWorkflowRun()`, `listActiveWithTaskAgentSession()`, `findByGoalId()` — these are workflow-internal queries that move to `NodeExecutionRepository`.

3. **`SpaceWorkflowRepository` updates:**
   - Add `end_node_id` to `WorkflowRow` and `rowToWorkflow()`.
   - Add `endNodeId` to `createWorkflow()` and `updateWorkflow()`. Use `params.endNodeId !== undefined` pattern for updates (consistent with `startNodeId`). Add inline comment: `// undefined = not provided (no change), null = clear the field, string = set new value`.
   - Remove reading/writing of `config` JSON blob fields (`rules`, `maxIterations`), `isDefault`.

4. **`SpaceWorkflowRunRepository` updates:**
   - Remove `config`, `goalId`, `failureReason`, `iterationCount`, `maxIterations` from row mapping and CRUD.
   - Add `startedAt`, `completedAt` if not present.
   - Update status values in transition logic.

5. **`SpaceAgentRepository` updates:**
   - Remove `role`, `config` (toolConfig), `inject_workflow_context` from row mapping and CRUD.

6. **Unit tests:**
   - New test file for `NodeExecutionRepository`: CRUD, status transitions, query by run/node.
   - Update existing repository tests for changed fields/status values.

**Acceptance criteria:**
- All repositories compile and pass their unit tests.
- `NodeExecutionRepository` has full CRUD coverage.
- Old fields are no longer read/written.
- `bun run typecheck` passes.

**Dependencies:** Task 1, Task 2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 4: SpaceTaskManager and status transition updates

**Description:** Update `SpaceTaskManager`, `VALID_SPACE_TASK_TRANSITIONS`, and `TERMINAL_TASK_STATUSES` to use new status values. Create `NodeExecutionManager` for workflow-internal execution state.

**Agent type:** coder

**Subtasks:**

1. **`SpaceTaskManager` updates:**
   - Update `VALID_SPACE_TASK_TRANSITIONS` for new `SpaceTaskStatus` values: `open`, `in_progress`, `done`, `blocked`, `cancelled`, `archived`.
   - Update `setTaskStatus()`, `retryTask()`, `reassignTask()` for new status names.
   - Remove any workflow-specific logic (the manager now handles only user-facing tasks).

2. **`NodeExecutionManager` (new or extend existing):**
   - Create status transition logic for `NodeExecutionStatus`: `pending` → `in_progress`, `in_progress` → `done`/`blocked`/`cancelled`, `blocked` → `in_progress`/`cancelled`, etc.
   - `TERMINAL_NODE_EXECUTION_STATUSES`: `done`, `cancelled`.
   - This manager is used by the runtime, node-agent-tools, and CompletionDetector.

3. **Update `CompletionDetector`:**
   - Change from querying `taskRepo.listByWorkflowRun()` to `nodeExecutionRepo.listByWorkflowRun()`.
   - Filter by `NodeExecution` instead of `SpaceTask`.
   - Update `TERMINAL_TASK_STATUSES` reference to `TERMINAL_NODE_EXECUTION_STATUSES` (`done`, `cancelled`).
   - Refactor `isComplete()` signature to options object: `isComplete(options: { workflowRunId: string, channels?: WorkflowChannel[], nodes?: WorkflowNode[], endNodeId?: string })`.
   - Add end-node completion logic: if `endNodeId` is provided, find the `NodeExecution` with matching `workflowNodeId` and check for terminal status. Short-circuit on match.
   - **Update ALL call sites** to new signature: `space-runtime.ts` and `task-agent-tools.ts` (the latter is removed in Task 6, but must compile in this task).

4. **Unit tests:**
   - Update `completion-detector.test.ts`: all existing tests updated for new types/repo, plus new end-node tests.
   - New tests for `NodeExecutionManager` status transitions.
   - Parameterized test over all `TERMINAL_NODE_EXECUTION_STATUSES`.

**Acceptance criteria:**
- New status values used consistently.
- CompletionDetector queries `node_executions` instead of `space_tasks`.
- End-node completion logic works as specified in prior iterations (bypass, orchestration task cleanup, etc.).
- All tests pass.

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 5: Runtime updates (ChannelRouter, SpaceRuntime, TaskAgentManager)

**Description:** Update the workflow runtime layer to use `node_executions` instead of `space_tasks` for workflow-internal state. This is the core behavioral change.

**Agent type:** coder

**Subtasks:**

1. **`ChannelRouter` updates (`packages/daemon/src/lib/space/runtime/channel-router.ts`):**
   - `activateNode()`: create `NodeExecution` records via `nodeExecutionRepo.create()` instead of creating `space_tasks` with `workflowNodeId`. Remove `taskType`, `goalId`, `customAgentId` from node activation.
   - `getActiveExecutionsForNode()`: query `nodeExecutionRepo.listByNode()` instead of filtering tasks.
   - Update channel routing to use `NodeExecution.agentName` for message delivery.

2. **`SpaceRuntime` updates (`packages/daemon/src/lib/space/runtime/space-runtime.ts`):**
   - `processRunTick()`: fetch `NodeExecution` records via `nodeExecutionRepo.listByWorkflowRun()` instead of tasks.
   - End-node bypass: before the `needs_attention` (now `blocked`) early-return block, check if end node's execution is `done` — skip the block if so.
   - Pass `endNodeId` to `completionDetector.isComplete()`.
   - **Orchestration task completion on auto-complete:** When the runtime auto-completes a run, find the orchestration task (task with no corresponding node execution, or a designated orchestration task) and complete it. Use `this.getOrCreateTaskManager(meta.spaceId)` for status update. Guard: only if status is `in_progress` or `review` (now `in_progress`). Inject `daemonHub` into `SpaceRuntimeConfig` (flows through automatically from `SpaceRuntimeServiceConfig`).
   - **Notification tradeoff:** When end-node bypass fires, `blocked` notifications for sibling executions are skipped. Add code comment.

3. **`TaskAgentManager` updates (`packages/daemon/src/lib/space/runtime/task-agent-manager.ts`):**
   - Read `NodeExecution.agentSessionId` instead of `task.taskAgentSessionId` for session lookup/restore.
   - Write `agentSessionId` to `NodeExecution` after spawning via `nodeExecutionRepo.updateSessionId()`.
   - `handleSubSessionComplete`/`handleSubSessionError`: match by `NodeExecution.agentSessionId` instead of `task.taskAgentSessionId`.
   - `listActiveWithTaskAgentSession()` equivalent: query `nodeExecutionRepo` for executions with non-null `agentSessionId` and non-terminal status.

4. **Unit tests:**
   - Update `space-runtime-completion.test.ts` for new types.
   - Update `channel-router.test.ts` for `NodeExecution` creation.
   - Update `task-agent-manager.test.ts` for session tracking via `NodeExecution`.

**Acceptance criteria:**
- Runtime creates `NodeExecution` records, not task-level records for workflow nodes.
- Session tracking uses `NodeExecution.agentSessionId`.
- End-node completion flow works: end node `done` → bypass → CompletionDetector → run `done` → orchestration task completed.
- All runtime tests pass.

**Dependencies:** Task 3, Task 4

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 6: Remove `report_workflow_done` and update agent tools

**Description:** Remove `report_workflow_done` from Task Agent tools, update node-agent-tools to work with `NodeExecution`, and update system prompts.

**Agent type:** coder

**Subtasks:**

1. **Remove `report_workflow_done`:**
   - Remove `ReportWorkflowDoneSchema` from `task-agent-tool-schemas.ts`.
   - Remove handler from `task-agent-tools.ts`.
   - Remove `completionDetector` from `TaskAgentToolsConfig` (defined at ~line 195 in `task-agent-tools.ts`). Remove the `CompletionDetector` import.
   - Remove both `new CompletionDetector()` instantiations in `task-agent-manager.ts` (~lines 630 and 1449).

2. **Update `node-agent-tools.ts`:**
   - `report_done`: update to set `NodeExecution.status = 'done'` via `nodeExecutionRepo` instead of `taskManager.setTaskStatus(stepTaskId, 'completed')`.
   - `list_peers`: query `nodeExecutionRepo` by `workflowRunId` instead of filtering tasks by `workflowNodeId`.
   - `send_message`: use `NodeExecution.agentName` for routing.

3. **Update `task-agent-tools.ts`:**
   - `spawn_node_agent`: read `NodeExecution.agentSessionId` for idempotency guard instead of `task.taskAgentSessionId`. Write `agentSessionId` to `NodeExecution` after session creation.
   - `list_group_members`: query `nodeExecutionRepo` instead of filtering tasks.

4. **Update Task Agent system prompt (`task-agent.ts`):**
   - Remove `report_workflow_done` documentation section.
   - Update step 6: "The workflow runtime automatically detects completion when the end node finishes. You do not need to detect or signal workflow completion."
   - Update step 4: "Monitoring task progress — the workflow runtime handles completion automatically when the end node finishes."
   - Note: Task Agent does NOT call `report_result` to self-terminate — runtime auto-completes.

5. **Update tests:**
   - Remove `report_workflow_done` tests from `task-agent-tool-schemas.test.ts`, `task-agent-tools.test.ts`, `task-agent-collaboration.test.ts`.
   - Update `node-agent-tools.test.ts` for `NodeExecution` usage.
   - Update prompt assertion tests in `task-agent.test.ts`.

**Acceptance criteria:**
- `report_workflow_done` completely removed.
- Node agent tools use `NodeExecution` for state management.
- Task agent tools use `NodeExecution` for session tracking.
- All tests pass, lint passes (no dead imports/exports).

**Dependencies:** Task 4, Task 5

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 7: Agent and utility cleanup

**Description:** Remove `SpaceAgent.role` and related utilities, remove `WorkflowNode.agentId` shorthand handling, clean up `resolveNodeAgents()`.

**Agent type:** coder

**Subtasks:**

1. **Remove `SpaceAgent.role` usage:**
   - Remove `getFeaturesForRole()` from `packages/daemon/src/lib/space/agents/seed-agents.ts` (or update to use `tools[]` array instead).
   - Remove `resolveTaskTypeForAgent()` from `channel-router.ts` and `space-runtime.ts` — task type is no longer needed since `node_executions` don't have a `taskType` field.
   - Remove `getRoleLabel()` usage.
   - Update `custom-agent.ts` to not reference `role`.

2. **Remove `WorkflowNode.agentId` shorthand:**
   - Update `resolveNodeAgents()` in `space-utils.ts`: remove the `agentId` fallback path. Expect `agents[]` to always be present.
   - Update all callers of `resolveNodeAgents()` (20+ call sites in daemon runtime).
   - Update `space_workflow_nodes` DB handling to not read/write `agent_id` column.

3. **Remove `SpaceAgent.injectWorkflowContext`:**
   - Remove from `neo-query-tools` display logic.
   - Remove from repository mapping.

4. **Unit tests:**
   - Update `seed-agents.test.ts`, `custom-agent.test.ts` for role removal.
   - Update any tests that use `resolveNodeAgents()` with `agentId` shorthand.

**Acceptance criteria:**
- `SpaceAgent.role`, `toolConfig`, `injectWorkflowContext` fully removed.
- `WorkflowNode.agentId` shorthand fully removed — only `agents[]` accepted.
- `resolveNodeAgents()` simplified.
- All tests pass, lint passes (no dead exports via knip check).

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 8: Built-in workflow templates

**Description:** Update built-in workflow templates for new schema: add `endNodeId`, remove `agentId` shorthand, ensure `agents[]` array format.

**Agent type:** coder

**Subtasks:**

1. In `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`:
   - `CODING_WORKFLOW`: add `endNodeId: CODING_DONE_STEP`. Ensure all nodes use `agents: [...]` not `agentId`.
   - `CODING_WORKFLOW_V2`: add `endNodeId: V2_DONE_STEP`.
   - `RESEARCH_WORKFLOW`: add `endNodeId: RESEARCH_GENERAL_STEP`. Add comment: `// Terminal in current 2-node topology; update endNodeId if topology changes`.
   - `REVIEW_ONLY_WORKFLOW`: add `endNodeId: REVIEW_CODER_STEP`. Add comment: `// Single-node workflow — start and end are the same node`. This is intentional and valid.
2. In `seedBuiltInWorkflows()`, add `endNodeId` mapping through `nodeIdMap`. Use non-null assertion (`!`) consistent with `startNodeId` — throws on mismatch.
3. Remove any `config`, `rules`, `maxIterations`, `isDefault` from template definitions.
4. Update tests in `built-in-workflows.test.ts`:
   - Assert each template has `endNodeId` set and references a valid node.
   - Assert `REVIEW_ONLY_WORKFLOW` has `startNodeId === endNodeId`.
   - Assert all nodes use `agents[]` not `agentId`.

**Acceptance criteria:**
- All templates define `endNodeId` and use `agents[]` format.
- Deprecated fields removed from templates.
- All tests pass.

**Dependencies:** Task 1, Task 3, Task 7

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 9: Export/import format updates

**Description:** Update export/import to handle new schema: `endNode`, removed fields, `agents[]` format, `NodeExecution` data.

**Agent type:** coder

**Subtasks:**

1. **Export format** (`packages/daemon/src/lib/space/export-format.ts`):
   - Add `endNode` mapping (UUID → name), optional.
   - Remove export of `rules`, `config`, `maxIterations`, `isDefault` from workflow export.
   - Remove `role`, `toolConfig`, `injectWorkflowContext` from agent export.
   - Ensure node export uses `agents[]` not `agentId`.
2. **Import handling** (`space-export-import-handlers.ts`):
   - Resolve `endNode` name → UUID on import.
   - Handle importing legacy exports that have `agentId` on nodes: convert to `agents[]` during import.
   - Handle importing legacy exports with old status values: map to new values.
3. **Tests:**
   - Update `export-format.test.ts` and `export-import-round-trip.test.ts`.
   - Add test for legacy export import (backward compat).

**Acceptance criteria:**
- Export includes `endNode` when set; omits deprecated fields.
- Import handles both new and legacy export formats.
- Round-trip preserves all data.

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 10: Visual editor and form editor updates

**Description:** Update frontend editors for new schema: `endNodeId` support, removed fields.

**Agent type:** coder

**Subtasks:**

1. **Visual editor serialization** (`serialization.ts`):
   - Add `endNodeId` to `VisualEditorState`, `workflowToVisualState()`, `buildWorkflowFields()`, `visualStateToCreateParams()`, `visualStateToUpdateParams()`.
   - Remove `agentId` shorthand handling — always use `agents[]`.
   - Remove deprecated fields from serialization.
2. **Visual editor UI** (`VisualWorkflowEditor.tsx`):
   - Add `endNodeId` state, wire to serialization.
   - Pass to `NodeConfigPanel`.
3. **NodeConfigPanel** (`NodeConfigPanel.tsx`):
   - Add "Set as End Node" button (parallel to "Set as Start Node").
   - Show "END" badge on end nodes.
4. **WorkflowEditor (form-based)** (`WorkflowEditor.tsx`):
   - Pass `endNodeId` in create/update params. For new workflows, default to last node. For updates, preserve existing. Add comment: `// Heuristic for new workflows: defaults to last node — use the visual editor for explicit control`.
   - Remove deprecated field inputs.
5. **Tests:**
   - Serialization test for `endNodeId` round-trip.
   - NodeConfigPanel "Set as End Node" button test.

**Acceptance criteria:**
- `endNodeId` supported in both editors.
- Deprecated fields removed from UI.
- All frontend tests pass.

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 11: Workflow manager validation and RPC handlers

**Description:** Add `endNodeId` validation, update RPC handlers for new schema.

**Agent type:** coder

**Subtasks:**

1. **Workflow manager validation** (`space-workflow-manager.ts`):
   - Validate `endNodeId` references a valid node on create/update.
   - Remove validation of deprecated fields.
2. **RPC handler updates:**
   - **Verification:** Confirm `spaceWorkflow.create` and `spaceWorkflow.update` handlers pass `endNodeId` through (current handlers use cast/spread — no whitelist).
   - Update any RPC handlers that reference removed fields (`goalId`, `config`, `failureReason`, etc.).
   - Add RPC handlers for `nodeExecution.list` (by run ID) if needed for frontend display.
3. **Tests:**
   - Validation tests: valid/invalid `endNodeId`, `null` to clear.
   - RPC passthrough regression test for `spaceWorkflow.create` with `endNodeId`.

**Acceptance criteria:**
- `endNodeId` validated at create/update.
- RPC handlers updated for new schema.
- All tests pass.

**Dependencies:** Task 1, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 12: Integration tests

**Description:** End-to-end integration tests for the complete end-node completion flow and schema cleanup.

**Agent type:** coder

**Subtasks:**

1. **Extend** `space-runtime-completion.test.ts` with new integration scenarios:
   - Workflow with `endNodeId`: end node execution `done` → `processRunTick` → run `done`.
   - Non-end node completes but end node still running → run stays `in_progress`.
   - Workflow without `endNodeId` → all-executions-done behavior (backward compat).
   - End node execution `blocked` → run escalates to `blocked`.
   - End node execution not yet created → run stays `in_progress`.
   - Orchestration task auto-completed when run completes (if `in_progress`).
   - Orchestration task in `open` state at completion → skipped, no throw.
2. Verify no existing integration tests rely on `report_workflow_done`.
3. Verify `NodeExecution` creation/completion flow works end-to-end through runtime.

**Acceptance criteria:**
- Full lifecycle proven: node `report_done` → execution `done` → tick → run `done`.
- Backward compat: workflows without `endNodeId` still complete.
- Schema cleanup doesn't break any existing test patterns.

**Dependencies:** Task 4, Task 5, Task 6, Task 11

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Dependency Graph

```
Task 1 (types)
├── Task 2 (migrations) → Task 3 (repositories) → Task 4 (managers/CompletionDetector)
│                                                  → Task 5 (runtime) → Task 6 (agent tools)
│                                                  → Task 7 (agent/utility cleanup) → Task 8 (templates)
│                                                  → Task 9 (export/import)
│                                                  → Task 10 (frontend editors)
│                                                  → Task 11 (validation/RPC)
│                                                  └── Task 12 (integration tests) ← Tasks 4,5,6,11
```

Parallelizable after Task 3: Tasks 7, 9, 10, 11 can run concurrently. Tasks 4, 5 are sequential. Task 6 depends on 4+5. Task 8 depends on 7. Task 12 depends on 4+5+6+11.
