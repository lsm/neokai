# Milestone 7: Built-in Workflow Migration and UI Updates

## Goal

Migrate the 3 built-in workflow templates (Coding, Research, Review-Only) to the agent-centric model, and update the frontend visual editor to support cross-node channels with gates.

## Scope

- Rewrite built-in workflows to use cross-node gated channels instead of transitions
- Update visual workflow editor to display cross-node channels
- Update WorkflowEditor component to configure cross-node channel gates
- Add web tests and e2e tests

## Tasks

### Task 7.1: Migrate Built-in Workflows to Agent-Centric Model

**Description**: Rewrite the 3 built-in workflow templates in `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` to use cross-node gated channels.

**Subtasks**:
1. **Coding Workflow** (Plan -> Code -> Verify -> Done with cycle):
   - Replace transitions with cross-node channels:
     - Plan -> Code: `human` gate channel (planner sends to coder after human approval)
     - Code -> Verify: `always` gate channel (coder sends to verifier)
     - Verify -> Plan: `task_result` gate channel (verifier sends to planner on 'failed')
     - Verify -> Done: `task_result` gate channel (verifier sends to general on 'passed')
   - Keep existing transitions for backward compatibility (dual model)
   - Add cross-node channels to the workflow definition
2. **Research Workflow** (Planner -> General):
   - Add a cross-node `always` gate channel from planner to general
3. **Review-Only Workflow** (single Coder node):
   - No changes needed (single-node workflow has no transitions/channels between nodes)
4. Update `seedBuiltInWorkflows()` to persist cross-node channels

**Acceptance Criteria**:
- All 3 built-in workflows include cross-node channels alongside existing transitions
- Coding workflow's gate logic is preserved in channel gates
- New spaces get workflows with both models (backward compatible)
- Existing spaces are not affected (they keep their current workflow data)

**Dependencies**: Tasks 2.3, 6.2

**Agent Type**: coder

---

### Task 7.2: Update Visual Workflow Editor for Cross-Node Channels

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

### Task 7.3: Update WorkflowNodeCard for Agent Completion State

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

### Task 7.4: Web Tests for UI Changes

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

**Dependencies**: Tasks 7.2, 7.3

**Agent Type**: coder

---

### Task 7.5: E2E Tests for Agent-Centric Workflow

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

**Dependencies**: Tasks 7.2, 7.3

**Agent Type**: coder
