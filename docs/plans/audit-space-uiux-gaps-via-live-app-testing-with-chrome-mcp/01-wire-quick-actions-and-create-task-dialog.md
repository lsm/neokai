# Milestone 1: Wire Quick Actions and Create Task Dialog

## Goal

Connect the existing unwired Quick Action buttons on SpaceDashboard and build a standalone task creation dialog so users can create tasks directly from the space detail view.

## Scope

- Wire "Create Task" quick action to open a new task creation dialog
- Build SpaceTaskCreateDialog component
- Wire "Start Workflow Run" quick action (placeholder — opens toast or redirects to Workflows tab until M2 dialog is built)
- Add padding fix for SpaceAgentList consistency

## Tasks

### Task 1.1: Build SpaceTaskCreateDialog Component

**Description:** Create a modal dialog for creating standalone tasks within a space. The dialog should mirror the SpaceCreateDialog pattern — modal form with validation and RPC submission.

**Agent type:** coder

**Subtasks:**
1. Create `packages/web/src/components/space/SpaceTaskCreateDialog.tsx` with fields: Title (required), Description (optional textarea), Priority (select: low/normal/high/urgent, default normal), Task Type (select: coding/review/research/general, default general)
2. Wire form submission to `spaceStore.createTask()` which calls `spaceTask.create` RPC
3. Add success toast and close dialog on successful creation
4. Add validation: title required, show inline error
5. Write unit test in `packages/web/src/components/space/__tests__/SpaceTaskCreateDialog.test.tsx` covering: render, validation, submit flow

**Acceptance criteria:**
- Dialog renders with all fields when opened
- Empty title submission shows validation error
- Successful submission creates a task and closes the dialog
- New task appears in the space's task list (via real-time event subscription)

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 1.2: Wire Quick Action Buttons in SpaceIsland

**Description:** Connect the SpaceDashboard Quick Action buttons by passing callbacks from SpaceIsland. "Create Task" opens the new dialog. "Start Workflow Run" shows a toast or switches to the Workflows tab as a temporary solution until M2.

**Agent type:** coder

**Subtasks:**
1. In `SpaceIsland.tsx`, add state for `createTaskOpen` (boolean) and import SpaceTaskCreateDialog
2. Pass `onCreateTask={() => setCreateTaskOpen(true)}` to SpaceDashboard
3. For "Start Workflow Run", pass `onStartWorkflow={() => setActiveTab('workflows')}` as a temporary redirect (or show a toast saying "Select a workflow from the Workflows tab")
4. Render `<SpaceTaskCreateDialog isOpen={createTaskOpen} onClose={() => setCreateTaskOpen(false)} />` in SpaceIsland
5. Update `SpaceIsland.test.tsx` to verify the dialog opens on button click
6. Add E2E test in `packages/e2e/tests/features/space-task-creation.e2e.ts` covering: navigate to space, click "Create Task", fill form, submit, verify task appears

**Acceptance criteria:**
- "Create Task" button on dashboard opens the task creation dialog
- "Start Workflow Run" button navigates to Workflows tab (temporary behavior)
- E2E test passes for the full task creation flow

**Dependencies:** Task 1.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 1.3: Fix SpaceAgentList Padding Consistency

**Description:** The Agents tab content lacks outer padding that Dashboard (`p-6`) and Settings (`p-6`) have. Add consistent padding wrapper.

**Agent type:** coder

**Subtasks:**
1. In `SpaceIsland.tsx`, wrap the `<SpaceAgentList />` render in a div with `class="p-6 h-full overflow-y-auto"` (or add padding directly in SpaceAgentList's root div)
2. Verify visually that the padding matches Dashboard and Settings tabs
3. Update any affected unit tests

**Acceptance criteria:**
- Agents tab content has consistent padding with other tabs
- No visual regression in agent list layout

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
