# Plan: Complete and Adopt the SQL LiveQuery System

## Goal

The SQL LiveQuery engine (`packages/daemon/src/storage/live-query.ts`) is fully implemented and tested
but not yet wired into any RPC handlers or frontend components. This plan adopts it progressively:

1. Fix `notifyChange` gaps for tables that bypass the ReactiveDatabase proxy
2. Expose LiveQuery as a typed named-query subscription protocol over the MessageHub WebSocket
3. Replace manual `daemonHub.emit` calls in the RPC handler layer with LiveQuery-backed subscriptions
4. Replace one-shot RPC + manual event listeners in the frontend with LiveQuery subscriptions

## Process requirements (applies to all tasks)

All coding tasks must be on a feature branch with a GitHub PR created via `gh pr create`. This
requirement is not repeated in individual task acceptance criteria below.

---

## Background

### What is implemented

- **`LiveQueryEngine`** — registers parameterized SQL queries, re-evaluates them on `ReactiveDatabase`
  change events, computes row-level diffs (added/removed/updated), invokes callbacks only when
  results change. Located at `packages/daemon/src/storage/live-query.ts`.
- **`ReactiveDatabase`** — wraps the `Database` facade; intercepts write calls and emits
  `change` / `change:<table>` events. Located at `packages/daemon/src/storage/reactive-database.ts`.
- Both are instantiated in `packages/daemon/src/app.ts` and exposed on `DaemonAppContext`.
- Unit tests (live-query.test.ts): 918 lines. Integration tests (live-query-integration.test.ts): 557 lines.

### What is missing

1. **`notifyChange` gaps** — Four tables are written via raw `BunDatabase` (not the `Database` facade)
   and therefore bypass the `ReactiveDatabase` proxy entirely:
   - `tasks` — written by `TaskManager` (takes raw `BunDatabase`)
   - `session_groups` — written by `SessionGroupRepository` (takes raw `BunDatabase`)
   - `session_group_messages` — written by `SessionGroupRepository.appendMessage()` (same)
   - `goals` — written by `GoalManager` and `GoalRepository` (both take raw `BunDatabase`). Note:
     these methods appear in `METHOD_TABLE_MAP` in `reactive-database.ts`, but those mappings are
     inert because `GoalManager` never calls the `Database` facade — it receives raw `BunDatabase`
     directly (`goal-manager.ts:25`).

2. **No WebSocket transport** — no RPC endpoint lets clients register queries and receive deltas.

3. **No frontend usage** — `room-store.ts` uses one-shot RPCs plus manual event listeners.

### Important constraint: `room.task.update` drives agent scheduling

`packages/daemon/src/lib/room/runtime/room-runtime-service.ts:343–345` subscribes to
`room.task.update` on `daemonHub` and calls `onTaskStatusChanged()` → `scheduleTick()`. This is what
drives the room runtime forward. The `room-runtime.ts` class also emits `room.task.update` from many
internal write sites (`emitTaskUpdate`/`emitTaskUpdateById`, called from ~14 locations). These
runtime-layer emits must **not** be removed; they drive agent execution and are unrelated to UI
updates. Task 3 below only migrates the RPC handler layer emits, not the runtime-layer emits.

---

## Tasks

### Task 1 — Add `notifyChange` for tables that bypass the ReactiveDatabase proxy

**Agent:** coder
**Depends on:** nothing

Four tables are written via raw `BunDatabase` and never trigger `ReactiveDatabase` events.
LiveQuery subscriptions on these tables will silently never fire unless `notifyChange` is called.

**Files to modify:**
- `packages/daemon/src/lib/room/managers/task-manager.ts` — after every write method, call
  `reactiveDb.notifyChange('tasks')`.
- `packages/daemon/src/lib/room/state/session-group-repository.ts`:
  - After writes to `session_groups` rows (createGroup, updateGroupState, setApproved, etc.) call
    `reactiveDb.notifyChange('session_groups')`.
  - After `appendMessage()` and any other `session_group_messages` writes, call
    `reactiveDb.notifyChange('session_group_messages')`.
- `packages/daemon/src/lib/room/managers/goal-manager.ts` and
  `packages/daemon/src/storage/repositories/goal-repository.ts` — after every write (create, update,
  delete, link, unlink), call `reactiveDb.notifyChange('goals')`.
- Each class needs `ReactiveDatabase` injected. Prefer required injection and update all call sites.
  If breaking all call sites is too disruptive, accept an optional parameter with a no-op fallback.

**Tests:**
- Unit tests verifying that a `LiveQueryEngine` subscription on `tasks` fires after a `TaskManager`
  write, and similarly for `session_groups`, `session_group_messages`, and `goals`.

**Acceptance criteria:**
- `LiveQueryEngine` re-evaluates queries on all four tables after writes through the respective classes.
- All existing tests still pass.
- New tests in `packages/daemon/tests/unit/` verify the reactive integration for each table.

---

### Task 2 — Add `liveQuery.subscribe` / `liveQuery.unsubscribe` RPC protocol over MessageHub

**Agent:** coder
**Depends on:** Task 1

Expose `LiveQueryEngine` to WebSocket clients. Naming follows the ADR
(`docs/adr/0001-live-query-and-job-queue.md`): `liveQuery.subscribe` / `liveQuery.unsubscribe`.

#### Security model: named queries, not raw SQL

Clients send a **named query key** (a string identifier) plus parameters. The daemon resolves the
name to a pre-registered SQL template server-side. Clients never send raw SQL. This prevents
arbitrary reads against sensitive tables (global_settings, API keys, OAuth tokens, etc.).

Named queries are registered at daemon startup in a `liveQueryRegistry` map:
- `tasks.byRoom` — `SELECT ... FROM tasks WHERE room_id = ?`
- `goals.byRoom` — `SELECT ... FROM goals WHERE room_id = ?`
- `sessionGroupMessages.byGroup` — `SELECT ... FROM session_group_messages WHERE group_id = ?`

Unknown query names are rejected with an error response.

#### Protocol types (add to `packages/shared/src/live-query-types.ts`)

```ts
interface LiveQuerySubscribeRequest {
  queryName: string;          // server-registered named query key
  params: unknown[];
  subscriptionId: string;     // client-chosen, unique per client connection
}
interface LiveQuerySubscribeResponse { ok: true }
interface LiveQueryUnsubscribeRequest { subscriptionId: string }
interface LiveQueryUnsubscribeResponse { ok: true }

// Server-pushed events
interface LiveQuerySnapshotEvent {
  subscriptionId: string;
  rows: unknown[];
  version: number;
}
interface LiveQueryDeltaEvent {
  subscriptionId: string;
  added?: unknown[];
  removed?: unknown[];
  updated?: unknown[];
  version: number;
}
```

#### `clientId` plumbing

`CallContext` (`packages/shared/src/message-hub/types.ts:57`) does not include `clientId`. Task 2
must extend `CallContext` with a `clientId?: string` field, populated by `WebSocketServerTransport`
when dispatching requests so `liveQuery.subscribe` can key subscriptions per client.

#### Disconnect cleanup

Wire per-client subscription disposal to `WebSocketServerTransport.onClientDisconnect(handler)`
(line ~363 of `packages/daemon/src/lib/websocket-server-transport.ts`). The handler receives the
`clientId`; dispose all LiveQuery handles keyed to that client.

#### `RPCHandlerDependencies` extension

Add `liveQueries: LiveQueryEngine` to the dependency interface in
`packages/daemon/src/lib/rpc-handlers/index.ts` so the new handlers can access the engine.

**Work:**
- Add shared types to `packages/shared/src/live-query-types.ts`, export from `packages/shared/src/mod.ts`.
- Extend `CallContext` with `clientId?: string`; populate it in `WebSocketServerTransport`.
- Add `liveQueryRegistry` (named-query map) to `DaemonAppContext`; register the initial named queries.
- Add `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` with `liveQuery.subscribe` and
  `liveQuery.unsubscribe` handlers.
- Track handles per `clientId + subscriptionId`; register `onClientDisconnect` for cleanup.
- Register handlers in `packages/daemon/src/lib/rpc-handlers/index.ts`; add `liveQueries` to
  the dependency type.
- Unit tests: subscribe → snapshot → delta → unsubscribe; unknown query name rejected.
- Online tests: full pipeline with real DB writes triggering deltas over the registered handler.

**Acceptance criteria:**
- A client can call `liveQuery.subscribe` with a known named query and receive a snapshot then deltas.
- Unknown query names are rejected with a clear error.
- `liveQuery.unsubscribe` stops further events.
- WebSocket disconnect disposes all subscriptions for that client (no zombie handles).
- `clientId` is available in the handler context (via extended `CallContext`).
- Tests in `packages/daemon/tests/unit/` and `packages/daemon/tests/online/` pass.

---

### Task 3 — Replace manual task/goal event emissions in RPC handlers with LiveQuery subscriptions

**Agent:** coder
**Depends on:** Task 2

**Scope boundary — RPC handler layer only.** The `room-runtime.ts` internal
`emitTaskUpdate`/`emitTaskUpdateById` calls (and the corresponding calls in `room-agent-tools.ts`)
must **not** be removed — they drive `scheduleTick()` in `room-runtime-service.ts` and are entirely
separate from UI update concerns.

**Emit sites being migrated (RPC handlers only):**
- `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` — `emitTaskUpdate()` and
  `emitRoomOverview()` called from `task.create`, `task.fail`.
- `packages/daemon/src/lib/rpc-handlers/goal-handlers.ts` — manual goal event emits.

**Emit sites NOT being touched (runtime/tool layer — preserve as-is):**
- `packages/daemon/src/lib/room/runtime/room-runtime.ts` — ~14 `emitTaskUpdate`/`emitTaskUpdateById`
  call sites. Must remain intact.
- `packages/daemon/src/lib/room/tools/room-agent-tools.ts` — task emit calls from tool handlers.

**Work:**
- In `setupTaskHandlers`, register a daemon-side LiveQuery subscription on `tasks` filtered by
  `room_id`. The delta callback calls `daemonHub.emit('room.task.update', ...)` — so the
  `room-runtime-service.ts` subscriber (line ~343) continues to receive it and scheduling is
  unaffected.
- Remove the now-redundant explicit `emitTaskUpdate`/`emitRoomOverview` calls from the RPC handlers
  that are now covered by the LiveQuery callback.
- In `setupGoalHandlers`, register a daemon-side LiveQuery on `goals` filtered by `room_id`. The
  delta callback calls `daemonHub.emit('goal.updated', ...)` (use the **existing** event name;
  there is no `room.goal.update` event — use `goal.updated` as defined in `daemon-hub.ts:332`).
- Both setup functions must return a `dispose` callback; the cleanup path in
  `packages/daemon/src/lib/rpc-handlers/index.ts` must call these on shutdown or room deletion.
- Add `liveQueries: LiveQueryEngine` parameter to both handler setup functions.

**Tests:**
- Integration tests verifying a task write triggers `room.task.update` via the LiveQuery path
  without a direct handler emit.
- Test that the dispose callback stops events after teardown.

**Acceptance criteria:**
- Task writes from `task.create`, `task.fail` trigger `room.task.update` via LiveQuery subscription.
- Goal writes trigger `goal.updated` via LiveQuery subscription.
- No double-emit: the RPC handler manual emits removed; the runtime-layer emits untouched.
- `room-runtime-service.ts` scheduling continues to work (still receives `room.task.update`).
- Setup functions return dispose handles wired into `rpc-handlers/index.ts` cleanup.
- All existing tests pass.

---

### Task 4 — Frontend: adopt `liveQuery.subscribe` in room-store for tasks and goals

**Agent:** coder
**Depends on:** Task 2

**What to replace:**
- `hub.onEvent('room.task.update', ...)` — replace with `liveQuery.subscribe` using `tasks.byRoom`.
- Goal event listeners `goal.created`, `goal.updated`, `goal.completed`
  (`room-store.ts:255–299`) — replace with `liveQuery.subscribe` using `goals.byRoom`.
- The task-update handling portion inside the `hub.onEvent('room.overview', ...)` callback.
- Existing tests in `packages/web/src/lib/__tests__/room-store-review.test.ts` that fire
  `room.task.update` events directly must be rewritten to use `liveQuery.snapshot`/`liveQuery.delta`.

**What NOT to remove:**
- The `room.overview` event listener itself must be kept for its `room` metadata and `sessions`
  signal updates (`room-store.ts:213–218`). Only the task-update portion within it is removed.

**Reconnect re-subscribe:**
- After WebSocket reconnect, re-issue `liveQuery.subscribe` for the active room. Use the
  `connection-manager.ts` reconnect path (lines ~493–507) as the hook. Handle the resulting snapshot
  to fully resync state.

**Work:**
- When a room is selected, call `liveQuery.subscribe` with `tasks.byRoom` and `goals.byRoom`.
- Handle `liveQuery.snapshot`: replace signal value entirely (equivalent to initial load).
- Handle `liveQuery.delta`: apply incremental updates using `added`/`removed`/`updated` arrays.
- Call `liveQuery.unsubscribe` in the cleanup path when switching rooms or disconnecting.
- Create `packages/web/src/hooks/useRoomLiveQuery.ts` — encapsulates subscribe/snapshot/delta/
  unsubscribe lifecycle including reconnect re-subscribe.
- Remove redundant `hub.onEvent('room.task.update', ...)` and the three goal event listeners.
- Retain the `room.overview` listener (remove only its task-update portion).
- Rewrite affected tests in `room-store-review.test.ts`.
- Add Vitest tests for `useRoomLiveQuery` hook.
- Add/update E2E test: task created by daemon appears in UI without page reload; switching rooms
  shows only the new room's tasks within one render cycle.

**Acceptance criteria:**
- Room task and goal lists update in real-time via `liveQuery.delta`.
- After WebSocket reconnect, subscriptions re-established and snapshot resyncs state.
- After switching rooms, task list reflects only the new room's tasks within one render cycle.
- `room.task.update`, `goal.created`, `goal.updated`, `goal.completed` listeners removed.
- `room.overview` listener retained for room/session updates.
- `room-store-review.test.ts` rewritten to use `liveQuery.snapshot`/`liveQuery.delta`.
- All Vitest and E2E tests pass.

---

### Task 5 — Frontend: adopt `liveQuery.subscribe` for session-group messages in TaskView

**Agent:** coder
**Depends on:** Task 2

**Existing real-time path being replaced:**
`TaskConversationRenderer.tsx` already has a real-time path via `state.groupMessages.delta` events
(lines ~122–136). Task 5 replaces this custom protocol with the standardized `liveQuery.subscribe`
protocol. The goal is protocol consolidation, not adding real-time updating from scratch.

**Reconnect re-subscribe:**
After WebSocket reconnect, re-issue `liveQuery.subscribe` for the active group and handle the
snapshot to resync message state.

**Work:**
- In the TaskView component (or a dedicated hook), subscribe via `liveQuery.subscribe` using
  `sessionGroupMessages.byGroup` named query.
- Handle `liveQuery.snapshot` to load full message history on mount.
- Handle `liveQuery.delta` to append new messages (`added` array) as agents post them.
- Remove the `state.groupMessages.delta` listener being replaced.
- Implement reconnect re-subscribe in the hook.
- Unsubscribe on component unmount or task deselection.
- Add Vitest tests for the hook; add/update E2E test for live message appearance in TaskView.

**Acceptance criteria:**
- New messages appear in TaskView without polling or manual refresh.
- After WebSocket reconnect, messages resync via snapshot.
- `state.groupMessages.delta` listener removed from `TaskConversationRenderer.tsx`.
- Subscription disposed on component unmount.
- Vitest and E2E tests pass.

---

## Dependency Graph

```
Task 1 ──► Task 2 ──► Task 3  (daemon RPC handler cleanup)
                 ├──► Task 4  (frontend tasks/goals)
                 └──► Task 5  (frontend task messages)
```

Tasks 3, 4, and 5 all depend on Task 2 and can run in parallel after it completes.

---

## Key Files Reference

| Area | File |
|------|------|
| LiveQueryEngine | `packages/daemon/src/storage/live-query.ts` |
| ReactiveDatabase | `packages/daemon/src/storage/reactive-database.ts` |
| App context | `packages/daemon/src/app.ts` |
| TaskManager | `packages/daemon/src/lib/room/managers/task-manager.ts` |
| GoalManager | `packages/daemon/src/lib/room/managers/goal-manager.ts` |
| GoalRepository | `packages/daemon/src/storage/repositories/goal-repository.ts` |
| SessionGroupRepository | `packages/daemon/src/lib/room/state/session-group-repository.ts` |
| Task RPC handlers | `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` |
| Goal RPC handlers | `packages/daemon/src/lib/rpc-handlers/goal-handlers.ts` |
| RPC handler index | `packages/daemon/src/lib/rpc-handlers/index.ts` |
| Room runtime (preserve emits) | `packages/daemon/src/lib/room/runtime/room-runtime.ts` |
| Room runtime service (scheduling) | `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` |
| Shared types | `packages/shared/src/message-hub/types.ts`, `packages/shared/src/mod.ts` |
| WS transport (disconnect hook) | `packages/daemon/src/lib/websocket-server-transport.ts` |
| Room store | `packages/web/src/lib/room-store.ts` |
| Room store tests | `packages/web/src/lib/__tests__/room-store-review.test.ts` |
| ADR | `docs/adr/0001-live-query-and-job-queue.md` |
| LiveQuery unit tests | `packages/daemon/tests/unit/storage/live-query.test.ts` |
| LiveQuery integration tests | `packages/daemon/tests/unit/storage/live-query-integration.test.ts` |
