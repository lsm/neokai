# Milestone 1: Router -- Add Room Tab Routes and Navigation

## Goal

Extend the SPA router to recognize room tab sub-paths (`/room/:id/tasks`, `/room/:id/agents`, `/room/:id/goals`, `/room/:id/settings`) and provide navigation functions that update the URL and `currentRoomActiveTabSignal`.

## Scope

All changes are in `packages/web/src/lib/router.ts` and its test file `packages/web/src/lib/__tests__/router.test.ts`. The existing `navigateToRoom` (plain `/room/:id`) continues to work and maps to the "overview" tab.

---

### Task 1: Add room tab route patterns, extractors, and path creators

**Description:** Add the route infrastructure for four new room tab sub-paths. Follow the existing pattern established by `ROOM_AGENT_ROUTE_PATTERN` and its associated helpers.

**Subtasks:**

1. Add four route pattern constants after `ROOM_MISSION_ROUTE_PATTERN`:
   - `ROOM_TASKS_ROUTE_PATTERN` = `/^\/room\/([a-f0-9-]+)\/tasks$/`
   - `ROOM_AGENTS_ROUTE_PATTERN` = `/^\/room\/([a-f0-9-]+)\/agents$/`
   - `ROOM_GOALS_ROUTE_PATTERN` = `/^\/room\/([a-f0-9-]+)\/goals$/`
   - `ROOM_SETTINGS_ROUTE_PATTERN` = `/^\/room\/([a-f0-9-]+)\/settings$/`
   - Note: `ROOM_TASKS_ROUTE_PATTERN` (`/tasks`) must not collide with `ROOM_TASK_ROUTE_PATTERN` (`/task/:id`) -- the trailing `s` and lack of second capture group distinguishes them.

2. Add extractor function `getRoomTabFromPath(path: string): { roomId: string; tab: string } | null` that tests each of the four tab patterns plus the agent pattern (maps to 'chat') and returns the roomId and tab name, or null.

3. Add path creator functions:
   - `createRoomTasksPath(roomId: string): string` returning `/room/${roomId}/tasks`
   - `createRoomAgentsPath(roomId: string): string` returning `/room/${roomId}/agents`
   - `createRoomGoalsPath(roomId: string): string` returning `/room/${roomId}/goals`
   - `createRoomSettingsPath(roomId: string): string` returning `/room/${roomId}/settings`

4. Update `getRoomIdFromPath` to also match the four new tab patterns (add checks before the legacy chat compat check, after the mission pattern check).

5. Add a `navigateToRoomTab(roomId: string, tab: string, replace = true): void` function:
   - If `tab === 'chat'`, delegate to `navigateToRoomAgent(roomId, replace)` and return.
   - If `tab === 'overview'`, delegate to `navigateToRoom(roomId, replace)` and return (overview has no sub-path).
   - For other tabs, compute the target path using the appropriate path creator.
   - Follow the same guard/signal-clearing pattern as `navigateToRoomAgent`:
     - Guard `routerState.isNavigating`
     - Check same-path early return (still update signals)
     - `replaceState` or `pushState` based on `replace` parameter (default `true` since tab changes should not pollute history)
     - Set `currentRoomIdSignal.value = roomId`
     - Clear `currentRoomSessionIdSignal`, `currentRoomTaskIdSignal`, `currentRoomGoalIdSignal`, `currentRoomAgentActiveSignal`, `currentSessionIdSignal`, `currentSpaceIdSignal`, `currentSpaceSessionIdSignal`, `currentSpaceTaskIdSignal`
     - Set `currentRoomActiveTabSignal.value = tab`
     - Set `navSectionSignal.value = 'rooms'`
   - Use the same `setTimeout(() => { routerState.isNavigating = false }, 0)` pattern in `finally`.

6. Export `navigateToRoomTab`, `getRoomTabFromPath`, and all four path creators.

**Acceptance Criteria:**

- `getRoomTabFromPath('/room/abc-123/tasks')` returns `{ roomId: 'abc-123', tab: 'tasks' }`
- `getRoomTabFromPath('/room/abc-123/agent')` returns `{ roomId: 'abc-123', tab: 'chat' }`
- `getRoomTabFromPath('/room/abc-123')` returns `null` (overview has no sub-path, handled by existing `getRoomIdFromPath`)
- `getRoomIdFromPath` returns the roomId for all four new tab paths
- `navigateToRoomTab(id, 'tasks')` updates the URL to `/room/<id>/tasks` and sets `currentRoomActiveTabSignal.value` to `'tasks'`
- `navigateToRoomTab(id, 'overview')` delegates to `navigateToRoom`
- `navigateToRoomTab(id, 'chat')` delegates to `navigateToRoomAgent`
- All new functions have unit tests in `router.test.ts`

**Dependencies:** None

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2: Update handlePopState and initializeRouter for tab routes

**Description:** Add room tab route matching to the `handlePopState` and `initializeRouter` if/else chains so that browser back/forward and direct URL entry correctly restore the active tab.

**Subtasks:**

1. In `handlePopState`, add a new variable: `const roomTab = getRoomTabFromPath(path)`.

2. Insert a new `else if (roomTab)` branch **after** `roomAgent` and **before** `roomMission` in the if/else chain. This is critical -- tab routes must be matched before the plain `roomId` catch-all but after the agent route (which has its own special handling). The branch should:
   - Set `currentRoomIdSignal.value = roomTab.roomId`
   - Set `currentRoomActiveTabSignal.value = roomTab.tab`
   - Clear all other signals (`currentRoomSessionIdSignal`, `currentRoomTaskIdSignal`, `currentRoomGoalIdSignal`, `currentRoomAgentActiveSignal`, `currentSessionIdSignal`, `currentSpaceIdSignal`, `currentSpaceSessionIdSignal`, `currentSpaceTaskIdSignal`, `currentSpaceViewModeSignal`)
   - Set `navSectionSignal.value = 'rooms'`

3. In the existing `roomId` (plain room) branch of `handlePopState`, add: `currentRoomActiveTabSignal.value = 'overview'` so that navigating back to `/room/:id` resets the tab.

4. Mirror the exact same changes in `initializeRouter`:
   - Add `const initialRoomTab = getRoomTabFromPath(initialPath)`
   - Insert `else if (initialRoomTab)` branch in the same position (after `initialRoomAgent`, before `initialRoomMission`)
   - In the `initialRoomId` branch, add `currentRoomActiveTabSignal.value = 'overview'`

5. Add unit tests verifying:
   - `handlePopState` correctly sets `currentRoomActiveTabSignal` when URL is `/room/:id/goals`
   - `initializeRouter` correctly sets `currentRoomActiveTabSignal` when page loads at `/room/:id/settings`
   - Browser back from `/room/:id/tasks` to `/room/:id` resets `currentRoomActiveTabSignal` to `'overview'`
   - Tab routes do not interfere with existing sub-routes (`/room/:id/task/:taskId`, `/room/:id/mission/:missionId`, `/room/:id/session/:sessionId`)

**Acceptance Criteria:**

- Direct navigation to `/room/abc/goals` in a fresh page load sets `currentRoomActiveTabSignal.value === 'goals'` and `currentRoomIdSignal.value === 'abc'`
- Browser back/forward between `/room/abc/tasks` and `/room/abc` correctly toggles `currentRoomActiveTabSignal` between `'tasks'` and `'overview'`
- Existing room sub-routes (`/room/:id/agent`, `/room/:id/task/:id`, `/room/:id/mission/:id`, `/room/:id/session/:id`) continue to work without regression
- Tests pass with `cd packages/web && bunx vitest run src/lib/__tests__/router.test.ts`

**Dependencies:** Task 1 (needs `getRoomTabFromPath` and route patterns)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
