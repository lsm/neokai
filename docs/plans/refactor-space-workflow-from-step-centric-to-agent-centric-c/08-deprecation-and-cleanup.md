# Milestone 8: Deprecation and Cleanup

## Goal

Mark the step-transition model as deprecated, add migration tooling, and clean up old code paths. This is the final milestone that completes the transition from step-centric to agent-centric.

## Scope

- Add deprecation warnings for step-centric APIs
- Create migration scripts to convert existing workflows
- Clean up `advance()` from non-legacy code paths
- Comprehensive test coverage update
- Documentation updates

## Tasks

### Task 8.1: Deprecation Warnings for Step-Centric APIs

**Description**: Add deprecation warnings to step-centric APIs and workflow features.

**Subtasks**:
1. Add `@deprecated` JSDoc tags to:
   - `WorkflowTransition` (prefer `CrossNodeChannel`)
   - `SpaceWorkflowRun.currentNodeId` (prefer completion detection)
   - `WorkflowExecutor.advance()` (prefer agent-driven messaging)
   - `WorkflowCondition` types on transitions (prefer channel gates)
2. Add runtime deprecation warnings (logged but not thrown):
   - When a workflow run uses the old advance() path, log a deprecation notice
   - When `advance_workflow` is called on a workflow with cross-node channels, log a warning
3. Update `CLAUDE.md` with guidance on using the agent-centric model

**Acceptance Criteria**:
- Deprecation warnings appear in logs when step-centric features are used
- JSDoc `@deprecated` tags guide developers to new APIs
- No runtime errors from deprecation warnings
- `CLAUDE.md` documents the new model

**Dependencies**: Tasks 6.3, 7.1

**Agent Type**: coder

---

### Task 8.2: Workflow Migration Script

**Description**: Create a migration utility that converts existing step-centric workflows to agent-centric workflows.

**Subtasks**:
1. Create `packages/daemon/src/lib/space/workflows/migrate-workflow.ts`
2. Implement `migrateWorkflowToAgentCentric(workflow: SpaceWorkflow): SpaceWorkflow`:
   - For each `WorkflowTransition` with a condition, create an equivalent `CrossNodeChannel` with a gate
   - Transitions with `condition.type === 'always'` -> cross-node channels with no gate
   - Transitions with `condition.type === 'human'` -> cross-node channels with human gate
   - Transitions with `condition.type === 'condition'` -> cross-node channels with condition gate
   - Transitions with `condition.type === 'task_result'` -> cross-node channels with task_result gate
   - Preserve the original transitions (dual model)
   - Preserve `isCyclic` flag on channels
3. Create an RPC handler `workflow.migrateToAgentCentric` that migrates a workflow
4. Add unit tests for the migration logic

**Acceptance Criteria**:
- Migration correctly converts all transition types to cross-node channels with equivalent gates
- Existing workflows can be migrated without data loss
- Migrated workflows work with both the old and new runtime paths
- Unit tests cover all transition types

**Dependencies**: Tasks 2.3, 4.1

**Agent Type**: coder

---

### Task 8.3: Clean Up advance() from Non-Legacy Code Paths

**Description**: Remove `advance()` calls from code paths that should now use agent-driven advancement.

**Subtasks**:
1. In `SpaceRuntime.processRunTick()`:
   - When a workflow has cross-node channels, do NOT call `advance()` even as a fallback
   - The Task Agent block already avoids `advance()` -- verify this is correct
2. In `TaskAgentToolsConfig` and tool handlers:
   - Ensure `advance_workflow` tool still works but is clearly labeled as legacy
   - Remove any internal code that assumes `advance()` is the primary advancement mechanism
3. Review `SpaceRuntimeService` for any direct `advance()` calls

**Acceptance Criteria**:
- `advance()` is only called for workflows without cross-node channels
- No hidden dependencies on `advance()` in the agent-centric code path
- Existing tests still pass

**Dependencies**: Tasks 6.3, 8.2

**Agent Type**: coder

---

### Task 8.4: Comprehensive Test Coverage Update

**Description**: Update all test suites to cover both the legacy and new models, ensuring no regressions.

**Subtasks**:
1. Update `packages/daemon/tests/unit/space/workflow-executor.test.ts`:
   - Add deprecation warning tests
   - Ensure all executor tests still pass
2. Update `packages/daemon/tests/unit/space/space-runtime.test.ts`:
   - Add tests for dual-model (both step-centric and agent-centric in same runtime)
3. Update `packages/daemon/tests/unit/space/built-in-workflows.test.ts`:
   - Verify migrated built-in workflows have correct cross-node channels
4. Update `packages/daemon/tests/unit/rpc-handlers/space-workflow-handlers.test.ts`:
   - Add tests for migration RPC handler
5. Run full test suite and fix any failures:
   - `make test-daemon`
   - `make test-web`

**Acceptance Criteria**:
- `make test-daemon` passes
- `make test-web` passes
- `bun run typecheck` passes
- `bun run lint` passes
- No regressions in any test suite

**Dependencies**: Tasks 8.1, 8.2, 8.3

**Agent Type**: coder

---

### Task 8.5: Online Integration Tests

**Description**: Write online integration tests that exercise the full agent-centric workflow model end-to-end.

**Subtasks**:
1. Create `packages/daemon/tests/online/space/agent-centric-workflow.test.ts`:
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
2. Follow the existing online test patterns (use `NEOKAI_USE_DEV_PROXY=1` for mocked API calls)

**Acceptance Criteria**:
- Online tests pass with `NEOKAI_USE_DEV_PROXY=1`
- Full workflow lifecycle is exercised
- Gate enforcement is verified
- Completion detection works correctly

**Dependencies**: Tasks 8.4

**Agent Type**: coder
