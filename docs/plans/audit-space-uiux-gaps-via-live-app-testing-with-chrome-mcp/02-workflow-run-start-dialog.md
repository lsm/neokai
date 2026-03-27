# Milestone 2: Workflow Run Start Dialog and RPC Verification

## Goal

Enable users to start a workflow run from the Dashboard's "Start Workflow Run" quick action. This requires verifying the backend RPC handler exists and building a workflow selection dialog.

## Scope

- Verify `spaceWorkflowRun.create` RPC handler registration in the daemon
- Build WorkflowRunStartDialog component
- Replace the temporary Workflows-tab redirect from M1 with the real dialog

## Tasks

### Task 2.1: Verify and Fix spaceWorkflowRun.create RPC Handler

**Description:** The space-store has a TODO(M6) comment indicating `spaceWorkflowRun.create` may be a stub. Verify whether the RPC handler is registered in the daemon's handler registration and fix if missing.

**Agent type:** coder

**Subtasks:**
1. Check `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` for `spaceWorkflowRun.create` handler implementation
2. Check `packages/daemon/src/lib/rpc-handlers/index.ts` to verify the handler is registered with the MessageHub
3. If missing, implement the handler: accept `{ spaceId, workflowId, title?, variables? }`, create a workflow run via SpaceWorkflowRunRepository, emit `space.workflowRun.created` event
4. If the handler exists but the space-store TODO is outdated, remove the TODO comment
5. Write an online test in `packages/daemon/tests/online/space/` verifying the RPC creates a run and returns it
6. Remove the TODO(M6) comment from `packages/web/src/lib/space-store.ts` once verified

**Acceptance criteria:**
- `spaceWorkflowRun.create` RPC handler is registered and functional
- Creating a run via RPC returns a SpaceWorkflowRun object
- The `space.workflowRun.created` event is emitted
- Online test passes

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 2.2: Build WorkflowRunStartDialog Component

**Description:** Create a modal dialog for starting a workflow run from the dashboard. The dialog should let users select a workflow from the space's configured workflows and optionally set a title.

**Agent type:** coder

**Subtasks:**
1. Create `packages/web/src/components/space/WorkflowRunStartDialog.tsx` with: Workflow selector (dropdown of space's workflows from `spaceStore.workflows`), Run title (optional text input, auto-suggested from workflow name + timestamp), Start button
2. Wire form submission to `spaceStore.startWorkflowRun({ workflowId, title })`
3. Handle edge case: no workflows configured — show "No workflows available. Create one first." with a link/button to switch to Workflows tab
4. Add success toast showing run title; close dialog on success
5. Write unit test covering: render with workflows, render empty state, submit flow

**Acceptance criteria:**
- Dialog shows available workflows in a dropdown
- Empty state shown when no workflows exist
- Successful submission creates a run and closes the dialog
- New run appears in dashboard active status banner

**Dependencies:** Task 2.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 2.3: Wire Start Workflow Run Button to Dialog

**Description:** Replace the temporary M1 behavior (tab switch) with the real WorkflowRunStartDialog in SpaceIsland.

**Agent type:** coder

**Subtasks:**
1. In `SpaceIsland.tsx`, add state for `startRunOpen` and import WorkflowRunStartDialog
2. Replace the temporary `onStartWorkflow` handler with `() => setStartRunOpen(true)`
3. Render `<WorkflowRunStartDialog isOpen={startRunOpen} onClose={() => setStartRunOpen(false)} onSwitchToWorkflows={() => { setStartRunOpen(false); setActiveTab('workflows'); }} />`
4. Add E2E test covering: click "Start Workflow Run" on dashboard, see dialog, select workflow, start run

**Acceptance criteria:**
- "Start Workflow Run" button opens the dialog instead of switching tabs
- Dialog correctly lists space's workflows
- Starting a run creates it and updates the dashboard

**Dependencies:** Task 2.2, Task 1.2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
