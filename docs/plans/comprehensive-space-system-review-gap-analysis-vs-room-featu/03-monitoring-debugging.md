# M3: Workflow Monitoring & Debugging

> **Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Goal

Give humans the ability to see what agents are doing in real time and intervene when needed. After this milestone, users can view task conversation history, approve or reject work in `review` status, and see real-time state changes without polling.

## Milestone Acceptance Criteria

- [ ] Users can view the full conversation history of any Space task.
- [ ] Space tasks in `review` status show approve/reject controls in the UI.
- [ ] Task and workflow run state changes are emitted as DaemonHub events for real-time frontend updates.

---

## Task 7: Space Task Conversation/Detail View

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Currently, `SpaceTaskPane.tsx` shows task metadata (title, status, priority, agents, result, error) but has no way to view the actual conversation history of the step agent sessions. Users cannot see what the agent is doing or has done. This task creates a conversation view for Space task sessions.

- **Files to create:**
  - `packages/web/src/components/space/SpaceTaskDetail.tsx`
  - `packages/web/src/hooks/useSpaceTaskMessages.ts`

- **Files to modify:**
  - `packages/web/src/components/space/SpaceTaskPane.tsx` -- add navigation to detail view
  - `packages/web/src/lib/space-store.ts` -- add actions for fetching task session messages

- **Implementation approach:**
  1. **Data loading hook** `useSpaceTaskMessages(spaceId, taskId)`:
     - Call `space.sessionGroup.list` RPC with filter by `taskId`.
     - For each session group, get member sessions.
     - Use LiveQuery to stream messages for each session (follow `useGroupMessages()` pattern from Room at `packages/web/src/hooks/`).
     - Convert messages to turn blocks via `useTurnBlocks()`.
  2. **SpaceTaskDetail component:**
     ```tsx
     interface SpaceTaskDetailProps {
       spaceId: string;
       taskId: string;
     }
     ```
     Render: task header (title, status, priority), agent list with status badges, conversation turns (reuse `AgentTurnBlock` from `packages/web/src/components/room/`), task info sidebar (metadata, error, result).
  3. **Navigation:** In `SpaceTaskPane.tsx`, add a "View Conversation" button that opens `SpaceTaskDetail` in a slide-out panel or replaces the current pane content.

- **Implementation notes:**
  - Reuse existing components: `AgentTurnBlock`, `RuntimeMessageRenderer`, `SlideOutPanel` from `packages/web/src/components/room/`.
  - Follow Room's LiveQuery pattern: subscribe to `sessionGroupMessages.byGroup` named query with snapshot + delta handling.
  - `SpaceTaskPane` already has the `WorkingAgents` component showing session groups -- the detail view extends this to show full conversation content.

- **Edge cases:**
  - Task has no session groups (not yet spawned) -- show empty state "Waiting for agent to start..."
  - Multiple session groups (sub-sessions for different steps in a cycle) -- show tabs or merged view with step labels.
  - Session is still streaming -- show live updates via LiveQuery subscription.

- **Testing:**
  - Unit test: `useSpaceTaskMessages` hook with mock data.
  - Test file: `packages/web/tests/hooks/useSpaceTaskMessages.test.ts` (create or extend existing)
  - E2E test file: `packages/e2e/tests/features/space-task-detail.e2e.ts` (create)
  - E2E scenario: navigate to space task, verify conversation view loads, verify turn blocks render.

- **Acceptance Criteria:** Users can click a Space task and see its full conversation history with agent turns rendered. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 8: Human Review/Approval UI for Space Tasks

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Space tasks can be set to `review` status via `SpaceTaskManager.reviewTask()` (line 233), which also stores PR metadata. However, there is no UI for a human to approve or reject a task in review. This task creates approve/reject controls.

- **Files to create:**
  - `packages/web/src/components/space/SpaceTaskReviewBar.tsx`

- **Files to modify:**
  - `packages/web/src/components/space/SpaceTaskPane.tsx` -- integrate review bar when task status is `review`

- **Implementation approach:**
  1. **Follow the pattern of Room's `HeaderReviewBar.tsx`** but adapted for Space:
     ```tsx
     interface SpaceTaskReviewBarProps {
       spaceId: string;
       taskId: string;
       task?: SpaceTask | null;
       onApproved: () => void;
       onRejected: () => void;
     }
     ```
  2. **Approve action:** Call `spaceStore.updateTask(taskId, { status: 'completed' })`.
  3. **Reject action:** Open a `RejectModal` with textarea, then call `spaceStore.updateTask(taskId, { status: 'needs_attention', error: feedback })`.
  4. **PR link display:** Show `task.prUrl` if present (same as Room's pattern).
  5. **Integration:** In `SpaceTaskPane.tsx`, when `task.status === 'review'`, render `SpaceTaskReviewBar` above the task details.

- **Implementation notes:**
  - Use the existing `ActionBar` component from `packages/web/src/components/shared/` with `type="review"` (same as Room).
  - `SpaceTaskPane` already renders `task.prUrl` -- the review bar should be more prominent, with explicit approve/reject buttons.
  - The `HumanInputArea` component already handles `needs_attention` status -- the review bar handles the `review` status which is a different workflow (work is done, awaiting explicit approval vs. work needs guidance).

- **Edge cases:**
  - Task transitions away from `review` while user is viewing -- hide the bar.
  - Network error on approve/reject -- show error banner, keep bar visible.
  - Task in `review` but no PR URL -- still show approve/reject (review is not PR-specific).

- **Testing:**
  - Unit test: Verify the component renders approve/reject buttons when status is `review`.
  - Test file: `packages/web/tests/space/SpaceTaskReviewBar.test.ts` (create)
  - E2E test file: `packages/e2e/tests/features/space-task-review.e2e.ts` (create)
  - E2E scenario: create space, create task, transition to review, verify review bar visible, click approve, verify task completed.

- **Acceptance Criteria:** Space tasks in `review` status show approve/reject controls. Approve completes; reject sets to `needs_attention` with feedback. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 9: DaemonHub Real-Time Events for Space Task/Run State Changes

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** The Space system emits events to the `NotificationSink` (consumed by the Space Agent session), but does not emit DaemonHub events for task and workflow run state changes that the frontend subscribes to. This means the frontend must poll or rely on LiveQuery for updates, which adds latency. This task adds DaemonHub events for key state transitions.

- **Files to modify:**
  - `packages/daemon/src/lib/space/managers/space-task-manager.ts` -- emit events on status transition
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- emit events on workflow run state changes
  - `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` -- emit events on manual status updates via RPC

- **Events to emit:**
  ```ts
  // On task status change:
  daemonHub.emit('spaceTask.updated', { spaceId, taskId, task: updatedTask, previousStatus });

  // On workflow run status change:
  daemonHub.emit('spaceWorkflowRun.updated', { spaceId, runId, run: updatedRun, previousStatus });
  ```

- **Implementation approach:**
  1. Add an `onStatusChange` callback to `SpaceTaskManager` constructor (optional, for daemon use):
     ```ts
     constructor(db, spaceId, onStatusChange?: (task: SpaceTask, previousStatus: string) => void)
     ```
  2. In `setTaskStatus()`, after the DB update, call the callback if provided.
  3. In `SpaceRuntimeService` or `rpc-handlers/index.ts`, wire the callback to emit DaemonHub events.
  4. Emit `spaceWorkflowRun.updated` in `processRunTick()` when run status changes (already tracked via `workflowRunRepo.updateStatus()`).

- **Edge cases:**
  - DaemonHub emit is async -- catch and log errors, do not let them fail the status transition.
  - Multiple rapid status changes -- events should be emitted for each, not batched.
  - Event ordering -- ensure task events are emitted before workflow run events in `processRunTick()`.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-task-events.test.ts` (create)
  - Test scenarios: (a) `setTaskStatus()` triggers event with correct payload, (b) workflow run status change triggers event, (c) error in event emission does not fail the status transition

- **Acceptance Criteria:** Task and workflow run state changes are emitted as DaemonHub events. The frontend can subscribe to these events for real-time updates. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
