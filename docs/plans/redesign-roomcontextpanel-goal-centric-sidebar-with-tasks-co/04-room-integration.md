# Milestone 4: Room.tsx Integration

## Goal

Ensure the `Room.tsx` component correctly handles the new Room Agent URL route and that all sidebar navigation targets drive the correct main content views. This is an integration validation task — its output may be minor wiring fixes plus a passing typecheck, or it may require no code changes if Milestones 2 and 3 work correctly end-to-end.

## Tasks

### Task 4.1: Validate and Fix Room.tsx Integration with New Routes

**Description:** Verify the end-to-end flow from new sidebar navigation to main content rendering. Fix any wiring issues found. The `Room.tsx` component renders `TaskView`, `ChatContainer`, or the tabbed dashboard based on `sessionViewId`/`taskViewId` props. Ensure the new Room Agent route, task navigation, and dashboard selection all produce the correct rendering.

**Agent type:** coder

**Depends on:** Task 2.1 (room agent route), Task 3.2 (RoomContextPanel rewrite)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Verify in `packages/web/src/islands/MainContent.tsx` that the `roomSessionId` signal (from `currentRoomSessionIdSignal`) correctly passes the synthetic `room:chat:<roomId>` value to the `Room` component's `sessionViewId` prop when navigating via the agent URL. The `navigateToRoomAgent` function (from Milestone 2) sets `currentRoomSessionIdSignal` to the synthetic ID, so `Room.tsx` should already receive it as `sessionViewId` and render `ChatContainer`.
3. Verify by running `bun run typecheck` and reviewing the signal flow: navigating to `/room/<uuid>/agent` should result in `sessionViewId` being the synthetic ID, which causes Room.tsx to render `ChatContainer`. If the flow is broken, fix the signal wiring.
4. In `packages/web/src/islands/ContextPanel.tsx`, verify that `RoomContextPanel` is still rendered correctly when a room is selected (the `onNavigate` prop from `ContextPanel` should still close the mobile drawer).
5. Run `bun run typecheck`, `bun run lint`, `bun run format`.

**Acceptance criteria:**
- Navigating to `/room/<uuid>/agent` renders the Room Agent chat view in the main content area.
- The Room Agent sidebar item is highlighted when viewing the agent route.
- All sidebar navigation items (Dashboard, Room Agent, goal tasks, orphan tasks, sessions) correctly switch the main content.
- TypeScript compiles without errors.
- If code changes were needed, they must be on a feature branch with a GitHub PR created via `gh pr create`. If no changes were needed, document the verification performed in the PR description.
