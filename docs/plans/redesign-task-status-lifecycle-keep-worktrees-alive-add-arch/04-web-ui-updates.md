# Milestone 4: Web UI Updates

## Goal

Update the frontend to reflect the new task lifecycle: new tab grouping, reactivate/archive actions, localStorage tab migration, and enable messaging for completed/cancelled tasks.

## Scope

- `packages/web/src/components/room/TaskView.tsx` -- Add reactivate/archive actions, enable messaging
- `packages/web/src/components/room/RoomTasks.tsx` -- Update `TaskFilterTab` type and tab grouping, add localStorage migration
- `packages/web/src/components/room/RoomDashboard.tsx` -- Update stats/task grouping
- `packages/web/src/lib/room-store.ts` -- Update filters and computed values for new statuses
- Any other components that reference task status for display or filtering

---

### Task 4.1: Update task tab grouping, localStorage migration, and status display

**Description:** Update the room dashboard and task list components to group tasks into the new tabs: Active (draft + pending + in_progress), Review (review + needs_attention), Done (completed + cancelled), Archived (archived, hidden by default). Add localStorage migration for the persisted tab value. Update status badge colors to include `archived`.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Search for all components that group or filter tasks by status (grep for `TaskFilterTab`, `completed`, `cancelled`, `review`, `needs_attention` in `packages/web/src/`).
3. In `packages/web/src/components/room/RoomTasks.tsx`:
   - Update the `TaskFilterTab` type. The current type is `'active' | 'review' | 'done' | 'needs_attention'`. Change to `'active' | 'review' | 'done' | 'archived'` (merging `needs_attention` into the `review` tab).
   - **Add localStorage migration:** In the `getInitialTab()` function (which already has a migration from `'failed'` to `'needs_attention'`), add: if `stored === 'needs_attention'`, return `'review'` (since `needs_attention` tasks now appear under the Review tab). This prevents existing users from landing on a removed tab.
   - Update tab filtering logic:
     - **Active tab**: `draft`, `pending`, `in_progress`
     - **Review tab**: `review`, `needs_attention`
     - **Done tab**: `completed`, `cancelled`
     - **Archived tab**: `archived` (collapsed/hidden by default, expandable)
4. In `packages/web/src/components/room/RoomDashboard.tsx`:
   - Update the stats overview to reflect the new groupings.
   - Add an "Archived" count if not already present.
5. Add `archived` to the status color map (e.g., `archived: 'text-gray-500'` with a muted/dimmed style).
6. In `packages/web/src/lib/room-store.ts`, update any computed signals that filter by task status to handle `archived` correctly (e.g., exclude archived from default task counts).
7. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- Tasks are grouped into four tabs: Active, Review, Done, Archived.
- `needs_attention` appears under Review (not its own separate category).
- `archived` tasks are hidden by default but viewable via the Archived tab.
- Status badge for `archived` has appropriate muted styling.
- localStorage migration handles `'needs_attention'` → `'review'` and `'failed'` → `'review'`.
- No type errors.

**Dependencies:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.2: Add reactivate and archive actions to TaskView

**Description:** Add "Reactivate" and "Archive" action buttons to the TaskView component. Reactivate transitions completed/cancelled tasks to `in_progress`. Archive transitions completed/cancelled/needs_attention tasks to `archived`. Enable the message input for completed/cancelled tasks — the daemon auto-reactivates on message send (no explicit UI reactivation required).

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/web/src/components/room/TaskView.tsx`:
   - Add a "Reactivate" button visible when task status is `completed` or `cancelled`. On click, call `task.setStatus` RPC with `status: 'in_progress'`.
   - Add an "Archive" button visible when task status is `completed`, `cancelled`, or `needs_attention`. On click, show a confirmation dialog warning that archiving is **permanent** and will clean up the worktree (for room tasks). Use a pattern similar to the existing cancel confirmation.
   - Update the existing cancel confirmation dialog to note that the action is **reversible** (task can be reactivated later). Remove or update the "This action cannot be undone" warning.
3. **Enable messaging for completed/cancelled tasks:** The chat input is currently disabled for terminal states (likely gated by `canSend = hasGroup` or similar). Enable the message input for `completed` and `cancelled` tasks. The daemon's `task.sendHumanMessage` handler (updated in Task 2.2) will auto-reactivate the task when a message is sent — no explicit reactivation step is needed from the UI. Add a subtle hint near the input (e.g., "Sending a message will reactivate this task") so the user understands the behavior.
4. Add a "Reactivate" option to any task action dropdowns that exist (e.g., in `TaskCard` or task list context menus).
5. Run `bun run typecheck`, `bun run lint`, `bun run format`.
6. Visually verify the UI renders correctly (manual check — describe expected behavior in the PR).

**Acceptance criteria:**
- Reactivate button appears for completed and cancelled tasks.
- Archive button appears for completed, cancelled, and needs_attention tasks.
- Archive confirmation dialog warns about permanent worktree cleanup.
- Cancel confirmation dialog notes reversibility.
- Message input is enabled for completed and cancelled tasks with a reactivation hint.
- Message input is disabled for archived tasks.
- No type errors.

**Dependencies:** Tasks 2.2, 3.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.3: Web unit tests for new UI behavior

**Description:** Add Vitest tests for the new UI components and behaviors: tab grouping logic, localStorage migration, action button visibility, and status transitions triggered from the UI.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Add or update web tests (in `packages/web/src/`) to verify:
   - Task grouping function correctly categorizes tasks into Active/Review/Done/Archived tabs.
   - `getInitialTab()` localStorage migration: `'needs_attention'` → `'review'`, `'failed'` → `'review'`.
   - Reactivate button renders only for `completed` and `cancelled` tasks.
   - Archive button renders only for `completed`, `cancelled`, and `needs_attention` tasks.
   - `archived` status displays with correct styling.
   - Message input is enabled for `completed`/`cancelled` and disabled for `archived`.
3. Run `cd packages/web && bunx vitest run`.
4. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All web unit tests pass.
- New test cases cover the tab grouping, localStorage migration, and action visibility logic.

**Dependencies:** Task 4.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
