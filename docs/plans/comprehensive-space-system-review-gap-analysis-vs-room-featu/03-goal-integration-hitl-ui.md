# M3: Goal Integration + Human-in-the-Loop UI

> **⚠️ Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Acceptance Criteria

- [ ] Completing a Space task with a `goalId` updates Room goal progress.
- [ ] `GoalsEditor` UI reflects Space task contributions.
- [ ] Space tasks in `review` status show approve/reject controls.
- [ ] Approving completes the task; rejecting sets it to `needs_attention`.
- [ ] Users can view Space task conversation history.

---

## Task 1: Wire Space Task Completion to Goal Progress Tracking

- **Priority:** CRITICAL
- **Agent Type:** coder
- **Dependencies:** Task 0 (design approved -- see `01-foundation.md`)
- **Description:** Implement the bridge between Space task completion and Room's GoalManager, following the design from Task 0.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- `handleSubSessionComplete()` at line ~907
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `SpaceRuntimeConfig` interface
  - Possibly: `packages/daemon/src/storage/repositories/goal-repository.ts` -- if new cross-system query methods are needed

- **Implementation approach** (will be refined based on Task 0 design):
  1. Add a goal integration callback to `SpaceRuntimeConfig` or `TaskAgentManagerConfig`:
     ```ts
     onTaskGoalProgressUpdate?: (taskId: string, goalId: string) => Promise<void>;
     ```
  2. In `handleSubSessionComplete()`, after `taskManager.setTaskStatus(stepTask.id, 'completed')` succeeds:
     - Look up the workflow run to get `goalId`.
     - If `goalId` exists, call `onTaskGoalProgressUpdate(taskId, goalId)`.
  3. The callback implementation (in `SpaceRuntimeService` or `rpc-handlers/index.ts`) will:
     - Resolve the goal from the `goals` table using `GoalRepository`.
     - Recalculate progress using the design's chosen mechanism.
     - Emit `goal.progressUpdated` DaemonHub event.
  4. Also emit `goal.progressUpdated` in `space-task-handlers.ts` when `spaceTask.update` transitions a task to `completed`.

- **Edge cases:**
  - Task has no `goalId` -- skip silently.
  - Goal has been deleted since the workflow run started -- handle gracefully (goal lookup returns null, log warning, skip).
  - Goal belongs to a different room than expected -- depends on Task 0 design.
  - Multiple tasks completing simultaneously -- each should trigger independent progress updates.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/task-agent-goal-bridge.test.ts` (create)
  - Test scenarios: (a) completing a task with goalId triggers progress update, (b) completing a task without goalId skips, (c) deleted goal is handled gracefully, (d) goal.progressUpdated event is emitted

- **Acceptance Criteria:** Space tasks with `goalId` update Room goal progress when completed. `GoalsEditor` reflects Space task contributions.

---

## Task 4: Human Review UI for Space Tasks

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Create approve/reject UI controls for Space tasks in `review` status.

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
  - Use `useMessageHub()` hook for the request calls, or delegate to `spaceStore.updateTask()`.
  - Follow Room's error display pattern (red banner below the bar).

- **Edge cases:**
  - Task transitions away from `review` while user is viewing -- hide the bar, no action needed.
  - Network error on approve/reject -- show error banner, keep bar visible.

- **Testing:**
  - Unit test: Verify the component renders approve/reject buttons when status is `review`.
  - E2E test file: `packages/e2e/tests/features/space-task-review.e2e.ts` (create)
  - E2E scenario: create space → create task → transition to review via RPC → verify review bar is visible → click approve → verify task is completed.

- **Acceptance Criteria:** Space tasks in `review` status show approve/reject controls. Approve completes; reject sets to `needs_attention`.

---

## Task 5: Space Task Detail/Conversation View

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Create a conversation view for Space task sessions.

- **Files to create:**
  - `packages/web/src/components/space/SpaceTaskDetail.tsx`
  - `packages/web/src/hooks/useSpaceTaskMessages.ts`

- **Files to modify:**
  - `packages/web/src/components/space/SpaceTaskPane.tsx` -- add navigation to detail view
  - `packages/web/src/lib/space-store.ts` -- add `getTaskSessionGroups()` action

- **Implementation approach:**
  1. **Data loading hook** `useSpaceTaskMessages(spaceId, taskId)`:
     - Call `space.sessionGroup.list` RPC with filter by `taskId` (via `spaceStore`).
     - For each session group, get member sessions.
     - Use LiveQuery to stream messages for each session (follow `useGroupMessages()` pattern from Room).
     - Convert messages to turn blocks via `useTurnBlocks()` (from `packages/web/src/hooks/`).
  2. **SpaceTaskDetail component:**
     ```tsx
     interface SpaceTaskDetailProps {
       spaceId: string;
       taskId: string;
     }
     ```
     Render: task header (title, status, priority), agent list with status badges, conversation turns (reuse `AgentTurnBlock` from `packages/web/src/components/room/`), task info sidebar (metadata, error, result).
  3. **Navigation:** In `SpaceTaskPane.tsx`, add a "View Conversation" button that sets a route state to open `SpaceTaskDetail` in a slide-out panel or full view.

- **Implementation notes:**
  - Reuse existing components: `AgentTurnBlock`, `RuntimeMessageRenderer`, `SlideOutPanel` from `packages/web/src/components/room/`.
  - Follow Room's LiveQuery pattern: subscribe to `sessionGroupMessages.byGroup` named query with snapshot + delta handling.

- **Edge cases:**
  - Task has no session groups (not yet spawned) -- show empty state "Waiting for agent to start..."
  - Multiple session groups (sub-sessions for different steps) -- show tabs or merged view.

- **Testing:**
  - Unit test: `useSpaceTaskMessages` hook with mock data.
  - E2E test file: `packages/e2e/tests/features/space-task-detail.e2e.ts` (create)
  - E2E scenario: navigate to space task → verify conversation view loads → verify turn blocks render.

- **Acceptance Criteria:** Users can click a Space task and see its full conversation history with agent turns rendered.

---

## Task 11: DaemonHub Event Emission for Space Goal Progress

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** Task 1
- **Description:** Emit `goal.progressUpdated` DaemonHub events when Space task completion triggers goal update, so the frontend updates in real time.

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- emit event in goal callback
  - `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts` -- emit event on status transition to completed
  - `packages/web/src/lib/room-store.ts` -- ensure `goal.progressUpdated` events are subscribed (may already be via Room channel)

- **Implementation approach:**
  1. In the goal progress callback (wired in Task 1), after recalculation, emit:
     ```ts
     daemonHub.emit('goal.progressUpdated', {
       sessionId: 'global',
       goalId,
       goal: updatedGoal,
     });
     ```
  2. In `space-task-handlers.ts`, in the `spaceTask.update` handler, when status transitions to `completed` and the task has a `goalId`, emit the same event.

- **Testing:**
  - Unit test: verify event emission with correct payload on task completion.
  - Test file: extend `packages/daemon/tests/unit/space/task-agent-goal-bridge.test.ts`

- **Acceptance Criteria:** Goal progress updates from Space task completions are emitted as DaemonHub events.
