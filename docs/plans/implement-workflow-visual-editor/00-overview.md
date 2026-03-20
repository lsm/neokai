# Implement Workflow Visual Editor

## Goal

Replace the current linear, form-based `WorkflowEditor` with a visual, canvas-based editor that supports drag-and-drop node placement, visual edge connections between steps, and an integrated configuration panel for editing node properties. The editor must work with the existing `SpaceWorkflow` directed-graph data model (steps as nodes, transitions as edges) and preserve full compatibility with the existing backend API (SpaceWorkflowManager, RPC handlers).

## Current State

- **Backend**: Complete workflow CRUD via `SpaceWorkflowManager`, `SpaceWorkflowRepository`, and RPC handlers (`space-workflow-handlers.ts`). Data model is a directed graph with `WorkflowStep[]` (nodes) and `WorkflowTransition[]` (edges).
- **Frontend**: `WorkflowEditor.tsx` is a form-based, vertically-stacked step list. `WorkflowStepCard.tsx` renders individual steps with expand/collapse editing. `WorkflowList.tsx` shows workflow cards with mini step visualizations.
- **Types**: `SpaceWorkflow`, `WorkflowStep`, `WorkflowTransition`, `WorkflowCondition` defined in `packages/shared/src/types/space.ts`.
- **Tests**: Unit tests exist for `WorkflowEditor`, `WorkflowList`, `WorkflowStepCard`, `WorkflowRulesEditor` in `packages/web/src/components/space/__tests__/`.

## Approach

Build a custom canvas-based visual editor using SVG for edge rendering and absolutely-positioned DOM nodes (not a third-party library like React Flow, since this is a Preact project with no React compatibility layer). The editor will:

1. Render workflow steps as draggable node cards on a pannable/zoomable canvas
2. Draw SVG edges (bezier curves) between connected nodes
3. Provide a side configuration panel for editing the selected node's properties
4. Support adding nodes via toolbar, removing nodes, and creating/removing connections by dragging from node ports
5. Auto-layout nodes using a simple DAG layout algorithm
6. Serialize/deserialize to the existing `SpaceWorkflow` data model
7. Integrate as a toggle ("Visual" / "List") in the existing workflow editor flow

No backend changes are required -- the visual editor produces the same `steps[]`, `transitions[]`, and `startStepId` data shape that the current form-based editor does.

## Milestones

1. **Canvas Foundation** -- Build the pannable, zoomable SVG+DOM canvas container with coordinate system management
2. **Node Rendering and Drag-and-Drop** -- Render workflow steps as draggable node cards with connection ports
3. **Edge Rendering and Connection Creation** -- Draw SVG bezier edges between nodes; support creating connections by dragging from ports
4. **Node Configuration Panel** -- Side panel for editing selected node properties (name, agent, instructions, gate conditions)
5. **Auto-Layout and Serialization** -- DAG layout algorithm for initial positioning; serialize visual state to/from SpaceWorkflow data model
6. **Integration and Toggle** -- Wire the visual editor into SpaceIsland alongside the existing list editor with a view toggle; update existing tests

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (canvas container)
- Milestone 3 depends on Milestones 1 and 2 (canvas + node positions/ports)
- Milestone 4 depends on Milestone 2 (node selection)
- Milestone 5 depends on Milestones 2 and 3 (nodes + edges to serialize)
- Milestone 6 depends on all previous milestones

## Estimated Total Task Count

16 tasks across 6 milestones.
