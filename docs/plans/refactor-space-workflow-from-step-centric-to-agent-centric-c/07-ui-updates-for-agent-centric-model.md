# Milestone 7: UI Updates for Agent-Centric Model

## Goal

Update the frontend visual editor and components to support the agent-centric model: unified channels, gate configuration, and agent completion state display.

## Scope

- Update visual workflow editor to display channels (replacing transition arrows)
- Add gate configuration UI
- Update node cards for agent completion state
- Web tests and e2e tests

## Tasks

### Task 7.1: Update Visual Workflow Editor for Channels

**Description**: Update the visual workflow editor UI to display and configure channels with gates. One unified channel editor — no separate within-node/cross-node editors.

**Subtasks**:
1. In `packages/web/src/components/space/visual-editor/WorkflowCanvas.tsx`:
   - Replace transition arrows with channel connections
   - Add visual distinction for gated channels (e.g., different color or gate icon)
   - Allow clicking on a channel connection to edit its gate configuration
2. In `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx`:
   - Add a panel/modal for editing channel gates
   - Support all 4 condition types: always, human, condition, task_result
   - Allow configuring gate expression, description, retries, timeout
3. In `packages/web/src/components/space/WorkflowEditor.tsx`:
   - Replace the "Transitions" section with a "Channels" section
   - CRUD interface for channels (add/edit/delete)
   - Channel form: `from` (agent or node name), `to` (agent or node name), direction, gate, label
4. Create `ChannelEditor.tsx` component for gate configuration

**Acceptance Criteria**:
- Channels are visible in the visual editor (no transition arrows)
- Users can add/edit/delete channels
- Gate configuration UI supports all condition types
- Visual distinction between gated and ungated channels
- One editor for all channel types (within-node and cross-node)

**Dependencies**: Task 1.1

**Agent Type**: coder

---

### Task 7.2: Update WorkflowNodeCard for Agent Completion State

**Description**: Update the `WorkflowNodeCard` component to show agent completion state within a node.

**Subtasks**:
1. In `packages/web/src/components/space/WorkflowNodeCard.tsx`:
   - Show per-agent completion status (active/done/failed) when session group data is available
   - Use visual indicators (checkmark, spinner, x-icon) for agent status
   - Show the completion summary when an agent reports done
2. In `packages/web/src/components/space/visual-editor/WorkflowNode.tsx`:
   - Add per-agent status indicators in the visual editor
   - Show "all agents done" indicator on completed nodes

**Acceptance Criteria**:
- Node cards show real-time agent completion state
- Visual editor shows agent status within nodes
- Status updates are reflected in real-time via WebSocket events

**Dependencies**: Task 2.4

**Agent Type**: coder

---

### Task 7.3: Web Tests for UI Changes

**Description**: Write web tests (vitest) for the updated UI components.

**Subtasks**:
1. Update `packages/web/src/components/space/__tests__/WorkflowEditor.test.tsx`:
   - Test channel CRUD operations
   - Remove any transition-related tests
2. Create `packages/web/src/components/space/visual-editor/__tests__/ChannelEditor.test.tsx`:
   - Test gate configuration for each condition type
3. Update `packages/web/src/components/space/__tests__/WorkflowNodeCard.test.tsx`:
   - Test agent completion state display
4. Update `packages/web/src/components/space/visual-editor/__tests__/WorkflowCanvas.test.tsx`:
   - Test channel rendering
   - Remove any transition rendering tests

**Acceptance Criteria**:
- All web tests pass (`cd packages/web && bunx vitest run`)
- Channel UI is tested
- Gate configuration UI is tested
- No regressions in existing workflow editor tests

**Dependencies**: Tasks 7.1, 7.2

**Agent Type**: coder

---

### Task 7.4: E2E Tests for Agent-Centric Workflow

**Description**: Write Playwright e2e tests for the agent-centric workflow model.

**Subtasks**:
1. Create `packages/e2e/tests/features/agent-centric-workflow.e2e.ts`:
   - Test creating a workflow with channels
   - Test adding a gate to a channel in the visual editor
   - Test viewing agent completion state in the workflow UI
2. Update `packages/e2e/tests/helpers/workflow-editor-helpers.ts`:
   - Add helpers for channel operations
   - Add helpers for gate configuration

**Acceptance Criteria**:
- E2E tests pass (`make run-e2e TEST=tests/features/agent-centric-workflow.e2e.ts`)
- Tests follow E2E test rules (pure browser-based, no API calls in test actions)
- No regressions in existing e2e tests

**Dependencies**: Tasks 7.1, 7.2

**Agent Type**: coder

## Rollback Strategy

- UI changes can be reverted by restoring the pre-milestone commit. Since the feature is unreleased, there is no production UI to worry about.
