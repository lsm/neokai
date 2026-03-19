# Milestone 4: Workflow Runtime Engine

## Goal

Build `SpaceRuntime` — a new workflow-first orchestration engine — and `WorkflowExecutor` to manage workflow run step sequences, gate evaluation, and rule injection within Spaces. All code lives in `packages/daemon/src/lib/space/runtime/`. No modifications to `RoomRuntime` or any existing runtime code.

## Isolation Checklist

- `WorkflowExecutor` in `packages/daemon/src/lib/space/runtime/workflow-executor.ts`
- `SpaceRuntime` in `packages/daemon/src/lib/space/runtime/space-runtime.ts`
- `SpaceRuntimeService` in `packages/daemon/src/lib/space/runtime/space-runtime-service.ts`
- Gate allowlist in `packages/daemon/src/lib/space/runtime/gate-allowlist.ts`
- All types use `SpaceTask`, `SpaceWorkflowRun`, `SpaceWorkflow`, `SpaceAgent` (NOT `NeoTask`, `RoomGoal`, `Workflow`)
- No modifications to `RoomRuntime`, `TaskGroupManager`, `room-runtime-service.ts`, `room-manager.ts`, or any file under `packages/daemon/src/lib/room/`

## Key Architecture: Workflow Run Orchestration

`SpaceRuntime` is a **new class** that manages the full lifecycle of workflow runs and tasks within a Space. Unlike `RoomRuntime` which has a hardcoded planner→coder→leader flow, `SpaceRuntime` is designed from the ground up for workflow-driven orchestration.

The `WorkflowExecutor` operates on **workflow runs** (not goals):
1. A `SpaceWorkflowRun` represents an active execution of a workflow
2. Each step produces `SpaceTask` records. `advance()` **creates task DB records only** (pending status) — it does NOT spawn session groups. The tick loop handles group spawning.
3. Each task still gets a Worker + Leader group pair (using `space_session_groups`/`space_session_group_members`)
4. When a step's tasks complete (Leader approves), the executor evaluates the exit gate and advances
5. Custom agents with `role: 'reviewer'` are specialized Workers, NOT Leader replacements

## Scope

- `WorkflowExecutor` class with gate evaluation and step progression
- `SpaceRuntime` class with workflow-driven tick loop
- `SpaceRuntimeService` for lifecycle management
- Gate security enforcement
- Rule injection into agent prompts
- Backward compatibility for spaces without workflows (standalone tasks)
- Unit and integration tests

---

### Task 4.1: WorkflowExecutor Core

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.2, Task 2.3

**Description:**

Create the `WorkflowExecutor` class that manages workflow run progression within Spaces.

**Subtasks:**

1. Create `packages/daemon/src/lib/space/runtime/workflow-executor.ts`:
   - `WorkflowExecutor` class with:
     - Constructor takes: `workflow: SpaceWorkflow`, `run: SpaceWorkflowRun`, `taskManager: SpaceTaskManager`, `workflowRunRepo: SpaceWorkflowRunRepository`, `agentManager: SpaceAgentManager`, `workspacePath: string`
     - The `run.currentStepIndex` enables **restart rehydration**: when creating from persisted state, the run already contains the correct step index. For new runs, it starts at `0`.
     - `getCurrentStep(): WorkflowStep | null`
     - `getNextStep(): WorkflowStep | null`
     - `canAdvance(): Promise<{ allowed: boolean; reason?: string }>` — evaluates current step's exit gate
     - `canEnterStep(stepIndex: number): Promise<{ allowed: boolean; reason?: string }>` — evaluates the target step's **entry gate** (if any). Called by `advance()` before entering the next step, and by `SpaceRuntime` before starting the first step of a new run.
     - `advance(): Promise<{ step: WorkflowStep; tasks: SpaceTask[] }>` — evaluates exit gate of current step, then evaluates **entry gate** of next step; increments step index (persisted on `SpaceWorkflowRun`), **creates `SpaceTask` DB records only** (pending status), sets `workflowRunId` and `workflowStepId` on new tasks. Does NOT spawn session groups.
     - `isComplete(): boolean`

2. Track workflow state:
   - `space_workflow_runs.current_step_index` tracks which step the run is on (persisted)
   - `space_tasks.workflow_run_id` links tasks to their run
   - `space_tasks.workflow_step_id` links tasks to the specific step that created them

3. Gate evaluation with security enforcement:
   - `evaluateGate(gate: WorkflowGate, context: GateContext): Promise<GateResult>`
   - Gate types:
     - `auto`: always passes
     - `human_approval`: checks approval flag
     - `quality_check`: runs **allowlisted command only** with timeout via `Bun.spawn`
     - `pr_review`: reuses existing PR review pattern (can import utility functions)
     - `custom`: validates relative path (no `..`, no absolute), runs with timeout
   - **Timeout**: `gate.timeoutMs` (default: 60000ms, max: 300000ms)
   - **Retry**: On failure, if `maxRetries > 0` and retries remain, re-evaluate gate only (NOT re-run agent). After exhaustion → `needs_attention`.

4. Quality check command allowlist:
   - Create `packages/daemon/src/lib/space/runtime/gate-allowlist.ts`
   - Default: `['bun run check', 'bun test', 'bun run lint', 'bun run typecheck', 'bun run format:check']`

5. Write unit tests:
   - Multi-step workflow run progression using `SpaceWorkflowRun`/`SpaceTask`/`SpaceWorkflow` types
   - All gate types evaluated correctly
   - Security: reject non-allowlisted commands, reject path traversal
   - Timeout enforcement (mock Bun.spawn)
   - Retry logic (re-evaluate gate, not re-run step)
   - Completion detection, error handling

**Acceptance criteria:**
- `WorkflowExecutor` advances workflow runs through step sequences
- All types are Space types (`SpaceTask`, `SpaceWorkflowRun`, `SpaceWorkflow`, `SpaceAgentManager`)
- All gate types evaluated with security enforcement
- Non-allowlisted commands rejected, path traversal rejected
- Timeout enforced on shell-executing gates
- Retry re-evaluates gate only
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4.2: SpaceRuntime — Workflow Resolution, Task Spawning, and Step Advancement

**Agent:** coder
**Priority:** high
**Depends on:** Task 4.1

**Description:**

Build `SpaceRuntime` — the workflow-first orchestration engine for Spaces. This is a **new class** in `packages/daemon/src/lib/space/runtime/space-runtime.ts` that manages workflow runs and standalone tasks: creating runs, spawning tasks per step, managing session groups (via `space_session_groups`), advancing steps, and enforcing gates. It does NOT modify `RoomRuntime`.

**Subtasks:**

1. Create `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - `SpaceRuntimeConfig` includes: `SpaceManager`, `SpaceTaskManager`, `SpaceWorkflowManager`, `SpaceAgentManager`, `SpaceWorkflowRunRepository`, `SpaceSessionGroupRepository`, and `WorkflowExecutor` factory
   - Maintain `Map<runId, WorkflowExecutor>` for active workflow runs
   - Implement `executeTick()` method — the main orchestration loop

2. **Executor rehydration on startup** (restart safety):
   - Implement `rehydrateExecutors()` async method called **at the start of the first `executeTick()`** (not in constructor — constructor is synchronous, async work deferred to first tick)
   - Query all in-progress `SpaceWorkflowRun` records (status = `in_progress`) from `space_workflow_runs`
   - Reconstruct executors: load `SpaceWorkflow`, create executor with the persisted `currentStepIndex` from the run record
   - Set `rehydrated: boolean` flag to prevent repeat runs

3. **Starting a workflow run**:
   - `startWorkflowRun(spaceId, workflowId, title, description?)` → creates `SpaceWorkflowRun` record, creates `WorkflowExecutor`, evaluates entry gate of first step, creates first step's `SpaceTask` records
   - `workflowId` is always required — the AI agent calls `list_workflows` and decides before calling this method. No default-workflow fallback.
   - Store executor in map

4. **Standalone tasks** (no workflow):
   - Tasks can be created directly without a workflow run (`workflowRunId` = null)
   - These enter the standard execution queue and are processed normally
   - No executor needed — they behave like regular tasks

5. **Task-type assignment for workflow steps**:
   - `agentRef: 'planner'` → `taskType: 'planning'`, uses planning group path with draft promotion
   - `agentRef: 'coder'|'general'` → `taskType: 'coding'`, status `pending`, standard execution queue
   - Custom agent (`agentRefType: 'custom'`) → `taskType: 'coding'`, `customAgentId` set, status `pending`
   - Helper: `resolveTaskTypeForStep(step: WorkflowStep): 'planning' | 'coding'`

6. **Step advancement and gate enforcement**:
   - After task completes (Leader approves), check if task belongs to a workflow run (via `workflowRunId`)
   - If yes: check if all tasks for the current step are complete
   - If all step tasks complete: `executor.canAdvance()` → evaluate exit gate
   - Gate passes → `executor.advance()` → creates next step's `SpaceTask` records
   - Gate requires human approval → pause run with flag
   - Gate fails after retries → run → `needs_attention`
   - All steps complete → mark `SpaceWorkflowRun` as complete

7. **Rule injection** into agent prompts:
   - When building worker config for a workflow task, check current step for rules
   - Filter by `rule.appliesTo` matching current step's **ID** (empty = all steps)
   - Append rules to system prompt

8. **Executor cleanup** (memory leak prevention):
   - Remove from map when: run completes, fails, is cancelled
   - Hook into `SpaceWorkflowRun` status change handlers

9. **Wire `seedBuiltInWorkflows`** from Task 3.4:
   - Call in the `space.create` RPC handler (in `space-handlers.ts`), **after** `SpaceManager.createSpace()` returns — the handler has access to both `SpaceManager` and `SpaceWorkflowManager`, whereas `SpaceManager` itself is constructed without workflow manager dependency
   - Seeds all three built-in workflow templates so the AI agent has workflows to choose from
   - Idempotent: safe if space already has workflows
   - **This is in the Space RPC handler** — NOT in `room-manager.ts`

10. Write integration tests:
    - Start workflow run → executor created → first step tasks created
    - First step `SpaceTask` records created with correct agent and task-type
    - Planning-step tasks use planning group path + draft promotion
    - Coding-step tasks created as pending
    - Custom-agent tasks have `customAgentId` set
    - Standalone tasks (no workflow) work normally
    - Exit gates checked between steps; entry gates evaluated before entering each step (including first step via `canEnterStep(0)`)
    - Rules injected into agent prompts per step
    - Human approval gate pauses run correctly
    - Gate failure → `needs_attention` on run
    - **Rehydration**: clear map, reinitialize, verify in-progress runs resume from correct step
    - **Cleanup**: executor removed after run completion/failure/cancellation

**Acceptance criteria:**
- `SpaceRuntime` is a new class that manages workflow runs and standalone tasks
- All operations use Space tables (`space_tasks`, `space_workflow_runs`, `space_session_groups`) — NOT existing Room tables
- Workflow runs are the unit of orchestration (not goals)
- Standalone tasks work without a workflow
- Executors rehydrated on startup, cleaned up on completion
- `advance()` creates `SpaceTask` DB records only; tick loop handles group spawning
- `seedBuiltInWorkflows` wired into `space.create` RPC handler (NOT `room-manager.ts`)
- Integration tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4.3: SpaceRuntimeService and Task/Group Lifecycle

**Agent:** coder
**Priority:** high
**Depends on:** Task 4.2

**Description:**

Build `SpaceRuntimeService` for managing `SpaceRuntime` lifecycle, and configure session group metadata for workflow tracking.

**Subtasks:**

1. Create `packages/daemon/src/lib/space/runtime/space-runtime-service.ts`:
   - `createOrGetRuntime(spaceId: string): SpaceRuntime`
   - `stopRuntime(spaceId: string): void`
   - Manage runtime instances per space
   - Handle startup/shutdown lifecycle

2. Update `SpaceSessionGroupRepository` metadata:
   - `workflowId` and `currentStepId` in group metadata
   - Groups expose workflow context for UI display

3. Task status events with workflow context:
   - `space.task.updated` events include `workflowStepName` for UI display
   - Frontend can show "Step 2/3: Code Review"

4. Multi-step workflow run lifecycle:
   - `SpaceWorkflowRun` remains `in_progress` until final step completes
   - Track `runId → step → [SpaceTask records]` relationship
   - Any step failure (gate fails after retries) → run → `needs_attention`

5. Create RPC handler for starting workflow runs in `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts`:
   - `spaceWorkflowRun.start { spaceId, workflowId, title, description? }` → `{ run: SpaceWorkflowRun }`:
     - `workflowId` is **required** — the AI agent always provides one (via `list_workflows` + its own reasoning). No default-workflow fallback.
     - Validate `workflowId` exists in the space (error if not found)
     - Creates `SpaceWorkflowRun` record via `SpaceWorkflowRunRepository`
     - Calls `SpaceRuntimeService.createOrGetRuntime(spaceId)` then `runtime.startWorkflowRun()` to create the executor and first step's tasks
     - Emits `space.workflowRun.created` event
   - `spaceWorkflowRun.list { spaceId, status? }` → `{ runs: SpaceWorkflowRun[] }`
   - `spaceWorkflowRun.get { id }` → `{ run: SpaceWorkflowRun }`
   - `spaceWorkflowRun.cancel { id }` → `{ success }` — cancels run and all pending tasks
   - Wire in `packages/daemon/src/lib/rpc-handlers/index.ts` (via `setupRPCHandlers()`)

6. Wire `SpaceRuntimeService` into `DaemonAppContext`:
   - Add as dependency alongside existing `RoomRuntimeService`
   - **No modifications to `RoomRuntimeService`** — just add `SpaceRuntimeService` as an additional registration

7. Write unit tests:
   - Runtime creation/disposal
   - Group metadata includes workflow info
   - Multi-step run tracking
   - Failure in middle step surfaces correctly

**Acceptance criteria:**
- `SpaceRuntimeService` manages `SpaceRuntime` instances
- `spaceWorkflowRun.start` RPC handler creates run and triggers first step task creation
- Session groups (in `space_session_groups`) expose workflow metadata
- Task events include step progression info
- Multi-step workflow run lifecycle managed correctly
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
