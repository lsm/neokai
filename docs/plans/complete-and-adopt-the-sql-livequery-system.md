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

When a client calls `liveQuery.subscribe`, the handler captures the `clientId` from `CallContext`.
The LiveQuery engine callback then delivers events to that specific client by calling
`messageHub.getRouter()!.sendToClient(clientId, message)`. `sendToClient` is defined on
`MessageHubRouter` at `packages/shared/src/message-hub/router.ts:211` and exposed via the public
`getRouter()` method (`message-hub.ts:211`).

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

**`notifyChange` call-site convention:** `notifyChange` must be called **only after a write has
been durably committed** — i.e., after the write statement or transaction completes successfully.
For multi-step transactional writes, call `notifyChange` after the transaction commits, never
before. Calling it before commit could deliver stale data to subscribers.

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
- `notifyChange` is called only after writes are durably committed; never before.
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

Named query keys follow the `<entity>.<filter>` convention. The registry is defined as a
**module-level constant** (a `Map`) in `live-query-handlers.ts` — it is not added to
`RPCHandlerDependencies`; handler code accesses it directly as a module import. The registry `Map`
is also exported from `live-query-handlers.ts` for testability.

**Room-level authorization:** Named queries that filter by `room_id` (e.g., `tasks.byRoom`,
`goals.byRoom`) must validate that the `room_id` parameter matches the room the requesting client
has access to. The `liveQuery.subscribe` handler must check that the provided `room_id` is a room
the caller's session is authorized for, before registering the subscription. Unknown or unauthorized
`room_id` values are rejected with an authorization error.

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

// Server-pushed via router.sendToClient, not broadcast
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

`CallContext` (`packages/shared/src/message-hub/types.ts:57`) does not currently include `clientId`.
Steps 1–3 of the threading chain are **already implemented**:
- `HubMessageWithMetadata.clientId` is already populated by `WebSocketServerTransport` and
  extracted at `message-hub.ts:470` from inbound request messages.

Only **step 4** requires new code: add `clientId?: string` to the `CallContext` type
(`packages/shared/src/message-hub/types.ts:57`) and populate it at `message-hub.ts:518` when
building the `CallContext` object from the already-extracted `clientId`.

**Handler-level validation:** `liveQuery.subscribe` must reject requests where `clientId` is absent
from `CallContext` with an explicit error, rather than silently creating a subscription with no
delivery target.

#### Server-push mechanism

The LiveQuery engine callback (registered at subscribe time) holds a closure over `clientId` and
pushes snapshot/delta events by calling:
```
messageHub.getRouter()!.sendToClient(clientId, message)
```
`getRouter()` is a public method on `MessageHub` (`message-hub.ts:211`, returns
`MessageHubRouter | null`). `sendToClient` is defined on `MessageHubRouter` at
`packages/shared/src/message-hub/router.ts:211`. No `daemonHub` involvement.

The callback must guard against a null router (log and skip) and a missing client (log and clean up
the subscription handle).

**Event ordering:** The snapshot event is always delivered before any delta event for a given
subscription. After snapshot delivery, delta events carry a monotonically increasing `version`
field.

#### Disconnect cleanup

`MessageHub` must expose a new public `onClientDisconnect(handler: (clientId: string) => void): () => void`
forwarding method. This method delegates to `this.transport.onClientDisconnect(handler)`, which
maps to `WebSocketServerTransport.onClientDisconnect` at line 363. (Since `MessageHub` owns the
transport, this wrapper is a thin delegation.)

The `liveQuery.subscribe` handler setup function calls `messageHub.onClientDisconnect` once at
handler registration time to install a cleanup callback. The callback receives `clientId` and
disposes all `LiveQueryHandle` instances keyed to that client.

#### `RPCHandlerDependencies` extension

Add `liveQueries: LiveQueryEngine` to the dependency interface in
`packages/daemon/src/lib/rpc-handlers/index.ts`.

#### Observability

Log lifecycle events at debug level: subscribe (with `clientId`, `subscriptionId`, `queryName`),
unsubscribe, and disconnect-cleanup. Failures (null router, absent `clientId`, unauthorized
`room_id`) are logged at warn level.

**Work:**
- Add shared types to `packages/shared/src/live-query-types.ts`, export from `packages/shared/src/mod.ts`.
- Extend `CallContext` with `clientId?: string` (step 4 only; steps 1–3 already implemented);
  populate at `message-hub.ts:518`.
- Add `onClientDisconnect` forwarding method to `MessageHub`.
- Define named-query registry as module-level constant in `live-query-handlers.ts`; export it.
- Add `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` with both handlers.
- Implement room-level authorization check in `liveQuery.subscribe` for room-scoped queries.
- Track handles per `clientId + subscriptionId`; register disconnect cleanup via
  `messageHub.onClientDisconnect`.
- Register handlers in `packages/daemon/src/lib/rpc-handlers/index.ts`; add `liveQueries` to
  the dependency type.
- Unit tests: subscribe → snapshot → delta → unsubscribe; unknown query name rejected; mismatched
  params count rejected; unauthorized room_id rejected; absent clientId rejected.
- Online tests: full pipeline with real DB writes triggering deltas to a subscribed client.

**Acceptance criteria:**
- A client can call `liveQuery.subscribe` with a known named query and receive a snapshot then deltas.
- Unknown query names are rejected with a clear error.
- Mismatched parameter count is rejected with a clear error.
- Unauthorized `room_id` is rejected with an authorization error.
- Absent `clientId` in `CallContext` is rejected immediately with an error.
- `liveQuery.unsubscribe` stops further events.
- WebSocket disconnect disposes all subscriptions for that client.
- `clientId` is present in `CallContext` (populated at `message-hub.ts:518`).
- Snapshot is always delivered before any delta for a given subscription.
- Delta events carry a monotonically increasing `version` field.
- Events pushed via `messageHub.getRouter()!.sendToClient`; `daemonHub` not involved.
- `MessageHub.onClientDisconnect` forwarding method added and wired to transport.
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

**Merge ordering:** Task 3 must be merged to the main branch **before** Tasks 4 and 5. See
dependency graph below. Merging Task 3 before Task 4 is safe because the frontend still holds the
old event listeners during that interim — it simply receives fewer events, not zero (runtime-layer
emits are preserved for scheduling). The dangerous ordering is reversed: Task 4 merged before
Task 3 would cause duplicate client updates.

#### Emit sites to remove (RPC handler layer only)

- **`task-handlers.ts`**: Remove the `emitTaskUpdate()` call from `task.fail` (line 171).
  - Note: `task.create` does **not** call `emitTaskUpdate()`; no change needed there.
  - **Keep `emitRoomOverview()` calls**: `room.overview` is emitted only from `task-handlers.ts`
    (confirmed by codebase audit). Task 4 retains the `room.overview` frontend listener for
    room/session metadata. Removing `emitRoomOverview` would make that listener permanently dead.
- **`goal-handlers.ts`**:
  - Remove `goal.updated` emits — covered by `goals.byRoom` LiveQuery delta.
  - Remove `goal.progressUpdated` emits — progress changes modify the goal row; the `goals.byRoom`
    LiveQuery delta includes all changed columns and delivers the update. Note: the frontend currently
    has no `goal.progressUpdated` listener in `room-store.ts` (updates were silently dropped); the
    LiveQuery approach now delivers them correctly for the first time.
  - Remove `goal.completed` emits if present — `goal.completed` is defined in `daemon-hub.ts:344`
    but is never actually emitted anywhere in the current codebase (confirmed by grep). No action
    required, but verify during implementation. If a new emit site is found, remove it — covered
    by `goals.byRoom` LiveQuery delta.
  - **Keep `goal.created` emits** — `room-runtime-service.ts:338` subscribes to `goal.created` on
    `daemonHub` to trigger scheduling. Removing this emit would silently break goal-creation scheduling.

#### Emit sites preserved (runtime/tool layer — do not touch)

- `packages/daemon/src/lib/room/runtime/room-runtime.ts` — all `emitTaskUpdate`/`emitTaskUpdateById`
  calls (~14 sites). Drive `scheduleTick()` via `room-runtime-service.ts`.
- `packages/daemon/src/lib/room/tools/room-agent-tools.ts` — task/goal emit calls.
- `packages/daemon/src/lib/room/runtime/room-runtime.ts:159-170` — `emitGoalProgressForTask`.

**Tests:**
- Integration test: RPC `task.fail` no longer produces a `room.task.update` daemonHub event.
- Integration test: RPC goal writes no longer produce `goal.updated` / `goal.progressUpdated` daemonHub events.
- Test: `goal.created` still fires from `goal-handlers.ts`.
- Test: `room.overview` still fires from `task-handlers.ts` after task writes.
- Test: `liveQuery.delta` reaches a subscribed client after task/goal RPC writes.

**Acceptance criteria:**
- `room.task.update` no longer emitted from `task.fail` RPC handler.
- `goal.updated` and `goal.progressUpdated` no longer emitted from `goal-handlers.ts`.
- `goal.created` continues to be emitted from `goal-handlers.ts`.
- `room.overview` continues to be emitted from `task-handlers.ts`.
- `liveQuery.delta` events reach subscribed clients for task and goal RPC writes.
- Runtime/tool-layer `room.task.update` emits untouched; scheduling continues to work.
- All existing tests pass.

---

### Task 4 — Frontend: adopt `liveQuery.subscribe` in room-store for tasks and goals

**Agent:** coder
**Depends on:** Task 3 (which depends on Task 2)

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

After WebSocket reconnect, re-issue `liveQuery.subscribe` for the active room. Hook into the
general `connected` state transition (not just the page-visibility resume path) — use the same
`onConnection` callback pattern used by `state-channel.ts`. Handle the resulting snapshot to
fully resync state.

#### Subscription ownership

`room-store.ts` is a class-based singleton. `useRoomLiveQuery.ts` is a React hook that acts as
a lifecycle adapter: it calls into room-store's subscription management methods on component
mount/unmount and room-switch. `room-store` owns the `LiveQueryHandle` references and signal
state; the hook owns the component-lifecycle-bound subscribe/unsubscribe triggers. There must
be no double-subscription: the hook calls `room-store.subscribeRoom(roomId)` and
`room-store.unsubscribeRoom(roomId)`.

**Work:**
- When a room is selected, call `liveQuery.subscribe` with `tasks.byRoom` and `goals.byRoom`.
- Handle `liveQuery.snapshot`: replace signal value entirely.
- Handle `liveQuery.delta`: apply incremental updates using `added`/`removed`/`updated` arrays.
- Call `liveQuery.unsubscribe` in the cleanup path when switching rooms or disconnecting.
- Create `packages/web/src/hooks/useRoomLiveQuery.ts` — lifecycle adapter hook; room-store owns
  handles and signals, hook calls store methods on mount/unmount/room-switch.
- Remove `hub.onEvent('room.task.update', ...)` and the three goal event listeners.
- Retain the `room.overview` listener; remove only its task-update portion.
- Rewrite affected tests in `room-store-review.test.ts`.
- Add Vitest tests for `useRoomLiveQuery` hook.
- Add/update E2E test: task created by agent appears in UI without page reload; switching rooms
  shows only the new room's tasks within one render cycle.

**Acceptance criteria:**
- Room task and goal lists update in real-time via `liveQuery.delta`.
- After WebSocket reconnect (general `connected` transition), subscriptions re-established and
  snapshot resyncs state.
- After switching rooms, task list reflects only the new room's tasks within one render cycle.
- `room.task.update`, `goal.created`, `goal.updated`, `goal.completed` listeners removed.
- `room.overview` listener retained for room/session updates.
- Goal progress updates surface in the UI (LiveQuery delivers them; were previously dropped).
- No double-subscription: hook calls store methods; store owns handles.
- `room-store-review.test.ts` rewritten to use `liveQuery.snapshot`/`liveQuery.delta`.
- All Vitest and E2E tests pass.

---

### Task 5 — Frontend: adopt `liveQuery.subscribe` for session-group messages in TaskView

**Agent:** coder
**Depends on:** Task 3 (which depends on Task 2)

#### Existing real-time path being replaced

`TaskConversationRenderer.tsx` already has a real-time path via `state.groupMessages.delta` events
(lines ~122–136). Task 5 replaces this with the standardized `liveQuery.subscribe` protocol
(protocol consolidation, not a new capability).

The daemon emits `state.groupMessages.delta` from two sites:
- `packages/daemon/src/lib/room/runtime/room-runtime.ts:888`
- `packages/daemon/src/lib/room/runtime/human-message-routing.ts:97`

Both sites become dead code once the frontend listener is removed. Task 5 must remove them.

#### Reconnect re-subscribe

After WebSocket reconnect (general `connected` state transition), re-issue `liveQuery.subscribe`
for the active group and handle the snapshot to resync message state.

**Work:**
- Subscribe via `liveQuery.subscribe` using `sessionGroupMessages.byGroup`.
- Handle `liveQuery.snapshot` to load full message history on mount.
- Handle `liveQuery.delta` to append new messages (`added` array).
- Remove `state.groupMessages.delta` frontend listener from `TaskConversationRenderer.tsx`.
- Remove daemon-side emission sites: `room-runtime.ts:888` and `human-message-routing.ts:97`.
- Implement reconnect re-subscribe via general `connected` transition.
- Unsubscribe on component unmount or task deselection.
- Add Vitest tests for the hook; add/update E2E test for live message appearance in TaskView.

**Acceptance criteria:**
- New messages appear in TaskView without polling or manual refresh.
- After WebSocket reconnect (general reconnect, not just visibility-resume), messages resync via snapshot.
- `state.groupMessages.delta` listener removed from `TaskConversationRenderer.tsx`.
- Both daemon-side `state.groupMessages.delta` emission sites removed.
- Subscription disposed on component unmount.
- Vitest and E2E tests pass.

---

## Dependency Graph

```
Task 1 ──► Task 2 ──► Task 3 ──► Task 4  (frontend tasks/goals)
                             └──► Task 5  (frontend task messages)
```

Task 3 must complete before Tasks 4 and 5. This prevents a cutover window where the daemon stops
emitting events the frontend still depends on. Tasks 4 and 5 can run in parallel after Task 3.

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
| MessageHubRouter (sendToClient) | `packages/shared/src/message-hub/router.ts` |
| WS transport (disconnect hook) | `packages/daemon/src/lib/websocket-server-transport.ts` |
| MessageHub (getRouter, CallContext construction) | `packages/shared/src/message-hub/message-hub.ts` |
| Room store | `packages/web/src/lib/room-store.ts` |
| Room store tests | `packages/web/src/lib/__tests__/room-store-review.test.ts` |
| ADR | `docs/adr/0001-live-query-and-job-queue.md` |
| LiveQuery unit tests | `packages/daemon/tests/unit/storage/live-query.test.ts` |
| LiveQuery integration tests | `packages/daemon/tests/unit/storage/live-query-integration.test.ts` |
