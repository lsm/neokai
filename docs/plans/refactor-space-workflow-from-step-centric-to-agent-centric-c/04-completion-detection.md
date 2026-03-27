# Milestone 4: Completion Detection

## Goal

Implement all-agents-done completion detection. The workflow run completes when all agents report done (or are auto-completed by the liveness guard). This replaces the old terminal-node detection model which was removed in Milestone 3.

## Scope

- Implement all-agents-done completion detection
- Update SpaceRuntime tick loop to use the new completion model
- Update workflow run status lifecycle
- Tests

## Tasks

### Task 4.1: All-Agents-Done Completion Detector

**Description**: Create a completion detector that determines whether all agents in a workflow run have reported done.

**Subtasks**:
1. Create `packages/daemon/src/lib/space/runtime/completion-detector.ts`
2. Implement `CompletionDetector` class:
   ```
   class CompletionDetector {
     constructor(config: {
       taskRepo: SpaceTaskRepository;
     })

     // Check if all agents in the workflow run have reported done
     isComplete(workflowRunId: string): boolean

     // Get completion status overview
     getStatus(workflowRunId: string): {
       totalAgents: number;
       doneAgents: number;
       activeAgents: number;
       failedAgents: number;
       isComplete: boolean;
     }
   }
   ```
3. Completion logic:
   - Query path: `space_tasks` WHERE `workflow_run_id = ?` — single direct query, no session group traversal
   - Count tasks with status `'completed'`, `'needs_attention'`, or `'cancelled'` (terminal states)
   - A run is complete when ALL tasks have reached a terminal status — i.e., zero tasks with status `'in_progress'` or `'pending'`
   - **Edge case — nodes with no tasks**: If a node in the workflow has no tasks yet (agents not spawned, possibly because no channel has fired to activate it), those nodes are **excluded** from the completion check. Only nodes with at least one task contribute to the agent count.
   - **Edge case — pending-but-blocked activations**: Before concluding a run is complete, check whether any node that currently has tasks (i.e., has been activated) has outbound `WorkflowChannel` entries (the unified channel type) whose `to` field references a node that has no tasks yet. If such "pending activation" channels exist, the run is **not complete** — those target nodes may still receive agents if gates open (via retry, human approval, or condition changes). Only when all reachable nodes have been activated (or explicitly skipped) is the run truly complete. This check uses the unified `WorkflowChannel` type — no separate cross-node channel query needed.

**Acceptance Criteria**:
- `isComplete()` returns true only when all agents have reached a terminal state
- Works correctly for single-node and multi-node workflows
- Works correctly for single-agent and multi-agent nodes
- Handles edge cases (no tasks, nodes with no tasks)

**Dependencies**: Task 2.2

**Agent Type**: coder

---

### Task 4.2: Update SpaceRuntime Tick Loop for Completion Detection

**Description**: Modify the `SpaceRuntime.executeTick()` and `processRunTick()` methods to detect completion via the all-agents-done model.

**Subtasks**:
1. In `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - Inject `CompletionDetector` into `SpaceRuntimeConfig`
   - In `processRunTick()`, after the liveness checks:
     - Use `CompletionDetector.isComplete()` to check if the workflow run is complete
     - If complete, mark the run as `'completed'`
   - Remove any remaining references to the old terminal-node detection logic (if any survived Milestone 3)
2. Add a `workflow_run_completed` notification event when the completion detector fires

**Acceptance Criteria**:
- Workflows complete via all-agents-done detection
- No duplicate completion events
- Terminal executor cleanup works correctly

**Dependencies**: Tasks 4.1, 3.3, 3.5

**Agent Type**: coder

---

### Task 4.3: Update Workflow Run Status Lifecycle

**Description**: Define the workflow run status lifecycle for the agent-centric model.

**Subtasks**:
1. Define and enforce status transitions in `SpaceWorkflowRun`:
   - `pending` → `in_progress` (start of run)
   - `in_progress` → `completed` (all agents done — detected by CompletionDetector)
   - `in_progress` → `needs_attention` (gate blocked, agent failed)
   - `needs_attention` → `in_progress` (human resolved the issue)
   - Any → `cancelled` (explicit cancellation)
2. Add status transition guards where needed (prevent invalid transitions)

**Acceptance Criteria**:
- Status lifecycle is consistent
- Invalid transitions are prevented
- Status is persisted correctly to DB
- Rehydration after restart works correctly

**Dependencies**: Task 4.2

**Agent Type**: coder

---

### Task 4.4: Tests for Completion Detection

**Description**: Write tests for the new completion detection system and the updated tick loop.

**Subtasks**:
1. Create `packages/daemon/tests/unit/space/completion-detector.test.ts`:
   - All agents done → complete
   - Some agents still active → not complete
   - Mixed done/failed agents → complete
   - No tasks at all → edge case handling (run with no activated nodes)
   - Multiple nodes in a single run
   - Nodes with no tasks → excluded from completion check
   - Pending-but-blocked activations: active node has outbound `WorkflowChannel` entries targeting unactivated nodes → NOT complete
   - All reachable nodes activated and all agents done → complete
2. Update `packages/daemon/tests/unit/space/space-runtime.test.ts`:
   - Add test cases for tick loop with completion detection
   - Test status transitions (pending → in_progress → completed)
3. Update `packages/daemon/tests/unit/space/space-runtime-edge-cases.test.ts`:
   - Edge cases for completion detection

**Acceptance Criteria**:
- All tests pass
- Completion detection works correctly for all scenarios
- No regressions

**Dependencies**: Tasks 4.2, 4.3

**Agent Type**: coder

## Rollback Strategy

- **CompletionDetector** (Task 4.1): New class. If it incorrectly marks runs as complete, it can be temporarily bypassed by commenting out its invocation in `processRunTick()`.
- **Tick loop changes** (Task 4.2): The old advance-based path is already removed (Milestone 3). The completion detector is the sole completion mechanism.
- **Status lifecycle** (Task 4.3): No new statuses are added; existing status transitions are clarified. Minimal rollback risk.
