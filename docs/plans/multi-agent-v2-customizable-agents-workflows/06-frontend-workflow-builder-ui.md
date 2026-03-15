# Milestone 6: Frontend -- Workflow Builder UI

## Goal

Build the visual workflow builder UI for composing agents into step sequences with gates and rules. Users should be able to create workflows by adding agent steps, configuring gates between them, and defining rules.

## Dependency Clarification

**M6 depends only on M3 (Workflow Data Model), NOT M4 (Workflow Runtime Engine).** The workflow builder is a pure data management UI — it creates and edits workflow definitions via RPC. The runtime engine (M4) consumes these definitions at execution time but is not needed for the builder UI. This allows M6 to proceed in parallel with M4 once M3 is complete.

## Shared State Design

Workflow state in `room-store.ts` follows the same pattern as custom agents:

```typescript
// In room-store.ts (alongside customAgents signal from M5)
const workflows = signal<Workflow[]>([]);

// Fetched when a room is selected
// Updated in real-time via DaemonHub events: workflow.created, workflow.updated, workflow.deleted
```

Both `customAgents` and `workflows` signals share the same reactive pattern. If M5 and M6 are implemented by different developers, they should coordinate on the `room-store.ts` signal shape to avoid conflicts.

## Scope

- Workflow list component
- Visual workflow builder/editor
- Step configuration with gate selection
- Rule editor
- Integration into Room UI
- E2E tests

---

### Task 6.1: Workflow List and Basic CRUD UI

**Agent:** coder
**Priority:** high
**Depends on:** Task 3.4

**Description:**

Create the frontend components for listing workflows and managing them within a room.

**Subtasks:**

1. Create `packages/web/src/components/room/WorkflowList.tsx`:
   - Fetches workflows via `connectionManager.request('workflow.list', { roomId })`
   - Displays workflows as cards with: name, description, step count, default badge, tag chips
   - "Create Workflow" button
   - "Set as Default" action per workflow
   - Click to open editor
   - Real-time updates via `workflow.created/updated/deleted` events

2. Create `packages/web/src/components/room/WorkflowCard.tsx`:
   - Compact card showing workflow name, step count, and a mini step visualization (horizontal dots/icons)
   - Default workflow gets a highlighted border
   - Actions: Edit, Duplicate, Delete, Set Default

3. Add workflow state to room-store:
   - `workflows` signal in `room-store.ts`
   - Subscribe to workflow events when room is selected
   - Fetch on room selection

4. Write unit tests:
   - WorkflowList renders with mock workflows
   - WorkflowList handles empty state with "Create your first workflow" prompt
   - Card actions trigger correct RPC calls

**Acceptance criteria:**
- Workflow list displays all workflows in the room
- Default workflow is visually highlighted
- CRUD actions work correctly
- Real-time updates work
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 6.2: Workflow Step Builder

**Agent:** coder
**Priority:** high
**Depends on:** Task 6.1

**Description:**

Build the core workflow editor -- a visual step builder where users add, reorder, and configure agent steps in a workflow.

**Subtasks:**

1. Create `packages/web/src/components/room/WorkflowEditor.tsx`:
   - Main editor layout with:
     - Workflow name and description fields at top
     - Vertical step list in the center (each step is a card)
     - "Add Step" button at the bottom
     - Save/Cancel buttons
   - Step cards show: step number, agent name, entry/exit gate icons, instructions preview
   - Drag-and-drop step reordering (use simple up/down buttons for MVP, drag later)

2. Create `packages/web/src/components/room/WorkflowStepCard.tsx`:
   - Expandable card for a single workflow step
   - Collapsed: shows step number, agent name, gate types
   - Expanded: shows full configuration
   - Fields:
     - **Name**: text input
     - **Agent**: dropdown populated from built-in agents (`planner`, `coder`, `general` — NOT `leader`) + custom agents in the room (from `customAgents` signal)
     - **Entry Gate**: gate type selector (auto, human_approval, quality_check, pr_review, custom)
     - **Exit Gate**: gate type selector
     - **Instructions**: textarea for step-specific instructions
   - Remove step button (with confirmation for non-empty steps)

3. Gate configuration sub-form:
   - When gate type is `quality_check`, show a dropdown of allowlisted commands (not a free-form text input)
   - When gate type is `custom`, show a command input field with hint: "Relative path to script in workspace (e.g., scripts/check.sh)"
   - `human_approval` and `pr_review` need no additional config
   - Description field for all gate types
   - Optional timeout field for `quality_check` and `custom` gates

4. Built-in workflow templates:
   - "Start from template" option when creating a new workflow
   - Templates: "Coding (Plan -> Code)", "Research (Plan -> Research)", "Quick Fix (Code only)"
   - Note: Templates do not include Leader as a step (Leader is implicit per group)
   - Template populates steps and gates with sensible defaults

5. Write unit tests:
   - Step adding and removal
   - Step reordering
   - Agent selection populates correctly (built-in agents exclude 'leader')
   - Gate configuration forms render correctly
   - Quality check gate shows allowlisted commands only

**Acceptance criteria:**
- Users can build multi-step workflows visually
- Steps can be added, removed, and reordered
- Agent selection includes built-in agents (excluding 'leader') and custom agents
- Gate configuration is intuitive with security constraints visible
- Templates provide quick-start options
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 6.3: Workflow Rules Editor and Integration

**Agent:** coder
**Priority:** normal
**Depends on:** Task 6.2

**Description:**

Add the rule editor to the workflow builder and integrate the entire workflow UI into the Room island.

**Subtasks:**

1. Create `packages/web/src/components/room/WorkflowRulesEditor.tsx`:
   - List of rules with name and content preview
   - "Add Rule" button
   - Each rule has:
     - Name input
     - Content textarea (Markdown-friendly)
     - "Applies to" multi-select of step names (empty = all steps)
     - Remove button
   - Rules are stored as part of the workflow and saved together

2. Add tags editor to WorkflowEditor:
   - Tag input field (comma-separated or chip input)
   - Common tag suggestions: "coding", "review", "research", "design", "deployment"

3. Integrate into Room UI:
   - Add "Workflows" tab to `Room.tsx` (or sub-section within existing layout)
   - Tab shows `WorkflowList` by default
   - Click to create/edit opens `WorkflowEditor`
   - Back navigation returns to list

4. Update `packages/web/src/components/room/index.ts` exports

5. Write e2e tests:
   - Create a workflow with 3 steps from template
   - Add a custom rule
   - Save and verify it persists
   - Set as default workflow
   - Edit an existing workflow
   - Delete a workflow

**Acceptance criteria:**
- Rules can be created and associated with specific steps
- Tags help categorize workflows
- Workflow tab is integrated into Room UI
- Full workflow CRUD flow works end-to-end
- E2E tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
