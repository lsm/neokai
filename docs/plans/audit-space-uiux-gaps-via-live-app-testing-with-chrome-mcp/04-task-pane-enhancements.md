# Milestone 4: Task Pane Enhancements

## Goal

Enhance the SpaceTaskPane with task status management controls and add a workflow run detail view to the dashboard, enabling users to manage task lifecycle and inspect run progress.

## Scope

- Add task status transition buttons in SpaceTaskPane
- Add workflow run detail/drill-down in the dashboard or a dedicated panel

## Tasks

### Task 4.1: Add Task Status Management Controls

**Description:** Currently SpaceTaskPane only shows the "Human Input Required" form for `needs_attention` tasks. Add buttons for common status transitions: mark complete, cancel, change priority.

**Agent type:** coder

**Subtasks:**
1. In `SpaceTaskPane.tsx`, add an "Actions" section below the status/priority row
2. Add "Mark Complete" button (visible when status is `in_progress`, `review`, or `needs_attention`) — calls `spaceStore.updateTask(taskId, { status: 'completed' })`
3. Add "Cancel Task" button (visible when status is not `completed`, `cancelled`, or `archived`) — calls `spaceStore.updateTask(taskId, { status: 'cancelled' })`
4. Add priority selector (dropdown or radio buttons) that calls `spaceStore.updateTask(taskId, { priority })` on change
5. Add confirmation step for "Cancel Task" to prevent accidental cancellation
6. Show success/error toast for all actions
7. Write unit test covering: button visibility per status, mark complete flow, cancel flow, priority change

**Acceptance criteria:**
- "Mark Complete" button appears for in-progress/review/needs_attention tasks
- "Cancel Task" button appears for non-terminal tasks with confirmation
- Priority can be changed inline
- All status transitions update the task via RPC and are reflected in real-time

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 4.2: Add Workflow Run Detail View

**Description:** Add ability to view details of a specific workflow run — showing its tasks grouped by workflow node, run status, timing, and progress. This is triggered by clicking a run in the Recent Activity section of SpaceDashboard.

**Agent type:** coder

**Subtasks:**
1. Create `packages/web/src/components/space/WorkflowRunDetail.tsx` showing: run title, status badge, started/completed timestamps, list of tasks grouped by workflow node (using `spaceStore.tasksByNodeId`)
2. In `SpaceDashboard.tsx`, make recent run items clickable — on click, open WorkflowRunDetail in a slide-over panel or replace the dashboard content
3. Add a "Back to Dashboard" button in the detail view
4. Show each task with its status dot, title, and click-to-open-task-pane behavior (navigate to `/space/:id/task/:taskId`)
5. Write unit test covering: render with run data, task grouping, back button navigation

**Acceptance criteria:**
- Clicking a run in Recent Activity opens the run detail view
- Tasks are displayed grouped by workflow node
- Clicking a task in the detail navigates to the task pane
- Back button returns to the main dashboard view

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
