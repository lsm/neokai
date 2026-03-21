# Plan: Complete and Adopt the SQL LiveQuery System

## Goal

The SQL LiveQuery engine (`packages/daemon/src/storage/live-query.ts`) is fully implemented and tested
but not yet wired into any RPC handlers or frontend components. This plan adopts it progressively:

1. Fix `notifyChange` gaps for tables that bypass the ReactiveDatabase proxy
2. Expose LiveQuery as a typed named-query subscription protocol over the MessageHub WebSocket
3. Remove the one remaining redundant RPC handler broadcast (`task.fail → emitTaskUpdate`)
4. Replace one-shot RPC + manual event listeners in the frontend with LiveQuery subscriptions
   (and atomically remove the corresponding daemon-side goal RPC handler broadcasts)
5. Adopt LiveQuery for session-group message streaming in TaskView

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
     the `Database` facade.
   - _Note: `session_group_members` is also written directly in `SessionGroupRepository` but no
     planned LiveQuery subscribes to it; excluded from scope._

2. **No WebSocket transport** — no RPC endpoint lets clients register queries and receive deltas.

3. **No frontend usage** — `room-store.ts` uses one-shot RPCs plus manual event listeners.

### Key constraint: `room.task.update` and `goal.created` drive agent scheduling

`room-runtime-service.ts` subscribes to both `room.task.update` and `goal.created` on
`daemonHub` to call `scheduleTick()`. `room-runtime.ts` emits `room.task.update` from ~14 internal
write sites. These runtime-layer emits must not be removed.

### How the push mechanism works (no double-emit)

When a client calls `liveQuery.subscribe`, the handler captures the `clientId` from `CallContext`.
The LiveQuery engine callback then delivers events to that specific client by calling
`messageHub.getRouter()!.sendToClient(clientId, message)`. `sendToClient` is defined on
`MessageHubRouter` at `packages/shared/src/message-hub/router.ts` and exposed via the public
`getRouter()` method on `MessageHub`.

This design **never routes LiveQuery callbacks through `daemonHub`**, which eliminates any
double-emit risk:
- Frontend receives task/goal updates exclusively via `liveQuery.delta` (after Milestone 3).
- `room-runtime-service.ts` receives `room.task.update` via `daemonHub` exclusively from the
  preserved runtime-layer emits. There is no overlap.

---

## Milestones

| # | Milestone | Tasks | Description |
|---|-----------|-------|-------------|
| 1 | [Backend Plumbing](./01-backend-plumbing.md) | 1.1–1.4 | Wire `notifyChange` into all four table writers |
| 2 | [RPC Protocol](./02-rpc-protocol.md) | 2.1–2.6 | Build the `liveQuery.subscribe`/`unsubscribe` RPC layer |
| 3 | [Daemon Cleanup & Frontend Tasks/Goals](./03-daemon-cleanup-and-frontend-tasks-goals.md) | 3.1–3.7 | Remove redundant emits, adopt LiveQuery in room-store |
| 4 | [Frontend Message Streaming](./04-frontend-message-streaming.md) | 4.1–4.4 | Adopt LiveQuery for session-group messages in TaskView |

## Dependency Graph

```
Milestone 1 ──► Milestone 2 ──► Milestone 3  (daemon cleanup + frontend tasks/goals)
                            └──► Milestone 4  (frontend task messages)
```

Milestones 3 and 4 can run in parallel after Milestone 2 completes.

Milestone 4 strictly requires only Milestone 2 for the subscribe/unsubscribe protocol. The dependency
on Milestone 2 completion (not just protocol availability) is intentional for **rollout discipline**:
keeping all frontend LiveQuery adoption gated behind Milestone 2 ensures the full pipeline is validated
before frontend migration begins.

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
| MessageHub (getRouter, CallContext) | `packages/shared/src/message-hub/message-hub.ts` |
| Room store | `packages/web/src/lib/room-store.ts` |
| Room store tests | `packages/web/src/lib/__tests__/room-store-review.test.ts` |
| TaskConversationRenderer tests | `packages/web/src/components/room/TaskConversationRenderer.test.tsx` |
| ADR | `docs/adr/0001-live-query-and-job-queue.md` |
| LiveQuery unit tests | `packages/daemon/tests/unit/storage/live-query.test.ts` |
| LiveQuery integration tests | `packages/daemon/tests/unit/storage/live-query-integration.test.ts` |
