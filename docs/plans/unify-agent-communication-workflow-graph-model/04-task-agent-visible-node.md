# Milestone 4: Task Agent as a First-Class Visible Node

## Goal

Make the Task Agent a visible, configurable participant in the visual workflow editor. Render it as a pinned node with a distinct style. Auto-create default bidirectional channels between the Task Agent node and newly added workflow nodes. Users can remove Task Agent channels if desired.

## Scope

- Add a Task Agent node representation in the visual editor canvas
- Distinct visual style (different color/shape, non-deletable, always present at top of canvas)
- Auto-create bidirectional channel entries when new nodes are added to the workflow
- Allow users to remove Task Agent channels (no forced connections)
- Task Agent node participates in the same layout algorithm
- Channel edges to/from Task Agent are rendered on the canvas like any other channel

## Tasks

### Task 4.1: Add Task Agent node to visual editor data model

**Description:** Extend the visual editor's data model to include a Task Agent node. This node is always present in the workflow, pinned to the top of the canvas, and non-deletable.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/shared/src/types/space.ts`:
   - Define a constant `TASK_AGENT_NODE_ID = '__task_agent__'` — the Task Agent is a **virtual node** that is never persisted in the DB's `space_workflow_nodes` table
   - The Task Agent node is injected at runtime by the frontend (serialization) and by the backend (channel resolution at workflow run start)
   - Task Agent channels ARE persisted as regular `WorkflowChannel` entries (with `from: 'task-agent'` or `to: 'task-agent'` roles) — these are the same channels auto-generated in Milestone 3's Task 3.3; M4 makes them user-visible and editable in the frontend, replacing the backend-only auto-generation with persisted, user-manageable channel entries
3. In `packages/web/src/components/space/visual-editor/types.ts`:
   - Add any types needed for the Task Agent node representation
4. In `packages/web/src/components/space/visual-editor/serialization.ts`:
   - When deserializing a workflow, always include the Task Agent node in the node list
   - When serializing, strip the Task Agent node from the persisted nodes (it's virtual)
5. In `packages/web/src/components/space/visual-editor/layout.ts`:
   - Include Task Agent node in layout computation
   - Pin it to the top-center of the canvas
6. Run `bun run typecheck`.
7. Write unit tests for serialization with Task Agent node.

**Acceptance Criteria:**
- Task Agent node always appears in the visual editor data model
- Serialization round-trip handles the virtual Task Agent node correctly
- Layout places Task Agent at the top of the canvas

**Dependencies:** Milestone 2 (types are `WorkflowNode`), Milestone 3 (Task Agent uses same messaging)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.2: Render Task Agent node on the canvas

**Description:** Render the Task Agent as a visually distinct node on the workflow canvas. It should have a different color/shape than regular nodes, show a "Task Agent" label, and not be deletable.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/web/src/components/space/visual-editor/WorkflowNode.tsx`:
   - Detect when the node is the Task Agent node (by ID or a `isTaskAgent` flag)
   - Render with a distinct visual style: different background color (e.g., amber/gold), a badge or icon indicating "Task Agent", rounded or octagonal shape
   - Hide the delete button for the Task Agent node
   - Hide the input port (Task Agent is not a target of workflow transitions, only of channels)
3. In `packages/web/src/components/space/visual-editor/WorkflowCanvas.tsx`:
   - Include the Task Agent node in the rendered node list
   - Ensure it renders above other nodes (z-index or render order)
4. In `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx`:
   - Prevent deletion of the Task Agent node in the delete handler
   - Prevent the Task Agent from being part of workflow transitions (it's not a step in the execution flow)
5. Run `bun run typecheck` and `bun run lint`.
6. Write visual editor tests:
   - Test that Task Agent node is always rendered
   - Test that Task Agent node cannot be deleted
   - Test distinct visual styling

**Acceptance Criteria:**
- Task Agent appears as a visually distinct, pinned node on the canvas
- Cannot be deleted or used as a transition source/target
- Visual style is clearly different from regular workflow nodes

**Dependencies:** Task 4.1

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.3: Auto-create Task Agent channels on node addition

**Description:** When a user adds a new node to the workflow, automatically create a default bidirectional channel between the Task Agent and the new node. Users can subsequently remove these channels if desired.

**Subtasks:**
1. Run `bun install` at worktree root.
2. In `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx` (or the appropriate handler):
   - When a new node is added (via the "Add Node" action), auto-add a bidirectional `WorkflowChannel` entry: `{ from: 'task-agent', to: <new-node-agent-role>, direction: 'bidirectional' }`
   - For multi-agent nodes, add channels for each agent role in the node
3. In `packages/web/src/components/space/visual-editor/NodeConfigPanel.tsx`:
   - Show Task Agent channels in the channel configuration panel
   - Allow users to remove Task Agent channels (same UI as other channels)
4. In the edge rendering:
   - Render edges between the Task Agent node and other nodes for each declared channel
   - These are distinct from workflow transition edges (different visual style -- dashed line or different color for communication channels vs execution flow)
5. **Remove M3 runtime auto-generation of Task Agent channels:** In `packages/daemon/src/lib/space/runtime/space-runtime.ts` (or equivalent), remove the logic added in Task 3.3 that auto-generates default bidirectional channels between the Task Agent and all node agents at workflow run start. Task Agent channels are now persisted as user-configurable `WorkflowChannel` entries created by the frontend (this task). The backend should read persisted channels only — no more runtime auto-generation. This prevents duplicate channels when both M3 and M4 are active.
6. Run `bun run typecheck` and `bun run lint`.
7. Write tests:
   - Test that adding a node auto-creates Task Agent channels
   - Test that removing a Task Agent channel works
   - Test that channel edges are rendered on the canvas
   - Test that no duplicate Task Agent channels are created at runtime (runtime auto-generation removed)

**Acceptance Criteria:**
- Adding a new node automatically creates bidirectional Task Agent <-> node channels
- Channels are visible in the channel config panel
- Users can remove Task Agent channels
- Channel edges are rendered on the canvas
- M3 runtime auto-generation logic is removed — Task Agent channels are sourced exclusively from persisted workflow data

**Dependencies:** Task 4.2

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.4: E2E tests for Task Agent visible node

**Description:** Write Playwright e2e tests for the Task Agent node in the visual workflow editor.

**Subtasks:**
1. Run `bun install` at worktree root.
2. Add e2e test scenarios to `packages/e2e/tests/features/visual-workflow-editor.e2e.ts` (or a new file):
   - Test that Task Agent node is always visible when opening the visual editor
   - Test that Task Agent node cannot be deleted (Delete key, right-click menu)
   - Test that adding a new node shows Task Agent channel edges on the canvas
   - Test that channels to the Task Agent can be removed via the config panel
   - Test that Task Agent node has distinct visual styling (check CSS classes or data attributes)
3. Run the e2e test to verify: `make run-e2e TEST=tests/features/visual-workflow-editor.e2e.ts`

**Acceptance Criteria:**
- E2E tests cover all Task Agent node interactions
- Tests pass reliably in CI environment

**Dependencies:** Task 4.3

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
