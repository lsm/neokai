# Milestone 4: Workflow Runtime Engine

## Goal

Build a workflow executor that can run tasks through configurable step sequences instead of the hardcoded planning/execution/review cycle. The workflow runtime reads `Workflow` definitions from the data layer and orchestrates agent sessions according to the defined steps and gates.

## Scope

- New `WorkflowExecutor` class that interprets workflow step sequences
- Integration with existing `RoomRuntime` tick loop
- Gate evaluation logic (auto, human_approval, quality_check, pr_review, custom)
- Rule injection into agent system prompts
- Backward compatibility: rooms without a custom workflow use the default built-in behavior
- Unit and online tests

---

### Task 4.1: WorkflowExecutor Core

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.3, Task 2.3

**Description:**

Create the `WorkflowExecutor` class that manages the progression of a task through workflow steps.

**Subtasks:**

1. Create `packages/daemon/src/lib/room/runtime/workflow-executor.ts`:
   - `WorkflowExecutor` class with:
     - Constructor takes: `workflow: Workflow`, `taskId: string`, `groupRepo: SessionGroupRepository`, `taskManager: TaskManager`, `customAgentManager: CustomAgentManager`
     - `getCurrentStep(): WorkflowStep | null` -- returns the current active step based on task/group state
     - `getNextStep(): WorkflowStep | null` -- returns the next step in sequence
     - `canAdvance(): Promise<{ allowed: boolean; reason?: string }>` -- evaluates the current step's exit gate
     - `advance(): Promise<WorkflowStep>` -- moves to the next step, creates the session group for it
     - `isComplete(): boolean` -- returns true if all steps have been executed

2. Add workflow execution state tracking in `SessionGroupRepository`:
   - Add `workflowId` and `currentStepId` to `TaskGroupMetadata`
   - Track which workflow step a group is executing

3. Implement gate evaluation:
   - `evaluateGate(gate: WorkflowGate, context: GateContext): Promise<GateResult>`
   - `GateContext` includes: `workspacePath`, `taskId`, `groupId`, `workerOutput`, etc.
   - Gate types:
     - `auto`: always passes
     - `human_approval`: checks `group.approved` flag (reuses existing pattern)
     - `quality_check`: runs shell command (e.g., `bun run check`) and checks exit code
     - `pr_review`: reuses existing `runWorkerExitGate` logic from lifecycle-hooks.ts
     - `custom`: runs user-provided command, checks exit code

4. Write unit tests:
   - Step progression through a multi-step workflow
   - Gate evaluation for each gate type
   - Workflow completion detection
   - Error handling (missing step, gate failure)

**Acceptance criteria:**
- `WorkflowExecutor` can advance a task through a sequence of steps
- All gate types are evaluated correctly
- State is persisted via group metadata
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4.2: Integrate WorkflowExecutor into RoomRuntime

**Agent:** coder
**Priority:** high
**Depends on:** Task 4.1

**Description:**

Update `RoomRuntime` to use `WorkflowExecutor` when a task has an associated workflow, while preserving the existing hardcoded behavior as fallback.

**Subtasks:**

1. In `RoomRuntime`, add workflow resolution logic:
   - When spawning a group for a task, check if the task's goal has an associated workflow (via room's default workflow or task-level override)
   - If a workflow exists, create a `WorkflowExecutor` and use it to determine which agent to spawn for the first step
   - Store `workflowId` in the group metadata

2. Update the `onWorkerTerminalState` handler:
   - If the group has a `workflowId`, use the `WorkflowExecutor` to evaluate the exit gate and determine the next step
   - If the next step is a different agent, complete the current group and spawn a new one for the next step
   - If the exit gate requires human approval, set `submittedForReview` (reuse existing pattern)
   - If all steps are complete, mark the task as completed

3. Inject workflow rules into agent system prompts:
   - When building the `WorkerConfig`, check if the current step has associated rules
   - Append applicable rules to the system prompt

4. Backward compatibility:
   - If no workflow is associated with a task/goal/room, use the existing hardcoded behavior (no behavior change)
   - The existing `taskType` and `assignedAgent` fields continue to work as before

5. Write integration tests:
   - Run a task through a 3-step workflow (plan -> code -> review)
   - Verify gates are checked between steps
   - Verify rules are injected
   - Verify fallback to built-in behavior when no workflow exists
   - Verify human approval gate pauses execution

**Acceptance criteria:**
- Tasks with workflows progress through steps automatically
- Gates between steps are enforced
- Rules are injected into agent prompts
- Existing non-workflow tasks are unaffected
- Integration tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4.3: Workflow-Aware Task Status and Group Lifecycle

**Agent:** coder
**Priority:** normal
**Depends on:** Task 4.2

**Description:**

Update task status tracking and group lifecycle to reflect workflow step progression in the UI and API.

**Subtasks:**

1. Add workflow step tracking to `NeoTask`:
   - Add `workflowId?: string` and `currentWorkflowStepId?: string` to the `NeoTask` interface
   - Add corresponding columns in a new migration
   - Update `TaskRepository` to read/write these fields

2. Update task status events to include workflow context:
   - `room.task.update` events should include `workflowStepName` for UI display
   - The frontend can show "Step 2/3: Code Review" in the task view

3. Update `TaskSummary` to include workflow info:
   - Add `workflowStepName?: string` and `workflowTotalSteps?: number` to `TaskSummary`

4. Handle multi-group lifecycle:
   - A workflow task may spawn multiple sequential groups (one per step)
   - Track the relationship: `taskId -> [groupId1 (step 1), groupId2 (step 2), ...]`
   - The task remains `in_progress` until the final step completes
   - If any step fails, the task goes to `needs_attention`

5. Write unit tests:
   - Task fields updated correctly at each step transition
   - Multi-group tracking
   - Failure in middle step surfaces correctly

**Acceptance criteria:**
- Tasks track their current workflow step
- UI events include step progression info
- Multi-group lifecycle is managed correctly
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
