# Milestone 2: Room.tsx -- Drive Tab State from URL

## Goal

Replace the local `useState<RoomTab>` in Room.tsx with URL-driven tab state via `currentRoomActiveTabSignal`, and migrate all cross-file callers of `currentRoomTabSignal` (the transient pending-tab signal) to use `navigateToRoomTab`.

## Scope

Primary files: `packages/web/src/islands/Room.tsx`, `packages/web/src/islands/BottomTabBar.tsx`, `packages/web/src/components/room/RoomDashboard.tsx`, `packages/web/src/components/room/task-shared/TaskHeader.tsx`, `packages/web/src/islands/RoomContextPanel.tsx`, and their test files.

---

### Task 3: Replace useState with signal-driven tab in Room.tsx

**Description:** Remove the local `activeTab` state in Room.tsx and read the active tab directly from `currentRoomActiveTabSignal`. Update `handleTabChange` to call `navigateToRoomTab` instead of managing signals manually.

**Subtasks:**

1. Remove `useState<RoomTab>` from Room.tsx. Read the active tab as:
   ```ts
   const activeTab: RoomTab = (currentRoomActiveTabSignal.value as RoomTab) ?? 'overview';
   ```

2. Simplify `handleTabChange` to just call `navigateToRoomTab(roomId, tab)`. Remove the manual signal setting and the conditional `navigateToRoomAgent`/`navigateToRoom` branching -- `navigateToRoomTab` handles all of that internally.

3. Remove the `useEffect` that watches `currentRoomTabSignal` (the pending-tab signal). This was the indirection layer for cross-component tab navigation. After this change, cross-component callers will use `navigateToRoomTab` directly, which updates `currentRoomActiveTabSignal` and the URL atomically.

4. Remove the `useEffect` that watches `currentRoomAgentActiveSignal` to set `activeTab('chat')`. This is no longer needed because `navigateToRoomAgent` already sets `currentRoomActiveTabSignal.value = 'chat'`.

5. In the room cleanup effect (`return () => { ... }` in the `[roomId]` useEffect), keep clearing `currentRoomActiveTabSignal.value = null`. Remove the `currentRoomTabSignal.value = null` line (the transient signal is no longer used by Room.tsx).

6. Update the inline `onGoalClick` handler in the tasks tab (line ~319) from `currentRoomTabSignal.value = 'goals'` to `navigateToRoomTab(roomId, 'goals')`.

7. Update `Room.tsx` imports: add `navigateToRoomTab` from router, remove `navigateToRoom` and `navigateToRoomAgent` if they are no longer directly used. Keep `currentRoomActiveTabSignal`. Remove `currentRoomTabSignal` import if no longer referenced. Keep `currentRoomAgentActiveSignal` if still read (for `isSessionTakeover` check).

8. Update `packages/web/src/islands/__tests__/Room.test.tsx` to reflect the new behavior: tab clicks should result in `navigateToRoomTab` calls, not direct signal mutations.

**Acceptance Criteria:**

- Room.tsx has no `useState` for tab management
- Tab clicks update the URL (verified via `navigateToRoomTab` mock in tests)
- `currentRoomActiveTabSignal` is the single source of truth for which tab is shown
- The `currentRoomTabSignal` (transient pending-tab) is no longer imported or used in Room.tsx
- Tests pass with `cd packages/web && bunx vitest run src/islands/__tests__/Room.test.tsx`

**Dependencies:** Milestone 1 Task 1 and Task 2 (needs `navigateToRoomTab`)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4: Migrate cross-file callers to navigateToRoomTab

**Description:** Update BottomTabBar, RoomDashboard, TaskHeader, and RoomContextPanel to use `navigateToRoomTab` instead of setting `currentRoomTabSignal` directly. After this task, `currentRoomTabSignal` can potentially be removed (or kept only if other consumers remain).

**Subtasks:**

1. **BottomTabBar.tsx** (`packages/web/src/islands/BottomTabBar.tsx`):
   - Import `navigateToRoomTab` from router.
   - In `handleTabClick`, replace the `room-overview`, `room-tasks`, `room-agents`, `room-missions` cases:
     - `room-overview`: `navigateToRoomTab(roomId, 'overview')` (instead of setting `currentRoomTabSignal.value = 'overview'` + `navigateToRoom`)
     - `room-tasks`: `navigateToRoomTab(roomId, 'tasks')`
     - `room-agents`: `navigateToRoomTab(roomId, 'agents')`
     - `room-missions`: `navigateToRoomTab(roomId, 'goals')`
   - Remove `currentRoomTabSignal` import if no longer used.
   - Update `packages/web/src/islands/__tests__/BottomTabBar.test.tsx` accordingly.

2. **RoomDashboard.tsx** (`packages/web/src/components/room/RoomDashboard.tsx`):
   - Import `navigateToRoomTab` from router.
   - Need the roomId -- check if it's available via props or `currentRoomIdSignal`. Currently RoomDashboard reads from `roomStore.room.value`, so `roomStore.room.value?.id` can provide the roomId.
   - Replace `currentRoomTabSignal.value = 'tasks'` (line ~277, ~283, ~289) with `navigateToRoomTab(roomStore.room.value!.id, 'tasks')`. **Safety note:** The non-null assertion (`!`) is safe here because `RoomDashboard` only renders when a room is loaded (the parent component guards this). However, if the implementer prefers defensive coding, use `const roomId = roomStore.room.value?.id; if (roomId) navigateToRoomTab(roomId, 'tasks');`.
   - Remove `currentRoomTabSignal` import.
   - Update `packages/web/src/components/room/RoomDashboard.test.tsx`.

3. **TaskHeader.tsx** (`packages/web/src/components/room/task-shared/TaskHeader.tsx`):
   - Import `navigateToRoomTab` from router.
   - Replace `currentRoomTabSignal.value = 'goals'` (line ~112) with `navigateToRoomTab(roomId, 'goals')` -- the roomId is available from `currentRoomIdSignal` or the component's props. Check the component's context to determine the best source.
   - Remove `currentRoomTabSignal` import.
   - Update `packages/web/src/components/room/task-shared/__tests__/TaskHeader.test.tsx`.

4. **RoomContextPanel.tsx** (`packages/web/src/islands/RoomContextPanel.tsx`):
   - Import `navigateToRoomTab` from router.
   - Replace `currentRoomTabSignal.value = 'goals'` (line ~95) with `navigateToRoomTab(roomId, 'goals')`.
   - Replace `currentRoomTabSignal.value = 'tasks'` (line ~101) with `navigateToRoomTab(roomId, 'tasks')`.
   - The roomId should be available from `currentRoomIdSignal.value` or equivalent.
   - Remove `currentRoomTabSignal` import.
   - Update `packages/web/src/islands/__tests__/RoomContextPanel.test.tsx`.

5. **Concrete `currentRoomTabSignal` cleanup.** After migrating all callers:
   - Run `grep -r 'currentRoomTabSignal' packages/web/src/ --include='*.ts' --include='*.tsx' -l` to find all remaining references.
   - Remove the `currentRoomTabSignal` export from `packages/web/src/lib/signals.ts`.
   - Update any test files that mock or reference `currentRoomTabSignal` to use `currentRoomActiveTabSignal` instead.
   - Remove the `navigate-to-room-tab-reset.test.ts` test file (tests the old pending-tab mechanism which no longer applies) or rewrite it to test the new `navigateToRoomTab` behavior.
   - **Acceptance criterion:** No non-test file imports `currentRoomTabSignal`. The signal definition is removed from `signals.ts`.

6. Run full web test suite to confirm no regressions: `cd packages/web && bunx vitest run`.

**Acceptance Criteria:**

- No production code (non-test) sets `currentRoomTabSignal.value = ...` -- all tab navigation goes through `navigateToRoomTab`
- BottomTabBar tab clicks update the URL to `/room/:id/tasks` etc.
- Goal badge clicks in TaskHeader and RoomContextPanel navigate to `/room/:id/goals`
- RoomDashboard "view all tasks" links navigate to `/room/:id/tasks`
- All affected test files updated and passing
- `cd packages/web && bunx vitest run` passes

**Dependencies:** Task 3 (Room.tsx must be migrated first so the pending-tab useEffect is removed)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
