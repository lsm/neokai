# Milestone 3: Slide-Out Panel

## Goal

Build a reusable right-side slide-out panel component that displays the full session chat for a given session ID, with smooth transition animation.

## Architectural Constraint: ChatContainer Cannot Be Reused

`ChatContainer` reads messages from `sessionStore.sdkMessages` — a global singleton signal that only holds data for ONE session at a time. The entire data-loading chain is triggered by `sessionStore.select()`:

```
select() → doSelect() → startSubscriptions() → fetchInitialState() → sdkMessages.value = [...]
```

Calling `select()` for the slide-out panel's session would overwrite the primary session's data. Suppressing `select()` would leave the panel with no messages. A save/restore wrapper is also broken because `doSelect()` clears `sdkMessages.value = []` when switching, blanking the primary view mid-render.

**Therefore**: The slide-out panel must use a standalone `ReadonlySessionChat` component that fetches and renders messages independently, without touching `sessionStore`. This component loads messages via `state.sdkMessages` RPC + `state.sdkMessages.delta` subscription, keyed to the target `sessionId`, and renders them using the existing `SDKMessageRenderer` components. This is more work than reusing `ChatContainer` but is the only architecturally sound approach.

## Tasks

### Task 3.1: Implement ReadonlySessionChat and SlideOutPanel components

**Agent type:** coder

**Description:**
Build a `ReadonlySessionChat` component that independently fetches and renders a session's messages (without touching `sessionStore`), then wrap it in a `SlideOutPanel` with slide-in animation, backdrop, and keyboard support.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/ReadonlySessionChat.tsx`:
   - **Props**: `{ sessionId: string }`
   - **Data loading** (independent of `sessionStore`):
     - **Channel subscription (required)** — use `useMessageHub()` hook which exposes `joinRoom`, `leaveRoom`, `onEvent`, and `isConnected`:
       1. **Gate on `isConnected`**: The entire subscription `useEffect` must include `isConnected` in its dependency array and early-return when `!isConnected`. This is critical because `joinRoom()` silently no-ops when not connected (it calls `getHubIfConnected()` and returns void if null — no queuing). Without this gate, the `onEvent` listener registers via `onceConnected` queuing but the server never routes events because channel membership was never established. Follow the same pattern as `useGroupMessages` (line 84): `if (!sessionId || !isConnected) return;`
       2. Call `joinRoom(\`session:${sessionId}\`)` — this wraps `hub.joinChannel()` internally. Required before receiving delta events. The server routes `state.sdkMessages.delta` events only to clients that have joined the matching channel (see `router.ts` line 356).
       3. Subscribe to `state.sdkMessages.delta` via `onEvent(...)` from the same hook.
       4. **Filter incoming deltas by channel**: The `onEvent` handler receives events from ALL joined channels. The handler MUST check `context.channel === \`session:${sessionId}\`` (the second argument to the event handler) to avoid cross-session message bleed during panel transitions.
       5. In the cleanup function: call `leaveRoom(\`session:${sessionId}\`)` to stop receiving events and prevent channel membership leaks. This wraps `hub.leaveChannel()` internally.
       6. **Reconnection**: Because `isConnected` is in the dep array, the effect re-runs on reconnect — automatically re-joining the channel and re-subscribing (same reconnect resilience as `useGroupMessages`).
     - **Initial fetch**: Use the `state.sdkMessages` RPC with `{ sessionId }` to fetch the most recent messages. Response shape: `{ sdkMessages, hasMore, timestamp }`.
     - **Load-older pagination**: Use the `message.sdkMessages` RPC with `{ sessionId, before: oldestTimestamp, limit }` where `oldestTimestamp: number` is the **`timestamp` field** of the oldest loaded message. **Important**: SDK messages returned from the DB have a `timestamp: number` field injected by the repository layer (`sdk-message-repository.ts` line 119-124: `{ ...sdkMessage, timestamp }`) — this is a DB-appended millisecond timestamp, NOT the SDK's optional `createdAt` field. Using `createdAt` will produce `undefined` and silently disable pagination. Access via `(msg as SDKMessage & { timestamp: number }).timestamp`. The `before` parameter is a **numeric timestamp**, NOT a string cursor — the daemon handler (`message-handlers.ts` line 86) expects `before?: number`. This mirrors `sessionStore.loadOlderMessages(beforeTimestamp, limit)` (session-store.ts line 593). Do NOT use a string cursor here — string cursors are only for `task.getGroupMessages`, a different RPC. This is a DIFFERENT RPC from the initial fetch — `state.sdkMessages` does not accept a `before` parameter at all.
     - **Deduplication**: Deduplicate incoming delta messages by UUID before appending to local state, matching the pattern in `sessionStore` (lines 273-276). Safari reconnections can replay events.
     - Maintain messages in local component state (NOT in `sessionStore`).
     - Handle loading and error states.
   - **Rendering**:
     - Render messages using `SDKMessageRenderer` with `taskContext={false}`. **Note**: `SDKMessageRenderer` has no `readonly` prop — read-only behavior is achieved by omitting question-handling props (`pendingQuestion`, `resolvedQuestions`, `onQuestionResolved`) and rewind props. With `taskContext={false}`, system init messages are suppressed (line 183 of SDKMessageRenderer) — this is intentional for the slide-out panel since the focus is on the conversation content, not session setup.
     - Omit the input area (read-only view).
     - Include auto-scroll to bottom on new messages (simple `scrollIntoView` on new message arrival).
     - Include a "Load older" button if the session has older messages (use `hasMore` from initial fetch response, then `hasMore` from subsequent `message.sdkMessages` responses).
   - **Note**: This component is a simplified, read-only version of the message rendering in `ChatContainer`. It does NOT need to support: message input, question resolution, file uploads, or session selection. It only needs: channel join/leave, message fetching, streaming delta updates with deduplication, and rendering via `SDKMessageRenderer`.
   - `data-testid="readonly-session-chat"` on the root element.
3. Create `packages/web/src/components/room/SlideOutPanel.tsx`:
   - **Props**:
     ```
     {
       isOpen: boolean;
       sessionId: string | null;
       agentLabel?: string;     // e.g., "Worker" or "Leader"
       agentRole?: string;      // for role color
       onClose: () => void;
     }
     ```
   - **Layout**:
     - **Absolutely positioned** within the task view container (NOT `position: fixed` on the viewport) — this prevents the panel from bleeding over the left navigation columns in the three-column Room layout.
     - Width: ~50% of the task view container on desktop, 100% on mobile (use responsive Tailwind classes).
     - Full height of the parent container.
     - Semi-transparent backdrop overlay scoped to the task view container that closes the panel on click.
   - **Header**:
     - Agent name/label with role color (import `ROLE_COLORS` from shared constants)
     - Close button (X icon) on the right
   - **Body**:
     - Mount `ReadonlySessionChat` with `sessionId={sessionId}` when `isOpen && sessionId`
     - This is fully independent of `sessionStore` — no side effects on the primary session.
   - **Transition animation**:
     - Slide-in from right: use CSS `transform: translateX(100%)` to `translateX(0)` with Tailwind `transition-transform duration-300`
     - Backdrop fade-in with `transition-opacity`
   - **Keyboard support**:
     - Close on Escape key press
   - **Accessibility**:
     - `role="dialog"` and `aria-modal="true"` on the panel container
     - Focus trapping: when panel opens, focus moves to the close button; Tab cycles within the panel
     - On close, return focus to the trigger element (the clicked turn block)
     - `aria-label` on the panel describing the content (e.g., "Session chat for Worker")
   - **`data-testid` attributes**:
     - `data-testid="slide-out-panel"` on the root panel element
     - `data-testid="slide-out-panel-close"` on the close button
     - `data-testid="slide-out-panel-header"` on the header
     - `data-testid="slide-out-backdrop"` on the backdrop overlay
4. Add the CSS transitions using Tailwind utility classes (no custom CSS needed).
5. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- `ReadonlySessionChat` fetches and renders messages independently of `sessionStore` — no calls to `sessionStore.select()`, no reads from `sessionStore.sdkMessages`.
- Messages stream in real-time via delta subscription.
- Panel slides in from the right with smooth animation.
- Panel is absolutely positioned within the task view container (not fixed to viewport).
- Panel has a header with agent label and close button.
- Clicking the backdrop closes the panel.
- Pressing Escape closes the panel.
- Panel is responsive (wider on desktop, full-width on mobile).
- Only one panel can be open at a time (managed by parent via `isOpen` prop).
- Accessibility: `role="dialog"`, `aria-modal`, focus trapping, focus restoration.
- All `data-testid` attributes are present.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** None

---

### Task 3.2: Unit tests for ReadonlySessionChat and SlideOutPanel

**Agent type:** coder

**Description:**
Write unit tests covering message loading isolation, panel open/close behavior, rendering, and accessibility.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/__tests__/SlideOutPanel.test.tsx`.
3. Mock the message fetching RPC and delta subscription used by `ReadonlySessionChat`.
4. Write test cases:
   - **Session isolation**: Verify that `sessionStore.select` is NEVER called when `ReadonlySessionChat` mounts — spy on `sessionStore.select` and confirm zero calls. Verify `sessionStore.activeSessionId` is not changed.
   - **Message loading**: Verify `ReadonlySessionChat` fetches messages via the correct RPC with the given `sessionId`.
   - **Cross-session channel filter**: Emit a mock `state.sdkMessages.delta` event with a `context.channel` that does NOT match the component's `sessionId` (e.g., `session:other-id`). Verify that the foreign message is NOT added to the component's rendered message list. This tests the channel-filtering guard from Task 3.1 step 4.
   - **Closed state**: When `isOpen: false`, panel is not visible (has translate-x-full or similar).
   - **Open state**: When `isOpen: true` with a sessionId, panel is visible and `ReadonlySessionChat` is mounted with correct sessionId.
   - **Close button**: Clicking close button calls `onClose`.
   - **Backdrop click**: Clicking the backdrop overlay calls `onClose`.
   - **Escape key**: Pressing Escape calls `onClose`.
   - **Agent label display**: Header shows the agent label with correct role color.
   - **Null sessionId**: When sessionId is null and isOpen is true, panel shows a placeholder or does not mount `ReadonlySessionChat`.
   - **Accessibility attributes**: Verify `role="dialog"`, `aria-modal="true"`, and `aria-label` are present.
   - **data-testid attributes**: Verify all required `data-testid` attributes are present.
5. Run tests and verify all pass.
6. Commit and push to the same feature branch, update PR.

**Acceptance Criteria:**
- All test cases pass.
- Session isolation test confirms `sessionStore` is never touched.
- Message fetching RPC is properly mocked and verified.
- Open/close transitions are tested via CSS class assertions.
- Accessibility attributes are verified.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 3.1
