# Milestone 5: Frontend -- Agent Creation UI

## Goal

Build the frontend UI for creating, editing, and managing custom agents within a room. Users should be able to define agents with custom names, models, tools, and system prompts from the room settings.

## Scope

- New `CustomAgentEditor` component for creating/editing custom agents
- `CustomAgentList` component showing all custom agents in a room
- Integration into the existing Room tabs (alongside the Agents tab)
- Real-time updates via DaemonHub events
- E2E tests for the agent creation flow

---

### Task 5.1: Custom Agent List and Detail Components

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.4

**Description:**

Create the frontend components for listing and viewing custom agent definitions within a room.

**Subtasks:**

1. Create `packages/web/src/components/room/CustomAgentList.tsx`:
   - Fetches agents via `connectionManager.request('customAgent.list', { roomId })`
   - Displays agents in a card list with: name, description, model, role badge
   - "Create Agent" button at the top
   - Click on agent card opens the editor
   - Subscribe to `customAgent.created/updated/deleted` events for real-time updates
   - Use existing UI patterns from `RoomAgents.tsx` (model family icons, compact layout)

2. Create `packages/web/src/components/room/CustomAgentDetail.tsx`:
   - Read-only detail view of a custom agent
   - Shows: name, description, model/provider, tools list, system prompt preview, role
   - "Edit" and "Delete" action buttons
   - Delete confirmation modal (reuse pattern from existing modals)

3. Add `CustomAgent` type to the frontend:
   - Import from `@neokai/shared` (already exported from Milestone 1)
   - Add to room-store signals if needed for real-time state

4. Write unit tests:
   - CustomAgentList renders correctly with mock agents
   - CustomAgentList handles empty state
   - Real-time update subscription works

**Acceptance criteria:**
- Agent list displays all custom agents in the room
- Cards show key information at a glance
- Real-time updates when agents are created/modified/deleted
- Follows existing UI design patterns
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5.2: Custom Agent Editor Form

**Agent:** coder
**Priority:** high
**Depends on:** Task 5.1

**Description:**

Build the form for creating and editing custom agents with model selection, tool configuration, and system prompt editing.

**Subtasks:**

1. Create `packages/web/src/components/room/CustomAgentEditor.tsx`:
   - Form fields:
     - **Name**: text input with validation (required, unique within room)
     - **Description**: textarea
     - **Role**: dropdown/radio (`worker`, `reviewer`, `orchestrator`)
     - **Model**: reuse the `ModelPicker` component from `RoomAgents.tsx` -- fetches available models via `connectionManager.request('models.list')`
     - **Provider**: auto-detected from model selection or manual override dropdown
     - **Tools**: multi-select checklist of available tools (Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch, Task, TaskOutput, TaskStop)
     - **System Prompt**: code editor textarea with monospace font, line numbers optional
   - Tool presets: "Full Coding" (all tools), "Read Only" (Read, Grep, Glob), "Custom" (manual selection)
   - "Save" button calls `customAgent.create` or `customAgent.update` RPC
   - "Cancel" button returns to list view
   - Loading states and error handling with toast notifications

2. Add form validation:
   - Name required and unique (check against existing agents via local state)
   - Model required
   - At least one tool selected
   - System prompt can be empty (will use default behavior)

3. Add system prompt templates:
   - "Coder" template: includes git workflow, testing instructions
   - "Reviewer" template: includes review criteria, feedback format
   - "Research" template: includes analysis and documentation format
   - "Custom" template: blank slate

4. Write unit tests:
   - Form renders all fields
   - Validation prevents invalid submissions
   - Create mode vs edit mode
   - Tool preset selection

**Acceptance criteria:**
- Users can create custom agents with all configurable fields
- Model picker reuses existing infrastructure
- Tool selection is intuitive with presets
- System prompt templates provide a starting point
- Form validation prevents invalid agents
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5.3: Integrate Custom Agents Tab into Room UI

**Agent:** coder
**Priority:** normal
**Depends on:** Task 5.2

**Description:**

Integrate the custom agent components into the Room island, add navigation, and create e2e tests.

**Subtasks:**

1. Update `packages/web/src/islands/Room.tsx`:
   - Add "Custom Agents" as a sub-section within the existing "Agents" tab, or as a new dedicated tab
   - Route between agent list, detail, and editor views within the tab
   - Consider a split layout: built-in agent config (existing `RoomAgents`) on top, custom agents below

2. Update `packages/web/src/components/room/index.ts`:
   - Export new components

3. Update the room-store if needed:
   - Add `customAgents` signal for real-time state
   - Subscribe to custom agent events when a room is selected

4. Add task creation integration:
   - When creating a task via the room agent or manually, allow selecting a custom agent from a dropdown alongside built-in agent types
   - Update the `create_task` room agent tool to accept custom agent references

5. Write e2e tests:
   - Create a custom agent from the room UI
   - Verify it appears in the list
   - Edit the agent and verify changes persist
   - Delete the agent and verify removal
   - Create a task assigned to a custom agent

**Acceptance criteria:**
- Custom agents are accessible from the room UI
- Full CRUD flow works end-to-end
- Task assignment to custom agents works
- E2E tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
