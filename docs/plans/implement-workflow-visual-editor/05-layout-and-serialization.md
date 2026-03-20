# Milestone 5: Layout, Serialization, and Templates

## Goal

Implement automatic DAG layout for initial node positioning, bidirectional serialization between the visual editor's internal state and the `SpaceWorkflow` data model, position persistence using the `layout` column, and template support.

## Tasks

### Task 5.1: DAG auto-layout algorithm

**Description**: Implement a simple layered DAG layout algorithm that assigns x/y positions to nodes. The algorithm performs topological sorting, assigns layers (y-axis), and spaces nodes within each layer (x-axis). This is used for initial layout when opening a workflow that has no saved positions (legacy workflow or first visual edit).

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/layout.ts`:
   - `autoLayout(steps, transitions, startStepId)` -> `Map<string, Point>`
   - Perform topological sort starting from `startStepId` following transitions
   - Assign layers: each step's layer = max(predecessor layers) + 1
   - Within each layer, space nodes horizontally with fixed gaps (e.g., 250px horizontal, 150px vertical)
   - Center each layer horizontally relative to the widest layer
   - Handle orphaned nodes (not reachable from start) by appending them in a final row
2. Add comprehensive tests: linear chain layout, branching layout, single node, orphaned nodes, cyclic graph handling (break cycles gracefully)

**Acceptance criteria**:
- Linear workflows lay out as a vertical chain
- Branching workflows spread nodes horizontally per layer
- Orphaned nodes are placed below the main graph
- No node overlaps
- Algorithm handles edge cases (empty workflow, single step, cycles)
- Tests pass

**Dependencies**: None (pure algorithm, no UI dependency — can be started in parallel with Milestones 1-3)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 5.2: Serialize visual state to SpaceWorkflow data model

**Description**: Build serialization functions that convert between the visual editor's internal state (nodes with positions, edges with conditions) and the `SpaceWorkflow` data model used by the backend. The `startStepId` is explicitly managed by the user (via "Set as Start" in the config panel), not inferred by heuristics.

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/serialization.ts`:
   - `workflowToVisualState(workflow: SpaceWorkflow)`: Convert SpaceWorkflow to visual editor state. If `workflow.layout` exists, use stored positions; otherwise compute positions via `autoLayout`.
   - `visualStateToWorkflowParams(state)`: Convert visual state back to `CreateSpaceWorkflowParams` or `UpdateSpaceWorkflowParams` — produces `steps[]`, `transitions[]`, `startStepId`, `rules[]`, and `layout` (current node positions)
   - `startStepId` is passed through from the editor state (explicitly set by user), not auto-detected
   - Compute transition `order` from visual position (left-to-right within outgoing edges of a node)
2. Reuse and extend the existing `initFromWorkflow` logic from `WorkflowEditor.tsx` where applicable
3. Add tests: round-trip serialization (workflow -> visual -> workflow produces equivalent data), position restoration from layout field, transition ordering

**Acceptance criteria**:
- Existing workflows can be loaded into the visual editor without data loss
- Workflows with saved `layout` data restore node positions correctly
- Workflows without `layout` data get auto-layout positions
- Visual editor state can be saved back as valid SpaceWorkflow parameters including layout
- Transition order is preserved
- Round-trip serialization is lossless for supported workflow structures
- Tests pass

**Dependencies**: Tasks 1.1 (layout column), 5.1 (auto-layout)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 5.3: Template support in visual editor

**Description**: Port the "Start from template" functionality from the existing `WorkflowEditor` to the visual editor. Templates populate the editor with pre-defined steps, transitions, and auto-layout positions.

**Agent type**: coder

**Subtasks**:
1. Import the `TEMPLATES` array from the existing `WorkflowEditor.tsx` (or extract to a shared module if needed)
2. Add a "Start from template" dropdown/button in the visual editor toolbar (consistent with the existing form editor's UX)
3. When a template is selected: populate steps and transitions from the template, compute positions via `autoLayout`, set `startStepId` from the template, and reset the viewport to fit-to-view
4. Only show the template button when creating a new workflow (not when editing an existing one)
5. Add tests: template selection populates nodes and edges, layout is computed correctly

**Acceptance criteria**:
- All existing templates are available in the visual editor
- Selecting a template populates the canvas with correctly positioned nodes and edges
- Template button is hidden when editing an existing workflow
- Tests pass

**Dependencies**: Tasks 5.1 (auto-layout), 6.1 (orchestrator component)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
