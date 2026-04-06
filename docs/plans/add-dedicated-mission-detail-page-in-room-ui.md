# Add Dedicated Mission Detail Page in Room UI

## Goal Summary

Create a dedicated route and page for viewing a single mission (goal) within a room, following the same architectural pattern used by `TaskView`. Currently, missions are only shown as expandable cards in the Missions tab list view (`GoalsEditor`). This plan adds a `/room/:roomId/mission/:goalId` route with a full-featured detail page.

## Approach

Follow the existing `TaskView` pattern closely:
1. Add a new signal (`currentRoomGoalIdSignal`) for URL-driven mission detail navigation
2. Add route pattern, extraction, path creation, and navigation functions in `router.ts`
3. Wire the signal into `handlePopState` and `initializeRouter` (with correct ordering -- must be checked before the plain room route since `getRoomIdFromPath` also matches sub-routes)
4. **Critical cross-cutting change**: Add `currentRoomGoalIdSignal.value = null` alongside EVERY existing `currentRoomTaskIdSignal.value = null` in all navigate functions, `handlePopState` branches, and `initializeRouter` branches (~50 occurrences in `router.ts`)
5. Create a `useMissionDetailData` hook (like `useTaskViewData`) for data fetching
6. Create a `MissionDetail` component with the wireframe layout
7. Render `MissionDetail` as an overlay in `Room.tsx` when the signal is set (same pattern as `TaskViewToggle`)
8. Add navigation entry points from the Missions list and task view mission badge

## Milestones

### M1: Routing Infrastructure (Tasks 1-2)
### M2: Data Hook and MissionDetail Component (Tasks 3-5) -- **Note: depends on M1 Task 2 (placeholder component)**
### M3: Navigation Entry Points and Integration (Task 6)
### M4: Testing (Tasks 7-8)

---

## Tasks

### Task 1: Add mission route to router and signals

**Description:** Add the `/room/:roomId/mission/:goalId` route pattern, signal, extraction functions, path creation, and navigation function to the routing layer. Wire the new route into `handlePopState` and `initializeRouter` so deep links and browser back/forward work correctly. **This is the highest-risk task** because it requires adding `currentRoomGoalIdSignal.value = null` alongside every existing `currentRoomTaskIdSignal.value = null` in `router.ts` (~50 occurrences across navigate functions, `handlePopState` branches, and `initializeRouter` branches).

**Subtasks:**
1. Add `currentRoomGoalIdSignal` to `packages/web/src/lib/signals.ts` (type `string | null`, initialized to `null`)
2. Add `ROOM_MISSION_ROUTE_PATTERN` regex to `packages/web/src/lib/router.ts`:
   - Pattern: `/^\/room\/([a-f0-9-]+)\/mission\/([a-f0-9-]+|[a-z]-[1-9]\d*)$/`
   - Accepts both UUID and short ID formats (matches `ROOM_TASK_ROUTE_PATTERN` pattern)
3. Add `getRoomMissionIdFromPath(path)` extraction function returning `{ roomId, goalId } | null`
4. Update `getRoomIdFromPath(path)` to also match `ROOM_MISSION_ROUTE_PATTERN` and return the roomId (same pattern as how `ROOM_TASK_ROUTE_PATTERN` is handled)
5. Add `createRoomMissionPath(roomId, goalId)` path creation function
6. Add `navigateToRoomMission(roomId, goalId, replace?)` navigation function following the exact same pattern as `navigateToRoomTask` -- set `currentRoomGoalIdSignal.value`, clear all other signals (`currentRoomTaskIdSignal`, `currentRoomSessionIdSignal`, `currentRoomAgentActiveSignal`, space signals, etc.)
7. **CROSS-CUTTING: Add `currentRoomGoalIdSignal.value = null` alongside EVERY existing `currentRoomTaskIdSignal.value = null` in `router.ts`**. Run `grep -n 'currentRoomTaskIdSignal.value = null' packages/web/src/lib/router.ts` and add `currentRoomGoalIdSignal.value = null` on the next line at each occurrence. This covers:
   - All `navigate*` functions: `navigateToRoom`, `navigateToRoomTask`, `navigateToRoomSession`, `navigateToRoomAgent`, `navigateToSpace*`, `navigateToSession`, `navigateToHome`, `navigateToSpaceTask`, `navigateToSpaceSession`, `navigateToSpaceAgent`
   - All `handlePopState` branches (roomMission, roomTask, roomSession, roomAgent, roomId, space*, session)
   - All `initializeRouter` branches (initialRoomMission, initialRoomTask, initialRoomSession, initialRoomAgent, initialRoomId, initialSpace*, initialSession)
   - **Missing even one occurrence will leave stale state that causes the mission overlay to persist when navigating away.**
8. Update `handlePopState` in `router.ts`:
   - Extract `roomMission` from path
   - Add the check **before** the `roomTask` branch (ordering matters -- both are sub-routes of `/room/:roomId/`)
   - When matched, set `currentRoomGoalIdSignal.value`, clear `currentRoomTaskIdSignal`, set `navSectionSignal.value = 'rooms'`
9. Update `initializeRouter` in `router.ts`:
   - Extract `initialRoomMission` from initial path
   - Add the check **before** `initialRoomTask` branch
   - When matched, set `currentRoomGoalIdSignal.value`, clear `currentRoomTaskIdSignal`
10. Export the new signal from `signals.ts` and the new functions from `router.ts`

**Acceptance Criteria:**
- `currentRoomGoalIdSignal` exists and is exported from `signals.ts`
- `navigateToRoomMission(roomId, goalId)` updates URL to `/room/:roomId/mission/:goalId` and sets the signal
- `navigateToRoomMission` clears all other view signals (task, session, agent, space)
- **Every existing `navigate*` function in `router.ts` clears `currentRoomGoalIdSignal.value`** -- verify by searching for `currentRoomTaskIdSignal.value = null` and confirming `currentRoomGoalIdSignal.value = null` appears immediately after at each location
- Browser back/forward correctly restores the mission view signal
- Page refresh on `/room/:roomId/mission/:goalId` correctly sets `currentRoomGoalIdSignal` on init
- Navigating away from mission view clears `currentRoomGoalIdSignal`
- TypeScript compiles with no errors

**Dependencies:** None
**Agent type:** coder

---

### Task 2: Wire MissionDetail view into Room component

**Description:** Pass the new `currentRoomGoalIdSignal` value through `MainContent` to `Room`, and render a `MissionDetail` overlay in `Room.tsx` when the goal ID is set (following the exact same overlay pattern used for `TaskViewToggle`).

**Subtasks:**
1. In `packages/web/src/islands/MainContent.tsx`:
   - Import `currentRoomGoalIdSignal` from signals
   - Read `const roomGoalId = currentRoomGoalIdSignal.value` in the component body
   - Pass `goalViewId={roomGoalId}` prop to `<Room>`
2. In `packages/web/src/islands/Room.tsx`:
   - Add `goalViewId?: string | null` to `RoomProps` interface
   - Import the new `navigateToRoomMission` function (will be created in Task 1)
   - Render a `MissionDetail` overlay when `goalViewId` is set, using the same `absolute inset-0 z-10` pattern as `TaskViewToggle`:
     ```tsx
     {goalViewId && (
       <div class="absolute inset-0 z-10 bg-dark-900 flex flex-col overflow-hidden">
         <MissionDetail key={goalViewId} roomId={roomId} goalId={goalViewId} />
       </div>
     )}
     ```
   - For now, use a placeholder `<MissionDetail>` component -- the real component will be created in Task 3
   - The overlay should appear inside the same `relative` container as the task overlay, after the task overlay block
3. Create a minimal placeholder file `packages/web/src/components/room/MissionDetail.tsx`:
   - Export a `MissionDetail` component that accepts `{ roomId: string; goalId: string }` props
   - For now, render "Mission detail view -- coming soon" with a back button that calls `navigateToRoom(roomId)`
   - This ensures the routing integration can be tested independently

**Acceptance Criteria:**
- Navigating to `/room/:roomId/mission/:goalId` renders the placeholder MissionDetail overlay on top of the room tabs
- The overlay has `z-10` and covers the full content area (header and tabs remain visible underneath)
- The back button navigates back to the room view
- Clicking a different tab while the overlay is shown does NOT navigate away (overlay covers tab bar interaction -- same as task view)
- Browser back from mission URL returns to the room view
- TypeScript compiles with no errors

**Dependencies:** Task 1
**Agent type:** coder

---

### Task 3: Create useMissionDetailData hook and export GoalsEditor sub-components

**Description:** Create a custom hook that encapsulates all data fetching and action handlers for the MissionDetail page, following the `useTaskViewData` pattern. The hook derives the goal reactively from `roomStore.goals` (via LiveQuery) and provides methods for updating, deleting, triggering, and scheduling the mission. Also, export the reusable sub-components from `GoalsEditor.tsx` so `MissionDetail` can import them.

**Subtasks:**
1. **Export reusable sub-components from `GoalsEditor.tsx`** (prerequisite for Task 4 and Task 5). Add `export` keyword to these functions (currently defined as bare `function`):
   - `StatusIndicator` (line ~141)
   - `PriorityBadge` (line ~159)
   - `MissionTypeBadge` (line ~175)
   - `AutonomyBadge` (line ~194)
   - `ProgressBar` (line ~221)
   - `MetricProgress` (line ~269)
   - `RecurringScheduleInfo` (line ~396)
   - `GoalShortIdBadge` (line ~1089)
   - `GoalForm` (line ~1121) -- needed for inline edit mode in MissionDetail
   - Verify line numbers by searching for `function StatusIndicator`, `function PriorityBadge`, etc. in the current file
2. Create `packages/web/src/hooks/useMissionDetailData.ts`
3. Define the hook interface `UseMissionDetailDataResult`:
   - `goal: RoomGoal | null` -- derived from `roomStore.goals` via `useComputed`, matching by UUID or short ID
   - `linkedTasks: NeoTask[]` -- derived from `roomStore.tasks`, filtered by `goal.linkedTaskIds`
   - `executions: MissionExecution[] | null` -- state, loaded on mount for recurring missions
   - `isLoadingExecutions: boolean`
   - `isUpdating: boolean`
   - `isTriggering: boolean`
   - Action handlers: `updateGoal(updates)`, `deleteGoal()`, `triggerNow()`, `scheduleNext(nextRunAt)`, `linkTask(taskId)`, `changeStatus(status)`
   - Available status actions: derived from current goal status (same logic as `getAvailableActions` in `GoalsEditor`)
4. Implement the hook:
   - Use `useComputed` to derive `goal` from `roomStore.goals.value.find(g => g.id === goalId || g.shortId === goalId)`
   - Use `useComputed` to derive `linkedTasks` from `roomStore.tasks.value`
   - Load executions via `roomStore.listExecutions(goalId)` in a `useEffect` when goal is available and missionType is 'recurring'
   - Wrap action handlers with loading state management (same pattern as `useTaskViewData`)
   - For `updateGoal` and `deleteGoal`, call `roomStore.updateGoal(goalId, updates)` and `roomStore.deleteGoal(goalId)` then navigate back on success
   - For `triggerNow`, call `roomStore.triggerNow(goalId)`
   - For `scheduleNext`, call `roomStore.scheduleNext(goalId, nextRunAt)`
5. Export the hook and its result type

**Acceptance Criteria:**
- All 9 reusable sub-components are exported from `GoalsEditor.tsx` (can be imported by `MissionDetail`)
- `useMissionDetailData(roomId, goalId)` returns the goal matching by UUID or short ID
- Linked tasks are derived reactively from roomStore.tasks
- Executions are loaded for recurring missions
- All action handlers update loading states correctly
- Deleting a goal navigates back to the room view
- Hook works correctly when the goal does not exist (returns null goal)
- TypeScript compiles with no errors

**Dependencies:** Task 1
**Agent type:** coder

---

### Task 4: Create MissionDetail component -- header and status sidebar

**Description:** Build the main `MissionDetail` component with the header section (title, short ID, status, badges, edit/delete actions) and the status sidebar (priority, autonomy level, quick actions). This forms the top portion of the two-column layout.

**Subtasks:**
1. Replace the placeholder in `packages/web/src/components/room/MissionDetail.tsx` with the real component
2. Component props: `{ roomId: string; goalId: string }`
3. Use the `useMissionDetailData` hook from Task 3
4. Implement the header section:
   - Back button (left arrow icon) that calls `navigateToRoom(roomId)` and explicitly sets `currentRoomTabSignal.value = 'goals'` to ensure the user lands on the Missions tab (the existing `navigateToRoom` function does NOT set the tab signal, so this must be done manually in the click handler)
   - Mission title (large, bold)
   - Short ID badge (reuse `GoalShortIdBadge` from `GoalsEditor`)
   - Status indicator (reuse `StatusIndicator` from `GoalsEditor`)
   - Edit button -- opens inline edit mode using `GoalForm` from `GoalsEditor` (imported as an exported sub-component). This is the chosen approach over navigating back to the list.
   - Delete button -- opens `ConfirmModal`
5. Implement the two-column layout structure:
   - Desktop: `grid grid-cols-[1fr_320px]` (main content + sidebar)
   - Mobile: `grid grid-cols-1` (stacked)
   - Use `md:grid-cols-[1fr_320px] grid-cols-1` responsive classes
6. Implement the status sidebar (right column):
   - Priority display with colored badge (reuse `PriorityBadge`)
   - Mission type badge (reuse `MissionTypeBadge`)
   - Autonomy level badge (reuse `AutonomyBadge`)
   - Quick actions section:
     - "Run Now" button (recurring missions only, calls `triggerNow`)
     - "Schedule" button with datetime picker (recurring missions only, calls `scheduleNext`)
     - "Reactivate" button (when status is completed/archived/needs_human)
     - "Complete" button (when status is active/needs_human)
     - "Needs Review" button (when status is active)
   - Created/Updated timestamps
7. Add loading and error states:
   - Loading: show skeleton placeholders
   - Goal not found: show "Mission not found" with back button

**Acceptance Criteria:**
- Header displays mission title, short ID, status, and type badges correctly
- Edit and delete actions are wired to the correct handlers
- Status sidebar shows priority, autonomy level, and mission type
- Quick actions are conditionally rendered based on mission type and status
- Two-column layout stacks to single column on mobile (< md breakpoint)
- Loading and error states are handled
- All reusable sub-components from `GoalsEditor` are imported rather than duplicated
- TypeScript compiles with no errors

**Dependencies:** Task 2, Task 3
**Agent type:** coder

---

### Task 5: Create MissionDetail component -- main content sections

**Description:** Build the main content area of the MissionDetail component with description, progress, linked tasks, and type-specific sections (metrics for measurable, schedule and execution history for recurring).

**Subtasks:**
1. Description section:
   - Display `goal.description` in a readable format
   - Show "No description provided" if empty
2. Progress section:
   - For one-shot missions: show `ProgressBar` with `goal.progress` percentage
   - For measurable missions: show `MetricProgress` with each metric's name, current/target, unit, and progress bar
3. Linked Tasks section:
   - Display linked tasks as interactive cards (not just a list)
   - Each card shows: task title, status badge (reuse `TaskStatusBadge`), short ID
   - Clicking a task card calls `navigateToRoomTask(roomId, taskId)`
   - Show "No tasks linked" empty state
   - Include a "Link Task" input at the bottom (same as in `GoalsEditor` expanded view)
4. Measurable mission section (conditional on `missionType === 'measurable'`):
   - Detailed metric progress with individual bars
   - If no metrics, show "No metrics configured"
5. Recurring mission section (conditional on `missionType === 'recurring'`):
   - Schedule info: cron expression, timezone, next run time, paused status (reuse `RecurringScheduleInfo` pattern)
   - Execution history list (reuse the execution item rendering from `GoalsEditor`)
   - Show loading skeleton while executions are being fetched
   - Show "No executions yet" empty state
6. Activity timeline (bottom section, recurring missions only):
   - **Important**: The `goal.getMetricHistory` RPC does NOT exist -- `GoalManager.getMetricHistory()` method exists in the daemon but is not registered as an RPC handler. Do NOT attempt to fetch metric history from the frontend.
   - For recurring missions only: show execution entries (started, completed, failed) using the `executions` data already loaded by `useMissionDetailData`
   - For one-shot and measurable missions: do NOT render the activity timeline section (no data source available). These mission types will show "No activity yet" or the section is omitted entirely.
   - If no events, show "No activity yet"

**Acceptance Criteria:**
- Description is displayed correctly (or empty state)
- Progress bar shows correct percentage for one-shot missions
- Metric progress shows all metrics with individual progress bars for measurable missions
- Linked tasks are displayed as interactive cards with status badges
- Clicking a linked task navigates to the task detail view
- Link task input works correctly
- Schedule info displays cron expression, timezone, next run, paused status
- Execution history loads and displays correctly for recurring missions
- Activity timeline shows execution events in chronological order for recurring missions only
- Activity timeline section is not rendered for one-shot and measurable missions (no data source available)
- No attempt is made to call a non-existent `goal.getMetricHistory` RPC
- All sections conditionally render based on mission type
- TypeScript compiles with no errors

**Dependencies:** Task 4
**Agent type:** coder

---

### Task 6: Add navigation from Missions list and task view

**Description:** Wire up navigation entry points so users can reach the MissionDetail page from the existing UI. This includes clicking a mission card in the Missions tab, clicking the mission badge in the task view, and updating the task list's goal click handler.

**Subtasks:**
1. In `packages/web/src/components/room/GoalsEditor.tsx`:
   - Add `onGoalClick?: (goalId: string) => void` to `GoalsEditorProps`
   - Add `onGoalClick` to `GoalItemProps`
   - In `GoalItem`, make the card header title area clickable to navigate to the detail page
   - The `onToggleExpand` behavior should remain (clicking the expand arrow or a separate control still expands inline)
   - Best approach: add a dedicated "View Details" button/link in the card header, or make the title itself a link that calls `onGoalClick(goal.id)` (while `onToggleExpand` stays on the expand/collapse chevron)
2. In `packages/web/src/islands/Room.tsx`:
   - Pass `onGoalClick={(goalId) => navigateToRoomMission(roomId, goalId)}` to `GoalsEditor`
   - Import `navigateToRoomMission` from router
3. In `packages/web/src/components/room/task-shared/TaskHeader.tsx`:
   - Import `navigateToRoomMission` from router
   - Change the mission badge click handler from:
     ```tsx
     onClick={() => {
       navigateToRoom(roomId);
       currentRoomTabSignal.value = 'goals';
     }}
     ```
     to:
     ```tsx
     onClick={() => navigateToRoomMission(roomId, associatedGoal.id)}
     ```
   - Remove the `currentRoomTabSignal` import if no longer needed
4. In `packages/web/src/components/room/RoomTasks.tsx`:
   - **This is a non-trivial refactor** -- `onGoalClick` is threaded through 6 internal sub-components, each with their own props interface declaring `onGoalClick?: () => void`. ALL of them must be updated:
     - `RoomTasks` (line 49): `onGoalClick?: (goalId: string) => void` (change signature)
     - `TaskList` (line 300): `onGoalClick?: (goalId: string) => void` (change signature, thread through)
     - `TaskGroup` (line 458): `onGoalClick?: (goalId: string) => void` (change signature, thread through)
     - `TaskItem` (line 598): `onGoalClick?: (goalId: string) => void` (change signature, thread through)
     - The task-goal badge at line 656: change from `onGoalClick?.()` to `onGoalClick?.(goalId)` -- note: the badge receives `goal: RoomGoal | null` via props but currently calls `onGoalClick` with no arguments
     - All intermediate components that pass `onGoalClick={onGoalClick}` through must continue to do so (the signature change propagates automatically)
   - Pass the goal ID through to the badge click handler
5. In `packages/web/src/islands/Room.tsx`:
   - Update the `RoomTasks` `onGoalClick` prop to navigate to the mission detail:
     ```tsx
     onGoalClick={(goalId) => navigateToRoomMission(roomId, goalId)}
     ```
6. Update existing tests affected by the `onGoalClick` signature change in `RoomTasks`:
   - `packages/web/src/components/room/RoomTasks.test.tsx` (lines 809-850 area): update any test that mocks or calls `onGoalClick` to pass a goal ID string argument

**Acceptance Criteria:**
- Clicking a mission card title in the Missions tab navigates to `/room/:roomId/mission/:goalId`
- The mission card's expand/collapse toggle still works independently
- Clicking the mission badge in the task view header navigates to the mission detail page
- Clicking the mission badge in the task list navigates to the mission detail page
- Browser back button returns to the previous view from mission detail
- Existing tests pass (update any that rely on the old `onGoalClick` signature)
- TypeScript compiles with no errors

**Dependencies:** Task 2
**Agent type:** coder

---

### Task 7: Add unit tests for routing and MissionDetail

**Description:** Add unit tests to verify the routing infrastructure and the MissionDetail component rendering and interactions.

**Subtasks:**
1. Create `packages/web/src/lib/__tests__/router-mission.test.ts` (or extend existing router tests if they exist):
   - Test `getRoomMissionIdFromPath` extracts roomId and goalId correctly
   - Test `getRoomMissionIdFromPath` returns null for non-mission paths
   - Test `createRoomMissionPath` generates correct URL
   - Test `navigateToRoomMission` sets the correct signal values and URL
   - Test `navigateToRoomMission` clears other view signals
2. Create `packages/web/src/components/room/MissionDetail.test.tsx`:
   - Test loading state (goal not yet loaded)
   - Test error state (goal not found)
   - Test header renders title, short ID, status, badges
   - Test status sidebar shows priority, autonomy, quick actions
   - Test linked tasks are displayed with correct status badges
   - Test clicking a linked task triggers navigation
   - Test delete confirmation modal
   - Test measurable mission shows metric progress
   - Test recurring mission shows schedule info and execution history
   - Test responsive layout (verify grid classes are present)
3. If `useMissionDetailData` has complex logic, add `packages/web/src/hooks/__tests__/useMissionDetailData.test.ts`

**Acceptance Criteria:**
- All new tests pass
- Existing tests continue to pass
- Tests cover the main rendering paths (loading, error, one-shot, measurable, recurring)
- Tests cover navigation actions (back button, task click, delete)
- No test files use prohibited patterns (direct RPC calls in test actions)

**Dependencies:** Task 5, Task 6
**Agent type:** coder

---

### Task 8: Add E2E tests for MissionDetail navigation

**Description:** Add Playwright E2E tests covering the primary user-visible navigation flows for the new MissionDetail page. Unit tests (Task 7) will not catch broken deep-link navigation, overlay z-index conflicts, or browser history regressions -- E2E tests are essential for this route-driven feature.

**Subtasks:**
1. Create or extend `packages/e2e/tests/features/mission-detail.e2e.ts` (file already exists with in-list expanded view tests):
   - Test: direct URL access `/room/:roomId/mission/:goalId` renders the MissionDetail overlay on page load
   - Test: clicking a mission card title in the Missions tab navigates to `/room/:roomId/mission/:goalId`
   - Test: browser back button from mission detail returns to the Missions tab list view
   - Test: clicking the back button in MissionDetail header returns to the Missions tab
   - Test: clicking a linked task card in MissionDetail navigates to the task detail view
   - Test: browser back from task detail (reached via mission detail) returns to mission detail
   - Test: mission detail overlay covers tab bar (clicking other tabs while overlay is shown does NOT navigate away)
2. Follow existing E2E patterns:
   - All interactions go through the UI (clicks, typing, navigation)
   - All assertions verify visible DOM state
   - Sessions created via "New Session" button
   - Use `waitFor` for async state transitions
   - Do NOT use `hub.request()` or `window.sessionStore` for test actions/assertions

**Acceptance Criteria:**
- All new E2E tests pass
- Tests cover the three critical navigation flows: direct URL, in-app navigation from list, and browser history
- Tests verify the overlay behavior (covers tabs, allows back navigation)
- No prohibited patterns (no direct RPC calls, no internal state access)
- `make run-e2e TEST=tests/features/mission-detail.e2e.ts` passes

**Dependencies:** Task 5, Task 6
**Agent type:** coder

---

### Task 9: Final integration, polish, and PR

**Description:** Do a final review pass, ensure everything works end-to-end, fix any edge cases, and create the feature branch PR.

**Subtasks:**
1. Verify all routing edge cases:
   - Direct URL access `/room/:roomId/mission/:goalId` works on page load
   - Browser back/forward preserves mission view state
   - Navigating from mission detail to task detail and back works
   - Navigating from mission detail to another mission works
2. Verify LiveQuery reactivity:
   - When a linked task's status changes, the MissionDetail view updates
   - When the mission's metrics change, the detail view updates
   - When a new execution completes, the execution history updates
3. Ensure the MissionDetail component is exported from `packages/web/src/components/room/index.ts` if needed
4. Run `bun run check` (lint + typecheck + knip) and fix any issues
5. Run `make test-web` and ensure all tests pass
6. Run `make build` and ensure the production bundle builds
7. Create the feature branch and PR

**Acceptance Criteria:**
- All routing scenarios work correctly
- LiveQuery updates are reflected in the mission detail view
- `bun run check` passes with no errors
- `make test-web` passes with no failures
- `make build` succeeds
- Feature branch created with clean commit history
- PR targets `dev` branch

**Dependencies:** Task 7, Task 8
**Agent type:** coder

### Signal ordering in router.ts

The `handlePopState` and `initializeRouter` functions check routes in a specific order. The new `roomMission` check MUST be added before the `roomTask` check, and both must be before the plain `roomId` check. This is because `getRoomIdFromPath` matches all `/room/:id/*` sub-routes. The current ordering is:

```
space routes > roomAgent > roomTask > roomSession > roomId
```

The new ordering will be:

```
space routes > roomAgent > roomMission > roomTask > roomSession > roomId
```

### Cross-cutting signal clearing in router.ts

**This is the single highest-risk change in the plan.** Every place in `router.ts` that clears `currentRoomTaskIdSignal.value = null` must also clear `currentRoomGoalIdSignal.value = null`. As of this writing, there are ~50 occurrences. Missing even one will leave stale state that causes the mission overlay to persist when navigating away.

**Verification approach**: After completing Task 1 subtask 7, run:
```bash
grep -c 'currentRoomTaskIdSignal.value = null' packages/web/src/lib/router.ts
grep -c 'currentRoomGoalIdSignal.value = null' packages/web/src/lib/router.ts
```
Both counts should be approximately equal.

### Component reuse from GoalsEditor

Nine sub-components in `GoalsEditor.tsx` are currently internal (bare `function` keyword, no `export`). They MUST be exported in Task 3 so `MissionDetail` can import them:
- `StatusIndicator`, `PriorityBadge`, `MissionTypeBadge`, `AutonomyBadge` -- badge components
- `ProgressBar`, `MetricProgress` -- progress display
- `RecurringScheduleInfo` -- schedule display for recurring missions
- `GoalShortIdBadge` -- short ID display
- `GoalForm` -- inline edit form (used for the edit action in MissionDetail header)

This export work is explicitly assigned as subtask 1 of Task 3.

### Avoiding duplication

The `MissionDetail` component should NOT duplicate the business logic already in `GoalsEditor`. Instead, it should:
- Import reusable sub-components from `GoalsEditor.tsx`
- Use `useMissionDetailData` hook for data fetching (same pattern as `useTaskViewData`)
- Use `roomStore` methods for actions
- Focus on the layout and presentation, not the data management

### Back navigation must restore Missions tab

The existing `navigateToRoom(roomId)` function does NOT set `currentRoomTabSignal`. When the user clicks the back button in MissionDetail, the handler must explicitly set `currentRoomTabSignal.value = 'goals'` in addition to calling `navigateToRoom(roomId)`, so the user lands on the Missions tab rather than whatever tab was previously active. This is specified in Task 4 subtask 4.

### Navigation from GoalsEditor

The current `GoalItem` card has an expand/collapse toggle. When we add `onGoalClick`, we need to decide the interaction model. The recommended approach is:
- Clicking the mission title navigates to the detail page (calls `onGoalClick`)
- Clicking the expand/collapse chevron toggles inline expansion (calls `onToggleExpand`)
- This matches the common pattern where the title is a link and the chevron is a separate control

### Activity timeline data source limitations

The activity timeline section is scoped to **recurring missions only** because:
- `goal.getMetricHistory` RPC does NOT exist (daemon method exists but is not registered as an RPC handler)
- One-shot missions have no event history beyond created_at/updated_at timestamps
- Only recurring missions have execution history data available via `goal.listExecutions`

