# Plan: Complete and Adopt the SQL LiveQuery System

**Date**: 2026-03-06
**Related ADRs**: [0001-live-query-and-job-queue.md](../adr/0001-live-query-and-job-queue.md), [0001-migration-plan.md](../adr/0001-migration-plan.md)
**Status**: Approved

---

## Goal

The `ReactiveDatabase`, `LiveQueryEngine`, `JobQueueRepository`, and `JobQueueProcessor` are implemented but not yet wired into the application. This plan finishes the integration by:

1. Wiring `JobQueueProcessor` into app lifecycle
2. Ensuring ReactiveDatabase fires change events for session/message writes
3. Exposing `LiveQueryEngine` via secure, named-query RPC
4. Migrating sessions and SDK messages from manual EventBus broadcasting to LiveQuery
5. Cleaning up all manual broadcast paths (StateManager + direct emitters)

**Key Principle**: The database is the message bus. Live Query is the subscription mechanism. No manual broadcasting for DB-backed state.

---

## Current State

### What's Complete (Foundation)

| Component | File | Status |
|-----------|------|--------|
| ReactiveDatabase | `packages/daemon/src/storage/reactive-database.ts` | ✅ Complete |
| LiveQueryEngine | `packages/daemon/src/storage/live-query.ts` | ✅ Complete |
| JobQueueRepository | `packages/daemon/src/storage/repositories/job-queue-repository.ts` | ✅ Complete |
| JobQueueProcessor | `packages/daemon/src/storage/job-queue-processor.ts` | ✅ Complete (not wired) |
| Unit tests (storage) | `packages/daemon/tests/unit/storage/` | ✅ Complete |

### What's Not Done

| Component | Status |
|-----------|--------|
| JobQueueProcessor wired in `app.ts` | ❌ Not done |
| `reactiveDb` used for session/message writes | ❌ Not done — `db` (facade) used directly; proxy never fires |
| Live Query RPC handlers (server) | ❌ Not done |
| LiveQueryChannel (client) | ❌ Not done |
| Sessions migrated to LiveQuery | ❌ Not done |
| SDK messages migrated to LiveQuery | ❌ Not done |
| All manual broadcast paths removed | ❌ Not done |

### Critical Architecture Note: ReactiveDatabase Wiring Gap

`ReactiveDatabase` is a Proxy around the `Database` facade that intercepts mapped facade methods (`createSession`, `saveSDKMessage`, etc.) and emits change events. **However**, the facade instance (`db`) is passed directly to `SessionManager`, `StateManager`, and agent components — not the proxy (`reactiveDb`). Writes go through `db.createSession()` → `SessionRepository` and never pass through the proxy, so `LiveQueryEngine` never receives change events for sessions or messages.

**Fix (Task 2)**: Replace `db` with `reactiveDb` in the call sites where session/message writes occur, so writes flow through the proxy and trigger change events.

---

## Tasks

### Task 1: Wire JobQueueProcessor into App Lifecycle

**Agent**: coder
**Priority**: high
**Depends on**: nothing (independent — can run in parallel with Task 2)

**Description**:
Wire `JobQueueProcessor` into `DaemonApp` so it starts and stops with the application. Additive only, no behavior change.

**Changes**:
- `packages/daemon/src/app.ts`:
  - Create `JobQueueProcessor` instance with `JobQueueRepository`
  - Call `processor.start()` in app init; `processor.stop()` in cleanup
  - Wire `reactiveDb.notifyChange('job_queue')` as the processor's change notifier so job completions trigger LiveQuery updates on the `job_queue` table
  - Add `jobQueueProcessor` to `DaemonAppContext`

**Acceptance Criteria**:
- `DaemonApp` starts/stops `JobQueueProcessor` cleanly with no side effects
- Unit test: processor lifecycle (start, stop, idle polling)
- Integration test: enqueue a job → processor picks it up → `job_queue` table update triggers a change event
- `bun run typecheck` passes
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2: Wire ReactiveDatabase for Session and Message Writes

**Agent**: coder
**Priority**: high (blocks Tasks 4 and 5)
**Depends on**: nothing (independent — can run in parallel with Task 1)

**Description**:
Ensure that writes to `sessions` and `sdk_messages` tables flow through the `ReactiveDatabase` proxy so `LiveQueryEngine` receives change events. Without this, subscribers created in Tasks 4 and 5 will never receive updates.

**Root cause**: `app.ts` creates `reactiveDb = createReactiveDatabase(db)` but passes `db` (the facade) to `SessionManager`, `StateManager`, and other components. Those components call `db.createSession()`, `db.saveSDKMessage()`, etc. directly — bypassing the proxy.

**Fix approach**: In `app.ts`, pass `reactiveDb` wherever the Database facade is currently passed to components that write sessions or messages. `reactiveDb` is a transparent Proxy of `db`, so all existing calls work unchanged — but the proxy now intercepts and fires change events for mapped methods.

**Key mapped methods** (already defined in `METHOD_TABLE_MAP` in `reactive-database.ts`):
- Sessions: `createSession`, `updateSession`, `deleteSession`
- SDK messages: `saveSDKMessage`, `saveUserMessage`, `updateMessageStatus`, `deleteMessagesAfter`, `deleteSessionMessages`

**Changes**:
- `packages/daemon/src/app.ts`: Pass `reactiveDb` instead of `db` to `SessionManager`, `StateManager`, and any other component that calls session/message write methods on the Database facade
- Verify no double-wrapping occurs (if a component already received `reactiveDb` somewhere, don't pass it twice)

**Acceptance Criteria**:
- Integration test: create a session via normal code path → `LiveQueryEngine` receives a `sessions` change event
- Integration test: save an SDK message via normal code path → `LiveQueryEngine` receives an `sdk_messages` change event
- All existing unit and integration tests continue to pass
- `bun run typecheck` passes
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3: LiveQuery RPC Infrastructure + Client Channel

**Agent**: coder
**Priority**: high
**Depends on**: Task 2 (LiveQuery only useful once change events fire)

**Description**:
Expose `LiveQueryEngine` via secure, named-query RPC. Use a server-side query allowlist instead of accepting raw SQL from clients (which would expose arbitrary read access to all tables including sensitive data like API keys in `global_settings`).

Also create the client-side `LiveQueryChannel` wrapper and the per-connection subscription cleanup mechanism.

#### 3a. Shared Types (`packages/shared/`)

Add to `packages/shared/src/state-types.ts` (or a new `live-query-types.ts`):

```typescript
// Named query IDs — client sends these, server maps to SQL
export type LiveQueryName =
  | 'sessions-active'           // Non-archived sessions
  | 'sessions-all'              // All sessions including archived
  | 'sessions-archived-count'   // COUNT of archived sessions
  | 'session-messages';         // Messages for a single session (paginated)

export interface LiveQuerySubscribeRequest {
  queryName: LiveQueryName;
  params: Record<string, unknown>; // Named params, e.g. { sessionId, limit }
}

export interface LiveQuerySnapshot<T> {
  type: 'snapshot';
  rows: T[];
  version: number;
}

export interface LiveQueryDelta<T> {
  type: 'delta';
  rows: T[];
  added: T[];
  removed: T[];
  updated: T[];
  version: number;
}
```

#### 3b. Server RPC Handlers (`packages/daemon/`)

Create `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`:

- **Query allowlist**: Define `LIVE_QUERY_TEMPLATES` — map from `LiveQueryName` to a function that returns `{ sql, params }` given client's named params. Server constructs SQL; client never sends raw SQL.

  The message query uses the `timestamp` column (not `created_at` — that column does not exist in `sdk_messages`). User messages are filtered via the existing `send_status` condition (`COALESCE(send_status, 'sent') IN ('sent', 'failed')`):

  ```typescript
  const LIVE_QUERY_TEMPLATES = {
    'sessions-active': () => ({
      sql: `SELECT * FROM sessions WHERE status != 'archived' ORDER BY last_active_at DESC`,
      params: [],
    }),
    'sessions-all': () => ({
      sql: `SELECT * FROM sessions ORDER BY last_active_at DESC`,
      params: [],
    }),
    'sessions-archived-count': () => ({
      sql: `SELECT COUNT(*) AS count FROM sessions WHERE status = 'archived'`,
      params: [],
    }),
    'session-messages': ({ sessionId, limit = 200 }) => ({
      sql: `SELECT sdk_message, timestamp, send_status FROM sdk_messages
            WHERE session_id = ?
              AND json_extract(sdk_message, '$.parent_tool_use_id') IS NULL
              AND (message_type != 'user' OR COALESCE(send_status, 'sent') IN ('sent', 'failed'))
            ORDER BY timestamp ASC LIMIT ?`,
      params: [sessionId, limit],
    }),
  };
  ```

- **`liveQuery.subscribe` RPC**: Validates `queryName` is in allowlist. Derives broadcast channel server-side from query name and params (e.g., `livequery.session-messages.${sessionId}`) — client does NOT supply the channel name. Subscribes via `LiveQueryEngine`, applies row mapper (see below), returns `{ subscriptionId, channel, snapshot }`. Tracks `subscriptionId → LiveQueryHandle` in a handler-level map.

- **`liveQuery.unsubscribe` RPC**: Accepts `{ subscriptionId }`. Looks up and disposes `LiveQueryHandle`.

- **Per-connection cleanup**: Use `WebSocketServerTransport.onClientDisconnect(clientId => ...)` (exists at line 363 of `websocket-server-transport.ts`). The transport injects `clientId` into messages (line 299). Pass `transport` to the handler setup so it can register the disconnect hook. On disconnect, dispose all handles belonging to that `clientId`.

- **Row mapping**: Each query template has a row mapper applied before broadcasting. Session queries use `SessionRepository.rowToSession()` (converts snake_case to camelCase, parses JSON columns). Message queries parse the `sdk_message` JSON blob. Raw SQLite rows are never sent to clients.

Register handlers in `packages/daemon/src/lib/rpc-handlers/index.ts`. Add `liveQueries`, `transport`, and `sessionRepo` to `RPCHandlerDependencies`.

#### 3c. Client LiveQueryChannel (`packages/web/`)

Create `packages/web/src/lib/live-query-channel.ts`:

- `LiveQueryChannel<T>` class: subscribes via `liveQuery.subscribe` RPC, listens on the server-assigned broadcast channel for diffs, exposes `rows` as a Preact signal
- `start()`: subscribe to channel first (before RPC call) to prevent race condition of missing events between RPC response and channel setup; apply initial snapshot from RPC response
- `stop()`: call `liveQuery.unsubscribe` RPC, remove event listener
- `handleDiff()`: uses `batch()` for atomic signal updates; merges delta into current rows using `id` field matching
- Reconnect: old server-side handle is disposed on disconnect; call `start()` again on reconnect to get fresh snapshot

**Acceptance Criteria**:
- Unit test: subscribe with invalid `queryName` returns error
- Unit test: subscribe → receive snapshot → receive delta (insert/update/delete)
- Unit test: `LiveQueryChannel` lifecycle (start, receive diffs, stop)
- Unit test: client disconnect triggers server-side handle disposal
- Unit test: row mapper applied — client receives typed objects (not raw rows)
- Integration test: subscribe to `sessions-active` → insert session → receive delta with mapped `Session` object
- Integration test: subscribe to `session-messages` → save message → receive delta with parsed `SDKMessage`
- `bun run typecheck` and `bun run lint` pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4: Migrate Sessions List to LiveQuery

**Agent**: coder
**Priority**: high
**Depends on**: Task 3

**Description**:
Replace the EventBus-based session broadcasting in `global-store.ts` with a `LiveQueryChannel` subscription.

#### `showArchived` and `hasArchivedSessions`

Subscribe to `sessions-all` (all sessions). Apply `showArchived` filtering **client-side** using a `computed()` signal derived from `settings.showArchived` and the raw sessions list. Compute `hasArchivedSessions` as a client-side derived signal (`computed(() => sessions.value.some(s => s.status === 'archived'))`). When `showArchived` changes, the existing computed signal re-runs — no re-subscription needed. This eliminates the server-side `sessions.filterChanged` event and the related broadcast.

#### Processing state distinction

The `sessions` table stores `processing_state` as a TEXT column, but the authoritative runtime value is `StateManager.processingStateCache` (in-memory, updated via EventBus events). The LiveQuery `sessions-all` subscription carries the DB-persisted `processingState` (written during state transitions, but may lag by milliseconds). For real-time streaming state, the existing `state.session` EventBus channel continues to be used until Task 6 cleanup. Document this in code comments.

#### Parallel run → cutover

**Phase A (parallel run)**: Subscribe to LiveQuery sessions alongside the existing EventBus path. In development mode, log divergence (session IDs in one but not the other). Run until zero divergences observed over a **24-hour observation window**.

**Phase B (cutover)**: Switch `sessions` signal to use `LiveQueryChannel.rows` as primary source. Derive `hasArchivedSessions` and filtered sessions as computed signals. Remove `state.sessions.delta` EventBus subscription from frontend.

**Acceptance Criteria**:
- `hasArchivedSessions` computed correctly client-side from LiveQuery data
- `showArchived` setting filters the session list client-side without re-subscription
- Phase A: zero divergence events logged over 24-hour observation window (must pass before Phase B)
- E2E test: create session via UI → sidebar updates
- E2E test: archive session → removed from sidebar (with `showArchived=false`)
- E2E test: toggle `showArchived=true` → archived sessions appear in sidebar
- E2E test: WebSocket disconnect + reconnect (via `closeWebSocket()` helper) → session list re-syncs with no missed sessions
- All existing session-related E2E tests continue to pass
- `bun run typecheck` and `bun run lint` pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5: Migrate SDK Messages to LiveQuery with Pagination

**Agent**: coder
**Priority**: normal
**Depends on**: Task 4

**Description**:
Replace per-session message broadcasting with `LiveQueryChannel`. Handles large message histories via initial pagination + delta streaming.

#### Pagination strategy

The `session-messages` query template uses `LIMIT 200` (configurable via params). For sessions with more than 200 messages, the initial snapshot returns the 200 most recent. When the user scrolls up (load-more), issue a one-shot `state.sdkMessages` RPC call to fetch older messages (not via LiveQuery — a separate paginated fetch). New messages arriving via LiveQuery delta are always appended/updated without re-fetching history.

Ordering: `ORDER BY timestamp ASC` using the `timestamp` column.

#### Subscription lifecycle

- Subscribe when a session is opened/selected
- Unsubscribe when the session is closed or deselected
- On reconnect: call `start()` again — server returns a fresh snapshot

**Changes**:
- `packages/web/src/lib/session-store.ts` (or equivalent): Replace EventBus `state.sdkMessages.delta` subscription with `LiveQueryChannel` for `session-messages`
- Handle subscription create/dispose on session open/close

**Acceptance Criteria**:
- E2E test: send a message → message appears in chat
- E2E test: agent reply → message updates in real time
- E2E test: session with >200 messages shows 200 most recent on load; load-more fetches older
- E2E test: WebSocket reconnect → messages re-sync without duplicates
- E2E test: rewind/checkpoint → message list reflects correct state
- All existing chat E2E tests continue to pass
- `bun run typecheck` and `bun run lint` pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 6: Remove All Manual Broadcast Paths

**Agent**: coder
**Priority**: normal
**Depends on**: Task 5

**Description**:
Remove all manual broadcasting for DB-backed state. Three locations emit session/message events directly — all must be cleaned up to avoid dual-path duplicates and race conditions.

#### Locations to remove

**1. `packages/daemon/src/lib/state-manager.ts`** — remove:
- `broadcastSessionsDelta()`
- `broadcastSessionsChange()`
- `broadcastSDKMessagesDelta()`
- `broadcastSDKMessagesChange()`
- The DB-metadata portions of `broadcastSessionUpdateFromCache()` (keep only the part that broadcasts agent processing state, which is still in-memory)
- EventBus listeners for `session.created`, `session.updated`, `session.deleted` that existed solely to trigger the above removed broadcasts

**2. `packages/daemon/src/lib/session/message-persistence.ts`** — remove:
- Direct `messageHub.event('state.sdkMessages.delta', ...)` call (~line 132)

**3. `packages/daemon/src/lib/agent/sdk-message-handler.ts`** — remove:
- Direct `messageHub.event('state.sdkMessages.delta', ...)` call (~lines 554-562)

#### Keep (non-DB state)

- `broadcastSystemChange()` — auth, config, health (not in DB)
- `broadcastSettingsChange()` — settings (consider migrating to LiveQuery in a follow-up)
- Processing state portion of `broadcastSessionStateChange()` — in-memory agent state (streaming, idle, errors) stays on EventBus

**Acceptance Criteria**:
- `grep -r 'state\.sessions\.delta\|state\.sdkMessages' packages/daemon/src` returns no results for DB-backed broadcast calls (verify with grep)
- `StateManager` reduced to ~270 lines or fewer (down from ~670)
- Full E2E test suite passes (all session + message tests)
- Unit tests for remaining `StateManager` methods pass
- `bun run typecheck`, `bun run lint`, `bun run check` all pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Dependency Graph

```
Task 1 (Wire JobQueueProcessor)         Task 2 (Wire ReactiveDatabase)
        [independent]                           [independent]
              │                                       │
              └───────────────────┬─────────────────-─┘
                                  │
                                  ▼
                        Task 3 (LiveQuery RPC + Client)
                                  │
                                  ▼
                        Task 4 (Migrate Sessions)
                                  │
                                  ▼
                        Task 5 (Migrate Messages)
                                  │
                                  ▼
                        Task 6 (Cleanup Broadcasts)
```

Tasks 1 and 2 are independent and can run in parallel. Task 3 depends on Task 2. Tasks 4→6 are strictly sequential after Task 3.

---

## Security Model

The `liveQuery.subscribe` RPC does **not** accept raw SQL from clients. The client sends a `LiveQueryName` (e.g., `"session-messages"`) and named params (e.g., `{ sessionId: "abc", limit: 200 }`). The server maps the name to a predefined SQL template; the client never controls query shape. The server also derives channel names — the client does not supply them.

This prevents:
- Arbitrary table reads (e.g., `global_settings` with API keys)
- `PRAGMA` statements or schema inspection
- Cross-session data access or channel spoofing

---

## Row Mapping

Raw SQLite rows are never sent to clients. Each query template has a corresponding row mapper:
- Sessions: `SessionRepository.rowToSession()` — converts snake_case to camelCase, parses JSON columns (`config`, `metadata`, `session_context`, worktree fields)
- Messages: parse `sdk_message` JSON blob to `SDKMessage` type
- Counts: `{ count: number }`

---

## Testing Strategy

Each task must include:
1. **Unit tests** for new/changed server-side code (`packages/daemon/tests/unit/`)
2. **Online/integration tests** for RPC endpoints and LiveQuery flows
3. **E2E tests** (Playwright) for user-visible behavior changes

```bash
make test:daemon      # Unit + integration tests
make test:web         # Web unit tests
make run-e2e TEST=tests/features/<test>.e2e.ts
```

---

## Rollback

Each task is a separate PR. Rollback = revert the PR.

| Task | Rollback Risk |
|------|--------------|
| Task 1 | Low — additive only |
| Task 2 | Low — additive only |
| Task 3 | Low — not used until Task 4 |
| Task 4 | Medium — clients need refresh after revert |
| Task 5 | Medium — clients need refresh after revert |
| Task 6 | High — must restore removed code; do only after Tasks 4+5 stable for 1+ week |
