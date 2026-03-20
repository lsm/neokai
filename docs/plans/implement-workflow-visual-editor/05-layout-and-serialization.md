# Milestone 5: Auto-Layout and Serialization

## Goal

Implement automatic DAG layout for initial node positioning and bidirectional serialization between the visual editor's internal state and the `SpaceWorkflow` data model.

## Tasks

### Task 5.1: DAG auto-layout algorithm

**Description**: Implement a simple layered DAG layout algorithm that assigns x/y positions to nodes. The algorithm performs topological sorting, assigns layers (y-axis), and spaces nodes within each layer (x-axis). This is used for initial layout when opening an existing workflow in the visual editor (since `SpaceWorkflow` does not store position data).

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

**Dependencies**: None (pure algorithm, no UI dependency)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 5.2: Serialize visual state to SpaceWorkflow data model

**Description**: Build serialization functions that convert between the visual editor's internal state (nodes with positions, edges with conditions) and the `SpaceWorkflow` data model used by the backend. Also handle position persistence by storing node positions in a metadata field or computing them on load via auto-layout.

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/serialization.ts`:
   - `workflowToVisualState(workflow: SpaceWorkflow)`: Convert SpaceWorkflow to visual editor state (steps as StepDraft with positions via auto-layout, transitions as ConditionDraft with from/to)
   - `visualStateToWorkflowParams(state)`: Convert visual state back to `CreateSpaceWorkflowParams` or `UpdateSpaceWorkflowParams` -- produces `steps[]`, `transitions[]`, `startStepId`, `rules[]`
   - Determine `startStepId` from the node with no incoming edges (or the topmost node if ambiguous)
   - Compute transition `order` from visual position (left-to-right within outgoing edges of a node)
2. Reuse and extend the existing `initFromWorkflow` logic from `WorkflowEditor.tsx` where applicable
3. Add tests: round-trip serialization (workflow -> visual -> workflow produces equivalent data), start step detection, transition ordering

**Acceptance criteria**:
- Existing workflows can be loaded into the visual editor without data loss
- Visual editor state can be saved back as valid SpaceWorkflow parameters
- Start step is correctly identified
- Transition order is preserved
- Round-trip serialization is lossless for supported workflow structures
- Tests pass

**Dependencies**: Task 5.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
