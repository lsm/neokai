# Milestone 2: Task Lifecycle and Status Management

## Goal

Harden the task lifecycle: creation from agent conversation, visibility in dashboard/context panel, blocked task display with reason, and manual status control for all valid transitions.

## Scope

Happy paths 3 (Agent conversation creates task), 4 (Task visibility), 10 (Blocked task status), 12 (Manual task status control).

## Tasks

### Task 2.1: Verify agent-to-task creation flow

**Description:** The space chat agent can create tasks via MCP tools. Verify this flow works end-to-end: agent calls `create_task` tool, task appears in space store, task has correct fields including pre-selected workflow.

**Subtasks:**
1. Read `packages/daemon/src/lib/space/tools/space-agent-tools.ts` for the `create_task` tool definition.
2. Read `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` for `spaceTask.create` handler.
3. Check existing tests in `packages/daemon/tests/unit/space/space-agent-tools*` for task creation coverage.
4. Add unit tests verifying: tool creates task with correct fields, task appears in `spaceTask.list` results, workflow association is set when agent specifies it.
5. Run tests to verify.

**Acceptance Criteria:**
- Unit tests verify the agent tool creates tasks with all expected fields.
- Workflow pre-selection by agent is tested.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 1.1

**Agent type:** coder

### Task 2.2: Add blocked reason display to task cards and task pane

**Description:** Currently the `TaskRow` in `SpaceDashboard.tsx` shows "blocked" status but does not display the reason. The `SpaceTaskPane.tsx` also lacks blocked reason display. Add visible blocked reason text to both components.

**Important scoping decision:** The `SpaceTask` type already has a `result` field (string, used for terminal-state text). The preferred approach is to **reuse the existing `result` field** to store the blocked reason when status is `blocked` — this avoids a schema migration. Do NOT add a new `blockedReason` DB column unless `result` is semantically incompatible (e.g., if it's already populated with a different value when the task is blocked). If a new column is truly needed, scope that as a separate sub-PR with explicit migration handling.

**Subtasks:**
1. Read `packages/shared/src/types/space.ts` for `SpaceTask` interface — check if `result` is already used for blocked tasks.
2. Read `packages/daemon/src/lib/space/runtime/session-notification-sink.ts` for how blocked events carry reason text.
3. Read `packages/daemon/src/lib/space/managers/space-task-manager.ts` — check if `result` is set when transitioning to `blocked`.
4. Read `packages/web/src/components/space/SpaceDashboard.tsx` `TaskRow` component.
5. Read `packages/web/src/components/space/SpaceTaskPane.tsx` for task detail view.
6. If `result` is not populated on blocked transition, update the backend to set `result` with the blocked reason when transitioning to `blocked` status.
7. Update `TaskRow` in `SpaceDashboard.tsx` to show `task.result` text below the status when task is blocked.
8. Update `SpaceTaskPane.tsx` to show a prominent blocked reason banner when task status is blocked.
9. Add Vitest tests for both components verifying blocked reason renders.
10. Run `cd packages/web && bunx vitest run src/components/space/__tests__/SpaceDashboard.test.tsx` and similar.

**Acceptance Criteria:**
- Blocked tasks show their reason visibly in both dashboard cards and task detail view.
- Vitest component tests verify the blocked reason renders.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 1.1

**Agent type:** coder

### Task 2.3: Add full manual task status control UI

**Description:** Currently only "Reopen Task" (done->in_progress) is available. The backend supports transitions: blocked->open, blocked->in_progress, cancelled->open, cancelled->in_progress. Add a status control dropdown or action buttons to `SpaceTaskPane.tsx` that exposes all valid transitions for the current status.

**Subtasks:**
1. Read `packages/daemon/src/lib/space/managers/space-task-manager.ts` for `VALID_SPACE_TASK_TRANSITIONS`.
2. Read `packages/web/src/components/space/SpaceTaskPane.tsx` for the current "Reopen Task" button logic.
3. Replace the single "Reopen Task" button with a status action menu that shows all valid next statuses from `VALID_SPACE_TASK_TRANSITIONS`.
4. Add appropriate labels: "Resume" (blocked->in_progress), "Reopen" (done/cancelled->open), "Mark Done" (in_progress->done), "Cancel" (any->cancelled), "Archive" (terminal->archived).
5. Wire each action to `spaceStore.updateTask(taskId, { status: newStatus })`.
6. Add Vitest tests for the new status control component.
7. Run tests to verify.

**Acceptance Criteria:**
- Users can change task status through all valid transitions from the task pane.
- Each transition has a clear, descriptive label.
- Vitest tests verify the correct actions appear for each status.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 2.2

**Agent type:** coder

### Task 2.4: Verify task visibility in context panel and overview

**Description:** Ensure tasks created via any path (UI dialog, agent tool, workflow run) appear correctly in both the space context panel (`SpaceDetailPanel.tsx`) and the overview dashboard (`SpaceDashboard.tsx`).

**Subtasks:**
1. Read `packages/web/src/islands/SpaceDetailPanel.tsx` for how tasks are listed.
2. Read `packages/web/src/lib/space-store.ts` for `tasks` signal and LiveQuery subscription.
3. Verify the store's LiveQuery for tasks triggers on task creation/update.
4. Check that the context panel and dashboard both subscribe to `spaceStore.tasks`.
5. Add Vitest tests verifying: tasks appear in dashboard grouped by status, task count badges update, new tasks appear without manual refresh.
6. Run tests to verify.

**Acceptance Criteria:**
- Tasks appear in both context panel and dashboard immediately after creation.
- Status-based grouping (Active/Review/Done tabs) is correct.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 2.1

**Agent type:** coder
