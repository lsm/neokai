# Milestone 3: Route-Driven Content Switching

## Goal

Refactor SpaceIsland's content rendering from a purely tab-based model to a route-driven model that supports dashboard tabs (default), agent/session chat, and full-width task view — matching the Room component's pattern.

## Design Reference

**Room.tsx content priority:**
```
taskViewId   → <TaskViewToggle roomId={roomId} taskId={taskViewId} />
sessionViewId → <ChatContainer sessionId={sessionViewId} />
default      → Header + Tab bar + Tab content
```

**SpaceIsland target content priority (after M2 partially wires this):**
```
activeTaskId  → <SpaceTaskView spaceId={spaceId} taskId={activeTaskId} />  (full-width)
sessionViewId → <ChatContainer sessionId={sessionViewId} />                 (from M2)
default       → Tab bar + Tab content (Dashboard/Agents/Workflows/Settings)
```

## Tasks

### Task 3.1: Make Task View Full-Width in SpaceIsland

**Description:** Currently SpaceTaskPane renders as a 320px side panel alongside the tab content. Refactor so that when a task is selected, SpaceTaskPane takes the full content area (replacing tabs), matching how Room shows TaskViewToggle full-width.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/islands/SpaceIsland.tsx` — currently renders task pane as `w-80` right column
- `packages/web/src/islands/Room.tsx` lines 155-156 — TaskViewToggle takes full width
- `packages/web/src/components/space/SpaceTaskPane.tsx` — may need layout adjustments for full-width

**Subtasks:**
1. In `SpaceIsland.tsx`, move the task view to the content priority chain (before session, before tabs):
   ```
   activeTaskId ? <SpaceTaskPane full-width /> : sessionViewId ? <ChatContainer /> : <tabs>
   ```
2. Remove the 320px right column rendering for SpaceTaskPane
3. Add a header to the full-width task view with: back button (navigates to `/space/:id`), task title, status badge
4. Adjust SpaceTaskPane layout for full-width display (it currently assumes narrow width). Consider using a max-width container (e.g., `max-w-3xl mx-auto`) for readability
5. Ensure clicking a task in SpaceDetailPanel navigates to `/space/:id/task/:tid` and shows full-width task view
6. Write unit test: verify SpaceTaskPane renders full-width when task selected, tabs hidden
7. Add E2E test: click task in SpaceDetailPanel, verify task pane fills content area, click back, verify tabs return

**Acceptance criteria:**
- Task view takes full content width (not 320px side panel)
- Tab bar is hidden when task is selected
- Back button returns to dashboard/tabs
- SpaceTaskPane is readable at full width (max-width constraint)
- Task navigation from SpaceDetailPanel works
- E2E test passes

**Dependencies:** Task 1.1 (SpaceDetailPanel), Task 2.3 (content priority chain)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 3.2: Handle All Space Sub-Routes in SpaceIsland

**Description:** Ensure SpaceIsland correctly handles all sub-route patterns: `/space/:id` (dashboard), `/space/:id/agent` (space agent), `/space/:id/session/:sid` (session), `/space/:id/task/:tid` (task). Currently only task sub-routes are partially handled.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/lib/router.ts` — route parsing logic
- `packages/web/src/islands/MainContent.tsx` — how spaceId/sessionViewId/taskViewId are passed
- `packages/web/src/lib/signals.ts` — `currentSpaceSessionIdSignal`, `currentSpaceTaskIdSignal`

**Subtasks:**
1. Verify `MainContent.tsx` passes `sessionViewId` and `taskViewId` to SpaceIsland (similar to how Room receives them as props). If not, add these props.
2. In `MainContent.tsx`, derive session and task view IDs from signals:
   - `spaceSessionViewId = currentSpaceSessionIdSignal.value` (when `currentSpaceIdSignal` is set)
   - `spaceTaskViewId = currentSpaceTaskIdSignal.value` (when `currentSpaceIdSignal` is set)
3. Pass both as props to `<SpaceIsland spaceId={spaceId} sessionViewId={spaceSessionViewId} taskViewId={spaceTaskViewId} />`
4. Update `SpaceIsland` to accept `sessionViewId` and `taskViewId` as props (replacing direct signal reads) for consistency with Room pattern
5. Verify deep link support: loading `/space/abc/agent` directly should show the space agent chat
6. Write E2E test: deep link to `/space/:id/agent`, verify chat loads. Deep link to `/space/:id/task/:tid`, verify task pane loads.

**Acceptance criteria:**
- All space sub-routes render the correct content
- Props-based rendering (matching Room pattern) instead of direct signal reads in SpaceIsland
- Deep links work for all sub-routes
- E2E test passes

**Dependencies:** Task 2.3 (ChatContainer wiring)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
