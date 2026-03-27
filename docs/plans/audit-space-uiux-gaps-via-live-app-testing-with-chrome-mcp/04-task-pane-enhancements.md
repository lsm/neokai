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
1. Create `packages/web/src/components/space/WorkflowRunDetail.tsx` showing: run title, status badge, started/completed timestamps, list of tasks grouped by workflow node
2. **Task grouping implementation**: Use `spaceStore.tasksByNodeId` (a computed signal at `space-store.ts` line 121 that returns `Map<string, SpaceTask[]>`) to group tasks. Grouping key is the node UUID (`nodeId`). Display each group as a collapsible section with the workflow step name as the header (resolve step name from the workflow definition). Standalone tasks (those without a `nodeId`) should appear in an "Ungrouped Tasks" section at the bottom.
3. In `SpaceDashboard.tsx`, make recent run items clickable — on click, open WorkflowRunDetail as a slide-over panel (overlay on the right side, similar to SpaceTaskPane pattern)
4. Add a "Back to Dashboard" button / close button in the detail view header
5. Show each task with its status dot, title, and click-to-open-task-pane behavior (navigate to `/space/:id/task/:taskId`)
6. Verify `tasksByNodeId` returns the expected `Map<string, SpaceTask[]>` structure in a unit test
7. Write unit test covering: render with run data, task grouping by node, ungrouped tasks section, back button navigation, task click navigation

**Acceptance criteria:**
- Clicking a run in Recent Activity opens the run detail view as a slide-over panel
- Tasks are displayed in collapsible sections grouped by workflow node name (using `tasksByNodeId` signal)
- Standalone tasks (no `nodeId`) appear in an "Ungrouped Tasks" section
- Clicking a task in the detail navigates to the task pane
- Back/close button returns to the main dashboard view

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
