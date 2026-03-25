# Milestone 8: UI Updates for Agent-Centric Model

## Goal

Update the frontend visual editor and components to support the agent-centric model: cross-node channels, gate configuration, and agent completion state display. This milestone runs in parallel with Milestone 7 (backend workflow migration).

## Scope

- Update visual workflow editor to display cross-node channels
- Add gate configuration UI
- Update node cards for agent completion state
- Web tests and e2e tests

## Tasks

### Task 8.1: Update Visual Workflow Editor for Cross-Node Channels

**Description**: Update the visual workflow editor UI to display and configure cross-node channels with gates.

**Subtasks**:
1. In `packages/web/src/components/space/visual-editor/WorkflowCanvas.tsx`:
   - Render cross-node channels as arrows between nodes (similar to existing transition arrows)
   - Add visual distinction for gated channels (e.g., different color or gate icon)
   - Allow clicking on a cross-node channel to edit its gate configuration
2. In `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx`:
   - Add a panel/modal for editing cross-node channel gates
   - Support all 4 condition types: always, human, condition, task_result
   - Allow configuring gate expression, description, retries, timeout
3. In `packages/web/src/components/space/WorkflowEditor.tsx`:
   - Add a "Cross-Node Channels" section in the non-visual workflow editor
   - CRUD interface for cross-node channels
4. Create new component `CrossNodeChannelEditor.tsx` for gate configuration

**Acceptance Criteria**:
- Cross-node channels are visible in the visual editor
- Users can add/edit/delete cross-node channels
- Gate configuration UI supports all condition types
- Visual distinction between gated and ungated channels
- Existing transition editing still works

**Dependencies**: Tasks 2.1, 7.1

**Agent Type**: coder

---

### Task 8.2: Update WorkflowNodeCard for Agent Completion State

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

**Dependencies**: Task 3.4

**Agent Type**: coder

---

### Task 8.3: Web Tests for UI Changes

**Description**: Write web tests (vitest) for the updated UI components.

**Subtasks**:
1. Update `packages/web/src/components/space/__tests__/WorkflowEditor.test.tsx`:
   - Test cross-node channel CRUD operations
2. Create `packages/web/src/components/space/visual-editor/__tests__/CrossNodeChannelEditor.test.tsx`:
   - Test gate configuration for each condition type
3. Update `packages/web/src/components/space/__tests__/WorkflowNodeCard.test.tsx`:
   - Test agent completion state display
4. Update `packages/web/src/components/space/visual-editor/__tests__/WorkflowCanvas.test.tsx`:
   - Test cross-node channel rendering

**Acceptance Criteria**:
- All web tests pass (`cd packages/web && bunx vitest run`)
- Cross-node channel UI is tested
- Gate configuration UI is tested
- No regressions in existing workflow editor tests

**Dependencies**: Tasks 8.1, 8.2

**Agent Type**: coder

---

### Task 8.4: E2E Tests for Agent-Centric Workflow

**Description**: Write Playwright e2e tests for the agent-centric workflow model.

**Subtasks**:
1. Create `packages/e2e/tests/features/agent-centric-workflow.e2e.ts`:
   - Test creating a workflow with cross-node channels
   - Test adding a gate to a cross-node channel in the visual editor
   - Test viewing agent completion state in the workflow UI
2. Update `packages/e2e/tests/helpers/workflow-editor-helpers.ts`:
   - Add helpers for cross-node channel operations
   - Add helpers for gate configuration

**Acceptance Criteria**:
- E2E tests pass (`make run-e2e TEST=tests/features/agent-centric-workflow.e2e.ts`)
- Tests follow E2E test rules (pure browser-based, no API calls in test actions)
- No regressions in existing e2e tests

**Dependencies**: Tasks 8.1, 8.2

**Agent Type**: coder

## Rollback Strategy

- UI changes are purely additive (new components, new sections) — no existing UI behavior is removed
- If issues arise, the new UI components can be hidden behind a feature flag or simply not rendered for workflows without cross-node channels
- The visual editor already conditionally renders based on workflow properties, so workflows without cross-node channels will show the old UI naturally
