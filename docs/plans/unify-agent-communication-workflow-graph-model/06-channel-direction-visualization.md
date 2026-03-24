# Milestone 6: Channel Direction Visualization

## Goal

Show channel direction (bidirectional vs one-way) visually on the canvas edges in the visual workflow editor. Bidirectional channels display double-headed arrows; one-way channels display a single arrowhead. This makes the messaging topology inspectable at a glance.

## Scope

- Render channel edges (distinct from transition edges) on the canvas
- Bidirectional channels (`direction: 'bidirectional'`): double-headed arrow on the edge
- One-way channels (`direction: 'one-way'`): single arrowhead on the edge

**IMPORTANT:** The actual type values in `packages/shared/src/types/space.ts` are `'one-way' | 'bidirectional'` — use these exact string literals in all comparisons, NOT `'unidirectional'`.
- Channel edges use a different visual style from transition edges (e.g., dashed lines, different colors)
- Channels to/from the Task Agent node are rendered as edges like any other channel
- Edge labels or tooltips show channel participants (e.g., "coder <-> reviewer")

## Tasks

### Task 6.1: Add channel edge rendering to EdgeRenderer

**Description:** Extend `EdgeRenderer.tsx` to render channel edges alongside transition edges. Channel edges connect nodes that have declared messaging channels and use distinct visual styling.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/web/src/components/space/visual-editor/EdgeRenderer.tsx`:
   - Add a new `channels` prop (array of `WorkflowChannel` with resolved source/target node IDs)
   - Render channel edges with a distinct style:
     - Dashed stroke pattern to differentiate from solid transition edges
     - Color: green or teal for channels (distinct from blue/yellow/purple transition colors)
   - For **bidirectional** channels (`direction === 'bidirectional'`): render with `marker-start` and `marker-end` (double arrowheads)
   - For **one-way** channels (`direction === 'one-way'`): render with `marker-end` only (single arrowhead pointing to target)
   - Add SVG marker definitions for channel arrowheads (distinct from transition arrowheads)
   - Channel edges connect between the side ports of nodes (left/right) rather than top/bottom to avoid confusion with transition edges
3. Add `data-testid` attributes for channel edges: `data-testid="channel-edge-{from}-{to}"`
4. Run `bun run typecheck` and `bun run lint`.
5. Write unit tests:
   - Test bidirectional channel renders two arrowheads
   - Test one-way channel renders one arrowhead
   - Test channel edges use dashed style
   - Test channel edges are distinct from transition edges

**Acceptance Criteria:**
- Channel edges rendered with correct arrowhead direction
- Visual distinction between channel edges and transition edges
- Both bidirectional and one-way styles are correct

**Dependencies:** Milestone 4 (Task Agent visible as node with channels)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.2: Integrate channel edges into WorkflowCanvas

**Description:** Update `WorkflowCanvas.tsx` to compute and pass channel edge data to `EdgeRenderer`. Resolve channel declarations from the workflow into renderable edge data with source/target node positions.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/web/src/components/space/visual-editor/WorkflowCanvas.tsx`:
   - Collect all `WorkflowChannel` declarations from all nodes in the workflow
   - Resolve channel endpoints to node IDs:
     - For intra-node channels (agents within the same node), render a loopback edge or skip (channels within a single node don't need cross-node edges)
     - For Task Agent channels, resolve the Task Agent node ID and the target node ID
   - Pass the resolved channel edge data to `EdgeRenderer`
3. In `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx`:
   - Ensure channel data flows through to the canvas
4. Handle edge cases:
   - Nodes with no channels: no channel edges rendered
   - Task Agent with channels to all nodes: multiple channel edges from the Task Agent node
5. Run `bun run typecheck` and `bun run lint`.
6. Write tests:
   - Test channel edges appear for declared channels
   - Test no channel edges for nodes without channels
   - Test Task Agent channel edges render correctly

**Acceptance Criteria:**
- Channel edges appear on the canvas for all declared channels
- Direction (bidirectional/one-way) is visually correct
- Task Agent channel edges render properly
- No visual clutter when many channels exist

**Dependencies:** Task 6.1

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.3: E2E tests for channel direction visualization

**Description:** Write Playwright e2e tests verifying that channel direction is correctly displayed in the visual workflow editor.

**Subtasks:**
1. Run `bun install` at worktree root.
2. Add e2e test scenarios:
   - Create a workflow with bidirectional channels, verify double-arrowhead edges appear
   - Create a workflow with one-way channels, verify single-arrowhead edges appear
   - Verify Task Agent channel edges are rendered
   - Verify channel edges are visually distinct from transition edges (check CSS/data attributes)
   - Verify channel direction changes are reflected immediately when editing channels in the config panel
3. Run the e2e test: `make run-e2e TEST=tests/features/visual-workflow-editor.e2e.ts`

**Acceptance Criteria:**
- E2E tests verify correct arrowhead rendering for both directions
- Tests pass reliably

**Dependencies:** Task 6.2

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
