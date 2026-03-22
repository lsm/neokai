# Milestone 4: TaskViewV2 Assembly and Toggle

## Goal

Assemble the complete TaskViewV2 from prior components, render runtime messages inline, add a V1/V2 toggle to the task view header, and persist the user preference.

## Tasks

### Task 4.1: Implement RuntimeMessageRenderer component

**Agent type:** coder

**Description:**
Build a small helper component that renders runtime messages (status dividers, rate limit warnings, model fallback notifications, leader summary cards) inline between turn blocks. These are the same visual elements as in V1 but extracted into a standalone component.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/RuntimeMessageRenderer.tsx`:
   - **Props**: `{ message: RuntimeMessage }` (the `RuntimeMessage` type from `useTurnBlocks`)
   - Renders based on message type:
     - `status` — centered text with horizontal lines (status divider)
     - `rate_limited` — amber notification card
     - `model_fallback` — amber notification card
     - `leader_summary` — purple context card
   - Copy the rendering JSX from `TaskConversationRenderer.tsx` for these specific message types. This is intentional duplication of ~50 lines of JSX, scoped to only runtime message rendering.
   - **Field access pattern**: The `RuntimeMessage` wrapper contains `message: SDKMessage`. To access type-specific fields (e.g., `resetsAt` and `sessionRole` for rate_limited, `fromModel`/`toModel` for model_fallback), access them from `runtimeMsg.message` and cast as needed: `const raw = runtimeMsg.message as Record<string, unknown>`. This matches the existing pattern in `TaskConversationRenderer.tsx`.
   - `data-testid="runtime-message"` on the root element
3. Write unit tests in `packages/web/src/components/room/__tests__/RuntimeMessageRenderer.test.tsx`:
   - Test rendering of each of the four message types (status, rate_limited, model_fallback, leader_summary).
   - Verify correct styling/classes for each type.
   - Verify field access from `message` property works correctly for typed fields (resetsAt, fromModel, etc.).
4. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- Component correctly renders all four runtime message types with appropriate styling.
- Visually matches the V1 rendering of these message types.
- Unit tests cover all four message types.
- `data-testid` attribute is present.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 1.2 (needs `RuntimeMessage` type)

---

### Task 4.2: Implement TaskViewV2 component

**Agent type:** coder

**Description:**
Build the full TaskViewV2 component that combines `useGroupMessages`, `useTurnBlocks`, `TurnSummaryBlock`, `RuntimeMessageRenderer`, and `SlideOutPanel` into the complete V2 experience.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/TaskViewV2.tsx`:
   - **Props**: `{ roomId: string; taskId: string }` — same as TaskView V1
   - Use `useTaskViewData(roomId, taskId)` (extracted in Task 1.1) for task/group/session data
   - Use `useGroupMessages(groupId)` (already extracted at `packages/web/src/hooks/useGroupMessages.ts`, uses LiveQuery) for message fetching — returns `{ messages: SessionGroupMessage[], isLoading, isReconnecting }`
   - Feed messages into `useTurnBlocks(messages)` to get `TurnBlockItem[]`
     - `isAtTail` defaults to `true` — LiveQuery streams all messages, no client-side pagination
   - Render the list of `TurnBlockItem[]`:
     - `type: 'turn'` items render as `TurnSummaryBlock` components
     - `type: 'runtime'` items render as `RuntimeMessageRenderer` components
   - Manage slide-out panel state: `selectedTurn: TurnBlock | null`
   - When a `TurnSummaryBlock` is clicked, set `selectedTurn` to open the `SlideOutPanel`
   - Use `conversationKey` from `useTaskViewData` as part of the key for the turn blocks list, so approve/reject actions force a re-fetch of messages (same remount pattern as V1)
   - Reuse shared sub-components from Task 1.1:
     - `HumanInputArea` for the human message input
     - `TaskHeaderActions` for the header action buttons (cancel, stop/interrupt, reactivate, dropdown)
     - `TaskActionDialogs` for complete/cancel/archive dialogs
     - `TaskReviewBar` for the approve/reject review bar (shown when `group?.submittedForReview` is true)
     - `RejectModal` (imported from `../ui/RejectModal`) — wired to `rejectReviewedTask` and `rejectModal` state from `useTaskViewData`
   - Include the same header structure as V1 (task name, status, model info)
   - **Auto-scroll**: Reuse the existing `useAutoScroll` hook from `packages/web/src/hooks/useAutoScroll.ts`. Its interface requires `UseAutoScrollOptions`:
     ```
     { containerRef, endRef, enabled: boolean, messageCount: number,
       isInitialLoad?: boolean, loadingOlder?: boolean, nearBottomThreshold?: number }
     ```
     V2 must maintain the following state to wire this hook:
     - `autoScrollEnabled: boolean` state (default `true`) — wired to the `enabled` parameter. Include a toggle button (matching V1's autoscroll toggle at ~lines 1105-1127) so users can lock/unlock autoscroll.
     - `isFirstLoad: boolean` state — set to `true` initially and whenever `conversationKey` changes (matching V1's pattern at lines 588, 610-621). Set to `false` once the first non-zero `TurnBlockItem[]` arrives. Pass as `isInitialLoad` to the hook.
     - Pass `TurnBlockItem[]` array length as `messageCount`.
     - Pass `loadingOlder` from `useGroupMessages` (if older messages are being fetched, prevent auto-scroll from jumping). **Note**: V1 does NOT pass `loadingOlder` to `useAutoScroll` — this is an intentional V2 improvement to prevent scroll-jump when older messages are prepended.
     This ensures initial-load scroll-to-bottom fires correctly and subsequent updates only auto-scroll when the user hasn't scrolled up.
3. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- TaskViewV2 renders turn blocks for all agents with correct interleaving.
- Runtime messages (status, rate_limited, model_fallback, leader_summary) appear inline between turn blocks.
- Clicking a turn block opens the slide-out panel with the correct session chat.
- Only one slide-out panel is open at a time.
- Shared sub-components (input area, header actions, dialogs, review bar, reject modal) work correctly.
- Approve/reject actions bump `conversationKey` and force message re-fetch (same behavior as V1).
- Review bar appears when `group?.submittedForReview` is true.
- Auto-scroll works correctly for new turn blocks.
- `data-testid="task-view-v2"` is set on the root container element.
- The existing TaskView.tsx and TaskConversationRenderer.tsx are NOT modified (beyond the import refactors done in Task 1.1).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 1.1, Task 1.2, Task 2.1, Task 3.1, Task 4.1

---

### Task 4.3: Implement TaskViewToggle and integrate into Room.tsx

**Agent type:** coder

**Description:**
Build the V1/V2 toggle wrapper and integrate it into the Room layout. The toggle button is rendered by the wrapper component *above* both V1 and V2 (not inside either view), avoiding any modification to V1's internal header.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/TaskViewToggle.tsx`:
   - A wrapper component that reads the V1/V2 preference from localStorage key `neokai:taskViewVersion`
   - **IMPORTANT**: Initialize the preference state synchronously from localStorage using a lazy initializer (e.g., `useState(() => localStorage.getItem('neokai:taskViewVersion') || 'v1')`) — NOT inside a `useEffect`. This prevents a visible flicker where V1 renders first, then V2 replaces it on the next frame.
   - Renders a small toggle header bar above the active view with:
     - A toggle button/switch to switch between 'v1' and 'v2'
     - The toggle is positioned in the top-right of the task view area, above the actual TaskView/TaskViewV2 content
   - Below the toggle, conditionally renders either `TaskView` (V1) or `TaskViewV2`
   - The toggle button switches between 'v1' and 'v2' and persists to localStorage
   - Default to 'v1' for backward compatibility
   - `data-testid="task-view-toggle"` on the toggle button
   - `data-testid="task-view-v2"` is set by `TaskViewV2` itself on its root container (Task 4.2 owns this attribute), NOT by the wrapper
3. Update `packages/web/src/islands/Room.tsx`:
   - Replace the `<TaskView>` usage with the new `<TaskViewToggle>` wrapper
   - This is the only modification to an existing file outside of the Task 1.1 refactors
   - The change is minimal: swap one import and one component usage
4. Run `bun run typecheck` and `bun run lint` to verify no regressions.
5. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- The V1/V2 toggle switches between views without page reload.
- User preference is persisted in localStorage and restored on page load.
- Default view is V1 (backward compatible).
- Toggle button is rendered above both views (not inside V1's header).
- Room.tsx change is minimal — only import/component swap.
- All `data-testid` attributes are present.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 4.2

---

### Task 4.4: E2E tests for TaskViewV2

**Agent type:** coder

**Description:**
Write Playwright E2E tests for the TaskViewV2 feature. Given the difficulty of seeding multi-agent task messages in E2E, tests are scoped to **structural and toggle behavior** — detailed message rendering/interaction is covered by unit tests in earlier milestones.

**E2E test strategy:**
- Toggle behavior and localStorage persistence can be tested without agent messages.
- Structural presence of V2 components (turn blocks container, slide-out panel) can be tested with minimal setup.
- For tests requiring task message data: use RPC-based message seeding in `beforeEach` as an "accepted infrastructure pattern" (same category as room/session creation in setup). If no suitable RPC exists for seeding group messages, limit assertions to component presence and toggle behavior only.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/task-view-v2.e2e.ts`.
3. Write test cases (all interactions through the UI, no direct RPC calls except for setup/teardown):
   - **V1/V2 toggle**: Navigate to a task view, find and click the V1/V2 toggle (`data-testid="task-view-toggle"`), verify the view switches (V2 container visible).
   - **Toggle persistence**: Switch to V2, reload the page, verify V2 is still shown.
   - **V2 structure**: In V2 mode, verify the turn blocks container is present (`data-testid="task-view-v2"`).
   - **Switch back to V1**: Toggle back to V1, verify the original flat timeline is shown and V2 container is not visible.
   - **Slide-out panel open/close** (if message seeding is available): Click a turn block, verify `data-testid="slide-out-panel"` appears. Click close (`data-testid="slide-out-panel-close"`), verify it closes.
   - **Keyboard close** (if slide-out can be opened): Press Escape, verify panel closes.
4. Use existing E2E helpers for room/task creation in beforeEach/afterEach.
5. Run the E2E test: `make run-e2e TEST=tests/features/task-view-v2.e2e.ts`
6. Commit and push to the same feature branch, update PR.

**Acceptance Criteria:**
- E2E tests pass in CI.
- Tests verify toggle behavior and localStorage persistence through UI interactions.
- Tests verify structural presence of V2 components through `data-testid` selectors.
- Tests follow E2E rules: all actions through UI, assertions on visible DOM state.
- No direct RPC calls in test actions/assertions (only setup/teardown).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 4.3
