# Milestone 9: Final Cleanup

## Goal

Clean up all remaining step-transition code and types that are no longer needed. Since the feature is unreleased, this is a straightforward removal — no deprecation warnings or migration scripts needed.

## Scope

- Remove `WorkflowTransition` type and all transition-related code
- Remove `currentNodeId` from `SpaceWorkflowRun`
- Remove transition-related DB tables/columns
- Clean up any remaining dead code
- Comprehensive test coverage
- Online integration tests

## Tasks

### Task 9.1: Remove WorkflowTransition and Transition-Related Code

**Description**: Remove all step-transition infrastructure that has been replaced by cross-node channels.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`:
   - Remove `WorkflowTransition` interface (replaced by `CrossNodeChannel`)
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

**Dependencies**: Tasks 6.3, 7.1

**Agent Type**: coder

---

### Task 9.2: Remove currentNodeId and Terminal-Node Detection

**Description**: Remove `currentNodeId` from `SpaceWorkflowRun` since the agent-centric model doesn't track a single active node.

**Subtasks**:
1. In `packages/shared/src/types/space.ts`:
   - Remove `currentNodeId` field from `SpaceWorkflowRun`
2. Add a DB migration to drop the `current_node_id` column from `space_workflow_runs`
3. Clean up any code that reads or writes `currentNodeId` (should already be cleaned up by Milestone 4/5, but verify)
4. Run full test suite to verify no regressions

**Acceptance Criteria**:
- `currentNodeId` removed from type and DB
- No code references `currentNodeId`
- All tests pass

**Dependencies**: Tasks 4.5, 5.2

**Agent Type**: coder

---

### Task 9.3: Comprehensive Test Suite and Online Integration Tests

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
   - Test full workflow lifecycle with cross-node channels:
     - Create space with agent-centric workflow
     - Start workflow run
     - Spawn agents
     - Agents communicate via gated channels
     - Agents report done
     - Workflow completes
   - Test gate enforcement (human gate blocks, condition gate evaluates)
   - Test cross-node message delivery
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

**Dependencies**: Tasks 9.1, 9.2

**Agent Type**: coder

## Rollback Strategy

- This milestone removes code that is no longer used (transitions, currentNodeId). If rollback is needed, all removed code is preserved in git history and can be restored from the pre-milestone commit.
- DB migrations to drop tables/columns are destructive but reversible (re-create the table/column and restore data from a backup if needed — though since the feature is unreleased, there should be no production data to worry about).
