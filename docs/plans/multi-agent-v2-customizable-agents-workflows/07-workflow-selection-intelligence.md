# Milestone 7: Workflow Selection & Intelligence

## Goal

Enable intelligent workflow selection so the room agent can automatically choose the appropriate workflow based on task context, goal type, and tags. Also support manual workflow override on tasks and goals.

## Scope

- Workflow selection logic in the room agent
- Room agent tool updates for workflow assignment
- Goal/task-level workflow override
- Auto-selection based on tags and task content
- Unit and online tests

---

### Task 7.1: Add Workflow Selection to Room Agent Tools

**Agent:** coder
**Priority:** high
**Depends on:** Task 4.2, Task 3.4

**Description:**

Update the room agent tools to support workflow selection and assignment when creating goals and tasks.

**Subtasks:**

1. Update `create_goal` tool in `packages/daemon/src/lib/room/tools/room-agent-tools.ts`:
   - Add optional `workflowId` parameter
   - When set, the goal uses the specified workflow for all its tasks
   - Validate the workflow belongs to the same room

2. Update `create_task` tool:
   - Add optional `workflowId` parameter
   - When set, overrides the goal-level or room-default workflow for this specific task
   - Validate the workflow belongs to the same room

3. Add `list_workflows` tool to room agent tools:
   - Returns available workflows in the room (name, description, tags, step count)
   - The room agent can use this to recommend or select workflows

4. Add `workflowId` field to `RoomGoal`:
   - Add `workflowId?: string` to the `RoomGoal` interface in shared types
   - Add column in migration
   - Update GoalManager and GoalRepository

5. Update `NeoTask`:
   - Add `workflowId?: string` to `NeoTask` (if not already added in Milestone 4)
   - Update `CreateTaskParams` to include `workflowId`

6. Write unit tests:
   - Goal creation with workflow assignment
   - Task creation with workflow override
   - Validation of workflow references

**Acceptance criteria:**
- Goals and tasks can have workflows assigned via room agent tools
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

Implement automatic workflow selection based on task/goal content and workflow tags. When no explicit workflow is assigned, the system should intelligently pick the best-matching workflow.

**Subtasks:**

1. Create `packages/daemon/src/lib/room/runtime/workflow-selector.ts`:
   - `selectWorkflow(context: WorkflowSelectionContext): Workflow | null`
   - `WorkflowSelectionContext`: `{ roomId, taskTitle, taskDescription, taskType, goalTitle, goalDescription, availableWorkflows }`
   - Selection algorithm:
     1. If task has explicit `workflowId` -> use it
     2. If task's goal has `workflowId` -> use it
     3. If room has a default workflow -> use it
     4. Tag-based matching: match `taskType` against workflow tags (e.g., `taskType: 'coding'` matches workflow tagged `coding`)
     5. Keyword matching in task title/description against workflow descriptions (simple substring matching)
     6. Fall back to null (use hardcoded behavior)

2. Integrate into `RoomRuntime.tick()`:
   - Before spawning a group for a task, call `selectWorkflow()` to determine the workflow
   - If a workflow is selected, use the `WorkflowExecutor` (from Milestone 4)
   - If null, use existing built-in behavior

3. Add workflow selection info to room agent system prompt:
   - When the room agent creates goals/tasks, include available workflow names and descriptions
   - The room agent can then suggest or assign workflows based on conversation context

4. Write unit tests:
   - Explicit assignment takes priority
   - Goal-level assignment is inherited by tasks
   - Room default is used when nothing else matches
   - Tag-based matching works correctly
   - Keyword matching works for common patterns
   - Null fallback when no workflows exist

**Acceptance criteria:**
- Automatic workflow selection works with a clear priority chain
- The room agent has enough context to recommend workflows
- Fallback to built-in behavior is seamless
- Unit tests cover all selection paths
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
   - Returns multiple candidates with match confidence

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
