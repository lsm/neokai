# Plan: Complete and Adopt the SQL LiveQuery System

## Goal

The SQL LiveQuery engine (`packages/daemon/src/storage/live-query.ts`) is fully implemented and tested
but not yet wired into any RPC handlers or frontend components. This plan adopts it progressively:

1. Fix `notifyChange` gaps for tables that bypass the ReactiveDatabase proxy
2. Expose LiveQuery as a typed named-query subscription protocol over the MessageHub WebSocket
3. Remove now-redundant manual daemonHub UI-notification broadcasts from RPC handlers
4. Replace one-shot RPC + manual event listeners in the frontend with LiveQuery subscriptions

## Process requirements (applies to all tasks)

All coding tasks must be on a feature branch with a GitHub PR created via `gh pr create`.
This requirement is not repeated in individual acceptance criteria below.

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
   and therefore bypass the `ReactiveDatabase` proxy:
   - `tasks` — written by `TaskManager` (takes raw `BunDatabase`)
   - `session_groups` — written by `SessionGroupRepository` (takes raw `BunDatabase`)
   - `session_group_messages` — written by `SessionGroupRepository.appendMessage()` (same)
   - `goals` — written by `GoalManager` and `GoalRepository` (both take raw `BunDatabase`). The
     `METHOD_TABLE_MAP` entries for goal operations are inert because `GoalManager` never calls
     the `Database` facade (`goal-manager.ts:25`).
   - _Note: `session_group_members` is also written directly in `SessionGroupRepository` but no
     planned LiveQuery subscribes to it; excluded from scope._

2. **No WebSocket transport** — no RPC endpoint lets clients register queries and receive deltas.

3. **No frontend usage** — `room-store.ts` uses one-shot RPCs plus manual event listeners.

### Key constraint: `room.task.update` and `goal.created` drive agent scheduling

`room-runtime-service.ts:337–345` subscribes to both `room.task.update` and `goal.created` on
`daemonHub` to call `scheduleTick()`. `room-runtime.ts` emits `room.task.update` from ~14 internal
write sites. These runtime-layer emits must not be removed.

### How the push mechanism works (no double-emit)

`MessageHub` exposes `sendToClient(clientId, message)` (defined in
`packages/shared/src/message-hub/types.ts:257`). When a client calls `liveQuery.subscribe`, the
handler captures the `clientId` from `CallContext`. The LiveQuery engine callback then calls
`messageHub.sendToClient(clientId, ...)` to deliver snapshot/delta events to the specific client.

This design **never routes LiveQuery callbacks through `daemonHub`**, which eliminates any
double-emit risk:
- Frontend receives task/goal updates exclusively via `liveQuery.delta` (after Task 4).
- `room-runtime-service.ts` receives `room.task.update` via `daemonHub` exclusively from the
  preserved runtime-layer emits. There is no overlap.

---

## Tasks

### Task 1 — Add `notifyChange` for tables that bypass the ReactiveDatabase proxy

**Agent:** coder
**Depends on:** nothing

Four tables are written via raw `BunDatabase` and never trigger `ReactiveDatabase` events. Any
LiveQuery subscription on these tables silently never fires until `notifyChange` is called.

**Injection strategy:** `ReactiveDatabase` must be **required** (not optional) in all four classes.
Update all call sites. Do not use an optional no-op fallback — a missed injection silently suppresses
all LiveQuery events with no error, making it impossible to catch the regression.

**Files to modify:**
- `packages/daemon/src/lib/room/managers/task-manager.ts` — inject `ReactiveDatabase`; call
  `reactiveDb.notifyChange('tasks')` after every write.
- `packages/daemon/src/lib/room/state/session-group-repository.ts` — inject `ReactiveDatabase`:
  - Call `reactiveDb.notifyChange('session_groups')` after writes to `session_groups` rows
    (createGroup, updateGroupState, setApproved, etc.).
  - Call `reactiveDb.notifyChange('session_group_messages')` after `appendMessage()` and any
    other `session_group_messages` writes.
- `packages/daemon/src/lib/room/managers/goal-manager.ts` and
  `packages/daemon/src/storage/repositories/goal-repository.ts` — inject `ReactiveDatabase`;
  call `reactiveDb.notifyChange('goals')` after every write (create, update, delete, link, unlink).
- Update all construction sites of these four classes to pass `reactiveDb`.

**Tests:**
- Unit tests verifying that a `LiveQueryEngine` subscription on each table fires after writes through
  the respective class.

**Acceptance criteria:**
- `LiveQueryEngine` re-evaluates queries on `tasks`, `session_groups`, `session_group_messages`,
  and `goals` after writes through the respective classes.
- `ReactiveDatabase` is required (no optional fallback) at all construction sites.
- All existing tests still pass.
- New unit tests verify reactive integration for each table.

---

### Task 2 — Add `liveQuery.subscribe` / `liveQuery.unsubscribe` RPC protocol over MessageHub

**Agent:** coder
**Depends on:** Task 1

Expose `LiveQueryEngine` to WebSocket clients. Naming follows
`docs/adr/0001-live-query-and-job-queue.md`: `liveQuery.subscribe` / `liveQuery.unsubscribe`.

#### Security model: named queries, not raw SQL

Clients send a **named query key** + parameters. The daemon resolves the name to a pre-registered
SQL template server-side. Clients never send raw SQL. Unknown query names are rejected with an error.

Initial named queries (registered at daemon startup):
- `tasks.byRoom` — `SELECT ... FROM tasks WHERE room_id = ?`
- `goals.byRoom` — `SELECT ... FROM goals WHERE room_id = ?`
- `sessionGroupMessages.byGroup` — `SELECT ... FROM session_group_messages WHERE group_id = ?`

The SQL column shape for each named query must match what the frontend already expects (aligned with
existing repository SELECT patterns). Parameter count validation is performed before execution; a
mismatch is rejected with a typed error. Type mismatches are caught by the SQL engine at runtime.

Named query keys follow the `<entity>.<filter>` convention. The registry is defined as a `Map` in
`live-query-handlers.ts` and also stored on `DaemonAppContext` for testability.

#### Protocol types (add to `packages/shared/src/live-query-types.ts`)

```ts
interface LiveQuerySubscribeRequest {
  queryName: string;       // named query key from server registry
  params: unknown[];
  subscriptionId: string;  // client-chosen, unique per client connection
}
interface LiveQuerySubscribeResponse { ok: true }
interface LiveQueryUnsubscribeRequest { subscriptionId: string }
interface LiveQueryUnsubscribeResponse { ok: true }

// Server-pushed via sendToClient, not broadcast
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

`CallContext` (`packages/shared/src/message-hub/types.ts:57`) does not include `clientId`. The
`clientId` must be threaded through the entire dispatch chain:

1. **`WebSocketServerTransport`** — knows `clientId` per WebSocket connection. When dispatching a
   request to the router, include `clientId` in the routed message metadata.
2. **`MessageHubRouter`** — thread the `clientId` through to `MessageHub` when routing requests.
3. **`MessageHub` (`message-hub.ts:518`)** — when building the `CallContext` object, populate
   `clientId` from the routed request metadata.
4. **`CallContext` type** — add `clientId?: string` field.

This enables the `liveQuery.subscribe` handler to capture `clientId` at subscribe time and use it
for both `sendToClient` pushes and disconnect cleanup.

#### Server-push mechanism

The LiveQuery engine callback (registered at subscribe time) holds a closure over `clientId` and
calls `messageHub.sendToClient(clientId, { type: 'event', method: 'liveQuery.snapshot' |
'liveQuery.delta', data: {...} })` to deliver events. This uses the existing `sendToClient` API
(`packages/shared/src/message-hub/types.ts:257`). No `daemonHub` involvement.

#### Disconnect cleanup

Register a cleanup handler via `messageHub.onClientDisconnect(handler)` (backed by
`WebSocketServerTransport.onClientDisconnect` at line ~363). The handler receives `clientId`;
dispose all LiveQuery handles keyed to that client.

#### `RPCHandlerDependencies` extension

Add `liveQueries: LiveQueryEngine` to the dependency interface in
`packages/daemon/src/lib/rpc-handlers/index.ts`.

**Work:**
- Add shared types to `packages/shared/src/live-query-types.ts`, export from `packages/shared/src/mod.ts`.
- Extend `CallContext` with `clientId?: string`; thread through `WebSocketServerTransport` →
  `MessageHubRouter` → `MessageHub` → `CallContext` construction at `message-hub.ts:518`.
- Define named-query registry in `live-query-handlers.ts`; store on `DaemonAppContext`.
- Add `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` with both handlers.
- Track handles per `clientId + subscriptionId`; register `onClientDisconnect` cleanup.
- Register handlers in `packages/daemon/src/lib/rpc-handlers/index.ts`; add `liveQueries` to
  the dependency type.
- Unit tests: subscribe → snapshot → delta → unsubscribe; unknown query name rejected; mismatched
  params count rejected.
- Online tests: full pipeline with real DB writes triggering deltas to a subscribed client.

**Acceptance criteria:**
- A client can call `liveQuery.subscribe` with a known named query and receive a snapshot then deltas.
- Unknown query names are rejected with a clear error.
- Mismatched parameter count is rejected with a clear error.
- `liveQuery.unsubscribe` stops further events.
- WebSocket disconnect disposes all subscriptions for that client.
- `clientId` is present in `CallContext` (threads from transport → router → MessageHub).
- Events pushed via `sendToClient`; `daemonHub` not involved.
- All unit and online tests pass.

---

### Task 3 — Remove redundant UI-notification broadcasts from RPC handlers

**Agent:** coder
**Depends on:** Task 2

After Tasks 1–2, every task/goal write automatically triggers `notifyChange`, which re-evaluates
all client LiveQuery subscriptions and pushes deltas via `sendToClient`. The manual `daemonHub`
broadcasts from RPC handlers that previously served the same UI-update purpose are now redundant.

**This task does NOT add any daemon-internal LiveQuery subscriptions.** There are no new long-lived
handles and no new dispose concerns — cleanup is handled entirely by the `liveQuery.unsubscribe`
and disconnect paths established in Task 2.

#### Emit sites to remove (RPC handler layer only)

- **`task-handlers.ts`**: Remove `emitTaskUpdate()` calls from `task.create` and `task.fail`.
  - **Keep `emitRoomOverview()` calls**: `room.overview` is emitted only from `task-handlers.ts`
    (confirmed by codebase audit). Task 4 retains the `room.overview` frontend listener for
    room/session metadata. Removing `emitRoomOverview` would make that listener permanently dead.
- **`goal-handlers.ts`**:
  - Remove `goal.updated` emits — covered by `goals.byRoom` LiveQuery delta.
  - Remove `goal.progressUpdated` emits — progress changes modify the goal row; the `goals.byRoom`
    LiveQuery delta includes all changed columns and delivers the update. Note: the frontend currently
    has no `goal.progressUpdated` listener in `room-store.ts` (updates were silently dropped); the
    LiveQuery approach now delivers them correctly for the first time.
  - **Keep `goal.created` emits** — `room-runtime-service.ts:338` subscribes to `goal.created` on
    `daemonHub` to trigger scheduling. Removing this emit would silently break goal-creation scheduling.

#### Emit sites preserved (runtime/tool layer — do not touch)

- `packages/daemon/src/lib/room/runtime/room-runtime.ts` — all `emitTaskUpdate`/`emitTaskUpdateById`
  calls (~14 sites). Drive `scheduleTick()` via `room-runtime-service.ts`.
- `packages/daemon/src/lib/room/tools/room-agent-tools.ts` — task/goal emit calls.
- `packages/daemon/src/lib/room/runtime/room-runtime.ts:159-170` — `emitGoalProgressForTask`.

**Tests:**
- Integration test: RPC `task.create` no longer produces a `room.task.update` daemonHub event.
- Integration test: RPC goal writes no longer produce `goal.updated` / `goal.progressUpdated` daemonHub events.
- Test: `goal.created` still fires from `goal-handlers.ts`.
- Test: `room.overview` still fires from `task-handlers.ts` after task writes.
- Test: `liveQuery.delta` reaches a subscribed client after task/goal RPC writes.

**Acceptance criteria:**
- `room.task.update` no longer emitted from RPC task handlers (`task.create`, `task.fail`).
- `goal.updated` and `goal.progressUpdated` no longer emitted from `goal-handlers.ts`.
- `goal.created` continues to be emitted from `goal-handlers.ts`.
- `room.overview` continues to be emitted from `task-handlers.ts`.
- `liveQuery.delta` events reach subscribed clients for task and goal RPC writes.
- Runtime/tool-layer `room.task.update` emits untouched; scheduling continues to work.
- All existing tests pass.

---

### Task 4 — Frontend: adopt `liveQuery.subscribe` in room-store for tasks and goals

**Agent:** coder
**Depends on:** Task 2

#### What to replace

- `hub.onEvent('room.task.update', ...)` — replace with `liveQuery.subscribe` using `tasks.byRoom`.
- Goal event listeners in `room-store.ts:255–299`:
  - `goal.created` — replaced by `goals.byRoom` LiveQuery.
  - `goal.updated` — replaced by `goals.byRoom` LiveQuery.
  - `goal.completed` — replaced by `goals.byRoom` LiveQuery.
  - `goal.progressUpdated` — no listener exists today (updates were silently dropped). The
    `goals.byRoom` LiveQuery now delivers these correctly; no listener removal needed, but note
    that goal progress is now surfaced in the UI for the first time.
- The task-update handling portion inside the `hub.onEvent('room.overview', ...)` callback.
- Tests in `packages/web/src/lib/__tests__/room-store-review.test.ts` that fire `room.task.update`
  events directly — rewrite to use `liveQuery.snapshot`/`liveQuery.delta`.

#### What NOT to remove

The `room.overview` event listener must be kept for its `room` metadata and `sessions` signal
updates (`room-store.ts:213–218`). Only the task-update portion within it is removed.

#### Reconnect re-subscribe

After WebSocket reconnect, re-issue `liveQuery.subscribe` for the active room. Use the
`connection-manager.ts` reconnect path (around lines 493–507) as the trigger. Handle the resulting
snapshot to fully resync state.

**Work:**
- When a room is selected, call `liveQuery.subscribe` with `tasks.byRoom` and `goals.byRoom`.
- Handle `liveQuery.snapshot`: replace signal value entirely.
- Handle `liveQuery.delta`: apply incremental updates using `added`/`removed`/`updated` arrays.
- Call `liveQuery.unsubscribe` in the cleanup path when switching rooms or disconnecting.
- Create `packages/web/src/hooks/useRoomLiveQuery.ts` — encapsulates subscribe/snapshot/delta/
  unsubscribe lifecycle including reconnect re-subscribe.
- Remove `hub.onEvent('room.task.update', ...)` and the three goal event listeners.
- Retain the `room.overview` listener; remove only its task-update portion.
- Rewrite affected tests in `room-store-review.test.ts`.
- Add Vitest tests for `useRoomLiveQuery` hook.
- Add/update E2E test: task created by agent appears in UI without page reload; switching rooms
  shows only the new room's tasks within one render cycle.

**Acceptance criteria:**
- Room task and goal lists update in real-time via `liveQuery.delta`.
- After WebSocket reconnect, subscriptions re-established and snapshot resyncs state.
- After switching rooms, task list reflects only the new room's tasks within one render cycle.
- `room.task.update`, `goal.created`, `goal.updated`, `goal.completed` listeners removed.
- `room.overview` listener retained for room/session updates.
- Goal progress updates surface in the UI (LiveQuery delivers them; were previously dropped).
- `room-store-review.test.ts` rewritten to use `liveQuery.snapshot`/`liveQuery.delta`.
- All Vitest and E2E tests pass.

---

### Task 5 — Frontend: adopt `liveQuery.subscribe` for session-group messages in TaskView

**Agent:** coder
**Depends on:** Task 2

#### Existing real-time path being replaced

`TaskConversationRenderer.tsx` already has a real-time path via `state.groupMessages.delta` events
(lines ~122–136). Task 5 replaces this with the standardized `liveQuery.subscribe` protocol
(protocol consolidation, not a new capability).

The daemon emits `state.groupMessages.delta` from two sites:
- `packages/daemon/src/lib/room/runtime/room-runtime.ts:888`
- `packages/daemon/src/lib/room/runtime/human-message-routing.ts:97`

Both sites become dead code once the frontend listener is removed. Task 5 must remove them.

#### Reconnect re-subscribe

After WebSocket reconnect, re-issue `liveQuery.subscribe` for the active group and handle the
snapshot to resync message state.

**Work:**
- Subscribe via `liveQuery.subscribe` using `sessionGroupMessages.byGroup`.
- Handle `liveQuery.snapshot` to load full message history on mount.
- Handle `liveQuery.delta` to append new messages (`added` array).
- Remove `state.groupMessages.delta` frontend listener from `TaskConversationRenderer.tsx`.
- Remove daemon-side emission sites: `room-runtime.ts:888` and `human-message-routing.ts:97`.
- Implement reconnect re-subscribe.
- Unsubscribe on component unmount or task deselection.
- Add Vitest tests for the hook; add/update E2E test for live message appearance in TaskView.

**Acceptance criteria:**
- New messages appear in TaskView without polling or manual refresh.
- After WebSocket reconnect, messages resync via snapshot.
- `state.groupMessages.delta` listener removed from `TaskConversationRenderer.tsx`.
- Both daemon-side `state.groupMessages.delta` emission sites removed.
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
| Human message routing | `packages/daemon/src/lib/room/runtime/human-message-routing.ts` |
| Shared types | `packages/shared/src/message-hub/types.ts`, `packages/shared/src/mod.ts` |
| WS transport (disconnect hook) | `packages/daemon/src/lib/websocket-server-transport.ts` |
| MessageHub (CallContext construction) | `packages/shared/src/message-hub/message-hub.ts` |
| Room store | `packages/web/src/lib/room-store.ts` |
| Room store tests | `packages/web/src/lib/__tests__/room-store-review.test.ts` |
| ADR | `docs/adr/0001-live-query-and-job-queue.md` |
| LiveQuery unit tests | `packages/daemon/tests/unit/storage/live-query.test.ts` |
| LiveQuery integration tests | `packages/daemon/tests/unit/storage/live-query-integration.test.ts` |
