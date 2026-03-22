# Redesign RoomContextPanel: Goal-Centric Sidebar

## Goal

Redesign the `RoomContextPanel` from a flat session-centric list into a structured, goal-and-task-centric sidebar with collapsible sections and URL-addressable navigation. Every clickable item that changes the main content view must have a URL that survives page refresh.

## Current State

- `RoomContextPanel.tsx` shows: back button, new session button, task stats strip, Dashboard/Room Agent pinned items, flat session list with archive toggle.
- Router (`router.ts`) already supports `/room/:roomId`, `/room/:roomId/session/:sessionId`, `/room/:roomId/task/:taskId` routes.
- `room-store.ts` has `goals`, `tasks`, and `sessions` signals. `RoomGoal.linkedTaskIds` tracks task-to-goal linkage.
- `Room.tsx` renders `TaskView`, `ChatContainer`, or tabbed dashboard based on `sessionViewId`/`taskViewId` props.
- No URL route exists for `/rooms/:roomId/agent` (Room Agent uses a synthetic session ID `room:chat:<roomId>`).

## Approach

Break this into 6 milestones working bottom-up: store/computed additions first, then router enhancements, then the main component redesign, integration into Room.tsx, unit tests, and finally E2E tests.

## Milestones

1. **Room Store Computed Signals** - Add computed signals to `room-store.ts` for orphan tasks (tasks not linked to any goal), tasks grouped by goal, and filtered task lists by status category.
2. **Router: Room Agent URL Route** - Add `/room/:roomId/agent` route pattern so the Room Agent view is URL-addressable and survives page refresh. Update `navigateToRoomSession` or add a dedicated `navigateToRoomAgent` function.
3. **RoomContextPanel Redesign** - Full rewrite of `RoomContextPanel.tsx` with the new layout: Dashboard + Room Agent pinned items, collapsible Goals section with expandable goals showing linked tasks, orphan Tasks section with tab filter, collapsible Sessions section with create button. Remove back button.
4. **Room.tsx Integration** - Update `Room.tsx` to handle the new Room Agent route (detect `/room/:roomId/agent` and render Room Agent chat). Ensure all navigation from the new sidebar correctly drives main content.
5. **Unit Tests** - Unit tests for new computed signals in room-store, the redesigned RoomContextPanel rendering (goals section, tasks section, sessions section, collapsible behavior), and router route parsing.
6. **E2E Tests** - Playwright E2E tests for URL-addressable navigation (refresh persistence for dashboard, agent, task, session routes), goal expand/collapse interaction, and task tab filtering.

## Cross-Milestone Dependencies

- Milestone 2 (router) and Milestone 1 (store) are independent and can run in parallel.
- Milestone 3 (component redesign) depends on both Milestone 1 and Milestone 2.
- Milestone 4 (Room.tsx integration) depends on Milestone 2 and Milestone 3. Note: Task 4.1 is an integration validation task — its output may be a passing typecheck/test run plus minor wiring fixes rather than a large code PR. If no code changes are needed, the PR should document the verification performed.
- Milestone 5 (unit tests) depends on Milestones 1-3.
- Milestone 6 (E2E tests) depends on Milestone 4.

## Estimated Total Tasks: 10

## Key Design Decisions

- **`draft` and `pending` task statuses** are included in the "Active" tab filter bucket alongside `in_progress`. This ensures no tasks silently vanish from the sidebar.
- **`isDashboardSelected`** must be true ONLY when both `currentRoomSessionIdSignal.value === null` AND `currentRoomTaskIdSignal.value === null`. Selecting a task or the Room Agent must NOT highlight the Dashboard.
- **Room Agent page-load path**: When `initializeRouter` parses `/room/:roomId/agent`, it must set `currentRoomSessionIdSignal` to the synthetic `room:chat:${roomId}` value. Without this, the Room Agent chat will not render on page refresh (Room.tsx requires a non-null `sessionViewId`). This couples the clean URL to the synthetic ID mechanism — accepted as pragmatic technical debt.
- **Mobile drawer**: All navigation actions in the redesigned panel must still call `onNavigate?.()` to close the mobile drawer, preserving existing mobile behavior.
- **Goal-task linkage in E2E setup**: Use `goal.create` RPC to create goals, `task.create` to create tasks, then `goal.linkTask` RPC (`{ roomId, goalId, taskId }`) to link tasks to goals. The `goal.create` handler does NOT accept `linkedTaskIds` directly — linkage is always done via `goal.linkTask`.
