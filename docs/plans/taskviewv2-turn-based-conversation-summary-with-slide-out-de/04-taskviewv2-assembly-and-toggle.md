# Milestone 4: TaskViewV2 Assembly and Toggle

## Goal

Assemble the complete TaskViewV2 from prior components, render runtime messages inline, add a V1/V2 toggle to the task view header, and persist the user preference.

## Tasks

### Task 4.1: Implement TaskViewV2 component and V1/V2 toggle

**Agent type:** coder

**Description:**
Build the full TaskViewV2 component that combines `useTurnBlocks`, `TurnSummaryBlock`, and `SlideOutPanel`. Then add a toggle mechanism in the parent that switches between V1 and V2 without modifying the existing `TaskView.tsx`.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/TaskViewV2.tsx`:
   - Accept the same props as `TaskView`: `{ roomId: string; taskId: string }`
   - Replicate the data-fetching logic from `TaskView` (task, group, sessions) -- or better, extract shared logic into a custom hook `useTaskViewData` in a new file `packages/web/src/hooks/useTaskViewData.ts` that both V1 and V2 can use. However, since V1 must not be modified, the V2 can duplicate the necessary data fetching or import shared utilities.
   - Use the same message fetching from `TaskConversationRenderer` -- subscribe to `state.groupMessages.delta` on channel `group:{groupId}` and fetch initial messages via `task.getGroupMessages` RPC. This can be extracted as a `useGroupMessages` hook.
   - Feed messages into `useTurnBlocks` to get `TurnBlockItem[]`.
   - Render the list of `TurnBlockItem[]`:
     - `type: 'turn'` items render as `TurnSummaryBlock` components
     - `type: 'runtime'` items render inline using the same rendering logic as V1 (status dividers, rate limit cards, model fallback cards, leader summary cards) -- copy the JSX from `TaskConversationRenderer.tsx` for these specific message types into a small `RuntimeMessageRenderer` helper component
   - Manage slide-out panel state: `selectedTurnSessionId: string | null`
   - When a `TurnSummaryBlock` is clicked, set `selectedTurnSessionId` to open the `SlideOutPanel`
   - Include the same header, action bar, human input area, and action dialogs as V1 (these can be imported/reused since they are separate sub-components within `TaskView.tsx` -- or duplicated if they are not exported)
   - Auto-scroll behavior: scroll to bottom when new turn blocks arrive (reuse `useAutoScroll`)
3. Create `packages/web/src/components/room/TaskViewToggle.tsx`:
   - A small wrapper component that reads the V1/V2 preference from localStorage (`neokai:taskViewVersion`) and renders either `TaskView` or `TaskViewV2`
   - Export a `TaskViewToggleButton` component (small icon/switch) that can be placed in the header
   - The toggle button switches between 'v1' and 'v2' and persists to localStorage
   - Default to 'v1' for backward compatibility
4. Update `packages/web/src/islands/Room.tsx`:
   - Replace the `<TaskView>` usage with the new `TaskViewToggle` wrapper that conditionally renders V1 or V2
   - This is the only modification to existing files (Room.tsx), and it is a minimal change (swapping one import/component)
5. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- TaskViewV2 renders turn blocks for all agents with correct interleaving.
- Runtime messages (status, rate_limited, model_fallback, leader_summary) appear inline between turn blocks.
- Clicking a turn block opens the slide-out panel with the correct session chat.
- Only one slide-out panel is open at a time.
- The V1/V2 toggle switches between views without page reload.
- User preference is persisted in localStorage and restored on page load.
- Default view is V1 (backward compatible).
- The existing TaskView.tsx and TaskConversationRenderer.tsx are NOT modified.
- Auto-scroll works correctly for new turn blocks.

**Dependencies:** Task 1.1, Task 2.1, Task 3.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.2: E2E tests for TaskViewV2

**Agent type:** coder

**Description:**
Write Playwright E2E tests that verify the full TaskViewV2 experience including the toggle, turn blocks rendering, and slide-out panel interaction.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/task-view-v2.e2e.ts`.
3. Write test cases (all interactions through the UI, no direct RPC calls except for setup/teardown):
   - **V1/V2 toggle**: Navigate to a task view, find and click the V1/V2 toggle, verify the view switches.
   - **Toggle persistence**: Switch to V2, reload the page, verify V2 is still shown.
   - **Turn blocks rendering**: In V2 mode, verify that turn blocks are visible with agent names and stats.
   - **Slide-out panel open/close**: Click a turn block, verify the slide-out panel opens. Click close, verify it closes.
   - **Slide-out panel content**: Verify the slide-out panel shows the session chat content.
   - **Runtime messages inline**: Verify status dividers and notification cards appear between turn blocks.
   - **Switch back to V1**: Toggle back to V1, verify the original flat timeline is shown.
4. Use existing E2E helpers for room/task creation in beforeEach/afterEach (create a room, create a task via RPC for setup, clean up after).
5. Note: These tests require a task with active agent messages. Use the dev proxy mock SDK to generate messages, or set up the test with pre-existing task data. If agent messages are difficult to generate in E2E, focus on structural tests (toggle behavior, component presence, localStorage persistence) and use unit tests for detailed rendering verification.
6. Run the E2E test: `make run-e2e TEST=tests/features/task-view-v2.e2e.ts`
7. Commit and push to the same feature branch, update PR.

**Acceptance Criteria:**
- E2E tests pass in CI.
- Tests verify toggle behavior and persistence.
- Tests verify turn block and slide-out panel visibility through DOM assertions.
- Tests follow E2E rules: all actions through UI, assertions on visible DOM state.

**Dependencies:** Task 4.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
