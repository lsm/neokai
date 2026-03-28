# Milestone 3: Route-Driven Content Switching

## Goal

Extend SpaceIsland's content priority chain (established in M2 Task 2.3) to support full-width task view with task agent session access, and verify all space sub-routes work correctly.

## Design Reference

**Content priority chain after M2 Task 2.3:**
```
taskViewId   → SpaceTaskPane (still side-pane from M2)
sessionViewId → <ChatContainer sessionId={sessionViewId} />
default       → Tab bar + Tab content (Dashboard/Agents/Workflows/Settings)
```

**Target after M3:**
```
taskViewId   → SpaceTaskPane (FULL-WIDTH, with "View Agent Session" button)
sessionViewId → <ChatContainer sessionId={sessionViewId} />
default       → Tab bar + Tab content (Dashboard/Agents/Workflows/Settings)
```

## Tasks

### Task 3.1: Make Task View Full-Width with Agent Session Access

**Description:** Convert SpaceTaskPane from a 320px side panel to a full-width content view (extending the content priority chain from M2 Task 2.3). Add a "View Agent Session" button that leverages the existing `SpaceTask.taskAgentSessionId` field to let users view the task's agent chat.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/islands/SpaceIsland.tsx` — after M2 Task 2.3, has content priority chain with side-pane task view
- `packages/web/src/islands/Room.tsx` lines 155-156 — TaskViewToggle takes full width
- `packages/web/src/components/space/SpaceTaskPane.tsx` — needs layout adjustments + agent session button
- `packages/shared/src/types/space.ts` line 218 — `SpaceTask.taskAgentSessionId?: string | null`
- `packages/shared/src/types/space.ts` line 204 — `SpaceTask.activeSession?: 'worker' | 'leader' | null`

**Subtasks:**
1. In `SpaceIsland.tsx`, convert the task view branch of the content priority chain from side-pane to full-width. Remove the 320px right column. The task view should now take the full content area (same priority position, just full-width):
   ```
   taskViewId ? <full-width SpaceTaskPane /> : sessionViewId ? <ChatContainer /> : <tabs>
   ```
2. Add a header bar to the full-width task view with: back button (navigates to `/space/:id`), task title, status badge
3. Adjust SpaceTaskPane layout for full-width display. Use a max-width container (e.g., `max-w-3xl mx-auto`) for readability since the component currently assumes 320px narrow width.
4. **Add "View Agent Session" button**: When `task.taskAgentSessionId` is set, show a button in the task header or actions section. Clicking it navigates to `/space/:id/session/:taskAgentSessionId` — this reuses the existing session route and ChatContainer rendering from M2. Show the button label as "View Worker Session" or "View Leader Session" based on `task.activeSession` value. Hide the button when `taskAgentSessionId` is null.
5. Write unit test: verify full-width rendering, back button, "View Agent Session" button visibility (shown when `taskAgentSessionId` set, hidden when null)
6. Add E2E test: click task in SpaceDetailPanel → verify full-width task pane → click back → verify tabs return

**Acceptance criteria:**
- Task view takes full content width (not 320px side panel)
- Tab bar is hidden when task is selected
- Back button returns to dashboard/tabs
- SpaceTaskPane is readable at full width (max-width constraint)
- "View Agent Session" button appears when `taskAgentSessionId` is set
- Clicking "View Agent Session" navigates to the session ChatContainer view
- Button hidden when no agent session is linked
- E2E test passes

**Dependencies:** Task 2.3 (content priority chain with props-based rendering)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 3.2: Verify and Fix All Space Sub-Routes

**Description:** Ensure all space sub-route patterns work correctly end-to-end: `/space/:id` (dashboard), `/space/:id/agent` (space agent), `/space/:id/session/:sid` (session), `/space/:id/task/:tid` (task). After M2, SpaceIsland uses props-based rendering — this task verifies the full integration and fixes any gaps in deep link handling.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/lib/router.ts` — route parsing logic, URL → signal mapping
- `packages/web/src/islands/MainContent.tsx` — props passing (updated in M2 Task 2.3)
- `packages/web/src/islands/SpaceIsland.tsx` — content priority chain (updated in M2 Task 2.3, extended in Task 3.1)

**Subtasks:**
1. Verify deep link support for all sub-routes by testing URL parsing:
   - `/space/:id` → `currentSpaceIdSignal` set, no session/task → dashboard tabs
   - `/space/:id/agent` → `currentSpaceIdSignal` + `currentSpaceSessionIdSignal` set → ChatContainer
   - `/space/:id/session/:sid` → `currentSpaceIdSignal` + `currentSpaceSessionIdSignal` set → ChatContainer
   - `/space/:id/task/:tid` → `currentSpaceIdSignal` + `currentSpaceTaskIdSignal` set → full-width SpaceTaskPane
2. Fix any gaps in the URL parser for space sub-routes (router.ts)
3. Verify browser back/forward navigation works between space views (e.g., dashboard → agent → task → back → back)
4. Write E2E test covering all deep link scenarios: direct navigation to `/space/:id/agent`, `/space/:id/task/:tid`, browser back/forward between views

**Acceptance criteria:**
- All space sub-routes render the correct content when navigated to directly (deep links)
- Browser back/forward works correctly between space views
- No signal state leaks between navigation transitions
- E2E test passes

**Dependencies:** Task 2.3 (props-based rendering), Task 3.1 (full-width task view)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
