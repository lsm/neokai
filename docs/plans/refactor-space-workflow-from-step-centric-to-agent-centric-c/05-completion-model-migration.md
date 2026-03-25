# Milestone 5: Completion Model Migration

## Goal

Replace the terminal-node detection model (run completes when `advance()` reaches a node with no outgoing transitions) with an all-agents-done model (run completes when all agents in the workflow report done). Remove `advance()` from the hot path in SpaceRuntime.

## Scope

- Implement all-agents-done completion detection
- Update SpaceRuntime tick loop to use the new completion model
- Keep `advance()` available as a fallback but stop calling it from the tick loop when cross-node channels are configured
- Update workflow run status transitions

## Tasks

### Task 5.1: All-Agents-Done Completion Detector

**Description**: Create a completion detector that determines whether all agents in a workflow run have reported done.

**Subtasks**:
1. Create `packages/daemon/src/lib/space/runtime/completion-detector.ts`
2. Implement `CompletionDetector` class:
   ```
   class CompletionDetector {
     constructor(config: {
       sessionGroupRepo: SpaceSessionGroupRepository;
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
   - Query all session groups associated with the workflow run
   - Count members with status `'done'`
   - A run is complete when ALL members across ALL groups have status `'done'` or `'completed'` or `'failed'`
   - Members with status `'active'` mean the run is not complete

**Acceptance Criteria**:
- `isComplete()` returns true only when all agents have reached a terminal state
- Works correctly for single-node and multi-node workflows
- Works correctly for single-agent and multi-agent nodes
- Handles edge cases (no groups, empty groups)

**Dependencies**: Task 3.2

**Agent Type**: coder

---

### Task 5.2: Update SpaceRuntime Tick Loop

**Description**: Modify the `SpaceRuntime.executeTick()` and `processRunTick()` methods to detect completion via the new all-agents-done model when cross-node channels are configured.

**Subtasks**:
1. In `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - Inject `CompletionDetector` into `SpaceRuntimeConfig`
   - In `processRunTick()`, after the Task Agent block:
     - Check if the workflow run has cross-node channels configured
     - If yes: use `CompletionDetector.isComplete()` instead of the old "all tasks completed" check
     - If the run has no cross-node channels: keep the old behavior (backward compatible)
   - When the new completion model detects completion, mark the run as `'completed'`
2. The old `advance()` path remains available for workflows that don't use cross-node channels
3. Add a new notification event `workflow_run_completed` when the completion detector fires (existing mechanism already exists)

**Acceptance Criteria**:
- Workflows with cross-node channels complete via all-agents-done detection
- Workflows without cross-node channels still work with the old advance() model
- No duplicate completion events
- Terminal executor cleanup works with both models

**Dependencies**: Tasks 5.1, 4.3

**Agent Type**: coder

---

### Task 5.3: Update Workflow Run Status Lifecycle

**Description**: Ensure the workflow run status lifecycle is consistent with the new completion model.

**Subtasks**:
1. Review and update status transitions in `SpaceWorkflowRun`:
   - `pending` -> `in_progress` (start of run)
   - `in_progress` -> `completed` (all agents done)
   - `in_progress` -> `needs_attention` (gate blocked, agent failed)
   - `needs_attention` -> `in_progress` (human resolved the issue)
   - Any -> `cancelled` (explicit cancellation)
2. Ensure the `CompletionDetector` and old `advance()` path use the same status transition logic
3. Add status transition guards where needed (prevent invalid transitions)

**Acceptance Criteria**:
- Status lifecycle is consistent across both completion models
- Invalid transitions are prevented
- Status is persisted correctly to DB
- Rehydration after restart works with both models

**Dependencies**: Task 5.2

**Agent Type**: coder

---

### Task 5.4: Tests for Completion Model Migration

**Description**: Write tests for the new completion detection system and the updated tick loop.

**Subtasks**:
1. Create `packages/daemon/tests/unit/space/completion-detector.test.ts`:
   - All agents done -> complete
   - Some agents still active -> not complete
   - Mixed done/failed agents -> complete
   - Empty groups -> edge case handling
   - Multiple groups in a single run
2. Update `packages/daemon/tests/unit/space/space-runtime.test.ts`:
   - Add test cases for tick loop with new completion model
   - Add test cases verifying backward compatibility (old model still works)
3. Update `packages/daemon/tests/unit/space/space-runtime-edge-cases.test.ts`:
   - Edge cases for the new completion model

**Acceptance Criteria**:
- All tests pass
- New completion model works correctly
- Old completion model (advance-based) still passes all existing tests
- No regressions

**Dependencies**: Tasks 5.2, 5.3

**Agent Type**: coder
