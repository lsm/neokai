# Milestone 8: Final Cleanup

## Goal

Clean up all remaining step-transition code and types that are no longer needed. Since the feature is unreleased, this is a straightforward removal — no deprecation warnings or migration scripts needed.

## Scope

- Remove `WorkflowTransition` type and all transition-related code
- Remove `currentNodeId` from `SpaceWorkflowRun` and `SpaceSessionGroup`
- Rename `SpaceTask.slotRole` → `SpaceTask.agentName` to align with "no role" naming
- Remove transition-related DB tables/columns
- Clean up any remaining dead code
- Comprehensive test coverage
- Online integration tests

## Tasks

### Task 8.1: Remove WorkflowTransition and Transition-Related Code

**Description**: Remove all step-transition infrastructure that has been replaced by channels.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`:
   - Remove `WorkflowTransition` interface (replaced by `WorkflowChannel`)
   - Remove `WorkflowTransitionInput` type
   - Remove `transitions` field from `SpaceWorkflow` interface
   - Remove `transitions` field from `CreateSpaceWorkflowParams` and `UpdateSpaceWorkflowParams`
   - Remove `ExportedWorkflowTransition` type and references
2. In `packages/shared/src/types/space-utils.ts`:
   - Remove any transition-related utility functions
3. In `packages/daemon/src/lib/space/`:
   - Remove transition-related repository methods (if any separate from workflow repository)
   - Clean up any transition-related exports
4. Add a DB migration to drop `space_workflow_transitions` table (and any related columns like `is_cyclic` on nodes if they were transition-specific)
5. Update `packages/daemon/src/lib/space/export-format.ts` to remove transition export/import logic

**Acceptance Criteria**:
- `WorkflowTransition` type no longer exists
- `transitions` field removed from `SpaceWorkflow`
- `space_workflow_transitions` table dropped
- No imports or references to transitions remain in the codebase
- TypeScript typecheck passes
- `bun run lint` passes

**Dependencies**: Tasks 5.3, 6.1

**Agent Type**: coder

---

### Task 8.2: Remove currentNodeId from Workflow Run

**Description**: Remove `currentNodeId` from `SpaceWorkflowRun` since the agent-centric model doesn't track a single active node.

**Important distinction**: `startNodeId` on `SpaceWorkflow` (the workflow template/definition) **stays unchanged** — it tells the system which node to activate first when a run starts. Only `currentNodeId` on `SpaceWorkflowRun` (the runtime execution state) is removed. In the agent-centric model, `SpaceRuntime.startWorkflowRun()` activates the start node via `activateNode()` (from Task 3.0) using the workflow's `startNodeId`. After that, nodes are activated lazily by the router — there is no single "current" node to track.

**Iteration tracking stays**: The `iteration_count` and `max_iterations` columns on `space_workflow_runs` remain. Iteration counting is now handled by `ChannelRouter.deliverMessage()` when delivering through channels with `isCyclic: true`, replacing the old `advance()` → `followTransition()` path.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`:
   - Remove `currentNodeId` field from `SpaceWorkflowRun`
   - Remove `currentNodeId` field from `SpaceSessionGroup` (if it exists — session groups are per-node and don't track a "current" node in the agent-centric model)
   - Keep `startNodeId` on `SpaceWorkflow` (unchanged — it's a workflow definition property)
   - Keep `iterationCount` and `maxIterations` on `SpaceWorkflowRun` (unchanged — iteration tracking moved to router in M3)
2. Add a DB migration to:
   - Drop the `current_node_id` column from `space_workflow_runs` (keep `iteration_count` and `max_iterations`)
   - Drop the `current_node_id` column from `space_session_groups` if it exists
   - Rename `slot_role` column to `agent_name` on `space_tasks` table (aligns with "no role" naming convention — `slotRole` referenced the agent's old `role` field)
   - Rename `role` column to `agent_name` on `space_session_group_members` table (`SpaceSessionGroupMember.role` → `SpaceSessionGroupMember.agentName`)
   - Update all code that reads/writes `slotRole` / `slot_role` or `SpaceSessionGroupMember.role` to use `agentName` / `agent_name`
3. In `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - Update `startWorkflowRun()` to activate the start node via `activateNode()` instead of setting `currentNodeId`
   - Verify iteration tracking is now handled by the router (not by `advance()`)
4. Clean up any code that reads or writes `currentNodeId` on `SpaceWorkflowRun` or `SpaceSessionGroup` (should already be cleaned up by Milestone 3/4, but verify)
5. Run full test suite to verify no regressions

**Acceptance Criteria**:
- `currentNodeId` removed from `SpaceWorkflowRun` and `SpaceSessionGroup` types and DB
- `slot_role` renamed to `agent_name` on `space_tasks` — no "role" column remains in task management
- `SpaceSessionGroupMember.role` renamed to `agentName` on `space_session_group_members` — no "role" column remains in session group members
- `startNodeId` on `SpaceWorkflow` still works correctly
- Workflow runs activate the start node via `activateNode()`
- No code references `currentNodeId` or `slotRole`
- All tests pass

**Dependencies**: Tasks 3.5, 4.2

**Agent Type**: coder

---

### Task 8.3: Comprehensive Test Suite and Online Integration Tests

**Description**: Run the full test suite and write online integration tests for the complete agent-centric workflow model.

**Subtasks**:
1. Run full test suite and fix any failures:
   - `make test-daemon`
   - `make test-web`
   - `bun run typecheck`
   - `bun run lint`
2. Update `packages/daemon/tests/unit/space/space-runtime.test.ts`:
   - Verify the tick loop works correctly with the new model
   - Test all status transitions
3. Create `packages/daemon/tests/online/space/agent-centric-workflow.test.ts`:
   - Test full workflow lifecycle with channels:
     - Create space with agent-centric workflow
     - Start workflow run
     - Spawn agents
     - Agents communicate via gated channels
     - Agents report done
     - Workflow completes
   - Test gate enforcement (human gate blocks, condition gate evaluates)
   - Test channel-based message delivery (within-node, cross-node, DM, fan-out)
   - Test completion detection
   - Test lazy node activation
4. Follow the existing online test patterns (use `NEOKAI_USE_DEV_PROXY=1` for mocked API calls)

**Acceptance Criteria**:
- `make test-daemon` passes
- `make test-web` passes
- `bun run typecheck` passes
- `bun run lint` passes
- Online tests pass with `NEOKAI_USE_DEV_PROXY=1`
- Full workflow lifecycle is exercised end-to-end
- No regressions in any test suite

**Dependencies**: Tasks 8.1, 8.2

**Agent Type**: coder

## Rollback Strategy

- This milestone removes code that is no longer used (transitions, currentNodeId). If rollback is needed, all removed code is preserved in git history and can be restored from the pre-milestone commit.
- DB migrations to drop tables/columns are destructive but reversible (re-create the table/column and restore data from a backup if needed — though since the feature is unreleased, there should be no production data to worry about).
