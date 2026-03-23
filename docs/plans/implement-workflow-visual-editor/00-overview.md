# Implement Workflow Visual Editor

## Goal

Replace the current linear, form-based `WorkflowEditor` with a visual, canvas-based editor that supports drag-and-drop node placement, visual edge connections between steps, and an integrated configuration panel for editing node properties. The editor must work with the existing `SpaceWorkflow` directed-graph data model (steps as nodes, transitions as edges) and preserve full compatibility with the existing backend API (SpaceWorkflowManager, RPC handlers).

## Current State

- **Backend**: Complete workflow CRUD via `SpaceWorkflowManager`, `SpaceWorkflowRepository`, and RPC handlers (`space-workflow-handlers.ts`). Data model is a directed graph with `WorkflowStep[]` (nodes) and `WorkflowTransition[]` (edges).
- **Frontend**: `WorkflowEditor.tsx` is a form-based, vertically-stacked step list. `WorkflowStepCard.tsx` renders individual steps with expand/collapse editing. `WorkflowList.tsx` shows workflow cards with mini step visualizations. Includes "Start from template" functionality via `TEMPLATES` array.
- **Types**: `SpaceWorkflow`, `WorkflowStep`, `WorkflowTransition`, `WorkflowCondition` defined in `packages/shared/src/types/space.ts`.
- **Tests**: Unit tests exist for `WorkflowEditor`, `WorkflowList`, `WorkflowStepCard`, `WorkflowRulesEditor` in `packages/web/src/components/space/__tests__/`.

## Approach

Build a custom canvas-based visual editor using SVG for edge rendering and absolutely-positioned DOM nodes (not a third-party library like React Flow, since this is a Preact project with no React compatibility layer). The editor will:

1. Render workflow steps as draggable node cards on a pannable/zoomable canvas
2. Draw SVG edges (bezier curves) between connected nodes
3. Provide a side configuration panel for editing the selected node's properties
4. Support adding nodes via toolbar, removing nodes, and creating/removing connections by dragging from node ports
5. Auto-layout nodes using a simple DAG layout algorithm
6. Persist node positions in a `layout` metadata field on the workflow (requires a small backend migration)
7. Serialize/deserialize to the existing `SpaceWorkflow` data model
8. Integrate as a toggle ("Visual" / "List") in the existing workflow editor flow
9. Preserve existing features: template support, tags, rules editing

### Position Persistence Strategy

Node positions are persisted in a `layout` JSON column on the `workflows` table. The column stores a `Record<stepId, {x, y}>` mapping. When a workflow is opened in the visual editor:
- If `layout` data exists, use the stored positions
- If no `layout` data exists (legacy workflow or first visual edit), compute positions via auto-layout algorithm
- Positions are saved alongside the workflow on every save

This requires a small backend migration to add the `layout` column — see Milestone 1, Task 1.1.

### Interactions

- **Pan**: Two-finger trackpad scroll, or spacebar + left-click drag (laptop-friendly; no middle-click requirement)
- **Zoom**: Pinch-to-zoom on trackpad, or Ctrl/Cmd + scroll wheel
- **Start node**: Explicitly designated via a "Set as Start" button in the node config panel; visually distinguished with a green border and "START" badge
- **Templates**: "Start from template" button in the visual editor toolbar, same as existing form editor

### Explicitly Out of Scope (V1)

- **Undo/redo**: Not included in V1. The config panel allows property editing with standard form undo (Ctrl+Z in text fields), and node deletion requires confirmation. Full canvas undo/redo (Ctrl+Z for drag, delete, connect operations) is deferred to a follow-up milestone after V1 ships and user feedback is gathered.
- **Touch device support**: Trackpad interactions are supported, but dedicated mobile/tablet touch UI is out of scope.

## Milestones

1. **Canvas Foundation & Backend Migration** (`01-canvas-foundation.md`) — Backend migration for `layout` column; pannable, zoomable SVG+DOM canvas container with coordinate system management and trackpad support
2. **Node Rendering and Drag-and-Drop** (`02-node-rendering.md`) — Render workflow steps as draggable node cards with connection ports and start-node designation
3. **Edge Rendering and Connection Creation** (`03-edge-rendering.md`) — Draw SVG bezier edges between nodes; support creating connections by dragging from ports
4. **Node Configuration Panel** (`04-configuration-panel.md`) — Side panel for editing selected node properties (name, agent, instructions, gate conditions) with "Set as Start" action
5. **Layout, Serialization, and Templates** (`05-layout-and-serialization.md`) — DAG layout algorithm for initial positioning; serialize visual state to/from SpaceWorkflow data model; position persistence; template support
6. **Integration and Toggle** (`06-integration-and-toggle.md`) — Wire the visual editor into SpaceIsland alongside the existing list editor with a view toggle
7. **Testing and Stabilization** (`07-testing-and-stabilization.md`) — Comprehensive E2E tests for drag-and-drop, connection creation, save/load round-trips; update existing tests for compatibility

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (canvas container)
- Milestone 3 depends on Milestones 1 and 2 (canvas + node positions/ports)
- Milestone 4 depends on Milestone 2 (node selection)
- Task 5.1 (auto-layout algorithm) has no dependencies and can be started in parallel with Milestones 1-3
- Task 5.2 (serialization) depends on Milestones 2 and 3 (nodes + edges to serialize)
- Task 5.3 (position persistence) depends on Task 1.1 (backend migration) and Task 5.1
- Milestone 6 depends on Milestones 1-5
- Milestone 7 depends on Milestone 6

## Estimated Total Task Count

20 tasks across 7 milestones.
