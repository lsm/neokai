# Milestone 2: Space Agent Chat

## Goal

Enable users to chat with a space-specific agent, following the Room Agent pattern. When a user clicks "Space Agent" in SpaceDetailPanel, the ContentPanel renders a ChatContainer with a dedicated agent session scoped to that space.

## Design Reference

**Room Agent pattern:**
- Session ID: `room:chat:{roomId}` — a "virtual" session that the daemon auto-provisions
- Route: `/room/:roomId/agent`
- RoomContextPanel: "Room Agent" pinned button highlights when active
- Room.tsx: When `sessionViewId` matches the room agent session ID, renders `<ChatContainer sessionId={sessionViewId} />`
- The ChatContainer handles all message display and input — no special wiring needed

**Space Agent pattern (to implement):**
- Session ID: `space:chat:{spaceId}` — same convention
- Route: `/space/:spaceId/agent`
- SpaceDetailPanel: "Space Agent" pinned button highlights when active (from M1)
- SpaceIsland: When `currentSpaceSessionIdSignal` is set, render ChatContainer instead of tabs

## Tasks

### Task 2.1: Provision Space Agent Session in Daemon

**Description:** Ensure the daemon provisions a `space:chat:{spaceId}` session for each space, similar to how room agent sessions are provisioned. The session should be auto-created when a space is loaded, or created on-demand when the user first navigates to the space agent.

**Agent type:** coder

**Key files to reference:**
- `packages/daemon/src/lib/agent/` — how room agent sessions are created
- `packages/daemon/src/lib/rpc-handlers/space-handlers.ts` — space RPC handlers
- Search for `room:chat:` in daemon code to find the room agent session provisioning pattern

**Subtasks:**
1. Research how `room:chat:{roomId}` sessions are provisioned — find the exact code path (likely in session creation or room initialization)
2. Implement the same pattern for `space:chat:{spaceId}`: either auto-provision when a space is selected, or create on first access
3. The space agent session should have access to space-relevant context: space metadata, workflow definitions, task list, agent configurations
4. Ensure the session is listed in the space's sessions so SpaceDetailPanel can show it
5. Write an online test verifying: requesting `space:chat:{spaceId}` creates/returns a valid session, messages can be sent to it

**Acceptance criteria:**
- `space:chat:{spaceId}` session is provisioned and accessible
- Session has space context (space name, workspace path at minimum)
- Messages sent to the session receive agent responses
- Online test passes

**Dependencies:** None (can develop in parallel with M1)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 2.2: Fix spaceWorkflowRun RPC Naming Mismatch

**Description:** The daemon registers the handler as `spaceWorkflowRun.start` (in `space-workflow-run-handlers.ts` line 124), but the frontend `space-store.ts` line 857 calls `spaceWorkflowRun.create`. Fix this naming mismatch and clean up stale TODO comments.

**Agent type:** coder

**Subtasks:**
1. In `packages/web/src/lib/space-store.ts`, rename the RPC call on line 857 from `hub.request('spaceWorkflowRun.create', ...)` to `hub.request('spaceWorkflowRun.start', ...)`
2. Update the response handling: the `spaceWorkflowRun.start` handler returns `{ run: SpaceWorkflowRun }`, so extract `.run` from the response
3. Remove the stale TODO(M6) comment on line 842
4. Verify existing online tests cover `spaceWorkflowRun.start`; if not, add a test
5. Run all existing tests to confirm no regressions

**Acceptance criteria:**
- Frontend calls `spaceWorkflowRun.start` (matching daemon handler name)
- Response correctly extracted as `{ run: SpaceWorkflowRun }`
- TODO(M6) comment removed
- All existing tests pass

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 2.3: Wire SpaceIsland to Render ChatContainer for Agent/Session Views

**Description:** Refactor SpaceIsland to detect when `currentSpaceSessionIdSignal` is set and render ChatContainer instead of the tab view, following Room.tsx's content priority pattern (taskView → sessionView → dashboard tabs).

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/islands/Room.tsx` lines 150-160 — the priority pattern: `taskViewId ? <TaskViewToggle> : sessionViewId ? <ChatContainer> : <tabs>`
- `packages/web/src/islands/SpaceIsland.tsx` — the file to modify
- `packages/web/src/islands/ChatContainer.tsx` — import and use

**Subtasks:**
1. In `SpaceIsland.tsx`, read `currentSpaceSessionIdSignal.value` as `sessionViewId`
2. Add the same content priority as Room.tsx:
   - If `activeTaskId` is set → render SpaceTaskPane (existing behavior, but consider making it full-width — see M3)
   - Else if `sessionViewId` is set → render `<ChatContainer key={sessionViewId} sessionId={sessionViewId} />`
   - Else → render existing tab view (Dashboard/Agents/Workflows/Settings)
3. Import `ChatContainer` from `./ChatContainer`
4. Ensure the Space Agent session ID `space:chat:{spaceId}` triggers the ChatContainer view
5. Write unit test: verify ChatContainer renders when `currentSpaceSessionIdSignal` is set
6. Add E2E test: navigate to space, click "Space Agent" in SpaceDetailPanel, verify ChatContainer renders with message input

**Acceptance criteria:**
- Clicking "Space Agent" in SpaceDetailPanel shows ChatContainer in the ContentPanel
- Regular session navigation also renders ChatContainer
- Tab view remains the default when no session/task is selected
- Agent chat is functional (messages can be sent and received)
- E2E test passes

**Dependencies:** Task 1.1, Task 1.3, Task 2.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
