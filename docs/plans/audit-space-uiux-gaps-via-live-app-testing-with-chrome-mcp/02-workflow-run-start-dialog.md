# Milestone 2: Workflow Run Start Dialog and RPC Verification

## Goal

Enable users to start a workflow run from the Dashboard's "Start Workflow Run" quick action. This requires fixing the RPC naming mismatch and building a workflow selection dialog.

## Scope

- Fix RPC naming mismatch: frontend calls `spaceWorkflowRun.create` but daemon registers `spaceWorkflowRun.start`
- Build WorkflowRunStartDialog component
- Replace the temporary Workflows-tab redirect from M1 with the real dialog

## Tasks

### Task 2.1: Fix spaceWorkflowRun RPC Naming Mismatch

**Description:** The daemon registers the handler as `spaceWorkflowRun.start` (in `space-workflow-run-handlers.ts` line 124), but the frontend `space-store.ts` line 857 calls `spaceWorkflowRun.create`. This is a naming mismatch, not a missing implementation. The TODO(M6) comment on line 842 is stale.

**Agent type:** coder

**Subtasks:**
1. In `packages/web/src/lib/space-store.ts`, rename the RPC call on line 857 from `hub.request('spaceWorkflowRun.create', ...)` to `hub.request('spaceWorkflowRun.start', ...)`
2. Update the response handling: the `spaceWorkflowRun.start` handler returns `{ run: SpaceWorkflowRun }`, so extract `.run` from the response (e.g., `const { run } = await hub.request('spaceWorkflowRun.start', params)`)
3. Remove the stale TODO(M6) comment on line 842
4. Verify the existing online tests in `packages/daemon/tests/online/space/` cover `spaceWorkflowRun.start`; if not, add a test verifying the RPC creates a run and returns `{ run: SpaceWorkflowRun }`
5. Run existing tests to confirm no regressions

**Acceptance criteria:**
- Frontend calls `spaceWorkflowRun.start` (matching the daemon handler name)
- Response is correctly extracted as `{ run: SpaceWorkflowRun }` (not bare `SpaceWorkflowRun`)
- TODO(M6) comment is removed
- All existing tests pass

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 2.2: Build WorkflowRunStartDialog Component

**Description:** Create a modal dialog for starting a workflow run from the dashboard. The dialog should let users select a workflow from the space's configured workflows and optionally set a title.

**Agent type:** coder

**Subtasks:**
1. Create `packages/web/src/components/space/WorkflowRunStartDialog.tsx` with: Workflow selector (dropdown of space's workflows from `spaceStore.workflows`), Run title (optional text input, auto-suggested from workflow name + timestamp), Start button
2. Wire form submission to `spaceStore.startWorkflowRun(params)` where params is `Omit<CreateWorkflowRunParams, 'spaceId'>` (spaceId is added by the store). Required field: `workflowId`. Optional fields: `title` (auto-suggested from workflow name + timestamp if empty), `variables`
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
