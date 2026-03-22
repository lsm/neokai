# Milestone 1: Shared Logic Extraction + Turn Grouping Data Layer

## Goal

Extract shared data-fetching logic and constants from V1 into reusable modules, then build the `useTurnBlocks` hook and supporting types that transform parsed group messages into structured turn blocks. This is the foundation for the entire V2 view.

## Tasks

### Task 1.1: Extract shared hooks, sub-components, and constants from TaskView/TaskConversationRenderer

**Agent type:** coder

**Description:**
Extract reusable logic from `TaskView.tsx` and `TaskConversationRenderer.tsx` into shared modules so V2 can reuse them without duplicating code. V1 is updated only to import from the new shared locations — no behavioral changes.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Extract `ROLE_COLORS` from `TaskConversationRenderer.tsx` into a new shared file `packages/web/src/lib/task-constants.ts`. Update `TaskConversationRenderer.tsx` to import from the shared location. This is a pure mechanical refactor — no logic changes.
3. Extract the data-fetching and action logic from `TaskView.tsx` into `packages/web/src/hooks/useTaskViewData.ts`:
   - `useTaskViewData(roomId, taskId)` — returns:
     ```
     {
       task, group, sessions, workerSession, leaderSession, isLoading, error,
       conversationKey,          // integer bumped to force conversation remount after approve/reject
       approveReviewedTask,      // async handler: calls task.approve RPC, bumps conversationKey
       rejectReviewedTask,       // async handler(feedback): calls task.reject RPC, bumps conversationKey
       approving, rejecting,     // loading states for approve/reject
       reviewError,              // error string from approve/reject
       rejectModal,              // { isOpen, open, close } state for the RejectModal
       interruptTask,            // handler: calls task.interrupt RPC
       reactivateTask,           // handler: calls task.reactivate RPC
       canCancel, canInterrupt, canReactivate, // derived permission flags
     }
     ```
   - This covers: `task.get` RPC, `task.getGroup` RPC, `session.get` calls for worker+leader, `room.task.update` event listener, session model fetch, loading/error states, `conversationKey` state (used to force `TaskConversationRenderer` remount after approve/reject), and all task action handlers (approve, reject, interrupt, reactivate) with their loading/error states.
   - Update `TaskView.tsx` to call `useTaskViewData()` instead of inline logic. Verify V1 behavior is unchanged.
4. Extract the group message fetching and parsing logic from `TaskConversationRenderer.tsx` into `packages/web/src/hooks/useGroupMessages.ts`:
   - Define the `ParsedGroupMessage` type alias: this is `SDKMessage` with `_taskMeta` (containing `authorRole`, `authorSessionId`, etc.) attached during parsing. Formally: `type ParsedGroupMessage = SDKMessage & { _taskMeta?: { authorRole: string; authorSessionId: string; [key: string]: unknown } }`. Export this type from the hook file so downstream consumers (e.g., `useTurnBlocks`) can import it.
   - `useGroupMessages(groupId)` — returns `{ messages: ParsedGroupMessage[], isLoading, loadOlder, hasOlder, isAtTail: boolean }`.
     - `isAtTail`: `true` when the loaded messages include the newest messages in the conversation (i.e., initial load fetches the tail, and no newer page exists). This is always `true` after initial load since the current implementation fetches newest-first. It would be `false` only if a future bidirectional pagination loads a middle page. For now, default to `true` after the initial fetch completes.
   - This covers: `task.getGroupMessages` RPC, `state.groupMessages.delta` subscription, `parseGroupMessage()` parsing, pagination buffer, deduplication, and the `fetchingRef`/`pendingDeltasRef` race-condition handling.
   - Update `TaskConversationRenderer.tsx` to call `useGroupMessages()` instead of inline logic. Verify V1 behavior is unchanged.
5. Extract shared sub-components from `TaskView.tsx` into `packages/web/src/components/room/task-shared/`:
   - `HumanInputArea.tsx` — the human message input component (inner function `HumanInputArea` at ~line 81)
   - `TaskActionDialogs.tsx` — `CompleteTaskDialog` (~line 267), `CancelTaskDialog` (~line 378), `ArchiveTaskDialog` (~line 468). Note: `RejectModal` is already a shared component imported from `../ui/RejectModal` — it does not need extraction, but V2 must import and wire it (see Task 4.2).
   - `TaskHeaderActions.tsx` — extract the inline header action button row (~lines 946-1015) into a new component. This is NOT an existing inner function — it is inline JSX containing the Cancel, Stop/Interrupt, Reactivate buttons and `TaskActionDropdown`. Extract this JSX into a `TaskHeaderActions` component that accepts the relevant handlers and permission flags as props.
   - `TaskReviewBar.tsx` — extract the review `ActionBar` rendering (~lines 1019-1043) into a component that accepts `approveReviewedTask`, `rejectModal.open`, `approving`, `rejecting`, `reviewError`, and `reviewPrMeta` as props. This is the `<ActionBar type="review" ...>` block shown when `group?.submittedForReview` is true.
   - These are inner components or inline JSX regions of `TaskView.tsx`. Extract them as named exports. Update `TaskView.tsx` to import them.
6. Run `bun run typecheck` and `bun run lint` to verify no regressions.
7. Run existing unit tests for TaskView/TaskConversationRenderer to verify behavior is unchanged.
8. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- `ROLE_COLORS` is exported from `packages/web/src/lib/task-constants.ts` and imported by both V1 and (later) V2.
- `useTaskViewData` hook encapsulates all task/group/session data fetching AND task action handlers (approve, reject, interrupt, reactivate) with `conversationKey` reload mechanism.
- `useGroupMessages` hook encapsulates group message fetching, parsing, deduplication, delta subscription, and pagination.
- `HumanInputArea`, `TaskActionDialogs`, `TaskHeaderActions`, `TaskReviewBar` are extracted into shared files.
- `TaskView.tsx` and `TaskConversationRenderer.tsx` import from the new shared locations.
- V1 behavior is identical — all existing tests pass, no visual changes.
- **Note on test updates**: Existing test files (`TaskView.test.tsx`, `TaskConversationRenderer.test.tsx`) may need mock target adjustments (e.g., mocking the new shared hook modules instead of inline logic). These import/mock swaps are expected and acceptable — they are part of the refactor, not a behavioral change.
- **Implementation note**: This task touches multiple complex files. Commit after each subtask (steps 2-5) for safe rollback if any extraction step causes issues.
- `ParsedGroupMessage` type is defined and exported from `useGroupMessages.ts`.
- `useGroupMessages` return type includes `isAtTail: boolean`.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** None

---

### Task 1.2: Define TurnBlock types and implement useTurnBlocks hook

**Agent type:** coder

**Description:**
Create the `useTurnBlocks` hook that consumes the parsed group messages (from `useGroupMessages`) and groups them into structured turn blocks with stats. The hook handles multi-agent interleaving, pagination-aware active detection, and real-time deltas.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/hooks/useTurnBlocks.ts` with the following exports:
   - `TurnBlock` interface:
     ```
     {
       id: string;              // unique turn identifier — use the first message's UUID for stability across pagination
       sessionId: string;       // authorSessionId from _taskMeta
       agentRole: string;       // authorRole from _taskMeta
       agentLabel: string;      // plain role label derived from ROLE_COLORS (e.g., "Leader", "Coder", "Worker") — does NOT include model name (model info is displayed separately in the UI if needed)
       startTime: number;       // timestamp of first message in turn
       endTime: number | null;  // timestamp of last message (null if active)
       messageCount: number;    // total messages in turn
       toolCallCount: number;   // count of tool_use/tool_result messages
       thinkingCount: number;   // count of thinking blocks
       assistantCount: number;  // count of assistant messages
       lastAction: string | null; // last tool name or message type (Read, Edit, Bash, etc.)
       previewMessage: SDKMessage | null; // last message for preview rendering
       isActive: boolean;       // true if this turn is still receiving messages (see active detection below)
       isError: boolean;        // true if turn ended with an error result
       errorMessage: string | null; // error text if isError
       messages: SDKMessage[];  // all messages in this turn (for future use)
     }
     ```
   - `RuntimeMessage` interface — for messages that render inline between turn blocks (status, rate_limited, model_fallback, leader_summary):
     ```
     {
       type: 'runtime';
       message: SDKMessage;
       index: number;           // position in the original message array
     }
     ```
   - `TurnBlockItem` union type: `{ type: 'turn'; turn: TurnBlock } | RuntimeMessage`
   - `useTurnBlocks(messages: ParsedGroupMessage[], isAtTail: boolean): TurnBlockItem[]` hook
     - `isAtTail` parameter: indicates whether the message array represents the current tail of the conversation (true when no newer messages exist beyond what's loaded). This drives `isActive` detection.
3. Implement the grouping logic:
   - Iterate through messages in order.
   - Extract `_taskMeta` from each message (reuse the pattern from `TaskConversationRenderer.tsx`).
   - **Runtime messages**: Messages with `authorRole === 'system'` or message types `status`, `rate_limited`, `model_fallback`, `leader_summary` become `RuntimeMessage` items.
   - **Human role messages**: Messages with `authorRole === 'human'` form their own turn blocks (e.g., when a human sends input to the task). They get the label "Human" and are rendered as turn blocks just like agent turns.
   - Other messages are grouped by `authorSessionId`. A new turn starts when `authorSessionId` changes from the previous non-runtime message.
   - For each turn, count tool calls (messages with `type === 'tool_use'` or `type === 'tool_result'`), thinking blocks (messages with `type === 'assistant'` containing thinking content), and assistant messages.
   - Extract `lastAction` from the most recent tool_use message's tool name, or fallback to the message type.
   - **Active turn detection**: Set `isActive = true` ONLY when ALL of these conditions are met:
     - `isAtTail` is true (we're viewing the current end of the conversation)
     - This is the last turn block in the array
     - The turn's `endTime` is null (no explicit end signal)
   - Detect error turns: if the last message in the turn is a result with `is_error: true`.
4. Wrap the logic in `useMemo` keyed on `messages` (reference and length) and `isAtTail` so it recomputes efficiently on delta updates.
5. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- `useTurnBlocks` correctly groups messages from multiple agents into interleaved turn blocks.
- Runtime messages (status, rate_limited, model_fallback, leader_summary) appear as `RuntimeMessage` items between turn blocks at the correct positions.
- Human role messages form their own turn blocks with the "Human" label.
- Stats (toolCallCount, thinkingCount, assistantCount) are accurate.
- `isActive` is true only when `isAtTail` is true AND it's the last turn block AND `endTime` is null.
- Error turns are detected when the final message has `is_error: true`.
- `TurnBlock.id` uses the first message's UUID for stability across pagination.
- The hook is memoized and does not recompute unnecessarily.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 1.1 (needs `ROLE_COLORS` from shared constants, `ParsedGroupMessage` type from `useGroupMessages`)

---

### Task 1.3: Unit tests for useTurnBlocks

**Agent type:** coder

**Description:**
Write comprehensive unit tests for the `useTurnBlocks` hook covering all grouping scenarios.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/hooks/__tests__/useTurnBlocks.test.ts`.
3. Write test cases:
   - **Single agent, single turn**: All messages from one session produce one turn block.
   - **Two agents, interleaved turns**: Worker messages, then leader messages, then worker again — produces 3 turn blocks in order.
   - **Runtime messages inline**: Status/rate_limited/model_fallback/leader_summary messages appear as `RuntimeMessage` items between turn blocks at correct positions.
   - **Human role messages**: Messages with `authorRole === 'human'` produce their own turn blocks with label "Human".
   - **Stats counting**: Verify toolCallCount, thinkingCount, assistantCount for a turn with mixed message types.
   - **Active turn detection (at tail)**: With `isAtTail=true`, last turn has `isActive: true`, all others have `isActive: false`.
   - **Active turn detection (not at tail)**: With `isAtTail=false`, ALL turns have `isActive: false` (even the last one) — covers the pagination scenario where we loaded older messages.
   - **Error turn detection**: Turn ending with `is_error: true` result has `isError: true` and `errorMessage` set.
   - **Empty input**: Empty message array returns empty result.
   - **Multi-agent (3+ agents)**: Messages from 3 different sessions produce correct interleaved turns.
   - **Last action extraction**: Verify `lastAction` shows the tool name from the most recent tool_use.
   - **Preview message**: Verify `previewMessage` is the last message in each turn.
   - **Stable IDs**: Verify `TurnBlock.id` uses the first message's UUID — IDs don't change when older messages are prepended (pagination).
   - **Real-time delta**: Adding a message to the same session extends the current turn; adding a message from a new session starts a new turn.
4. Use vitest with `renderHook` from `@testing-library/preact` for hook testing (matching existing test patterns in the project).
5. Run `cd packages/web && bunx vitest run src/hooks/__tests__/useTurnBlocks.test.ts` to verify all tests pass.
6. Commit and push to the same feature branch as Task 1.2, create/update PR.

**Acceptance Criteria:**
- All test cases pass.
- Tests cover edge cases (empty input, single message, multi-agent, human role).
- Tests verify pagination-aware active detection (`isAtTail` parameter).
- Tests verify stable IDs across pagination.
- Tests verify real-time delta behavior (appending messages updates turn blocks correctly).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 1.2
