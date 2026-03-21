# Milestone 3: RoomContextPanel Redesign

## Goal

Fully rewrite `RoomContextPanel.tsx` to implement the new goal-centric sidebar layout with collapsible sections and proper navigation.

## Tasks

### Task 3.1: Implement Collapsible Section Components

**Description:** Create reusable collapsible section header components that will be used for Goals, Tasks, and Sessions sections. Each section has a header with title, count badge, and expand/collapse toggle.

**Agent type:** coder

**Depends on:** (none)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/CollapsibleSection.tsx`:
   - Props: `title: string`, `count?: number`, `defaultExpanded?: boolean`, `headerRight?: ComponentChildren` (for action buttons like [+]), `children: ComponentChildren`.
   - Renders a section header with the triangle toggle indicator (right-pointing when collapsed, down-pointing when expanded), title text in uppercase small caps style, optional count badge, and optional `headerRight` slot.
   - Clicking the header toggles the section body visibility.
   - Use local `useState` for expand/collapse state.
   - Style: header text should be `text-xs font-semibold text-gray-500 uppercase tracking-wider`, consistent with existing sidebar styling.
3. Ensure the component is importable without knip dead-export warnings. Either add it to the barrel export in `packages/web/src/components/room/index.ts` (if one exists) or verify that direct file imports are allowed by the knip configuration.
4. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- `CollapsibleSection` renders with expand/collapse toggle.
- Default expansion state is configurable.
- `headerRight` slot renders inline with the section title.
- No knip dead-export warnings for the new component.
- TypeScript compiles without errors.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 3.2: Rewrite RoomContextPanel with New Layout

**Description:** Rewrite `RoomContextPanel.tsx` to implement the full new sidebar layout: pinned Dashboard and Room Agent items at top, then Goals section with expandable goals showing linked tasks, then orphan Tasks section with tab filter, then collapsible Sessions section.

**Agent type:** coder

**Depends on:** Task 1.1 (room store computed signals), Task 2.1 (room agent route), Task 3.1 (collapsible section)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Rewrite `packages/web/src/islands/RoomContextPanel.tsx`:
   - **Remove** the "All Rooms" back button (nav rail handles this).
   - **Remove** the standalone "New Session" button from the top (move to Sessions section header).
   - **Keep** task stats strip below room name area showing `N pending . N active` summary.
   - **Pinned items section** (no section header):
     - Dashboard button (existing) - navigates to `/room/:roomId` via `navigateToRoom`.
     - Room Agent button (existing) - navigates to `/room/:roomId/agent` via `navigateToRoomAgent`.
     - Visual divider after pinned items.
   - **Goals section** using `CollapsibleSection` with title "GOALS" and count of active goals:
     - Default expanded.
     - Each goal renders as an expandable row with triangle toggle, goal title, and status indicator.
     - When expanded, shows linked tasks (from `roomStore.tasksByGoalId`) indented under the goal.
     - Each linked task is clickable, navigating to `/room/:roomId/task/:taskId` via `navigateToRoomTask`.
     - Task rows show a status dot (color by status) and task title.
     - Goal expand/collapse uses local state (not URL-addressable).
   - **Tasks section** using `CollapsibleSection` with title "TASKS":
     - Default expanded.
     - Tab bar inside the section: Active | Review | Done. Defaults to "Active".
     - Lists orphan tasks from `roomStore.orphanTasksActive`, `roomStore.orphanTasksReview`, or `roomStore.orphanTasksDone` based on selected tab.
     - Each task clickable, navigating to task view.
     - Show "No orphan tasks" empty state when the filtered list is empty.
   - **Sessions section** using `CollapsibleSection` with title "SESSIONS", count, and `headerRight` containing the [+] create session button:
     - Default collapsed.
     - Lists non-archived sessions (with "Show archived" toggle as before).
     - Each session clickable, navigating to `/room/:roomId/session/:sessionId`.
     - Session rows show status dot, title, and relative time.
   - **Selection highlighting**: The currently active item (based on `currentRoomSessionIdSignal` and `currentRoomTaskIdSignal`) should have a highlighted background (`bg-dark-700`).
   - **`isDashboardSelected` logic** (CRITICAL): Must be `currentRoomSessionIdSignal.value === null && currentRoomTaskIdSignal.value === null`. The current code only checks `selectedSessionId === null`, which would incorrectly highlight Dashboard when a task is selected (since task navigation sets session ID to null). Both signals must be null for Dashboard to be selected.
   - **Mobile drawer**: Every navigation action (Dashboard click, Room Agent click, task click, session click) must call `onNavigate?.()` to close the mobile drawer. The existing `onNavigate` prop from `ContextPanel` must be preserved.
3. Import and use `navigateToRoomAgent` from `router.ts` for the Room Agent button.
4. Import both `currentRoomSessionIdSignal` and `currentRoomTaskIdSignal` from signals. The current `RoomContextPanel.tsx` only imports `currentRoomSessionIdSignal` — the task signal import must be added explicitly.
5. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- The sidebar renders all five areas: stats, pinned items, goals, tasks, sessions.
- Goals section shows goals with expandable linked tasks.
- Tasks section shows only orphan tasks with tab filtering.
- Sessions section is collapsible with create button in header.
- Back button is removed.
- All navigation targets produce correct URLs.
- Current selection is visually highlighted.
- Dashboard is NOT highlighted when a task or Room Agent is selected (`isDashboardSelected` checks both signals are null).
- Mobile drawer closes on every navigation action (`onNavigate?.()` called).
- TypeScript compiles without errors.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
