# Milestone 4: Room.tsx Integration

## Goal

Ensure the `Room.tsx` component correctly handles the new Room Agent URL route and that all sidebar navigation targets drive the correct main content views.

## Tasks

### Task 4.1: Update Room.tsx to Handle Room Agent Route

**Description:** The Room Agent view currently relies on `sessionViewId` being the synthetic `room:chat:<roomId>` string. With the new `/room/:roomId/agent` route, `MainContent.tsx` passes `roomSessionId` signal which is set by the router. Verify this works end-to-end, and if the synthetic session ID approach needs adjustment, update accordingly. Also clean up any references to the removed back button.

**Agent type:** coder

**Depends on:** Task 2.1 (room agent route), Task 3.2 (RoomContextPanel rewrite)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Verify in `packages/web/src/islands/MainContent.tsx` that the `roomSessionId` signal (from `currentRoomSessionIdSignal`) correctly passes the synthetic `room:chat:<roomId>` value to the `Room` component's `sessionViewId` prop when navigating via the agent URL. The `navigateToRoomAgent` function (from Milestone 2) sets `currentRoomSessionIdSignal` to the synthetic ID, so `Room.tsx` should already receive it as `sessionViewId` and render `ChatContainer`.
3. Test the flow manually or with a quick sanity check: navigating to `/room/<uuid>/agent` should show the Room Agent chat. Confirm the `isRoomAgentSelected` logic in `RoomContextPanel` still correctly highlights the Room Agent button when viewing the agent URL.
4. In `packages/web/src/islands/ContextPanel.tsx`, verify that `RoomContextPanel` is still rendered correctly when a room is selected (the `onNavigate` prop from `ContextPanel` should still close the mobile drawer).
5. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- Navigating to `/room/<uuid>/agent` renders the Room Agent chat view in the main content area.
- The Room Agent sidebar item is highlighted when viewing the agent route.
- All sidebar navigation items (Dashboard, Room Agent, goal tasks, orphan tasks, sessions) correctly switch the main content.
- TypeScript compiles without errors.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
