# Milestone 4: Workflow Runtime Engine

## Goal

Build `SpaceRuntime` — a new workflow-first orchestration engine — and `WorkflowExecutor` to manage goal-level step sequences, gate evaluation, and rule injection within Spaces. All code lives in `packages/daemon/src/lib/space/runtime/`. No modifications to `RoomRuntime` or any existing runtime code.

## Isolation Checklist

- `WorkflowExecutor` in `packages/daemon/src/lib/space/runtime/workflow-executor.ts`
- `SpaceRuntime` in `packages/daemon/src/lib/space/runtime/space-runtime.ts`
- `SpaceRuntimeService` in `packages/daemon/src/lib/space/runtime/space-runtime-service.ts`
- Gate allowlist in `packages/daemon/src/lib/space/runtime/gate-allowlist.ts`
- All types use `SpaceTask`, `SpaceGoal`, `SpaceWorkflow`, `SpaceAgent` (NOT `NeoTask`, `RoomGoal`, `Workflow`)
- No modifications to `RoomRuntime`, `TaskGroupManager`, `room-runtime-service.ts`, `room-manager.ts`, or any file under `packages/daemon/src/lib/room/`

## Key Architecture: Workflow-First Orchestration

`SpaceRuntime` is a **new class** that manages the full lifecycle of goals within a Space. Unlike `RoomRuntime` which has a hardcoded planner→coder→leader flow with workflows bolted on, `SpaceRuntime` is designed from the ground up for workflow-driven orchestration.

The `WorkflowExecutor` operates at the **goal level**:
1. A `SpaceGoal` has an associated `SpaceWorkflow`
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
- Backward compatibility for spaces without workflows
- Unit and integration tests

---

### Task 4.1: WorkflowExecutor Core

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.2, Task 2.3

**Description:**

Create the `WorkflowExecutor` class that manages goal-level workflow progression within Spaces.

**Subtasks:**

1. Create `packages/daemon/src/lib/space/runtime/workflow-executor.ts`:
   - `WorkflowExecutor` class with:
     - Constructor takes: `workflow: SpaceWorkflow`, `goalId: string`, `currentStepIndex: number`, `taskManager: SpaceTaskManager`, `goalManager: SpaceGoalManager`, `agentManager: SpaceAgentManager`, `workspacePath: string`
     - `currentStepIndex` enables **restart rehydration**: when creating from persisted state, pass step index derived from latest task's `workflowStepId`. For new goals, pass `0`.
     - `getCurrentStep(): WorkflowStep | null`
     - `getNextStep(): WorkflowStep | null`
     - `canAdvance(): Promise<{ allowed: boolean; reason?: string }>` — evaluates current step's exit gate
     - `advance(): Promise<{ step: WorkflowStep; tasks: SpaceTask[] }>` — increments step, **creates `SpaceTask` DB records only** (pending status), persists `workflowStepId` on new tasks. Does NOT spawn session groups.
     - `isComplete(): boolean`

2. Track workflow state:
   - `space_goals.workflow_id` associates goals with workflows
   - Current step tracked via latest task's `workflow_step_id` in `space_tasks`
   - `currentStepIndex` is in-memory; persisted via task metadata

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
   - Multi-step goal progression using `SpaceGoal`/`SpaceTask`/`SpaceWorkflow` types
   - All gate types evaluated correctly
   - Security: reject non-allowlisted commands, reject path traversal
   - Timeout enforcement (mock Bun.spawn)
   - Retry logic (re-evaluate gate, not re-run step)
   - Completion detection, error handling

**Acceptance criteria:**
- `WorkflowExecutor` advances goals through step sequences
- All types are Space types (`SpaceTask`, `SpaceGoal`, `SpaceWorkflow`, `SpaceAgentManager`)
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

Build `SpaceRuntime` — the workflow-first orchestration engine for Spaces. This is a **new class** in `packages/daemon/src/lib/space/runtime/space-runtime.ts` that manages the full lifecycle of goals within a Space: workflow resolution, task creation, session group management (via `space_session_groups`), step advancement, and gate enforcement. It does NOT modify `RoomRuntime`.

**Subtasks:**

1. Create `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - `SpaceRuntimeConfig` includes: `SpaceManager`, `SpaceTaskManager`, `SpaceGoalManager`, `SpaceWorkflowManager`, `SpaceAgentManager`, `SpaceSessionGroupRepository`, and `WorkflowExecutor` factory
   - Maintain `Map<goalId, WorkflowExecutor>` for active workflows
   - Implement `executeTick()` method — the main orchestration loop

2. **Executor rehydration on startup** (restart safety):
   - Implement `rehydrateExecutors()` async method called **at the start of the first `executeTick()`** (not in constructor — constructor is synchronous, async work deferred to first tick)
   - Query all in-progress `SpaceGoal` records with non-null `workflow_id` from `space_goals`
   - Reconstruct executors: load `SpaceWorkflow`, determine `currentStepIndex` from latest `SpaceTask`'s `workflow_step_id`, create executor
   - Set `rehydrated: boolean` flag to prevent repeat runs

3. **Workflow resolution** for new goals:
   - When `SpaceGoal` created/started, check `goal.workflowId`
   - If none, check space's default workflow via `SpaceWorkflowManager.getDefaultWorkflow(spaceId)`
   - If found, create `WorkflowExecutor` with `currentStepIndex: 0`
   - Store in executor map

4. **Guard against incorrect planning dispatch**:
   - Goals managed by a `WorkflowExecutor` must NOT be dispatched to a generic planning path
   - Only the executor decides when to spawn planning tasks (via `advance()` when `agentRef === 'planner'`)
   - Check: if goal has executor in map (or `goal.workflowId != null`), skip generic planning

5. **Task-type assignment for workflow steps**:
   - `agentRef: 'planner'` → `taskType: 'planning'`, uses planning group path with draft promotion
   - `agentRef: 'coder'|'general'` → `taskType: 'coding'`, status `pending`, standard execution queue
   - Custom agent (`agentRefType: 'custom'`) → `taskType: 'coding'`, `customAgentId` set, status `pending`
   - Helper: `resolveTaskTypeForStep(step: WorkflowStep): 'planning' | 'coding'`

6. **Step advancement and gate enforcement** (goal completion path):
   - After task completes (Leader approves), check if goal has executor
   - If yes: `executor.canAdvance()` → evaluate exit gate
   - Gate passes → `executor.advance()` → creates next step's `SpaceTask` records
   - Gate requires human approval → pause with flag
   - Gate fails after retries → task → `needs_attention`
   - All steps complete → mark `SpaceGoal` as complete

7. **Rule injection** into agent prompts:
   - When building worker config for a workflow task, check current step for rules
   - Filter by `rule.appliesTo` matching current step's **ID** (empty = all steps)
   - Append rules to system prompt

8. **Executor cleanup** (memory leak prevention):
   - Remove from map when: goal completes, fails, is cancelled/archived
   - Hook into `SpaceGoal` state change handlers

9. **Wire `seedDefaultWorkflow`** from Task 3.4:
   - In `SpaceManager.createSpace()` (or the `space.create` RPC handler), call `seedDefaultWorkflow()`
   - Idempotent: safe if space already has a workflow
   - **This is in `SpaceManager`** — NOT in `room-manager.ts`

10. **Backward compatibility**:
    - Spaces without workflows use a simple default behavior (direct planner→coder flow without executor)
    - Regression test: verify default flow works when no workflow configured

11. Write integration tests:
    - `SpaceGoal` → workflow resolution → executor created
    - First step `SpaceTask` records created with correct agent and task-type
    - Planning-step tasks use planning group path + draft promotion
    - Coding-step tasks created as pending
    - Custom-agent tasks have `customAgentId` set
    - **Planning guard**: workflow goal with non-planner first step does NOT trigger generic planning
    - Exit gates checked between steps, entry gates before step
    - Rules injected into agent prompts per step
    - Human approval gate pauses correctly
    - Gate failure → `needs_attention`
    - **Rehydration**: clear map, reinitialize, verify resume from correct step
    - **Cleanup**: executor removed after goal completion/failure/cancellation
    - Regression: goals without workflows work normally

**Acceptance criteria:**
- `SpaceRuntime` is a new class that manages full workflow lifecycle for `SpaceGoal`s
- All operations use Space tables (`space_tasks`, `space_goals`, `space_session_groups`) — NOT existing Room tables
- Workflow resolution works: explicit, space-default, and no-workflow cases
- Planning guard prevents spurious planning for non-planner-first workflows
- Executors rehydrated on startup, cleaned up on completion
- `advance()` creates `SpaceTask` DB records only; tick loop handles group spawning
- `seedDefaultWorkflow` wired into `SpaceManager.createSpace()` (NOT `room-manager.ts`)
- Non-workflow goals unaffected
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

4. Multi-step goal lifecycle:
   - `SpaceGoal` remains `in_progress` until final step completes
   - Track `goalId → step → [SpaceTask records]` relationship
   - Any step failure (gate fails after retries) → goal → `needs_attention`

5. Wire `SpaceRuntimeService` into `DaemonAppContext`:
   - Add as dependency alongside existing `RoomRuntimeService`
   - **No modifications to `RoomRuntimeService`** — just add `SpaceRuntimeService` as an additional registration

6. Write unit tests:
   - Runtime creation/disposal
   - Group metadata includes workflow info
   - Multi-step goal tracking
   - Failure in middle step surfaces correctly

**Acceptance criteria:**
- `SpaceRuntimeService` manages `SpaceRuntime` instances
- Session groups (in `space_session_groups`) expose workflow metadata
- Task events include step progression info
- Multi-step goal lifecycle managed correctly
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
