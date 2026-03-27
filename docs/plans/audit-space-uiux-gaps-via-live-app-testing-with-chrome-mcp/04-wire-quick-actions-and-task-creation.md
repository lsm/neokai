# Milestone 4: Wire Quick Actions + Task Creation

## Goal

Connect the unwired dashboard Quick Action buttons and build a standalone task creation dialog, enabling users to create tasks and start workflow runs from the SpaceDashboard.

## Tasks

### Task 4.1: Build SpaceTaskCreateDialog Component

**Description:** Create a modal dialog for creating standalone tasks within a space, following the SpaceCreateDialog pattern.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/components/space/SpaceCreateDialog.tsx` — modal pattern to follow
- `packages/web/src/lib/space-store.ts` — `spaceStore.createTask()` method

**Subtasks:**
1. Create `packages/web/src/components/space/SpaceTaskCreateDialog.tsx` with fields: Title (required), Description (optional textarea), Priority (select: low/normal/high/urgent, default normal), Task Type (select: coding/review/research/general, default general)
2. Wire form submission to `spaceStore.createTask()` which calls `spaceTask.create` RPC. Note: `spaceStore.spaceId.value` must be set (guaranteed since dialog only renders within space detail view)
3. Add success toast and close dialog on successful creation
4. Add validation: title required (non-empty after trim), show inline error
5. Write unit test in `packages/web/src/components/space/__tests__/SpaceTaskCreateDialog.test.tsx` covering: render, validation error on empty title, successful submit flow

**Acceptance criteria:**
- Dialog renders with all fields when opened
- Empty title submission shows validation error
- Successful submission creates a task and closes the dialog
- New task appears in SpaceDetailPanel's tasks section (via real-time event)

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 4.2: Build WorkflowRunStartDialog Component

**Description:** Create a modal dialog for starting a workflow run from the dashboard. Lets users select from the space's configured workflows and optionally set a run title.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/lib/space-store.ts` — `spaceStore.startWorkflowRun(params)` where params is `Omit<CreateWorkflowRunParams, 'spaceId'>`
- The `spaceWorkflowRun.start` handler returns `{ run: SpaceWorkflowRun }` (fixed in Task 2.2)

**Subtasks:**
1. Create `packages/web/src/components/space/WorkflowRunStartDialog.tsx` with: Workflow selector (dropdown of `spaceStore.workflows.value`), Run title (optional, auto-suggested from workflow name + timestamp if empty), Start button
2. Wire form submission to `spaceStore.startWorkflowRun(params)`. Required field: `workflowId`. Optional: `title`
3. Handle edge case: no workflows configured — show "No workflows available. Create one in the Workflows tab." with a button to switch to Workflows tab
4. Add success toast showing run title; close dialog on success
5. Write unit test covering: render with workflows, render empty state, submit flow

**Acceptance criteria:**
- Dialog shows available workflows in a dropdown
- Empty state shown when no workflows exist
- Successful submission creates a run and closes the dialog
- New run appears in SpaceDetailPanel's workflow runs section

**Dependencies:** Task 2.2 (RPC naming fix)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 4.3: Wire Quick Action Buttons in SpaceIsland

**Description:** Connect the SpaceDashboard Quick Action buttons by passing callbacks from SpaceIsland. "Create Task" opens SpaceTaskCreateDialog. "Start Workflow Run" opens WorkflowRunStartDialog.

**Agent type:** coder

**Subtasks:**
1. In `SpaceIsland.tsx`, add state for `createTaskOpen` and `startRunOpen` (booleans)
2. Import SpaceTaskCreateDialog and WorkflowRunStartDialog
3. Pass `onCreateTask={() => setCreateTaskOpen(true)}` and `onStartWorkflow={() => setStartRunOpen(true)}` to SpaceDashboard
4. Render both dialogs in SpaceIsland (outside the tab content area so they work regardless of active tab)
5. Update `SpaceIsland.test.tsx` to verify dialog opens on button click
6. Add E2E test in `packages/e2e/tests/features/space-task-creation.e2e.ts`: navigate to space dashboard, click "Create Task", fill form, submit, verify task appears in SpaceDetailPanel

**Acceptance criteria:**
- "Create Task" button opens SpaceTaskCreateDialog
- "Start Workflow Run" button opens WorkflowRunStartDialog
- Both dialogs function correctly
- E2E test passes for task creation flow

**Dependencies:** Task 4.1, Task 4.2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
