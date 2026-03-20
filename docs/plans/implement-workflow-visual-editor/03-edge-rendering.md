# Milestone 3: Edge Rendering and Connection Creation

## Goal

Draw visual edges (SVG bezier curves) between connected nodes and support creating new connections by dragging from output ports to input ports.

## Tasks

### Task 3.1: Render edges as SVG bezier curves

**Description**: Render `WorkflowTransition` entries as SVG cubic bezier paths connecting the output port of one node to the input port of another. Edge color/style reflects the transition condition type (always=blue, human=yellow, condition=purple), matching the existing `GATE_COLORS` from `WorkflowList.tsx`.

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/EdgeRenderer.tsx`:
   - Props: `transitions` (with from/to step IDs and conditions), `nodePositions` (map of step ID to position+size), `selectedEdgeId`
   - For each transition, compute source point (output port of `from` node: bottom-center) and target point (input port of `to` node: top-center) from node positions
   - Render SVG `<path>` with cubic bezier: control points offset vertically by ~60px for a smooth curve
   - Color stroke based on condition type; selected edge gets thicker stroke
   - Add invisible wider hitbox path (stroke-width ~12px, transparent) for easier click selection
2. Emit `onEdgeSelect(transitionId)` on click, `onEdgeDelete(transitionId)` on Delete key when selected
3. Add an arrowhead marker definition for edge direction
4. Add tests: correct number of paths rendered, bezier control point math, click selects edge

**Acceptance criteria**:
- Edges render as smooth bezier curves between connected nodes
- Edge color matches condition type
- Edges update position when nodes are dragged
- Edge selection works with visible feedback
- Arrowhead indicates direction
- Tests pass

**Dependencies**: Tasks 1.2, 2.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 3.2: Create connections by dragging from ports

**Description**: Allow users to create new transitions by dragging from a node's output port to another node's input port. Show a temporary "ghost" edge following the cursor during the drag.

**Agent type**: coder

**Subtasks**:
1. Create `packages/web/src/components/space/visual-editor/useConnectionDrag.ts` hook:
   - Track drag state: `{active: boolean, fromStepId, fromPort, currentMousePos}`
   - On port mousedown (output port): start drag, capture source step ID
   - On mousemove: update current mouse position (converted to canvas coordinates)
   - On mouseup over an input port: complete connection, emit `onCreateTransition(fromId, toId)`
   - On mouseup over empty space: cancel drag
2. Render a ghost edge (dashed SVG path) from source port to current mouse position during drag
3. Highlight valid drop targets (input ports of other nodes) during drag
4. Validate: prevent self-connections, prevent duplicate transitions
5. Add tests: ghost edge renders during drag, connection created on valid drop, invalid drops cancel

**Acceptance criteria**:
- Dragging from output port shows ghost edge following cursor
- Dropping on valid input port creates a new transition
- Self-connections are prevented
- Duplicate transitions are prevented
- Ghost edge disappears on cancel
- Tests pass

**Dependencies**: Tasks 3.1, 2.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
