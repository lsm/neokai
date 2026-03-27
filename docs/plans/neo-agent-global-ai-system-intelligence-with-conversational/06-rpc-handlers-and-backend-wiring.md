# Milestone 6: Neo RPC Handlers and Backend Wiring

## Goal

Create the RPC endpoints that the frontend uses to communicate with the Neo agent, set up LiveQuery for real-time message streaming, and wire origin metadata propagation into the message system.

## Tasks

### Task 6.1: Neo RPC Handlers

- **Description**: Create RPC handlers for Neo communication: sending messages, retrieving history, clearing the session, and confirming/cancelling pending actions.
- **Agent type**: coder
- **Depends on**: Task 2.2, Task 4.6, Task 5.2
- **Subtasks**:
  1. Create `packages/daemon/src/lib/rpc-handlers/neo-handlers.ts`
  2. Implement `setupNeoHandlers(hub, neoSessionService, actionLogger)` following the existing handler registration pattern
  3. Register RPC handlers:
     - `neo.send` -- accepts `{ content: string }`, sends message to Neo session, returns acknowledgement. If there are pending confirmations, check if content matches "yes"/"confirm"/"no"/"cancel" and handle accordingly.
     - `neo.history` -- accepts `{ limit?: number, offset?: number }`, returns message history
     - `neo.clear_session` -- clears Neo session and starts fresh
     - `neo.confirm_action` -- accepts `{ actionId: string }`, confirms a pending action
     - `neo.cancel_action` -- accepts `{ actionId: string }`, cancels a pending action
     - `neo.activity_log` -- accepts `{ limit?: number, offset?: number }`, returns action log entries
     - `neo.settings` -- accepts `{ securityMode?: NeoSecurityMode, model?: string }`, updates Neo settings
  4. Register handlers in `packages/daemon/src/lib/rpc-handlers/index.ts` by calling `setupNeoHandlers()` in `setupRPCHandlers()`
  5. Write unit tests in `packages/daemon/tests/unit/rpc-handlers/neo-handlers.test.ts`
- **Acceptance criteria**:
  - All RPC handlers work correctly
  - `neo.send` properly queues messages and handles confirmation responses
  - `neo.history` returns paginated results
  - `neo.clear_session` resets the Neo session
  - Unit tests cover all handlers
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 6.2: Neo LiveQuery for Real-Time Streaming

- **Description**: Set up LiveQuery subscriptions so the frontend receives real-time updates when Neo sends responses or when the action log changes.
- **Agent type**: coder
- **Depends on**: Task 6.1
- **Subtasks**:
  1. Add named queries to `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`:
     - `neo.messages` -- query Neo session messages ordered by timestamp
     - `neo.activity` -- query `neo_action_log` ordered by `created_at` DESC
     - `neo.pending_actions` -- query pending confirmation actions
  2. Define row mappers for each query
  3. Ensure the reactive database detects changes to Neo message tables and `neo_action_log`
  4. Write unit tests for the named queries
- **Acceptance criteria**:
  - Frontend can subscribe to `neo.messages` and receive real-time message updates
  - Frontend can subscribe to `neo.activity` and receive action log updates
  - `neo.pending_actions` returns only pending confirmation entries
  - Row mappers correctly transform DB rows to frontend types
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 6.3: Origin Metadata Propagation

- **Description**: Add `origin` field support to the message system so messages sent by Neo are properly attributed.
- **Agent type**: coder
- **Depends on**: Task 1.1
- **Subtasks**:
  1. Add optional `origin?: MessageOrigin` field to the message content type in `packages/shared/src/types.ts` (verify the exact type to extend -- likely `MessageContent` or the message metadata)
  2. Update `MessagePersistence` in `packages/daemon/src/lib/session/message-persistence.ts` to persist and retrieve the origin field
  3. Update the message sending flow to accept and propagate origin:
     - `SessionManager.sendMessage()` accepts optional `origin` parameter
     - Origin is stored in message metadata
  4. When Neo sends a message to a room/task via tools, the tool handler passes `origin: 'neo'`
  5. Write unit tests verifying origin propagation through the message pipeline
- **Acceptance criteria**:
  - Messages sent by Neo have `origin: 'neo'` in their metadata
  - Messages sent by humans default to `origin: 'human'`
  - Origin field persists through DB storage and retrieval
  - Existing message flows are not broken (origin is optional)
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
