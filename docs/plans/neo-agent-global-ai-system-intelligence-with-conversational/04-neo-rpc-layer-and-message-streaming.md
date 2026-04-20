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
   - Runs health check before injection (auto-recovers if session is unhealthy)
   - Injects the message into the `neo:global` session via `sessionManager.injectMessage()`
   - Returns `{ success: boolean, messageId: string }`
   - **Provider error handling**: Catch LLM provider errors (429 rate limit, 5xx server errors, network failures) and return user-friendly error responses: `{ success: false, error: 'Neo is temporarily unavailable. Please try again.', errorCode: 'PROVIDER_ERROR' }`
   - **Missing credentials**: If no API key is configured, return `{ success: false, error: 'API key not configured. Please set up your provider in Settings.', errorCode: 'NO_CREDENTIALS' }`
   - **Model unavailable**: If the selected Neo model is not available, return descriptive error
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
7. Implement `neo.confirmAction` handler:
   - Accepts `{ actionId: string }` payload
   - Retrieves pending action from `PendingActionStore`, executes it, injects result into Neo chat as a system message
   - Returns `{ success: boolean, result?: unknown, error?: string }`
   - This is the **primary confirmation path** called by `NeoConfirmationCard` buttons (bypasses LLM)
8. Implement `neo.cancelAction` handler:
   - Accepts `{ actionId: string }` payload
   - Removes pending action without executing, injects cancellation message into Neo chat
   - Returns `{ success: boolean }`
9. Register handlers in `setupRPCHandlers()` in `packages/daemon/src/lib/rpc-handlers/index.ts`
10. Add unit tests for each handler (including provider error scenarios)

**Acceptance Criteria**:
- `neo.send` delivers messages to Neo session and Neo responds
- `neo.history` returns paginated message history
- `neo.clearSession` resets the session cleanly (stops in-flight SDK queries before destroying)
- `neo.confirmAction` / `neo.cancelAction` execute/discard pending actions via direct RPC
- Settings CRUD works
- Provider errors return user-friendly messages with appropriate error codes
- Unit tests pass (including provider error scenarios)

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
