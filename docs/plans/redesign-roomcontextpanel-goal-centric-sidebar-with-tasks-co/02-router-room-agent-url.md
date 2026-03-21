# Milestone 2: Router - Room Agent URL Route

## Goal

Make the Room Agent view URL-addressable at `/room/:roomId/agent` so it survives page refresh. Currently, the Room Agent uses the synthetic session ID `room:chat:<roomId>` but has no dedicated URL -- navigating to it uses the same `/room/:roomId/session/:sessionId` pattern with this synthetic ID, which is fragile.

## Tasks

### Task 2.1: Add Room Agent Route Pattern and Navigation Function

**Description:** Add a dedicated URL route `/room/:roomId/agent` for the Room Agent view. Add route pattern matching, path creation, extraction, and a `navigateToRoomAgent` function. Update the `initializeRouter` popstate handler to recognize this route.

**Agent type:** coder

**Depends on:** (none)

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/web/src/lib/router.ts`:
   - Add `ROOM_AGENT_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/agent$/` alongside existing route patterns.
   - Add `createRoomAgentPath(roomId: string): string` returning `/room/${roomId}/agent`.
   - Add `getRoomAgentFromPath(path: string): string | null` that extracts the roomId if the path matches the agent route pattern.
   - Add `navigateToRoomAgent(roomId: string, replace = false): void` that pushes `/room/:roomId/agent` to history and sets `currentRoomIdSignal`, `currentRoomSessionIdSignal` to the synthetic `room:chat:<roomId>` value, and clears `currentRoomTaskIdSignal`.
   - Update `getRoomIdFromPath` to also check the agent route pattern.
   - Update the `handleRouteChange` / `initializeRouter` function to recognize the agent route on page load / popstate, setting signals accordingly.
3. In `packages/web/src/islands/RoomContextPanel.tsx`, update `handleRoomAgentClick` to call `navigateToRoomAgent(roomId)` instead of `navigateToRoomSession(roomId, roomAgentSessionId)`.
4. Run `bun run typecheck` to verify no type errors.
5. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- Navigating to `/room/<uuid>/agent` in the browser sets the correct signals for Room Agent view.
- `navigateToRoomAgent(roomId)` pushes the correct URL and updates signals.
- `getRoomIdFromPath` recognizes the agent route.
- Page refresh on `/room/<uuid>/agent` restores Room Agent state.
- TypeScript compiles without errors.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
