# Plan: Add End Node to Workflow Definition for Deterministic Workflow Completion

## Goal

The workflow graph currently has `startNodeId` but no `endNodeId`. Workflow completion relies on the Task Agent LLM calling `report_workflow_done`, which is fragile and architecturally incorrect -- task completion is a workflow concern, not a task concern.

## Approach

Add an `endNodeId` field to `SpaceWorkflow` (mirroring `startNodeId`). When the end node's task calls `report_done`, the `CompletionDetector` auto-completes the workflow run. Remove `report_workflow_done` from the Task Agent tools and system prompt. The existing all-agents-done check remains as a safety net for workflows without `endNodeId`.

The field is optional for backward compatibility with existing workflows.

---

## Task 1: Add `endNodeId` to shared types

**Description:** Add the `endNodeId` field to `SpaceWorkflow`, `CreateSpaceWorkflowParams`, `UpdateSpaceWorkflowParams`, and `ExportedSpaceWorkflow` interfaces in the shared types package.

**Agent type:** coder

**Subtasks:**
1. In `packages/shared/src/types/space.ts`, add `endNodeId?: string` to `SpaceWorkflow` (after `startNodeId`, line ~869) with JSDoc: "ID of the node whose completion signals workflow done. Optional -- when absent, the all-agents-done detector is the sole completion mechanism."
2. In `CreateSpaceWorkflowParams` (line ~925), add `endNodeId?: string` with JSDoc mirroring startNodeId pattern: "ID of the node whose completion signals workflow done. Defaults to undefined (no end node)."
3. In `UpdateSpaceWorkflowParams` (line ~966), add `endNodeId?: string | null` with JSDoc: "Updates the workflow end node. Pass `null` to clear."
4. In `ExportedSpaceWorkflow` (line ~1155), add `endNode?: string` (optional, mirroring `startNode` pattern) with JSDoc: "Name of the node whose completion signals workflow done."

**Acceptance criteria:**
- TypeScript compiles cleanly (`bun run typecheck`).
- `endNodeId` is optional on all interfaces.
- `ExportedSpaceWorkflow` uses `endNode` (name-based, not UUID) and is optional since existing exports won't have it.

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 2: DB migration and repository layer

**Description:** Add `end_node_id` column to `space_workflows` table and update the repository to read/write it.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/storage/schema/migrations.ts`, add the next migration: `ALTER TABLE space_workflows ADD COLUMN end_node_id TEXT`. Follow the pattern of existing migrations (e.g., migration 65). Add the migration call in the main migration function (after the latest existing call). The column is nullable with no default -- safe for SQLite. **Note:** The migration number (currently 70) should be verified at implementation time — another migration may have been added to `dev` by then. Always use the next available number.
2. In `packages/daemon/src/storage/repositories/space-workflow-repository.ts`:
   - Add `end_node_id: string | null` to `WorkflowRow` interface (line ~34).
   - In `rowToWorkflow()` (line ~115), map `row.end_node_id` to `endNodeId` on the returned `SpaceWorkflow`, using the same pattern as `startNodeId` but keeping it optional: `endNodeId: row.end_node_id ?? undefined`.
   - In `createWorkflow()` (line ~154), add `end_node_id` to the INSERT statement and pass `params.endNodeId ?? null`.
   - In `updateWorkflow()` (line ~234), add handling for `params.endNodeId !== undefined` to build the `end_node_id = ?` SET clause, same pattern as `startNodeId`.
3. Add unit tests in a new file `packages/daemon/tests/unit/space/space-workflow-end-node.test.ts`:
   - Test that creating a workflow with `endNodeId` persists and reads it back.
   - Test that creating a workflow without `endNodeId` returns `undefined` for the field.
   - Test that updating `endNodeId` persists the change.
   - Test that setting `endNodeId` to `null` clears it.

**Acceptance criteria:**
- Migration 70 runs without errors on existing databases.
- Round-trip: create workflow with `endNodeId` -> read it back -> field matches.
- Workflows without `endNodeId` return `undefined` (not `null`).
- All existing tests in `space-workflow.test.ts` still pass.

**Dependencies:** Task 1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 3: CompletionDetector end-node check and orchestration task cleanup

**Description:** Extend `CompletionDetector` to detect workflow completion when the end node's task reaches a terminal status, and ensure the runtime properly completes the Task Agent's orchestration task when auto-completing a run.

**Agent type:** coder

**Subtasks:**
1. Refactor `CompletionDetector.isComplete()` signature (in `packages/daemon/src/lib/space/runtime/completion-detector.ts`) to accept an options object instead of growing positional parameters. The new signature: `isComplete(options: { workflowRunId: string, channels?: WorkflowChannel[], nodes?: WorkflowNode[], endNodeId?: string }): boolean`. Update the existing call site accordingly.
2. Add end-node completion logic: after the "no tasks" early return and before the all-agents-done check, if `endNodeId` is provided, find any task in the run whose `workflowNodeId === endNodeId` and check if it has a terminal status. If yes, return `true` immediately. This means the workflow completes as soon as the end node finishes, even if other nodes are still running (they will be cleaned up by the runtime).
3. Update the call site in `packages/daemon/src/lib/space/runtime/space-runtime.ts` (line ~798) to pass the options object including `meta.workflow.endNodeId`.
4. **Critical: Orchestration task completion on auto-complete.** Currently `report_workflow_done` does three things: (a) transitions the run to `completed`, (b) marks the Task Agent's orchestration task as `completed`, and (c) emits `space.task.completed`. When the runtime auto-completes a run via CompletionDetector, it only does (a). Add post-completion logic in the runtime's run completion path (after `transitionStatus(runId, 'completed')`) to also: find the orchestration task (task with `workflowNodeId == null` in the run), set its status to `completed`, and emit the `space.task.completed` event. This prevents the orchestration task from dangling as `in_progress` forever.
5. Add unit tests in `packages/daemon/tests/unit/space/completion-detector.test.ts`:
   - Test: workflow with `endNodeId` completes when end node task is `completed`, even if other tasks are `in_progress`.
   - Test: workflow with `endNodeId` does NOT complete when end node task is `in_progress`.
   - Test: workflow with `endNodeId` completes when end node task is `needs_attention` (still terminal).
   - Test: workflow without `endNodeId` falls through to existing all-agents-done logic (backward compat).
   - Test: workflow with `endNodeId` but no task for that node yet does NOT complete.
6. Add unit tests for the orchestration task auto-completion:
   - Test: when runtime auto-completes a run, the orchestration task is also set to `completed`.
   - Test: `space.task.completed` event is emitted for the orchestration task.

**Acceptance criteria:**
- End node completion is a priority check that short-circuits the all-agents-done logic.
- `isComplete()` uses an options object (not positional params) for a clean interface.
- When the runtime auto-completes a run, the orchestration task is also completed and its event emitted — no dangling tasks.
- All existing completion-detector tests pass (updated to use new signature).
- New tests cover the end-node-specific scenarios and orchestration task cleanup.
- `bun run typecheck` passes.

**Dependencies:** Task 1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 4: Remove `report_workflow_done` from Task Agent

**Description:** Remove the `report_workflow_done` tool from the Task Agent's toolset and update its system prompt to remove completion detection instructions. The Task Agent should focus on spawning, monitoring, and gate handling.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/space/tools/task-agent-tool-schemas.ts`:
   - Remove `ReportWorkflowDoneSchema` (lines 132-146).
   - Remove `report_workflow_done` from `TASK_AGENT_TOOL_SCHEMAS` (line 160).
   - Remove the `ReportWorkflowDoneInput` type export.
2. In `packages/daemon/src/lib/space/tools/task-agent-tools.ts`:
   - Remove the `report_workflow_done` handler function (lines 648-730).
   - Remove the tool registration at line 1042-1049.
   - Remove the `completionDetector` parameter from the function signature if it was only used by `report_workflow_done`. Check if `completionDetector` is used elsewhere -- if not, remove the parameter and its import.
3. In `packages/daemon/src/lib/space/agents/task-agent.ts` (`buildTaskAgentSystemPrompt`):
   - Remove the `report_workflow_done` tool documentation section (lines 217-223).
   - Update step 6 "Detect completion" (lines 277-280) to say: "The workflow runtime automatically detects completion when the end node finishes. You do not need to detect or signal workflow completion. When the runtime completes the workflow, your orchestration task will be auto-completed."
   - Update step 4 "Reporting the final result" in the role section (line 182) to: "Monitoring task progress — the workflow runtime handles completion automatically when the end node finishes".
   - **Note on Task Agent lifecycle:** The Task Agent does NOT need to call `report_result` to self-terminate. The runtime will auto-complete the orchestration task when the run completes (handled by Task 3's orchestration cleanup). The Task Agent should focus on spawning, monitoring, and gate handling until the runtime terminates it.
4. Update tests:
   - In `packages/daemon/tests/unit/space/task-agent-tool-schemas.test.ts`: remove tests for `ReportWorkflowDoneSchema`.
   - In `packages/daemon/tests/unit/space/task-agent-tools.test.ts`: remove `report_workflow_done` test cases.
   - In `packages/daemon/tests/unit/space/task-agent-collaboration.test.ts`: update any references to `report_workflow_done`.
   - In `packages/daemon/tests/unit/space/task-agent.test.ts`: update prompt assertion tests if they check for `report_workflow_done` text.

**Acceptance criteria:**
- `report_workflow_done` is completely removed from tool schemas, handlers, and registrations.
- Task Agent system prompt no longer mentions `report_workflow_done`.
- Task Agent system prompt instructs the agent to use `report_result` for its own task completion.
- All modified test files pass.
- `bun run typecheck` passes.
- `bun run lint` passes (no unused exports).

**Dependencies:** Task 3 (CompletionDetector must handle end-node completion before removing the manual trigger)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 5: Update built-in workflow templates

**Description:** Add `endNodeId` to all built-in workflow templates, pointing to their logical terminal nodes.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`:
   - `CODING_WORKFLOW`: add `endNodeId: CODING_DONE_STEP` (the "Done" node).
   - `CODING_WORKFLOW_V2`: add `endNodeId: V2_DONE_STEP` (the "Done" node).
   - `RESEARCH_WORKFLOW`: add `endNodeId: RESEARCH_GENERAL_STEP` (the "Research" node -- it is the terminal node in this 2-node graph). Add a code comment: `// Terminal node in this topology — update if downstream nodes are added`.
   - `REVIEW_ONLY_WORKFLOW`: add `endNodeId: REVIEW_CODER_STEP` (single-node workflow; start and end are the same). Add a code comment: `// Single-node workflow — start and end are the same node`.
2. In `seedBuiltInWorkflows()` (line ~578), add `endNodeId` mapping through `nodeIdMap`, same as `startNodeId` is mapped on line 640: `const endNodeId = template.endNodeId ? nodeIdMap.get(template.endNodeId)! : undefined;`. Pass `endNodeId` in the `createWorkflow()` call.
3. Update tests in `packages/daemon/tests/unit/space/built-in-workflows.test.ts`:
   - Assert each built-in template has `endNodeId` set.
   - Assert `endNodeId` references a valid node ID in the template.
   - Assert seeded workflows have `endNodeId` mapped through `nodeIdMap` (not the template placeholder).

**Acceptance criteria:**
- All four built-in templates define `endNodeId`.
- `seedBuiltInWorkflows()` maps `endNodeId` through `nodeIdMap` correctly.
- Existing built-in-workflows tests pass.
- New assertions verify `endNodeId` presence and validity.

**Dependencies:** Task 1, Task 2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 6a: Export/import `endNode` support

**Description:** Add `endNodeId`/`endNode` support to the workflow export/import format (backend only).

**Agent type:** coder

**Subtasks:**
1. **Export format** (`packages/daemon/src/lib/space/export-format.ts`):
   - In `exportWorkflow()`: add `endNode` mapping parallel to `startNode` (line ~260). Map `workflow.endNodeId` UUID to node name via `nodeIdToName`. Only include `endNode` in the result if `endNodeId` is defined.
   - In `exportedWorkflowBaseSchema`: add `endNode: z.string().min(1).optional()` (after `startNode`, line ~138).
   - In `validateExportedWorkflow()`: add validation that `endNode` references a known node name (parallel to `startNode` check at line ~387), but only when `endNode` is present.
2. **Import handling** (`packages/daemon/src/lib/rpc-handlers/space-export-import-handlers.ts`):
   - In the workflow import logic, resolve `endNode` name back to the corresponding node UUID, parallel to `startNode` resolution. Pass as `endNodeId` in `createWorkflow()`.
3. **Tests:**
   - Update `packages/daemon/tests/unit/space/export-format.test.ts` with endNode export/import tests.
   - Update `packages/daemon/tests/unit/space/export-import-round-trip.test.ts` with endNode round-trip.

**Acceptance criteria:**
- Export includes `endNode` when `endNodeId` is set; omits it when not set.
- Import resolves `endNode` name to UUID and persists as `endNodeId`.
- Round-trip export-import preserves `endNodeId`.
- All export/import tests pass.

**Dependencies:** Task 1, Task 2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 6b: Visual editor and form editor `endNodeId` support

**Description:** Add `endNodeId` support to the visual editor serialization, visual editor UI, and form-based workflow editor (frontend).

**Agent type:** coder

**Subtasks:**
1. **Visual editor serialization** (`packages/web/src/components/space/visual-editor/serialization.ts`):
   - Add `endNodeId: string` to `VisualEditorState` interface (line ~84, after `startNodeId`). Make it optional with empty string as default.
   - In `workflowToVisualState()`: populate `endNodeId` from `workflow.endNodeId`, same pattern as `startNodeId` (line ~155).
   - In `buildWorkflowFields()`: add `endNodeId` resolution parallel to `startNodeId` (lines ~280-290). Add to `BuiltWorkflowFields` interface.
   - In `visualStateToCreateParams()`: pass `endNodeId` through to `CreateSpaceWorkflowParams`.
   - In `visualStateToUpdateParams()`: pass `endNodeId` through to `UpdateSpaceWorkflowParams`.
2. **Visual editor UI** (`packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx`):
   - Add `endNodeId` state (mirroring `startNodeId` state, line ~227).
   - Wire it through to the serialization output (line ~1096).
   - Pass `endNodeId` and `setEndNodeId` to `NodeConfigPanel`.
3. **NodeConfigPanel** (`packages/web/src/components/space/visual-editor/NodeConfigPanel.tsx`):
   - Add a "Set as End Node" button (parallel to "Set as Start Node", line ~600).
   - Disable when the node is already the end node. Show an "END" badge on end nodes.
4. **WorkflowEditor (form-based)** (`packages/web/src/components/space/WorkflowEditor.tsx`):
   - In the create/update params building (lines ~686, ~704), pass `endNodeId` if applicable.
5. **Tests:**
   - Update `packages/web/src/components/space/visual-editor/__tests__/serialization.test.ts` (if it exists) or add tests covering endNodeId serialization.
   - Update `packages/web/src/components/space/visual-editor/__tests__/NodeConfigPanel.test.ts` with "Set as End Node" button tests.

**Acceptance criteria:**
- Visual editor state includes `endNodeId`; serialization round-trips it.
- "Set as End Node" button works in the visual editor.
- Form-based editor passes `endNodeId` through to create/update params.
- All serialization and component tests pass.

**Dependencies:** Task 1, Task 2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 7: Workflow manager validation

**Description:** Add validation for `endNodeId` in the workflow manager, ensuring it references a valid node.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/space/managers/space-workflow-manager.ts`:
   - In `createWorkflow()`: after existing validation (line ~66), if `params.endNodeId` is provided, validate it references a node in `params.nodes`. Throw `WorkflowValidationError` if not found.
   - In `updateWorkflow()`: if `params.endNodeId` is provided (and not `null`), validate it references a node in the effective node list (either `params.nodes` if being updated, or `existing.nodes`).
2. Add unit tests in `packages/daemon/tests/unit/space/space-workflow.test.ts`:
   - Test: creating a workflow with valid `endNodeId` succeeds.
   - Test: creating a workflow with invalid `endNodeId` (not in nodes list) throws `WorkflowValidationError`.
   - Test: updating `endNodeId` to a valid node succeeds.
   - Test: updating `endNodeId` to an invalid node throws.
   - Test: setting `endNodeId` to `null` clears it without error.

**Acceptance criteria:**
- Invalid `endNodeId` references are rejected at create/update time.
- `null` clears the field without validation error.
- All existing workflow manager tests pass.

**Dependencies:** Task 1, Task 2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 8: Integration tests for end-node workflow completion

**Description:** Add integration-level tests that verify the full end-node completion flow: end node finishes -> CompletionDetector detects -> runtime transitions run to completed.

**Agent type:** coder

**Subtasks:**
1. Add or extend tests in `packages/daemon/tests/unit/space/space-runtime-completion.test.ts`:
   - Test: workflow with `endNodeId` -- when end node task calls `report_done`, the next `processRunTick` transitions the run to `completed`.
   - Test: workflow with `endNodeId` -- when a non-end node completes but end node is still running, the run remains `in_progress`.
   - Test: workflow without `endNodeId` -- existing all-agents-done behavior is unchanged (backward compat).
   - Test: workflow with `endNodeId` where the end node task status is `needs_attention` (terminal) -- run completes.
2. Verify that removing `report_workflow_done` does not break any existing integration test scenarios. If any tests relied on it, update them to use the end-node completion path instead.

**Acceptance criteria:**
- Integration tests prove the full lifecycle: end node `report_done` -> tick -> run completed.
- Backward compatibility: workflows without `endNodeId` still complete via all-agents-done.
- All existing runtime completion tests pass.

**Dependencies:** Task 2, Task 3, Task 4, Task 5, Task 6a

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
