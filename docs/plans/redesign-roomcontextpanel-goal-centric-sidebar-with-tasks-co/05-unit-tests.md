# Milestone 5: Unit Tests

## Goal

Add unit tests covering the new computed signals, router route parsing, and the redesigned RoomContextPanel rendering.

## Tasks

### Task 5.1: Unit Tests for Room Store Computed Signals

**Description:** Add unit tests for the new computed signals (`tasksByGoalId`, `orphanTasks`, `orphanTasksActive`, `orphanTasksReview`, `orphanTasksDone`) in room-store.

**Agent type:** coder

**Depends on:** Task 1.1 (room store computed signals)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Create `packages/web/src/lib/room-store.test.ts` (or add to existing test file if one exists):
   - Test `tasksByGoalId`: Set `roomStore.goals` and `roomStore.tasks` with known data where some tasks are in goal `linkedTaskIds`. Verify the computed Map has the correct entries.
   - Test `orphanTasks`: Verify tasks not in any goal's `linkedTaskIds` appear in this signal.
   - Test `orphanTasksActive`: Verify orphan tasks with status `draft`, `pending`, or `in_progress` are included (all three statuses).
   - Test `orphanTasksReview`: Verify orphan tasks with status `review` or `needs_attention` are included.
   - Test `orphanTasksDone`: Verify orphan tasks with status `completed` or `cancelled` are included.
   - Test reactivity: Changing `tasks` or `goals` signals updates the computed signals.
3. Run `cd packages/web && bunx vitest run src/lib/room-store.test.ts` to verify tests pass.

**Acceptance criteria:**
- All computed signal tests pass.
- Edge cases covered: empty tasks, empty goals, all tasks linked, no tasks linked.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 5.2: Unit Tests for Router Room Agent Route

**Description:** Add unit tests for the new Room Agent route pattern and navigation function.

**Agent type:** coder

**Depends on:** Task 2.1 (room agent route)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Add tests to the appropriate router test file (check for existing `packages/web/src/lib/router.test.ts` or create one):
   - Test `getRoomAgentFromPath('/room/<uuid>/agent')` returns the room ID.
   - Test `getRoomAgentFromPath('/room/<uuid>')` returns null.
   - Test `getRoomIdFromPath('/room/<uuid>/agent')` returns the room ID (since it should also recognize the agent route).
   - Test `createRoomAgentPath(roomId)` returns the correct path string.
3. Run tests to verify they pass.

**Acceptance criteria:**
- All route parsing tests pass.
- Both positive and negative cases covered.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 5.3: Unit Tests for Redesigned RoomContextPanel

**Description:** Add unit tests for the redesigned `RoomContextPanel` component rendering, verifying the goals section, tasks section, sessions section, and navigation behavior.

**Agent type:** coder

**Depends on:** Task 3.2 (RoomContextPanel rewrite)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Update `packages/web/src/islands/__tests__/RoomContextPanel.test.tsx`. **IMPORTANT:** An existing test file covers the old "New Session" button behavior — these tests WILL break after the component rewrite (the button moves to Sessions section header and becomes an icon). The existing tests must be migrated/rewritten, not just supplemented with new ones. Failure to do so will produce failing tests on `make test-web`.
   - Remove or rewrite existing tests that reference the old "New Session" button in the top-level layout.
   - Test that the "All Rooms" back button is NOT rendered.
   - Test that Dashboard and Room Agent pinned items are rendered.
   - Test that Dashboard is NOT highlighted when `currentRoomTaskIdSignal` is set (verifies `isDashboardSelected` logic).
   - Test Goals section: renders with correct goal count, goals are listed, expanding a goal shows linked tasks.
   - Test Tasks section: renders orphan tasks, tab filter switches between Active/Review/Done views. Verify `draft`/`pending` tasks appear under "Active" tab.
   - Test Sessions section: renders with session count, has create button in header, defaults to collapsed.
   - Test selection highlighting: when `currentRoomTaskIdSignal` is set, the corresponding task item has the highlighted style.
3. Mock `roomStore` signals and `router` navigation functions appropriately for the test environment.
4. Run tests to verify they pass.

**Acceptance criteria:**
- All rendering and interaction tests pass.
- Coverage includes: section visibility, collapsible behavior, tab filtering, navigation calls, selection highlighting.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
