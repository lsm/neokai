# Milestone 1: Turn Grouping Data Layer

## Goal

Build the `useTurnBlocks` hook and supporting types that transform a flat array of group messages into structured turn blocks. This is the foundation for the entire V2 view.

## Tasks

### Task 1.1: Define TurnBlock types and implement useTurnBlocks hook

**Agent type:** coder

**Description:**
Create the `useTurnBlocks` hook that consumes the same flat message array produced by `TaskConversationRenderer`'s data fetching logic (via `task.getGroupMessages` RPC and `state.groupMessages.delta` events). The hook groups sequential messages from the same session into turn blocks and extracts stats.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/hooks/useTurnBlocks.ts` with the following exports:
   - `TurnBlock` interface:
     ```
     {
       id: string;              // unique turn identifier (e.g., `${sessionId}-${startIndex}`)
       sessionId: string;       // authorSessionId from _taskMeta
       agentRole: string;       // authorRole from _taskMeta
       agentLabel: string;      // display label (from ROLE_COLORS-style mapping)
       startTime: number;       // timestamp of first message in turn
       endTime: number | null;  // timestamp of last message (null if active)
       messageCount: number;    // total messages in turn
       toolCallCount: number;   // count of tool_use/tool_result messages
       thinkingCount: number;   // count of thinking blocks
       assistantCount: number;  // count of assistant messages
       lastAction: string | null; // last tool name or message type (Read, Edit, Bash, etc.)
       previewMessage: SDKMessage | null; // last message for preview rendering
       isActive: boolean;       // true if this is the most recent turn and still receiving messages
       isError: boolean;        // true if turn ended with an error result
       errorMessage: string | null; // error text if isError
       messages: SDKMessage[];  // all messages in this turn (for future use)
     }
     ```
   - `RuntimeMessage` interface -- for messages that render inline between turn blocks (status, rate_limited, model_fallback, leader_summary):
     ```
     {
       type: 'runtime';
       message: SDKMessage;
       index: number;           // position in the original message array
     }
     ```
   - `TurnBlockItem` union type: `{ type: 'turn'; turn: TurnBlock } | RuntimeMessage`
   - `useTurnBlocks(messages: SDKMessage[]): TurnBlockItem[]` hook
3. Implement the grouping logic:
   - Iterate through messages in order.
   - Extract `_taskMeta` from each message (reuse the pattern from `TaskConversationRenderer.tsx`).
   - Messages with `authorRole === 'system'` or message types `status`, `rate_limited`, `model_fallback`, `leader_summary` become `RuntimeMessage` items.
   - Other messages are grouped by `authorSessionId`. A new turn starts when `authorSessionId` changes from the previous non-runtime message.
   - For each turn, count tool calls (messages with `type === 'tool_use'` or `type === 'tool_result'`), thinking blocks (messages with `type === 'assistant'` containing thinking content), and assistant messages.
   - Extract `lastAction` from the most recent tool_use message's tool name, or fallback to the message type.
   - Set `isActive = true` for the last turn block only (it is still receiving messages if it is the final non-runtime item).
   - Detect error turns: if the last message in the turn is a result with `is_error: true`.
4. Wrap the logic in `useMemo` keyed on `messages` (reference and length) so it recomputes efficiently on delta updates.
5. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- `useTurnBlocks` correctly groups messages from multiple agents into interleaved turn blocks.
- Runtime messages (status, rate_limited, model_fallback, leader_summary) appear as `RuntimeMessage` items between turn blocks at the correct positions.
- Stats (toolCallCount, thinkingCount, assistantCount) are accurate.
- `isActive` is true only for the last turn block.
- Error turns are detected when the final message has `is_error: true`.
- The hook is memoized and does not recompute unnecessarily.

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.2: Unit tests for useTurnBlocks

**Agent type:** coder

**Description:**
Write comprehensive unit tests for the `useTurnBlocks` hook covering all grouping scenarios.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/hooks/__tests__/useTurnBlocks.test.ts`.
3. Write test cases:
   - **Single agent, single turn**: All messages from one session produce one turn block.
   - **Two agents, interleaved turns**: Worker messages, then leader messages, then worker again -- produces 3 turn blocks in order.
   - **Runtime messages inline**: Status/rate_limited/model_fallback/leader_summary messages appear as `RuntimeMessage` items between turn blocks at correct positions.
   - **Stats counting**: Verify toolCallCount, thinkingCount, assistantCount for a turn with mixed message types.
   - **Active turn detection**: Last turn has `isActive: true`, all others have `isActive: false`.
   - **Error turn detection**: Turn ending with `is_error: true` result has `isError: true` and `errorMessage` set.
   - **Empty input**: Empty message array returns empty result.
   - **Multi-agent (3+ agents)**: Messages from 3 different sessions produce correct interleaved turns.
   - **Last action extraction**: Verify `lastAction` shows the tool name from the most recent tool_use.
   - **Preview message**: Verify `previewMessage` is the last message in each turn.
   - **Real-time delta**: Adding a message to the same session extends the current turn; adding a message from a new session starts a new turn.
4. Use vitest with `renderHook` from `@testing-library/preact` for hook testing (matching existing test patterns in the project).
5. Run `cd packages/web && bunx vitest run src/hooks/__tests__/useTurnBlocks.test.ts` to verify all tests pass.
6. Commit and push to the same feature branch as Task 1.1, create/update PR.

**Acceptance Criteria:**
- All test cases pass.
- Tests cover edge cases (empty input, single message, multi-agent).
- Tests verify real-time delta behavior (appending messages updates turn blocks correctly).

**Dependencies:** Task 1.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
