# Milestone 4: Neo RPC Layer and Message Streaming

## Goal

Create the RPC endpoints and real-time message streaming infrastructure that the frontend uses to communicate with Neo.

## Scope

- New `neo.*` RPC handlers
- LiveQuery integration for real-time message streaming
- Message persistence using existing `sdk_messages` table (with `neo:global` session ID)

## Tasks

### Task 4.1: Neo RPC Handlers

**Description**: Create RPC handlers for sending messages to Neo and retrieving history.

**Subtasks**:
1. Create `packages/daemon/src/lib/rpc-handlers/neo-handlers.ts`
2. Implement `neo.send` handler:
   - Accepts `{ message: string }` payload
   - Injects the message into the `neo:global` session via `sessionManager.injectMessage()`
   - Returns `{ success: boolean, messageId: string }`
3. Implement `neo.history` handler:
   - Accepts `{ limit?: number, before?: string }` for pagination
   - Queries `sdk_messages` for the `neo:global` session
   - Returns message array in chronological order
4. Implement `neo.clearSession` handler:
   - Stops the current Neo session and creates a fresh one
   - Clears message history for the old session
   - Returns `{ success: boolean }`
5. Implement `neo.getSettings` handler:
   - Returns current Neo settings (security mode, model)
6. Implement `neo.updateSettings` handler:
   - Updates Neo settings (security mode, model)
   - Persists via SettingsManager
7. Register handlers in `setupRPCHandlers()` in `packages/daemon/src/lib/rpc-handlers/index.ts`
8. Add unit tests for each handler

**Acceptance Criteria**:
- `neo.send` delivers messages to Neo session and Neo responds
- `neo.history` returns paginated message history
- `neo.clearSession` resets the session cleanly
- Settings CRUD works
- Unit tests pass

**Dependencies**: Task 1.3

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4.2: Neo LiveQuery Integration

**Description**: Set up LiveQuery subscriptions for real-time Neo message streaming to the frontend.

**Subtasks**:
1. Add `neo.messages` named query to `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`:
   - SQL query: select from `sdk_messages` where `session_id = 'neo:global'` ordered by timestamp
   - Supports pagination params
2. Add `neo.activity` named query:
   - SQL query: select from `neo_activity_log` ordered by `created_at` DESC
   - Supports pagination params (`limit`, `offset`)
   - Default limit of 50 entries per page to prevent unbounded result sets
3. Register the named queries in the LiveQuery handler setup
4. Add unit tests verifying query registration and result shape

**Acceptance Criteria**:
- Frontend can subscribe to `neo.messages` and receive real-time updates
- Frontend can subscribe to `neo.activity` for the activity feed
- LiveQuery invalidation triggers when Neo sends/receives messages
- Unit tests pass

**Dependencies**: Task 4.1, Task 1.1 (activity log table)

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
