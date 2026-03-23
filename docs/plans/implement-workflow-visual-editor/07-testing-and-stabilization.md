# Milestone 7: Testing and Stabilization

## Goal

Ensure comprehensive test coverage for the visual editor with stable, non-flaky tests. Update existing workflow tests for compatibility with extracted components. Verify all tests pass in CI.

## Tasks

### Task 7.1: E2E test for visual editor workflow

**Description**: Create a Playwright E2E test that exercises the full visual editor workflow: create a workflow, add nodes, connect them, configure properties, designate start node, save, reopen and verify positions are restored.

**Agent type**: coder

**Subtasks**:
1. Create `packages/e2e/tests/features/visual-workflow-editor.e2e.ts`:
   - Test: "Create workflow with visual editor"
     - Navigate to Space, create a new workflow
     - Toggle to "Visual" editor mode
     - Add 3 nodes via "Add Step" button
     - Drag nodes to specific positions (use deterministic coordinates, avoid animation-dependent assertions)
     - Connect nodes by simulating port drag interactions
     - Select a node, edit properties in the config panel (change name, select agent)
     - Designate a non-first node as start via "Set as Start" button
     - Save the workflow
     - Reopen the workflow in visual mode and verify: node positions are restored from saved layout, connections are preserved, start node is correct
   - Test: "Load template in visual editor"
     - Create new workflow, toggle to Visual mode
     - Select a template from "Start from template"
     - Verify nodes and edges appear with auto-layout
     - Save and verify
   - Test: "Toggle between List and Visual modes"
     - Create a workflow in List mode with 2 steps
     - Switch to Visual mode, verify nodes appear
     - Switch back to List mode, verify steps are preserved
2. Use deterministic coordinates for drag operations (avoid flaky pixel-precision assertions)
3. Use proper `waitFor` conditions instead of `sleep` for all assertions
4. Follow E2E test rules from CLAUDE.md: all actions through UI, all assertions on visible DOM state

**Acceptance criteria**:
- All E2E tests pass locally (`make run-e2e TEST=tests/features/visual-workflow-editor.e2e.ts`)
- Tests pass in CI (manually trigger e2e test run to verify)
- No flaky tests: deterministic coordinates, proper wait conditions, no animation dependencies
- Tests follow the E2E guidelines in CLAUDE.md (no direct RPC calls in assertions)

**Dependencies**: Task 6.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 7.2: Update existing tests for compatibility

**Description**: Ensure all existing workflow-related tests still pass after the integration. Update any tests that may break due to extracted components (e.g., `GateConfig` moved to shared file) or new imports.

**Agent type**: coder

**Subtasks**:
1. Run existing test suites: `WorkflowEditor.test.tsx`, `WorkflowList.test.tsx`, `WorkflowStepCard.test.tsx`, `WorkflowRulesEditor.test.tsx`
2. Fix any import path changes from extracting `GateConfig`
3. Update `WorkflowStepCard.test.tsx` if `GateConfig` was extracted
4. Run backend tests to verify migration doesn't break existing workflow CRUD tests
5. Verify all tests pass: `cd packages/web && bunx vitest run` and `cd packages/daemon && bun test`
6. Run linter and type checker: `bun run lint && bun run typecheck`

**Acceptance criteria**:
- All existing workflow tests pass without modification (or with minimal import fixes)
- Backend workflow tests pass with the new `layout` column
- No lint errors or type errors introduced
- `bun run check` passes clean

**Dependencies**: Tasks 6.1, 6.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 7.3: Performance validation with large workflows

**Description**: Validate that the visual editor performs acceptably with large workflows (20+ nodes, 30+ edges). This is not a dedicated perf test suite, but a manual validation checkpoint with documented results.

**Agent type**: coder

**Subtasks**:
1. Create a unit test in `packages/web/src/components/space/visual-editor/__tests__/performance.test.tsx`:
   - Generate a workflow with 25 nodes and 35 edges
   - Measure auto-layout computation time (should be < 100ms)
   - Render the VisualWorkflowEditor with the large workflow and verify it mounts without errors
   - Measure initial render time (should be < 500ms)
2. Document performance baselines in test comments for future regression tracking

**Acceptance criteria**:
- Auto-layout for 25 nodes completes in < 100ms
- Visual editor renders 25 nodes + 35 edges without errors
- Performance test passes in CI
- Tests pass

**Dependencies**: Task 6.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
