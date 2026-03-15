# Milestone 4: Workflow Runtime Engine

## Goal

Build a goal-level workflow executor that orchestrates agent step sequences while preserving the existing Leader/Worker group model. The executor reads `Workflow` definitions from the data layer and manages step progression, gate evaluation, and rule injection.

## Key Architecture: Goal-Level Orchestration with Preserved Leader/Worker Pairs

The `WorkflowExecutor` operates at the **goal level**, not the task level:

1. A goal has an associated workflow (e.g., Planner -> Coder -> Security Reviewer)
2. Each workflow step produces **tasks**. The executor creates tasks for the current step's agent.
3. Each task still gets a **Worker + Leader group pair**. The Leader reviews the Worker's output via the existing `submit_for_review` -> `complete_task` / `send_to_worker` cycle.
4. When a step's tasks complete (Leader approves), the executor evaluates the **exit gate** and, if passed, advances to the next step (creating new tasks for the next agent).
5. Custom agents with `role: 'reviewer'` are specialized Workers (e.g., produce a security audit), NOT replacements for the Leader. The Leader still approves/rejects their output.

**What changes in `RoomRuntime`:**
- `onWorkerTerminalState` / `onLeaderTerminalState` remain unchanged within a group
- After a task completes (Leader approves via `complete_task`), the goal-level completion path checks the `WorkflowExecutor` to decide whether to advance to the next step or mark the goal as complete
- The existing `submittedForReview` / `approved` / `feedbackIteration` semantics are unchanged per group

**What does NOT change:**
- Worker/Leader pair creation in `TaskGroupManager`
- `createLeaderCallbacks()` and Leader tool contract (`complete_task` must follow `submit_for_review`)
- The `onWorkerTerminalState` -> Leader routing flow
- Non-workflow tasks (fallback to existing hardcoded behavior)

## Scope

- New `WorkflowExecutor` class that interprets workflow step sequences at the goal level
- Integration with existing `RoomRuntime` goal completion path
- Gate evaluation logic with security enforcement (auto, human_approval, quality_check, pr_review, custom)
- Rule injection into agent system prompts
- Backward compatibility: rooms without a custom workflow use the default built-in behavior
- Unit and online tests

---

### Task 4.1: WorkflowExecutor Core

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.3, Task 2.3

**Description:**

Create the `WorkflowExecutor` class that manages the progression of a goal through workflow steps.

**Subtasks:**

1. Create `packages/daemon/src/lib/room/runtime/workflow-executor.ts`:
   - `WorkflowExecutor` class with:
     - Constructor takes: `workflow: Workflow`, `goalId: string`, `currentStepIndex: number`, `taskManager: TaskManager`, `goalManager: GoalManager`, `customAgentManager: CustomAgentManager`, `workspacePath: string`
     - `currentStepIndex` enables **restart rehydration**: when creating an executor from persisted state, pass the step index derived from the latest task's `current_workflow_step_id`. For new goals, pass `0`.
     - `getCurrentStep(): WorkflowStep | null` -- returns `workflow.steps[currentStepIndex]`
     - `getNextStep(): WorkflowStep | null` -- returns the next step in sequence
     - `canAdvance(): Promise<{ allowed: boolean; reason?: string }>` -- evaluates the current step's exit gate
     - `advance(): Promise<{ step: WorkflowStep; tasks: NeoTask[] }>` -- moves to the next step, increments `currentStepIndex`, creates tasks for the next agent, persists `current_workflow_step_id` on the new tasks
     - `isComplete(): boolean` -- returns true if all steps have been executed and gates passed
   - **`GoalManager` dependency**: needed by `advance()` to read goal state (e.g., check goal is still active) and by `isComplete()` to verify goal status. If the executor only needs read access, `GoalRepository` can be used directly instead.

2. Track workflow state on the goal:
   - Use `goals.workflow_id` (added in consolidated Migration B) to associate goals with workflows
   - Track current step via task metadata (latest task's `current_workflow_step_id`)
   - The `currentStepIndex` in the executor is the in-memory representation; the persisted representation is `current_workflow_step_id` on the latest task for the goal

3. Implement gate evaluation with security enforcement:
   - `evaluateGate(gate: WorkflowGate, context: GateContext): Promise<GateResult>`
   - `GateContext` includes: `workspacePath`, `goalId`, `taskId`, `lastTaskSummary`, etc.
   - Gate types:
     - `auto`: always passes
     - `human_approval`: checks approval flag (reuses existing pattern from `submittedForReview`/`approved`)
     - `quality_check`: runs command from **allowlist only** (e.g., `bun run check`, `bun test`) with timeout enforcement. Reject any command not in the allowlist.
     - `pr_review`: reuses existing `runWorkerExitGate` logic from lifecycle-hooks.ts
     - `custom`: validates command is a relative path within workspace (no `..`, no absolute paths), then runs with timeout via `Bun.spawn`. Logs command output for debugging.
   - **Timeout enforcement**: All shell-executing gates (`quality_check`, `custom`) use `gate.timeoutMs` (default: 60000ms, max: 300000ms) via `Bun.spawn`'s timeout option. On timeout, gate fails with a descriptive error.
   - **Retry logic**: On gate failure, if `gate.maxRetries > 0` and retries remain, re-evaluate the gate (do NOT re-run the agent step). After all retries exhausted, fail the gate and transition the task to `needs_attention`.

4. Define the quality check command allowlist:
   - Create `packages/daemon/src/lib/room/runtime/gate-allowlist.ts`
   - Default allowlist: `['bun run check', 'bun test', 'bun run lint', 'bun run typecheck', 'bun run format:check']`
   - Allowlist is configurable via room settings (future extensibility)

5. Write unit tests:
   - Step progression through a multi-step workflow at the goal level
   - Gate evaluation for each gate type
   - Gate security: reject non-allowlisted commands for quality_check, reject path traversal for custom gates
   - Timeout enforcement (mock Bun.spawn)
   - Retry logic (re-evaluate gate, not re-run step)
   - Workflow completion detection
   - Error handling (missing step, gate failure, timeout)

**Acceptance criteria:**
- `WorkflowExecutor` can advance a goal through a sequence of steps
- All gate types are evaluated correctly with security enforcement
- Non-allowlisted commands are rejected
- Path traversal in custom gates is rejected
- Timeout is enforced on all shell-executing gates
- Retry re-evaluates gate only (not agent step)
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4.2a: Integrate WorkflowExecutor into RoomRuntime — Workflow Resolution and Step Spawning

**Agent:** coder
**Priority:** high
**Depends on:** Task 4.1

**Description:**

Update `RoomRuntime` to resolve workflows for goals and spawn tasks using the `WorkflowExecutor`. This is the first part of the runtime integration, focused on workflow resolution and task creation.

**Subtasks:**

1. Add `WorkflowManager`, `GoalManager`, and `WorkflowExecutor` factory as dependencies in `RoomRuntimeConfig`

2. **Executor rehydration on runtime startup** (restart safety):
   - When `RoomRuntime` initializes, query all in-progress goals that have a non-null `workflow_id`
   - For each such goal, reconstruct a `WorkflowExecutor`:
     - Load the `Workflow` from `WorkflowManager`
     - Determine `currentStepIndex` from the latest task's `current_workflow_step_id` (find the step in the workflow by ID, get its `order` index)
     - Create the executor with `new WorkflowExecutor(workflow, goalId, currentStepIndex, ...)`
   - Populate the `Map<goalId, WorkflowExecutor>` with rehydrated executors
   - **Without this**, any in-progress workflow goal will stall after a server restart (no executor in the map) or restart from step 1 (spawning duplicate tasks)

3. Add workflow resolution logic in the goal processing path:
   - When a new goal is created or started, check if it has a `workflowId`
   - If no explicit `workflowId`, check room's default workflow
   - If a workflow is found, create a `WorkflowExecutor` instance for the goal with `currentStepIndex: 0`
   - Store in the `Map<goalId, WorkflowExecutor>` on the runtime

4. **Executor cleanup policy** (prevent memory leak):
   - Remove executor from the map when:
     - Goal completes (all steps done, goal marked complete)
     - Goal fails (goes to `needs_attention` after gate failure)
     - Goal is cancelled or archived
   - Hook into existing goal state change handlers for cleanup
   - Long-lived rooms with many processed goals must not accumulate stale executor entries

5. **Task-type assignment and planning/execution integration for workflow steps:**

   The existing `executeTick()` has a hard split between planning tasks and execution tasks:
   - Planning: `getNextGoalForPlanning()` → `spawnPlanningGroup()` creates a task with `taskType: 'planning'`. The planner's `create_task` tool creates draft children with `taskType: 'coding'`. On completion, `promoteDraftTasksIfPlanning()` promotes drafts to pending.
   - Execution: pending tasks with `taskType !== 'planning'` are picked up by the execution queue.

   For workflow steps, the executor must integrate with this split:
   - **Step with `agentRef: 'planner'` (builtin)**: Use the existing `spawnPlanningGroup()` path. Set `taskType: 'planning'` on the created task. Draft promotion still fires on completion. The planner's draft children inherit `workflowId` and `currentWorkflowStepId` from the parent planning task.
   - **Step with `agentRef: 'coder'` or `agentRef: 'general'` (builtin)**: Create tasks with `taskType: 'coding'` and `status: 'pending'` directly. These enter the standard execution queue.
   - **Step with custom agent (`agentRefType: 'custom'`)**: Create tasks with `taskType: 'coding'` and `customAgentId` set. Status: `pending`. The existing tick loop picks them up and resolves the custom agent (from Task 2.3).
   - **Key invariant**: `advance()` must set the correct `taskType` based on the step's `agentRef`. A helper function `resolveTaskTypeForStep(step: WorkflowStep): 'planning' | 'coding'` maps step agent refs to task types.

6. **Wire `seedDefaultWorkflow` call site** (from Task 3.5):
   - In `room-manager.ts` room creation path, call `seedDefaultWorkflow()` for new rooms
   - Idempotent: safe to call even if room already has a workflow

7. Backward compatibility:
   - If no workflow is associated with a goal/room, use the existing hardcoded behavior (no behavior change)
   - The existing `taskType` and `assignedAgent` fields continue to work as before
   - **Explicit regression test**: verify that the entire existing flow (goal -> planner -> coder -> leader) works identically when no workflow is configured

8. Write integration tests:
   - Goal with workflow resolves to WorkflowExecutor
   - First step tasks are created with correct agent and task-type assignment
   - Planning-step tasks use `spawnPlanningGroup()` path and draft promotion works
   - Coding-step tasks are created as pending with `taskType: 'coding'`
   - Custom-agent-step tasks are created with `customAgentId` set
   - **Rehydration test**: simulate restart (clear executor map, reinitialize) and verify in-progress workflow goals resume from correct step
   - **Cleanup test**: verify executor is removed from map after goal completion/failure/cancellation
   - Goals without workflows use existing behavior (regression test covering the full goal -> planner -> coder -> leader flow)

**Acceptance criteria:**
- Workflow resolution works for goals with explicit, room-default, and no workflows
- **Executors are rehydrated on runtime startup** — in-progress workflow goals resume from the correct step after restart
- **Executors are cleaned up** — no stale entries accumulate in the map
- Task creation uses the correct `taskType` based on workflow step agent ref (planning vs coding)
- Planning-type workflow steps integrate with `spawnPlanningGroup()` and draft promotion
- `seedDefaultWorkflow` is wired into room creation
- Existing non-workflow goals are completely unaffected (comprehensive regression test)
- Integration tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4.2b: Integrate WorkflowExecutor into RoomRuntime — Step Advancement and Gate Enforcement

**Agent:** coder
**Priority:** high
**Depends on:** Task 4.2a

**Description:**

Update the goal completion path in `RoomRuntime` to use `WorkflowExecutor` for gate evaluation and step advancement.

**Subtasks:**

1. Update the goal-level task completion handler:
   - After a task completes (Leader approves via `complete_task`), check if the goal has a `WorkflowExecutor`
   - If yes, call `executor.canAdvance()` to evaluate the current step's exit gate
   - If gate passes, call `executor.advance()` to create tasks for the next step
   - If gate requires human approval, set appropriate flag and pause
   - If gate fails (after retries), set task to `needs_attention`
   - If all steps complete, mark the goal as complete

2. Inject workflow rules into agent system prompts:
   - When building the `WorkerConfig` for a workflow task, check the current step for associated rules
   - Append applicable rules (filtered by `rule.appliesTo` matching the current step's **ID**) to the system prompt
   - Rules with empty `appliesTo` are injected for all steps

3. Write integration tests:
   - Run a goal through a 3-step workflow (plan -> code -> review)
   - Verify exit gates are checked between steps
   - Verify entry gates are checked before step starts
   - Verify rules are injected into agent prompts
   - Verify human approval gate pauses execution
   - Verify gate failure transitions to needs_attention

**Acceptance criteria:**
- Goals with workflows progress through steps when tasks complete
- Gates between steps are enforced (including security constraints)
- Rules are injected into agent prompts per step
- Human approval gates pause correctly
- Gate failures are handled gracefully
- Integration tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4.3: Workflow-Aware Task Status and Group Lifecycle

**Agent:** coder
**Priority:** normal
**Depends on:** Task 4.2b

**Description:**

Update task status tracking and group lifecycle to reflect workflow step progression in the UI and API.

**Subtasks:**

1. Update task and goal fields for workflow tracking:
   - `NeoTask.workflowId` and `NeoTask.currentWorkflowStepId` are already available from consolidated Migration B (Task 3.2)
   - Update `TaskRepository` to read/write these fields (update `rowToTask()` mapping, SQL INSERT/UPDATE statements)
   - Update `GoalRepository` to read/write `goals.workflow_id` (update `rowToGoal()` mapping, SQL INSERT/UPDATE statements)

2. Update `SessionGroup` and `TaskGroupMetadata`:
   - Add `workflowId` and `currentStepId` to `TaskGroupMetadata` in `session-group-repository.ts`
   - Also update `SessionGroup` (the public view) to expose `workflowId`/`currentStepId` since consumers use `group.workflowId`, not `group.metadata.workflowId`

3. Update task status events to include workflow context:
   - `room.task.update` events should include `workflowStepName` for UI display
   - The frontend can show "Step 2/3: Code Review" in the task view

4. Update `TaskSummary` to include workflow info:
   - Add `workflowStepName?: string` and `workflowTotalSteps?: number` to `TaskSummary`

5. Handle multi-step goal lifecycle:
   - A workflow goal spawns sequential sets of tasks (one set per step)
   - Track the relationship: `goalId -> step -> [task1, task2, ...]`
   - The goal remains `in_progress` until the final step completes
   - If any step fails (gate fails after retries), the goal goes to `needs_attention`

6. Write unit tests:
   - Task fields updated correctly at each step transition
   - GoalRepository correctly reads/writes workflow_id
   - SessionGroup exposes workflow metadata
   - Multi-step goal tracking
   - Failure in middle step surfaces correctly

**Acceptance criteria:**
- Tasks and goals track their current workflow step
- SessionGroup exposes workflow metadata to consumers
- UI events include step progression info
- Multi-step goal lifecycle is managed correctly
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
