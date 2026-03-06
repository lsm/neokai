# Plan: Complete and Adopt the SQL LiveQuery System

## Goal

The SQL LiveQuery system (`packages/daemon/src/storage/live-query.ts`) is fully implemented and tested but
not yet used anywhere in the codebase. This plan adopts it progressively by:

1. Exposing LiveQuery as a subscription protocol over the MessageHub WebSocket
2. Adding `notifyChange` coverage for tables that bypass the ReactiveDatabase proxy
3. Replacing ad-hoc manual event emissions in RPC handlers with LiveQuery-backed subscriptions for tasks
4. Adopting LiveQuery-backed subscriptions on the frontend for task/goal lists in room view

The adoption follows a bottom-up approach: daemon transport layer first, then one high-value domain
(tasks), then front-end consumption, ending with clean-up of now-redundant manual event code.

---

## Background

### What is implemented

- **`LiveQueryEngine`** — registers parameterized SQL queries, re-evaluates them on `ReactiveDatabase`
  change events, computes row-level diffs (added/removed/updated), and invokes registered callbacks
  only when results change. Located at `packages/daemon/src/storage/live-query.ts`.
- **`ReactiveDatabase`** — a proxy around the `Database` facade that intercepts write calls and emits
  `change` / `change:<table>` events. Located at `packages/daemon/src/storage/reactive-database.ts`.
- Both are instantiated in `packages/daemon/src/app.ts` and exposed on `DaemonAppContext`.
- Unit tests: 919 lines covering snapshots, deltas, multi-subscriber, disposal, parameterized queries,
  JOIN queries (`live-query.test.ts`).
- Integration tests: 558 lines covering full pipeline with real DB (`live-query-integration.test.ts`).

### What is missing

1. **No WebSocket transport** — there is no RPC/subscription endpoint that clients can use to register
   a LiveQuery and receive snapshots + deltas.
2. **`tasks` and `session_groups` tables bypass the proxy** — `TaskManager` and
   `SessionGroupRepository` write directly via raw SQL (not through the Database facade), so their
   writes do not trigger `ReactiveDatabase` events. `notifyChange()` must be called manually after
   each write.
3. **No frontend usage** — `room-store.ts` uses one-shot RPC calls (`task.list`, `room.overview`) plus
   manual event listeners (`room.task.update`, `room.overview`) instead of LiveQuery subscriptions.

---

## Tasks

### Task 1 — Add `notifyChange` calls for tables that bypass the proxy

**Agent:** coder
**Depends on:** nothing (independent prerequisite)

The `tasks` and `session_groups` tables are written to directly via SQL in:
- `packages/daemon/src/lib/room/managers/task-manager.ts`
- `packages/daemon/src/lib/room/state/session-group-repository.ts`

These writes never go through the `Database` facade, so `ReactiveDatabase` never emits change events
for them, meaning `LiveQueryEngine` never re-evaluates queries on these tables.

**Work:**
- In `TaskManager` constructor or all write methods (`createTask`, `updateTaskStatus`,
  `updateTaskPriority`, etc.) call `reactiveDb.notifyChange('tasks')` after each write.
- In `SessionGroupRepository` write methods (`createGroup`, `updateGroupState`, etc.) call
  `reactiveDb.notifyChange('session_groups')` after each write.
- Both classes need `ReactiveDatabase` injected (or accept it as an optional parameter to avoid
  breaking existing call sites; prefer required injection and update all call sites).
- Add unit tests verifying that a LiveQuery on `tasks` / `session_groups` fires after a write via
  these classes.

**Acceptance criteria:**
- `LiveQueryEngine` re-evaluates queries on `tasks` when `TaskManager` creates/updates/deletes a task.
- `LiveQueryEngine` re-evaluates queries on `session_groups` when `SessionGroupRepository` mutates a group.
- All existing tests still pass.
- New tests in `packages/daemon/tests/unit/` verify the reactive integration.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2 — Add a `query.subscribe` / `query.unsubscribe` RPC protocol over MessageHub

**Agent:** coder
**Depends on:** Task 1

Expose the `LiveQueryEngine` to WebSocket clients via a subscription RPC pair:

- **`query.subscribe`** — client sends `{ sql, params, subscriptionId }`, daemon registers a
  LiveQuery and immediately pushes a `query.snapshot` event with the full initial result set, then
  pushes `query.delta` events as rows change.
- **`query.unsubscribe`** — client sends `{ subscriptionId }`, daemon disposes the handle.
- On WebSocket disconnect, all handles owned by that client are disposed automatically.

**Protocol types** (to be added to `packages/shared/src/`):
```ts
// RPC request/response
interface QuerySubscribeRequest { sql: string; params?: unknown[]; subscriptionId: string; }
interface QuerySubscribeResponse { ok: true; }
interface QueryUnsubscribeRequest { subscriptionId: string; }
interface QueryUnsubscribeResponse { ok: true; }

// Server-pushed events
interface QuerySnapshotEvent { subscriptionId: string; rows: unknown[]; version: number; }
interface QueryDeltaEvent {
  subscriptionId: string;
  added?: unknown[]; removed?: unknown[]; updated?: unknown[];
  version: number;
}
```

**Work:**
- Add shared types to `packages/shared/src/query-types.ts` and export from `packages/shared/src/mod.ts`.
- Add `query-subscription-handlers.ts` in `packages/daemon/src/lib/rpc-handlers/`.
- Register handlers in `packages/daemon/src/lib/rpc-handlers/index.ts`.
- Track per-client subscription handles keyed by `clientId + subscriptionId`; dispose on disconnect.
- Add unit tests for `subscribe → snapshot → delta → unsubscribe` flow.
- Add online tests exercising the full pipeline with real DB changes.

**Acceptance criteria:**
- A client can call `query.subscribe` and receive a snapshot followed by deltas.
- Disposing (via `query.unsubscribe` or disconnect) stops further events.
- `subscriptionId` namespacing prevents cross-client leaks.
- Tests in `packages/daemon/tests/unit/` and `packages/daemon/tests/online/` pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3 — Replace manual task/goal event emissions with LiveQuery subscriptions in RPC handlers

**Agent:** coder
**Depends on:** Task 2

Currently, `task-handlers.ts` and `goal-handlers.ts` manually call `daemonHub.emit('room.task.update', ...)` and `daemonHub.emit('room.overview', ...)` after every write. This is fragile (callers must remember to emit) and duplicates update logic. With LiveQuery available, the daemon can subscribe internally and push deltas automatically.

**Work:**
- In `setupTaskHandlers`, after registering request handlers, create a LiveQuery subscription on the
  `tasks` table (filtered by `room_id`) using the `liveQueries` engine from `DaemonAppContext`.
- On each delta, emit `room.task.update` (for individual task changes) and `room.overview` only when
  the set changes structurally (adds/removes).
- Remove the explicit `emitTaskUpdate` / `emitRoomOverview` calls from individual request handlers.
- Do the same for goals in `goal-handlers.ts`: subscribe on `goals` table, emit `room.goal.update`
  on delta.
- Wire `liveQueries` into both handler setup functions (add parameter to their signatures).
- Add integration tests verifying that a task write triggers the event without the handler explicitly
  emitting it.

**Acceptance criteria:**
- Task writes from `task.create`, `task.fail`, room agent writes all trigger `room.task.update` events
  without any explicit `emit` call in those code paths.
- Goal writes trigger `room.goal.update` events automatically.
- No double-emit occurs (previous manual calls removed).
- All existing unit and online tests still pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4 — Frontend: adopt `query.subscribe` in room-store for tasks and goals

**Agent:** coder
**Depends on:** Task 2

Replace the one-shot `task.list` RPC call + manual `room.task.update` / `room.overview` event listeners in `room-store.ts` with a LiveQuery subscription using the new `query.subscribe` protocol.

**Work:**
- In `room-store.ts`, when a room is selected, call `query.subscribe` with a tasks query
  (`SELECT ... FROM tasks WHERE room_id = ?`) and a goals query (`SELECT ... FROM goals WHERE room_id = ?`).
- Handle `query.snapshot` to replace the signal value entirely (equivalent to initial load).
- Handle `query.delta` to apply incremental updates to the signal (using `added`, `removed`, `updated`
  arrays), avoiding a full re-render.
- Remove the manual `hub.onEvent('room.task.update', ...)` and `hub.onEvent('room.overview', ...)`
  listeners that are now redundant.
- Call `query.unsubscribe` in the cleanup function when switching rooms or disconnecting.
- Add a `useRoomLiveQuery` hook in `packages/web/src/hooks/` that encapsulates subscribe/unsubscribe
  lifecycle for reuse.
- Add Vitest unit tests for the hook and store changes.
- Add or update an E2E test verifying that creating a task in the daemon reflects in the UI without
  a page reload.

**Acceptance criteria:**
- Room task list updates in real-time without manual event wiring.
- Switching rooms disposes old subscriptions and creates new ones.
- No stale task data after room switch.
- `room.task.update` listener removed from `room-store.ts`.
- Tests in `packages/web/` (Vitest) and `packages/e2e/` (Playwright) pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5 — Frontend: adopt `query.subscribe` for session-group messages in TaskView

**Agent:** coder
**Depends on:** Task 2

Task detail views need real-time updates as the room agent progresses. Currently, messages from a
session group are fetched on demand via `task.getGroupMessages`. This should be replaced with a
LiveQuery subscription so new messages appear automatically.

**Work:**
- In the TaskView component (or a dedicated hook), subscribe to session group messages via
  `query.subscribe` with a SQL query on `session_group_messages WHERE group_id = ?`.
- Handle `query.snapshot` and `query.delta` to incrementally append new messages to the view.
- Unsubscribe on component unmount or task deselection.
- Ensure the subscription uses `session_groups` / `session_group_messages` correctly (Task 1 ensures
  writes to these tables trigger events).
- Add Vitest tests for the hook, E2E test for live message appearance in TaskView.

**Acceptance criteria:**
- New messages in a task group appear in TaskView without polling or manual refresh.
- Subscription is cleaned up on unmount.
- Tests in `packages/web/` and `packages/e2e/` pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Dependency Graph

```
Task 1 ──► Task 2 ──► Task 3 (daemon cleanup)
                 └──► Task 4 (frontend tasks/goals)
                 └──► Task 5 (frontend task messages)
```

Tasks 3, 4, 5 all depend on Task 2 but are independent of each other and can run in parallel.

---

## Key Files Reference

| Area | File |
|------|------|
| LiveQueryEngine | `packages/daemon/src/storage/live-query.ts` |
| ReactiveDatabase | `packages/daemon/src/storage/reactive-database.ts` |
| App context | `packages/daemon/src/app.ts` |
| TaskManager | `packages/daemon/src/lib/room/managers/task-manager.ts` |
| SessionGroupRepository | `packages/daemon/src/lib/room/state/session-group-repository.ts` |
| Task RPC handlers | `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` |
| Goal RPC handlers | `packages/daemon/src/lib/rpc-handlers/goal-handlers.ts` |
| RPC handler index | `packages/daemon/src/lib/rpc-handlers/index.ts` |
| Room store | `packages/web/src/lib/room-store.ts` |
| State channel | `packages/web/src/lib/state-channel.ts` |
| Shared types | `packages/shared/src/mod.ts` |
| LiveQuery tests | `packages/daemon/tests/unit/storage/live-query.test.ts` |
| Integration tests | `packages/daemon/tests/unit/storage/live-query-integration.test.ts` |
