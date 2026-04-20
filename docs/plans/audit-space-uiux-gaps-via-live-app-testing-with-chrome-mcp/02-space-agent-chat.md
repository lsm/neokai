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
- SpaceIsland: When `sessionViewId` prop is set, render ChatContainer instead of tabs

## Tasks

### Task 2.1: Provision Space Agent Session in Daemon

**Description:** Ensure the daemon provisions a `space:chat:{spaceId}` session for each space, similar to how room agent sessions are provisioned. The session should be created lazily (on first access) to handle both new and existing spaces without requiring a migration.

**Agent type:** coder

**Key files to reference:**
- `packages/daemon/src/lib/agent/` — how room agent sessions are created
- `packages/daemon/src/lib/rpc-handlers/room-handlers.ts` lines 64-85 — room agent session provisioning during `room.create`
- `packages/daemon/src/lib/session/session-lifecycle.ts` — session type system
- `packages/shared/src/types/` — `CreateSessionParams.sessionType` union type
- Search for `room:chat:` and `room_chat` in daemon code

**Subtasks:**
1. **Add session type**: Add `'space_chat'` to the `CreateSessionParams.sessionType` union in shared types (alongside existing `'room_chat'`). Update any type guards or validators.
2. **Implement lazy provisioning**: When `space:chat:{spaceId}` session is requested (via ChatContainer or session fetch), check if it exists. If not, create it with `sessionType: 'space_chat'` and link to the space. Lazy provisioning avoids needing a migration for existing spaces.
3. **Space agent context**: The space agent session should have access to space-relevant context via MCP tools (similar to how `spaces:global` session uses space-agent-tools). Specifically: inject the space's MCP tools so the agent can query space metadata, list tasks, list workflows, check workflow run status, and manage agents. Reference `packages/daemon/src/lib/agent/space-agent-tools.ts` if it exists, or the MCP tool registration pattern used for room agents.
4. **Session listing**: Ensure the space agent session appears when listing sessions for a space, so SpaceDetailPanel's Sessions section can display it.
5. **Online test**: Write a test in `packages/daemon/tests/online/space/` verifying: (1) requesting `space:chat:{spaceId}` creates a session on first access, (2) subsequent requests return the same session, (3) the session has the correct `sessionType: 'space_chat'`. Note: this test requires real API credentials per project convention — it must FAIL if credentials are absent, not skip.

**Acceptance criteria:**
- `'space_chat'` added to session type union
- `space:chat:{spaceId}` session is lazily provisioned on first access
- Existing spaces (created before this change) get their agent session on first access — no migration needed
- Session has space-relevant MCP tools injected
- Online test passes (with credentials configured)

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

**Description:** Refactor SpaceIsland to accept `sessionViewId` and `taskViewId` as props (matching Room.tsx's pattern) and render ChatContainer when a session is active. This establishes the content priority chain that M3 will extend.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/islands/Room.tsx` lines 27-31 — props interface: `sessionViewId?: string | null`, `taskViewId?: string | null`
- `packages/web/src/islands/Room.tsx` lines 150-160 — content priority: `taskViewId ? <TaskViewToggle> : sessionViewId ? <ChatContainer> : <tabs>`
- `packages/web/src/islands/MainContent.tsx` — where SpaceIsland is rendered; needs to pass props from signals
- `packages/web/src/islands/SpaceIsland.tsx` — the file to modify

**Subtasks:**
1. **Update MainContent.tsx**: Derive `spaceSessionViewId` from `currentSpaceSessionIdSignal.value` and `spaceTaskViewId` from `currentSpaceTaskIdSignal.value`. Pass both as props to `<SpaceIsland spaceId={spaceId} sessionViewId={spaceSessionViewId} taskViewId={spaceTaskViewId} />`
2. **Update SpaceIsland props**: Add `sessionViewId?: string | null` and `taskViewId?: string | null` to `SpaceIslandProps`. Remove direct reads of `currentSpaceSessionIdSignal` and `currentSpaceTaskIdSignal` from the component body — use props instead.
3. **Add content priority chain**: Following Room.tsx's pattern:
   - If `taskViewId` is set → render SpaceTaskPane (keep existing side-pane behavior for now; M3 Task 3.1 will convert to full-width)
   - Else if `sessionViewId` is set → render `<ChatContainer key={sessionViewId} sessionId={sessionViewId} />`
   - Else → render existing tab view (Dashboard/Agents/Workflows/Settings)
4. Import `ChatContainer` from `./ChatContainer`
5. Write unit test: verify ChatContainer renders when `sessionViewId` prop is set, tabs render when neither is set
6. Add E2E test: navigate to space, click "Space Agent" in SpaceDetailPanel, verify ChatContainer renders with message input

**Acceptance criteria:**
- SpaceIsland accepts `sessionViewId` and `taskViewId` as props (consistent with Room.tsx pattern)
- MainContent passes these props from signals
- Clicking "Space Agent" in SpaceDetailPanel shows ChatContainer in the ContentPanel
- Regular session navigation also renders ChatContainer
- Tab view remains the default when no session/task is selected
- Agent chat is functional (messages can be sent and received)
- E2E test passes

**Dependencies:** Task 1.1 (SpaceDetailPanel), Task 1.3 (navigateToSpaceAgent), Task 2.1 (session provisioning)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 2.4: Add Space Agent Navigation to Router

**Description:** Add the `navigateToSpaceAgent()` router function following the exact pattern of `navigateToRoomAgent()`. This is needed by SpaceDetailPanel's "Space Agent" pinned item and by Task 2.3's ChatContainer integration.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/lib/router.ts` — `navigateToRoomAgent()` at ~line 358 as the pattern
- `packages/web/src/lib/signals.ts` — may need `currentSpaceSessionIdSignal` updates

**Subtasks:**
1. In `router.ts`, add `navigateToSpaceAgent(spaceId: string, replace = false)` function:
   - Set `currentSpaceIdSignal.value = spaceId`
   - Set `currentSpaceSessionIdSignal.value = 'space:chat:' + spaceId`
   - Clear `currentSpaceTaskIdSignal.value = null`
   - Push URL `/space/${spaceId}/agent`
2. In the URL parser (the `parseUrl` or route handler), add handling for `/space/:id/agent` pattern:
   - Set `currentSpaceIdSignal` and `currentSpaceSessionIdSignal` appropriately
3. Export the function
4. Write unit test verifying signal state after calling `navigateToSpaceAgent()`

**Acceptance criteria:**
- `navigateToSpaceAgent('abc')` sets signals correctly and pushes `/space/abc/agent` URL
- URL `/space/:id/agent` is parsed correctly on page load (deep link support)
- Function is exported and available for import

**Dependencies:** None (can start immediately)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
