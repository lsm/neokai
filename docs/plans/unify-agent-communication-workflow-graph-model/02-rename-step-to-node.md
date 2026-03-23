# Milestone 2: Rename `WorkflowStep` to `WorkflowNode`

## Goal

Rename all `step`-related terminology to `node` across the entire codebase: shared types, backend runtime, storage layer (including DB migration), frontend components, export/import format, and all tests. The visual editor frontend already uses a component called `WorkflowNode` -- align the backend and shared types to match.

## Scope

This is the largest mechanical change in the project. Key renames:
- `WorkflowStep` -> `WorkflowNode` (the type)
- `WorkflowStepAgent` -> `WorkflowNodeAgent`
- `WorkflowStepInput` -> `WorkflowNodeInput`
- `ExportedWorkflowStep` -> `ExportedWorkflowNode`
- `ExportedWorkflowStepAgent` -> `ExportedWorkflowNodeAgent`
- `startStepId` -> `startNodeId`
- `workflow.steps` -> `workflow.nodes`
- DB table `space_workflow_steps` -> `space_workflow_nodes` (via ALTER TABLE RENAME)
- DB columns `from_step_id`/`to_step_id` -> `from_node_id`/`to_node_id` in transitions
- DB column `start_step_id` -> `start_node_id` in `space_workflows`
- DB column `workflow_step_id` -> `workflow_node_id` in related tables
- Component file `WorkflowStepCard.tsx` -> `WorkflowNodeCard.tsx`
- All variable names, function names, and comments using "step" in the workflow context

**Note:** The visual editor already has a file `WorkflowNode.tsx` which is the canvas node renderer. The `WorkflowStepCard.tsx` component is a separate list-view card. When renaming, `WorkflowStepCard.tsx` becomes `WorkflowNodeCard.tsx` (distinct from the visual editor's `WorkflowNode.tsx`).

## Tasks

### Task 2.1: Rename shared types in space.ts and space-utils.ts

**Description:** Rename all `WorkflowStep*` types to `WorkflowNode*` in the shared package. Update `startStepId` to `startNodeId` and `steps` to `nodes` in workflow interfaces.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/shared/src/types/space.ts`:
   - `WorkflowStepAgent` -> `WorkflowNodeAgent`
   - `WorkflowStep` -> `WorkflowNode` (the interface -- note: careful not to clash with the visual editor component name, which is in a different package)
   - `WorkflowStepInput` -> `WorkflowNodeInput`
   - `ExportedWorkflowStep` -> `ExportedWorkflowNode`
   - `ExportedWorkflowStepAgent` -> `ExportedWorkflowNodeAgent`
   - `startStepId` -> `startNodeId` in `SpaceWorkflow`, `CreateSpaceWorkflowParams`, `UpdateSpaceWorkflowParams`
   - `steps` -> `nodes` in `SpaceWorkflow`, `CreateSpaceWorkflowParams`, `UpdateSpaceWorkflowParams`
   - Update all JSDoc comments referencing "step" to "node"
3. In `packages/shared/src/types/space-utils.ts`:
   - Update all references to the renamed types
   - Rename any `step`-related function names or parameters
4. Update exports in `packages/shared/src/types/` index file if one exists.
5. Run `bun run typecheck` -- expect many errors from downstream consumers (this is expected, they get fixed in subsequent tasks).
6. Run `cd packages/shared && bun test` to verify shared package tests pass.

**Acceptance Criteria:**
- All `WorkflowStep*` types renamed to `WorkflowNode*` in shared package
- `startStepId` -> `startNodeId` everywhere in shared types
- `steps` -> `nodes` in workflow interfaces
- Shared package tests pass

**Dependencies:** None

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.2: Add DB migration for table and column renames

**Description:** Add a new migration in `packages/daemon/src/storage/schema/migrations.ts` that renames the `space_workflow_steps` table to `space_workflow_nodes` and renames all `step`-related columns.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/daemon/src/storage/schema/migrations.ts`, add a new migration that:
   - Renames table `space_workflow_steps` -> `space_workflow_nodes`
   - Renames column `start_step_id` -> `start_node_id` in `space_workflows`
   - Renames columns `from_step_id` -> `from_node_id` and `to_step_id` -> `to_node_id` in `space_workflow_transitions`
   - Renames column `workflow_step_id` -> `workflow_node_id` in any tables that reference it (check `space_workflow_runs`, session groups, etc.)
   - Recreates affected indexes with new names
   - Uses SQLite's `ALTER TABLE RENAME` where supported; for column renames (SQLite 3.25+), use `ALTER TABLE RENAME COLUMN`
3. Update the migration registration/version number.
4. Run `bun run typecheck`.

**Acceptance Criteria:**
- Migration runs cleanly on a fresh DB and on an existing DB with `space_workflow_steps` data
- All renamed tables and columns are accessible with new names
- Indexes are recreated

**Dependencies:** None (can proceed in parallel with Task 2.1)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.3: Update space-workflow-repository.ts and space-agent-repository.ts

**Description:** Update the storage repository layer to use the new table and column names. Update all SQL queries from `space_workflow_steps` to `space_workflow_nodes`, `start_step_id` to `start_node_id`, etc.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/daemon/src/storage/repositories/space-workflow-repository.ts`:
   - Update all SQL queries to reference `space_workflow_nodes` instead of `space_workflow_steps`
   - Update `start_step_id` -> `start_node_id`
   - Update `from_step_id` / `to_step_id` -> `from_node_id` / `to_node_id`
   - Update `workflow_step_id` -> `workflow_node_id`
   - Update TypeScript interfaces and method names that reference "step"
3. In `packages/daemon/src/storage/repositories/space-agent-repository.ts`:
   - Update any references to step-related DB columns
4. Check other repositories in `packages/daemon/src/storage/repositories/` for step references.
5. Run `bun run typecheck`.
6. Run repository tests: `cd packages/daemon && bun test tests/unit/storage/space-agent-repository.test.ts`

**Acceptance Criteria:**
- All SQL queries use new table/column names
- Repository TypeScript interfaces use `node` terminology
- Repository tests pass

**Dependencies:** Task 2.1 (shared types), Task 2.2 (DB migration)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.4: Update backend runtime and managers

**Description:** Update the backend runtime layer (`workflow-executor.ts`, `space-runtime.ts`, `space-workflow-manager.ts`, `task-agent.ts`, `export-format.ts`) to use `WorkflowNode` types and `node` terminology.

**Subtasks:**
1. Run `bun install` at worktree root.
2. Update `packages/daemon/src/lib/space/runtime/workflow-executor.ts`:
   - Replace all `WorkflowStep` -> `WorkflowNode` type references
   - Rename variables and function parameters from `step` to `node`
   - Update `startStepId` -> `startNodeId`
3. Update `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - Same renames
4. Update `packages/daemon/src/lib/space/managers/space-workflow-manager.ts`:
   - Same renames for types, method parameters, and internal variables
5. Update `packages/daemon/src/lib/space/agents/task-agent.ts`:
   - System prompt text: "step" -> "node"
   - Type references
6. Update `packages/daemon/src/lib/space/export-format.ts`:
   - `ExportedWorkflowStep` -> `ExportedWorkflowNode`
   - `ExportedWorkflowStepAgent` -> `ExportedWorkflowNodeAgent`
7. Update `packages/daemon/src/lib/space/index.ts` re-exports.
8. Update `packages/daemon/src/lib/rpc-handlers/space-export-import-handlers.ts`.
9. Run `bun run typecheck` and `bun run lint`.

**Acceptance Criteria:**
- Zero references to `WorkflowStep` in `packages/daemon/src/` (outside historical docs)
- `bun run typecheck` passes
- `bun run lint` passes

**Dependencies:** Task 2.1, Task 2.3

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.5: Update frontend components

**Description:** Rename `WorkflowStepCard.tsx` to `WorkflowNodeCard.tsx` and update all frontend components, imports, and references from step to node terminology.

**Subtasks:**
1. Run `bun install` at worktree root.
2. Rename `packages/web/src/components/space/WorkflowStepCard.tsx` to `WorkflowNodeCard.tsx`.
3. Update all internal references in the renamed file (type `StepDraft` -> `NodeDraft`, function `isMultiAgentStep` -> `isMultiAgentNode`, etc.).
4. Update `packages/web/src/components/space/WorkflowEditor.tsx`:
   - Import paths and type references
   - Variable names from `step` to `node`
5. Update `packages/web/src/components/space/WorkflowRulesEditor.tsx`:
   - Step references in `appliesTo` UI
6. Update `packages/web/src/components/space/visual-editor/` files:
   - `serialization.ts` -- step -> node in serialization/deserialization
   - `layout.ts` -- step -> node
   - `NodeConfigPanel.tsx` -- `WorkflowStepAgent` -> `WorkflowNodeAgent`
   - `WorkflowNode.tsx` (visual editor canvas node) -- update imports from renamed `WorkflowNodeCard` types
   - `WorkflowCanvas.tsx` -- update step references
   - `VisualWorkflowEditor.tsx` -- update step references
   - `GateConfig.tsx` -- step references
7. Update `packages/web/src/components/space/index.ts` re-exports.
8. Run `bun run typecheck` and `bun run lint`.

**Acceptance Criteria:**
- `WorkflowStepCard.tsx` renamed to `WorkflowNodeCard.tsx`
- Zero references to `WorkflowStep` type in `packages/web/src/` (the visual editor `WorkflowNode.tsx` component name stays as-is)
- `bun run typecheck` passes

**Dependencies:** Task 2.1 (shared types)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.6: Update all tests for step->node rename

**Description:** Update all daemon unit tests, shared tests, web tests, and e2e tests that reference step terminology.

**Subtasks:**
1. Run `bun install` at worktree root.
2. Update `packages/shared/tests/space-utils.test.ts`.
3. Update daemon unit tests in `packages/daemon/tests/unit/`:
   - `space/space-workflow.test.ts`
   - `space/workflow-executor-multi-agent.test.ts`
   - `space/workflow-executor.test.ts`
   - `space/export-format.test.ts`
   - `storage/space-agent-repository.test.ts`
   - `rpc-handlers/space-agent-handlers.test.ts`
   - `lib/space-agent-manager.test.ts`
   - `helpers/space-agent-schema.ts`
   - Any other test files referencing `WorkflowStep` or `startStepId`
4. Update web component tests:
   - Rename `packages/web/src/components/space/__tests__/WorkflowStepCard.test.tsx` to `WorkflowNodeCard.test.tsx`
   - Update `WorkflowEditor.test.tsx`, `WorkflowRulesEditor.test.tsx`
   - Update visual editor tests in `packages/web/src/components/space/visual-editor/__tests__/`
5. Update e2e tests:
   - `packages/e2e/tests/features/visual-workflow-editor.e2e.ts`
   - `packages/e2e/tests/features/space-multi-agent-editor.e2e.ts`
   - `packages/e2e/tests/features/space-export-import.e2e.ts`
   - `packages/e2e/tests/features/space-workflow-rules.e2e.ts`
   - Any other e2e tests referencing step terminology
6. Run all tests: `make test-daemon`, `make test-web`, and spot-check key e2e tests.

**Acceptance Criteria:**
- All tests updated to use `node` terminology
- `make test-daemon` passes
- `make test-web` passes
- No regressions

**Dependencies:** Task 2.3, Task 2.4, Task 2.5

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
