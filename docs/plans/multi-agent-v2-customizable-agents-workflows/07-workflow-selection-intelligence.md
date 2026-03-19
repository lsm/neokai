# Milestone 7: Workflow Selection & Intelligence

## Goal

Enable intelligent workflow selection within Spaces so the Space agent can automatically choose the appropriate workflow based on task context. Also support manual workflow override on goals and tasks, and enhance agent prompts with workflow awareness. All code lives in the Space namespace — no existing Room code is modified.

## Isolation Checklist

- Selection logic in `packages/daemon/src/lib/space/runtime/workflow-selector.ts`
- Space agent tools in `packages/daemon/src/lib/space/tools/space-agent-tools.ts` (NOT `room-agent-tools.ts`)
- `SpaceGoalManager` workflow assignment in `packages/daemon/src/lib/space/managers/space-goal-manager.ts` (NOT `GoalManager` or `GoalRepository`)
- No modifications to `room-agent-tools.ts`, `GoalRepository`, `GoalManager`, or any Room file

## Note on Auto-Selection

The auto-selection algorithm is an **MVP heuristic** — a simple priority-based chain with tag matching and basic keyword matching. It is explicitly NOT sophisticated. Future iterations can replace keyword matching with LLM-based classification without changing the interface.

## Scope

- Pure, testable workflow selection logic
- Space agent tool updates for workflow assignment
- Goal/task-level workflow override via `SpaceGoalManager`/`SpaceTaskManager`
- Agent prompt enhancement with workflow context
- Unit tests

---

### Task 7.1: Workflow Selection Logic and Goal Assignment

**Agent:** coder
**Priority:** high
**Depends on:** Task 4.2

**Description:**

Implement workflow selection as a pure testable unit and wire goal/task workflow assignment into Space agent tools. All in the Space namespace.

**Subtasks:**

1. Create `packages/daemon/src/lib/space/runtime/workflow-selector.ts`:
   - `selectWorkflow(context: WorkflowSelectionContext): SpaceWorkflow | null`
   - `WorkflowSelectionContext`: `{ spaceId, taskTitle, taskDescription, taskType, goalTitle, goalDescription, availableWorkflows: SpaceWorkflow[] }`
   - Selection algorithm (deterministic priority chain):
     1. Task has explicit `workflowId` → use it
     2. Task's goal has `workflowId` → use it
     3. Space has default workflow → use it
     4. Tag-based: match `taskType` against workflow tags
     5. MVP keyword matching: substring match task title/description against workflow descriptions
     6. Fall back to null (use default behavior)

2. **Unit-testable without runtime**: `selectWorkflow()` takes only data inputs (all `SpaceWorkflow` type).

3. Wire into `SpaceGoalManager` (already in `packages/daemon/src/lib/space/managers/`):
   - `createGoal` accepts optional `workflowId`
   - Validation: if provided, workflow must exist in same space (query `SpaceWorkflowManager`)
   - **External caller validation only**: internal `updateGoalWorkflowStep(goalId, stepId)` bypasses existence check for `WorkflowExecutor` use (avoids redundant DB round-trips)

4. Create Space agent tools in `packages/daemon/src/lib/space/tools/space-agent-tools.ts`:
   - `create_goal` tool accepts optional `workflowId`
   - `create_task` tool accepts optional `workflowId` (overrides goal-level)
   - `list_workflows` tool returns available `SpaceWorkflow` records
   - **This is a new file** — NOT modifying `room-agent-tools.ts`

5. Integration point in `SpaceRuntime`:
   - `resolveWorkflowForGoal(goalId: string): SpaceWorkflow | null` — calls `selectWorkflow()`

6. Write unit tests:
   - All priority chain levels tested
   - Explicit assignment wins over defaults
   - Tag matching works
   - Keyword matching handles common patterns and no-match gracefully
   - Null fallback when no workflows exist
   - Goal workflow assignment validation via `SpaceGoalManager`

**Acceptance criteria:**
- `selectWorkflow()` is a pure function with no runtime dependencies, using `SpaceWorkflow` type
- Deterministic priority chain with clear precedence
- Goals and tasks can have workflows assigned via `SpaceGoalManager`/`SpaceTaskManager`
- Space agent tools in new file `space-agent-tools.ts` (NOT modifying `room-agent-tools.ts`)
- Validation prevents cross-space references
- Unit tests cover all selection paths
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 7.2: Space Agent Prompt Enhancement

**Agent:** coder
**Priority:** normal
**Depends on:** Task 7.1

**Description:**

Enhance Space agent prompts with workflow awareness so agents can recommend and work within workflows intelligently. All prompt building in Space namespace.

**Subtasks:**

1. Create Space chat agent system prompt builder in `packages/daemon/src/lib/space/agents/space-chat-agent.ts`:
   - Include available `SpaceWorkflow` records (names, descriptions, tags)
   - Include `SpaceAgent` information
   - Guidance: "When creating goals, consider which workflow best fits the work"
   - **New file** — NOT modifying existing room agent prompt builders

2. Add `get_workflow_detail` tool to `space-agent-tools.ts`:
   - Takes `workflowId`, returns full `SpaceWorkflow` with steps, gates, rules

3. Add `suggest_workflow` tool to `space-agent-tools.ts`:
   - Takes `description` of intended work
   - Returns best-matching `SpaceWorkflow` records via `selectWorkflow()` logic

4. Update Planner agent prompt for workflow context (in Space planner setup):
   - When `SpaceGoal` has an assigned workflow, include structure in planning context
   - Planner creates tasks aligned with workflow steps

5. Write unit tests:
   - Prompt includes workflow information
   - `suggest_workflow` returns relevant matches
   - Planner receives workflow context

**Acceptance criteria:**
- Space agent aware of available workflows
- All prompt builders in Space namespace (new files, not modifying Room prompts)
- Workflow context flows to planner for aligned task creation
- New tools work correctly
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
