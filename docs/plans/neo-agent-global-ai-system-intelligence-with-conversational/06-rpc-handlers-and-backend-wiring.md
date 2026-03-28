# Milestone 6: Neo RPC Handlers and Backend Wiring

## Goal

Create the RPC endpoints that the frontend uses to communicate with the Neo agent, and set up LiveQuery for real-time message streaming. Origin metadata propagation was moved to Milestone 1 (Task 1.4) since write tools in Milestone 4 depend on it.

## Design Notes

- **`neo.send` is fire-and-forget**: It accepts a message, queues it to the Neo session, and returns an acknowledgement immediately. The frontend subscribes to `neo.messages` LiveQuery for response streaming. This avoids long-polling RPC calls.
- **No chat-text confirmation**: Confirmations are handled exclusively via `neo.confirm_action` / `neo.cancel_action` RPC endpoints triggered by UI buttons. The `neo.send` handler does NOT inspect message content for "yes"/"no" text — this would be fragile (e.g., "can you confirm what rooms I have?" would false-positive) and conflicts with the dedicated RPC endpoints. For `require_explicit` confirmations, the frontend sends the typed phrase via `neo.confirm_explicit` which validates the exact match.
- **Row mappers**: Neo messages are stored in `sdk_messages` (same table as all sessions). The `neo.messages` LiveQuery needs a row mapper that projects `sdk_messages` rows (filtered by `session_id = 'neo:global'`) into `NeoMessage` frontend types.

## Tasks

### Task 6.1: Neo RPC Handlers

- **Description**: Create RPC handlers for Neo communication: sending messages, retrieving history, clearing the session, and confirming/cancelling pending actions.
- **Agent type**: coder
- **Depends on**: Task 2.2, Task 4.6, Task 5.2
- **Subtasks**:
  1. Create `packages/daemon/src/lib/rpc-handlers/neo-handlers.ts`
  2. Implement `setupNeoHandlers(hub, neoAgentHandle, actionLogger)` following the existing handler registration pattern
  3. Register RPC handlers:
     - `neo.send` -- accepts `{ content: string }`, calls `neoAgentHandle.sendMessage(content)`, returns `{ ok: true }` immediately (fire-and-forget). Does NOT parse content for confirmation keywords.
     - `neo.history` -- accepts `{ limit?: number, offset?: number }`, returns message history
     - `neo.clear_session` -- clears Neo session and starts fresh. Action log is preserved.
     - `neo.confirm_action` -- accepts `{ actionId: string }`, confirms a pending action via `NeoActionLogger.confirmAction()`
     - `neo.cancel_action` -- accepts `{ actionId: string }`, cancels a pending action
     - `neo.confirm_explicit` -- accepts `{ actionId: string, phrase: string }`, validates the phrase against the `expected_phrase` stored in the `neo_action_log` row (status must be `pending_explicit`), then executes if match
     - `neo.activity_log` -- accepts `{ limit?: number, offset?: number }`, returns action log entries. Backed by the same `NeoActionLogRepository.getRecent()` as the `get_activity_log` tool.
     - `neo.settings` -- accepts `{ securityMode?: NeoSecurityMode, model?: string }`, updates Neo settings
  4. Register handlers in `packages/daemon/src/lib/rpc-handlers/index.ts` by calling `setupNeoHandlers()` in `setupRPCHandlers()`
  5. Write unit tests in `packages/daemon/tests/unit/rpc-handlers/neo-handlers.test.ts`
- **Acceptance criteria**:
  - All RPC handlers work correctly
  - `neo.send` returns immediately (fire-and-forget), does NOT parse content
  - `neo.confirm_action` and `neo.cancel_action` work via dedicated endpoints only
  - `neo.confirm_explicit` validates phrase against stored `expected_phrase` in `neo_action_log`
  - `neo.clear_session` resets the conversation but preserves action log
  - Unit tests cover all handlers
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 6.2: Neo LiveQuery for Real-Time Streaming

- **Description**: Set up LiveQuery subscriptions so the frontend receives real-time updates when Neo sends responses or when the action log changes.
- **Agent type**: coder
- **Depends on**: Task 6.1
- **Subtasks**:
  1. Add named queries to `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`:
     - `neo.messages` -- query `sdk_messages WHERE session_id = 'neo:global'` ordered by timestamp
     - `neo.activity` -- query `neo_action_log` ordered by `created_at` DESC
     - `neo.pending_actions` -- query `neo_action_log WHERE status IN ('pending_confirmation', 'pending_explicit')`
  2. Define row mapper for `neo.messages` that converts `sdk_messages` rows to `NeoMessage` frontend type:
     - Map `id`, `role` (from SDK message role), `content` (from message content), `createdAt`
     - Extract `toolCalls` from SDK message tool_use blocks (if present)
     - Handle the `sdk_messages` row format (which may use JSON columns for content/tool calls)
  3. Define row mappers for `neo.activity` and `neo.pending_actions` (snake_case to camelCase `NeoActionLog`)
  4. Ensure the reactive database detects changes to `sdk_messages` (for Neo's session ID) and `neo_action_log`
  5. Write unit tests for the named queries and row mappers
- **Acceptance criteria**:
  - Frontend can subscribe to `neo.messages` and receive real-time message updates
  - Row mapper correctly transforms `sdk_messages` rows into `NeoMessage` objects
  - Frontend can subscribe to `neo.activity` and receive action log updates
  - `neo.pending_actions` returns only pending confirmation entries
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
