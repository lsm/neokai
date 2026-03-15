# Milestone 7: Workflow Selection & Intelligence

## Goal

Enable intelligent workflow selection so the room agent can automatically choose the appropriate workflow based on task context, goal type, and tags. Also support manual workflow override on tasks and goals.

## Note on Auto-Selection

The auto-selection algorithm in Task 7.2 is an **MVP heuristic** — a simple priority-based chain with tag matching and basic keyword matching. It is explicitly NOT meant to be sophisticated. The priority chain ensures deterministic, predictable behavior. Future iterations can replace the keyword matching step with more intelligent approaches (e.g., LLM-based classification, learned preferences) without changing the interface.

## Scope

- Workflow selection logic (pure testable unit, independent of runtime)
- Room agent tool updates for workflow assignment
- Goal/task-level workflow override
- Auto-selection based on tags and task content
- GoalRepository/GoalManager updates for `workflow_id` column (from consolidated Migration B)
- Unit and online tests

---

### Task 7.1: Add Workflow Selection to Room Agent Tools

**Agent:** coder
**Priority:** high
**Depends on:** Task 4.2b, Task 3.4

**Description:**

Update the room agent tools to support workflow selection and assignment when creating goals and tasks. Also wire up the `goals.workflow_id` column (added in consolidated Migration B).

**Subtasks:**

1. Update `GoalRepository` and `GoalManager` for `workflow_id`:
   - Update `rowToGoal()` mapping function to include `workflowId` from the `workflow_id` column
   - Update all SQL INSERT/UPDATE statements for `goals` table to read/write `workflow_id`
   - Update `CreateGoalParams` and `UpdateGoalParams` to include `workflowId?: string`
   - Add validation in `GoalManager`: if `workflowId` is provided, verify the workflow exists and belongs to the same room

2. Update `create_goal` tool in `packages/daemon/src/lib/room/tools/room-agent-tools.ts`:
   - Add optional `workflowId` parameter
   - When set, the goal uses the specified workflow for all its tasks
   - Validate the workflow belongs to the same room

3. Update `create_task` tool:
   - Add optional `workflowId` parameter
   - When set, overrides the goal-level or room-default workflow for this specific task
   - Validate the workflow belongs to the same room

4. Add `list_workflows` tool to room agent tools:
   - Returns available workflows in the room (name, description, tags, step count)
   - The room agent can use this to recommend or select workflows

5. Write unit tests:
   - GoalRepository reads/writes workflow_id correctly
   - Goal creation with workflow assignment
   - Task creation with workflow override
   - Validation of workflow references (exists, same room)
   - `list_workflows` tool returns correct data

**Acceptance criteria:**
- Goals and tasks can have workflows assigned via room agent tools
- GoalRepository correctly persists and retrieves `workflow_id`
- Workflow validation prevents cross-room references
- Room agent has visibility into available workflows
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 7.2: Workflow Auto-Selection Logic

**Agent:** coder
**Priority:** normal
**Depends on:** Task 7.1

**Description:**

Implement automatic workflow selection as a **pure, testable unit** based on task/goal content and workflow tags. This is an MVP heuristic with deterministic priority-based resolution. The selection logic is independent of the runtime and can be tested without `RoomRuntime`.

**Subtasks:**

1. Create `packages/daemon/src/lib/room/runtime/workflow-selector.ts`:
   - `selectWorkflow(context: WorkflowSelectionContext): Workflow | null`
   - `WorkflowSelectionContext`: `{ roomId, taskTitle, taskDescription, taskType, goalTitle, goalDescription, availableWorkflows }`
   - Selection algorithm (deterministic priority chain):
     1. If task has explicit `workflowId` -> use it
     2. If task's goal has `workflowId` -> use it
     3. If room has a default workflow -> use it
     4. Tag-based matching: match `taskType` against workflow tags (e.g., `taskType: 'coding'` matches workflow tagged `coding`)
     5. **MVP keyword matching**: simple substring matching of task title/description against workflow descriptions. This is explicitly a rough heuristic — it will be replaced with more intelligent approaches in future iterations.
     6. Fall back to null (use hardcoded behavior)

2. **Unit-testable without runtime**: The `selectWorkflow()` function takes only data inputs (no runtime dependencies). It can be thoroughly tested with pure unit tests.

3. Create a separate integration point in `RoomRuntime`:
   - `resolveWorkflowForGoal(goalId: string): Workflow | null` — calls `selectWorkflow()` with the appropriate context
   - This is the only place where the selector touches the runtime

4. Write unit tests for the pure selection logic:
   - Explicit assignment takes priority
   - Goal-level assignment is inherited by tasks
   - Room default is used when nothing else matches
   - Tag-based matching works correctly
   - Keyword matching works for common patterns (and gracefully handles no matches)
   - Null fallback when no workflows exist
   - Priority chain is deterministic (higher-priority rules always win)

**Acceptance criteria:**
- `selectWorkflow()` is a pure function with no runtime dependencies
- Automatic workflow selection works with a clear, deterministic priority chain
- Fallback to built-in behavior is seamless
- Unit tests cover all selection paths independently of runtime
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 7.3: Room Agent Prompt Enhancement for Workflow Awareness

**Agent:** coder
**Priority:** normal
**Depends on:** Task 7.2

**Description:**

Update the room agent (chat session) system prompt and tools to be workflow-aware, so the room agent can intelligently recommend and manage workflows during conversations.

**Subtasks:**

1. Update room agent system prompt building (in the session setup for `room:chat:${roomId}`):
   - Include a section listing available workflows with their names, descriptions, and tags
   - Include guidance: "When creating goals, consider which workflow best fits the work type"
   - Include custom agent information: "Custom agents available: [names with descriptions]"

2. Add `get_workflow_detail` tool:
   - Takes `workflowId`
   - Returns full workflow with steps, gates, and rules
   - Helps the room agent understand workflow specifics before recommending

3. Add `suggest_workflow` tool:
   - Takes `description` of the intended work
   - Returns the best-matching workflow(s) based on `selectWorkflow()` logic
   - Returns multiple candidates ranked by match quality
   - Explicitly notes this is heuristic-based (not AI-powered matching)

4. Update the Planner agent prompt:
   - When a goal has an assigned workflow, include the workflow structure in the planning context
   - The planner should create tasks that align with workflow steps (e.g., if workflow expects a "security review" step, tasks should be structured to produce reviewable output)

5. Write unit tests:
   - Room agent prompt includes workflow information
   - `suggest_workflow` tool returns relevant matches
   - Planner receives workflow context when available

**Acceptance criteria:**
- Room agent is aware of available workflows and can recommend them
- Workflow context flows through to planner for aligned task creation
- New tools work correctly
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
