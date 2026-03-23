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
- `currentStepId` -> `currentNodeId` in `SpaceWorkflowRun`, `CreateSpaceWorkflowRunParams`, `SpaceSessionGroup`
- `workflow.steps` -> `workflow.nodes`
- DB table `space_workflow_steps` -> `space_workflow_nodes` (via ALTER TABLE RENAME)
- DB columns `from_step_id`/`to_step_id` -> `from_node_id`/`to_node_id` in transitions
- DB column `start_step_id` -> `start_node_id` in `space_workflows`
- DB column `current_step_id` -> `current_node_id` in `space_workflow_runs` and `space_session_groups`
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
   - Rename `workflowStepId` -> `workflowNodeId` in `SpaceTask`, `CreateSpaceTaskParams`, `UpdateSpaceTaskParams`
   - Rename `currentStepId` -> `currentNodeId` in `SpaceWorkflowRun` (line 305), `CreateSpaceWorkflowRunParams` (line 337), `SpaceSessionGroup` (line 390)
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
- `workflowStepId` -> `workflowNodeId` in `SpaceTask`, `CreateSpaceTaskParams`, `UpdateSpaceTaskParams`
- `currentStepId` -> `currentNodeId` in `SpaceWorkflowRun`, `CreateSpaceWorkflowRunParams`, `SpaceSessionGroup`
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
   - Renames column `current_step_id` -> `current_node_id` in `space_workflow_runs` (migrations.ts line 1637)
   - Renames column `current_step_id` -> `current_node_id` in `space_session_groups` (migrations.ts line 1726)
   - Recreates affected indexes with new names
   - **IMPORTANT:** Follow the project's established create-copy-drop-rename migration pattern (see `migrations.ts` lines 381, 572, 737, 790 for examples). Do NOT use `ALTER TABLE RENAME COLUMN` — instead: create new table with new column names, copy data, drop old table, rename new table. This ensures compatibility across all SQLite versions bundled by Bun.
   - Renames column `workflow_step_id` -> `workflow_node_id` in `space_tasks` table (FK to `space_workflow_nodes`)
3. Update the migration registration/version number.
4. Run `bun run typecheck`.

**Acceptance Criteria:**
- Migration uses the create-copy-drop-rename pattern (NOT `ALTER TABLE RENAME COLUMN`)
- Migration runs cleanly on a fresh DB and on an existing DB with `space_workflow_steps` data
- All renamed tables and columns are accessible with new names
- `workflow_step_id` in `space_tasks` is renamed to `workflow_node_id`
- `current_step_id` in `space_workflow_runs` and `space_session_groups` is renamed to `current_node_id`
- Indexes are recreated

**Dependencies:** None (can proceed in parallel with Task 2.1)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.3: Update all storage repositories

**Description:** Update the storage repository layer to use the new table and column names. Update all SQL queries from `space_workflow_steps` to `space_workflow_nodes`, `start_step_id` to `start_node_id`, `current_step_id` to `current_node_id`, etc.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/daemon/src/storage/repositories/space-workflow-repository.ts`:
   - Update all SQL queries to reference `space_workflow_nodes` instead of `space_workflow_steps`
   - Update `start_step_id` -> `start_node_id`
   - Update `from_step_id` / `to_step_id` -> `from_node_id` / `to_node_id`
   - Update `workflow_step_id` -> `workflow_node_id`
   - Update TypeScript interfaces and method names that reference "step"
3. In `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts`:
   - Update `current_step_id` -> `current_node_id` in all SQL queries
   - Update `currentStepId` -> `currentNodeId` in TypeScript mappings (lines 16, 33, 44, 139-140, 172, 204)
4. In `packages/daemon/src/storage/repositories/space-session-group-repository.ts`:
   - Update `current_step_id` -> `current_node_id` in all SQL queries
   - Update `currentStepId` -> `currentNodeId` in TypeScript mappings (lines 16, 26, 61, 70, 156-158, 396)
5. In `packages/daemon/src/storage/repositories/space-agent-repository.ts`:
   - Update any references to step-related DB columns
6. In `packages/daemon/src/storage/repositories/space-task-repository.ts`:
   - Update `workflow_step_id` -> `workflow_node_id` in all SQL queries
   - Update `workflowStepId` -> `workflowNodeId` in TypeScript mappings (e.g., line 357)
7. Check other repositories in `packages/daemon/src/storage/repositories/` for any remaining step references.
8. Run `bun run typecheck`.
9. Run repository tests: `cd packages/daemon && bun test tests/unit/storage/`

**Acceptance Criteria:**
- All SQL queries use new table/column names (`space_workflow_nodes`, `current_node_id`, `workflow_node_id`, etc.)
- All repository TypeScript interfaces use `node` terminology (`currentNodeId`, `workflowNodeId`)
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
   - Update `currentStepId` -> `currentNodeId` (lines 198, 206, 298, 406, 440)
   - Update `workflowStepId` -> `workflowNodeId` references (e.g., line 464)
3. Update `packages/daemon/src/lib/space/runtime/space-runtime.ts`:
   - Same renames
   - Update `currentStepId` -> `currentNodeId` (e.g., line 307: `currentStepId: workflow.startStepId`, lines 599-606)
   - Update all `workflowStepId` -> `workflowNodeId` references
4. Update `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`:
   - Rename step -> node in types, method parameters, internal variables (e.g., line 898 `workflowStepId` -> `workflowNodeId`)
5. Update `packages/daemon/src/lib/space/tools/task-agent-tools.ts`:
   - Update `currentStepId` -> `currentNodeId` (lines 464, 470, 619)
   - Update any `stepId` references
6. Update `packages/daemon/src/lib/space/tools/space-agent-tools.ts`:
   - Update `run.currentStepId` -> `run.currentNodeId` and `workflow.steps.find(...)` -> `workflow.nodes.find(...)`
7. Update `packages/daemon/src/lib/space/tools/global-spaces-tools.ts`:
   - Update `currentStepId` and `workflow.steps` references
8. Search for any manager file under `packages/daemon/src/lib/space/managers/` that references workflow steps and update it.
9. Update `packages/daemon/src/lib/space/agents/task-agent.ts`:
   - System prompt text: "step" -> "node"
   - Type references
10. Update `packages/daemon/src/lib/space/export-format.ts`:
    - `ExportedWorkflowStep` -> `ExportedWorkflowNode`
    - `ExportedWorkflowStepAgent` -> `ExportedWorkflowNodeAgent`
11. Update `packages/daemon/src/lib/space/index.ts` re-exports.
12. Update `packages/daemon/src/lib/rpc-handlers/space-export-import-handlers.ts`.
13. Run `bun run typecheck` and `bun run lint`.

**Acceptance Criteria:**
- Zero references to `WorkflowStep`, `currentStepId`, `workflowStepId`, or `startStepId` in `packages/daemon/src/` (outside historical docs)
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
6. Update `packages/web/src/components/space/SpaceTaskPane.tsx`:
   - Rename `task.workflowStepId` -> `task.workflowNodeId` (e.g., line 341)
7. Update `packages/web/src/components/space/visual-editor/` files:
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
   - `storage/space-task-repository.test.ts`
   - `rpc-handlers/space-agent-handlers.test.ts`
   - `lib/space-agent-manager.test.ts`
   - `helpers/space-agent-schema.ts`
   - Any other test files referencing `WorkflowStep`, `startStepId`, `currentStepId`, or `workflowStepId`
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
