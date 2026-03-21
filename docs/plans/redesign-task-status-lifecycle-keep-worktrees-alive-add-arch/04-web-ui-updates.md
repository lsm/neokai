# Milestone 4: Web UI Updates

## Goal

Update the frontend to reflect the new task lifecycle: new tab grouping, reactivate/archive actions, and enable messaging for completed/cancelled tasks.

## Scope

- `packages/web/src/components/room/TaskView.tsx` -- Add reactivate/archive actions, enable messaging
- `packages/web/src/components/room/RoomDashboard.tsx` -- Update stats/task grouping
- `packages/web/src/lib/room-store.ts` -- Update filters and computed values for new statuses
- Any other components that reference task status for display or filtering

---

### Task 4.1: Update task tab grouping and status display

**Description:** Update the room dashboard and any task list components to group tasks into the new tabs: Active (draft + pending + in_progress), Review (review + needs_attention), Done (completed + cancelled), Archived (archived, hidden by default). Update status badge colors to include `archived`.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Search for all components that group or filter tasks by status (grep for `completed`, `cancelled`, `review`, `needs_attention` in `packages/web/src/`).
3. In `packages/web/src/components/room/RoomDashboard.tsx`:
   - Update the stats overview to reflect the new groupings.
   - Add an "Archived" count if not already present.
4. In any task list component that renders tabs or groups:
   - **Active tab**: `draft`, `pending`, `in_progress`
   - **Review tab**: `review`, `needs_attention`
   - **Done tab**: `completed`, `cancelled`
   - **Archived tab**: `archived` (collapsed/hidden by default, expandable)
5. Add `archived` to the status color map (e.g., `archived: 'text-gray-600'` in `TaskView.tsx` line ~97).
6. In `packages/web/src/lib/room-store.ts`, update any computed signals that filter by task status to handle `archived` correctly (e.g., exclude archived from default task counts).
7. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- Tasks are grouped into four tabs: Active, Review, Done, Archived.
- `needs_attention` appears under Review (not its own separate category).
- `archived` tasks are hidden by default but viewable.
- Status badge for `archived` has appropriate styling.
- No type errors.

**Dependencies:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.2: Add reactivate and archive actions to TaskView

**Description:** Add "Reactivate" and "Archive" action buttons to the TaskView component. Reactivate transitions completed/cancelled tasks to `in_progress`. Archive transitions completed/cancelled/needs_attention tasks to `archived`.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/web/src/components/room/TaskView.tsx`:
   - Add a "Reactivate" button visible when task status is `completed` or `cancelled`. On click, call `task.setStatus` RPC with `status: 'in_progress'`.
   - Add an "Archive" button visible when task status is `completed`, `cancelled`, or `needs_attention`. On click, show a confirmation dialog (similar to the existing cancel confirmation) warning that archiving is permanent and will clean up the worktree.
   - Update the existing complete/cancel confirmation dialogs to note that the action is reversible (task can be reactivated later).
   - Remove or update the "This action cannot be undone" warning from the cancel dialog (since cancel is now reversible).
3. Enable the message input for `completed` and `cancelled` tasks. Currently the chat input is likely disabled for terminal states. Allow users to send messages which triggers reactivation to `in_progress`.
4. Add a "Reactivate" option to any task action dropdowns that exist.
5. Run `bun run typecheck`, `bun run lint`, `bun run format`.
6. Visually verify the UI renders correctly (manual check -- describe expected behavior in the PR).

**Acceptance criteria:**
- Reactivate button appears for completed and cancelled tasks.
- Archive button appears for completed, cancelled, and needs_attention tasks.
- Archive confirmation dialog warns about permanent worktree cleanup.
- Message input is enabled for completed and cancelled tasks.
- No type errors.

**Dependencies:** Tasks 2.2, 3.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.3: Web unit tests for new UI behavior

**Description:** Add Vitest tests for the new UI components and behaviors: tab grouping logic, action button visibility, and status transitions triggered from the UI.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Add or update web tests (in `packages/web/src/`) to verify:
   - Task grouping function correctly categorizes tasks into Active/Review/Done/Archived tabs.
   - Reactivate button renders only for `completed` and `cancelled` tasks.
   - Archive button renders only for `completed`, `cancelled`, and `needs_attention` tasks.
   - `archived` status displays with correct styling.
3. Run `cd packages/web && bunx vitest run`.
4. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All web unit tests pass.
- New test cases cover the tab grouping and action visibility logic.

**Dependencies:** Task 4.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
