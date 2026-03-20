# Milestone 6: Integration and Toggle

## Goal

Wire the visual editor into the existing Space workflow tab, add a view toggle between list and visual modes, and compose all milestone components into the final `VisualWorkflowEditor` orchestrator component.

## Tasks

### Task 6.1: Build VisualWorkflowEditor orchestrator component

**Description**: Create the top-level `VisualWorkflowEditor` component that composes the canvas, nodes, edges, configuration panel, and toolbar into a complete visual editing experience. This component manages all visual editor state and handles save/cancel.

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx`:
   - Props: same interface as existing `WorkflowEditor` (`workflow?: SpaceWorkflow`, `onSave`, `onCancel`)
   - Internal state: `steps` (StepDraft[]), `transitions` (ConditionDraft[] with from/to), `nodePositions` (Map), `selectedNodeId`, `selectedEdgeId`, `viewportState`, `rules` (RuleDraft[]), `tags` (string[])
   - On mount: if editing existing workflow, use `workflowToVisualState` + `autoLayout` to initialize positions
   - Compose: `VisualCanvas` with `CanvasToolbar`, `WorkflowNode` for each step, `EdgeRenderer` for transitions, `NodeConfigPanel` or `EdgeConfigPanel` based on selection
   - Add "Add Step" button in the toolbar that creates a new node at center of viewport
   - Header bar with workflow name/description inputs, Save/Cancel buttons (reuse layout from existing `WorkflowEditor`)
   - Include `WorkflowRulesEditor` and tags section below the canvas (collapsible)
   - On save: use `visualStateToWorkflowParams` to produce params, call `spaceStore.createWorkflow` or `spaceStore.updateWorkflow`
2. Wire up all event handlers: node drag, node select, port drag, edge select, edge delete, node delete, condition updates
3. Add integration tests: component renders with empty workflow, component renders with existing workflow, save produces valid params

**Acceptance criteria**:
- Visual editor renders existing workflows correctly
- New workflows can be created from scratch
- All editing operations work: add/remove/drag nodes, create/delete edges, edit properties via config panel
- Save produces valid SpaceWorkflow parameters
- Cancel returns to list view without changes
- Tests pass

**Dependencies**: All tasks from Milestones 1-5

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 6.2: Add view toggle in SpaceIsland workflows tab

**Description**: Add a "List" / "Visual" toggle in the workflow editor view so users can choose between the existing form-based editor and the new visual editor. The toggle is shown in the workflow editor header.

**Agent type**: coder

**Subtasks**:
1. Update `packages/web/src/islands/SpaceIsland.tsx`:
   - Add `editorMode` state: `'list' | 'visual'` (default: `'list'` to preserve backward compatibility)
   - When `workflowEditId` is set and `editorMode === 'visual'`, render `VisualWorkflowEditor` instead of `WorkflowEditor`
   - Pass the same `workflow`, `onSave`, `onCancel` props to whichever editor is active
2. Add a toggle button group in the workflow editor header area (small pill-style toggle: "List | Visual")
3. Persist the user's editor mode preference in localStorage
4. Add tests: toggle switches between editors, both editors receive correct props

**Acceptance criteria**:
- Toggle is visible when editing/creating a workflow
- Switching modes preserves the workflow being edited (or created)
- Default mode is "List" for backward compatibility
- Preference persists across page reloads
- Tests pass

**Dependencies**: Task 6.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 6.3: Update existing tests for compatibility

**Description**: Ensure all existing workflow-related tests still pass after the integration. Update any tests that may break due to extracted components (e.g., `GateConfig` moved to shared file) or new imports.

**Agent type**: coder

**Subtasks**:
1. Run existing test suites: `WorkflowEditor.test.tsx`, `WorkflowList.test.tsx`, `WorkflowStepCard.test.tsx`, `WorkflowRulesEditor.test.tsx`
2. Fix any import path changes from extracting `GateConfig`
3. Update `WorkflowStepCard.test.tsx` if `GateConfig` was extracted
4. Verify all tests pass: `cd packages/web && bunx vitest run`
5. Run linter and type checker: `bun run lint && bun run typecheck`

**Acceptance criteria**:
- All existing workflow tests pass without modification (or with minimal import fixes)
- No lint errors or type errors introduced
- `bun run check` passes clean

**Dependencies**: Tasks 6.1, 6.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
