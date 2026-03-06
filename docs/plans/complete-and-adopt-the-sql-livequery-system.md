# Plan: Complete and Adopt the SQL LiveQuery System

**Date**: 2026-03-06
**Related ADRs**: [0001-live-query-and-job-queue.md](../adr/0001-live-query-and-job-queue.md), [0001-migration-plan.md](../adr/0001-migration-plan.md)
**Status**: Approved

---

## Goal

The `ReactiveDatabase`, `LiveQueryEngine`, `JobQueueRepository`, and `JobQueueProcessor` are all implemented but not yet wired into the application. This plan finishes the integration by:

1. Wiring `JobQueueProcessor` into app lifecycle
2. Exposing `LiveQueryEngine` via MessageHub RPC
3. Migrating sessions and SDK messages from manual EventBus broadcasting to LiveQuery
4. Cleaning up the manual broadcast code from `StateManager`

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
| Live Query RPC handlers | ❌ Not done |
| LiveQueryChannel (client) | ❌ Not done |
| Sessions migrated to LiveQuery | ❌ Not done |
| SDK messages migrated to LiveQuery | ❌ Not done |
| StateManager manual broadcasts removed | ❌ Not done |

---

## Tasks

### Task 1: Wire JobQueueProcessor into App Lifecycle

**Agent**: coder
**Priority**: high
**Depends on**: nothing

**Description**:
Wire `JobQueueProcessor` into `DaemonApp` so it starts and stops with the application. This is low-risk (additive only) and unblocks future job-based background work.

**Changes**:
- `packages/daemon/src/app.ts`: Create `JobQueueProcessor` instance, call `start()` on init and `stop()` on cleanup. Add `jobQueueProcessor` to `DaemonAppContext`. Wire `reactiveDb.notifyChange` as the processor's change notifier so job completions trigger LiveQuery updates.
- No behavior change — processor starts but has no handlers registered yet.

**Acceptance Criteria**:
- `DaemonApp` starts/stops `JobQueueProcessor` cleanly
- Unit test: processor lifecycle (start, stop, stale job recovery)
- Integration test: enqueue a job, processor picks it up, job_queue table updates
- `bun run typecheck` passes
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2: Create Live Query RPC Handlers and Client Channel

**Agent**: coder
**Priority**: high
**Depends on**: Task 1

**Description**:
Expose `LiveQueryEngine` via MessageHub RPC so clients can subscribe to SQL queries and receive push updates. Also create the client-side `LiveQueryChannel` wrapper that manages subscription lifecycle.

**Server-side changes** (`packages/daemon/`):
- Create `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`:
  - `liveQuery.subscribe` RPC: accepts `{ sql, params, channel }`, returns `{ subscriptionId, snapshot }`
  - `liveQuery.unsubscribe` RPC: accepts `{ subscriptionId }`, disposes handle
  - Per-connection subscription tracking (map of `clientId → Set<subscriptionId>`)
  - Auto-cleanup of subscriptions on WebSocket disconnect
- Modify `packages/daemon/src/lib/rpc-handlers/index.ts`: register `setupLiveQueryHandlers`
- Modify `packages/daemon/src/app.ts`: pass `liveQueries` to RPC handler deps

**Shared types** (`packages/shared/`):
- Add `LiveQuerySubscribeRequest`, `LiveQuerySubscribeResponse`, `LiveQuerySnapshot<T>`, `LiveQueryDelta<T>` to `packages/shared/src/state-types.ts` (or a new `live-query-types.ts`)

**Client-side changes** (`packages/web/`):
- Create `packages/web/src/lib/live-query-channel.ts`:
  - `LiveQueryChannel<T>` class: subscribes via RPC, listens for broadcast diffs, exposes `rows` as a Preact signal
  - Handles `start()` and `stop()` lifecycle
  - Uses `batch()` for atomic signal updates
  - Integrates with reconnection flow (re-subscribes on reconnect)

**Acceptance Criteria**:
- Unit test: RPC handler with mock `LiveQueryEngine` — subscribe returns snapshot, diff broadcasts to channel
- Unit test: `LiveQueryChannel` subscription lifecycle (start → receive diffs → stop)
- Unit test: auto-cleanup on client disconnect
- Integration test (online test): subscribe → insert row → receive delta
- `bun run typecheck` and `bun run lint` pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3: Migrate Sessions List to LiveQuery

**Agent**: coder
**Priority**: high
**Depends on**: Task 2

**Description**:
Replace the manual EventBus-based session broadcasting with LiveQuery. Run both in parallel first (to verify correctness), then cut over.

**Phase A — Parallel Run**:
- Modify `packages/web/src/lib/global-store.ts`: add a secondary `LiveQueryChannel` subscription for sessions (`SELECT * FROM sessions WHERE status != 'archived' ORDER BY last_active_at DESC`), log divergence with existing EventBus path (diff verification in dev/test mode only)

**Phase B — Cutover**:
- Switch `global-store.ts` to use `LiveQueryChannel` as the primary source for `sessions` signal
- Remove `state.sessions.delta` EventBus subscription from frontend

**Server cleanup** (done in Task 4):
- `broadcastSessionsDelta()` and `broadcastSessionsChange()` removal deferred to Task 4

**Acceptance Criteria**:
- E2E test: create session via UI → sidebar updates
- E2E test: archive session → removed from sidebar
- E2E test: update session title → sidebar reflects change
- E2E test: WebSocket disconnect + reconnect → session list syncs correctly (use `closeWebSocket()` helper)
- All existing session-related E2E tests continue to pass
- `bun run typecheck` and `bun run lint` pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4: Migrate SDK Messages to LiveQuery

**Agent**: coder
**Priority**: normal
**Depends on**: Task 3

**Description**:
Replace the manual EventBus-based SDK message broadcasting with LiveQuery. This covers the per-session message list that drives the chat UI.

**Server changes**:
- No new server code needed — LiveQuery RPC from Task 2 handles this generically

**Client changes** (`packages/web/src/lib/session-store.ts` or equivalent):
- Replace `StateChannel` for `state.sdkMessages` with `LiveQueryChannel`:
  - SQL: `SELECT * FROM sdk_messages WHERE session_id = ? ORDER BY created_at ASC`
  - Channel: `state.messages.<sessionId>`
- Handle per-session subscription lifecycle (subscribe on session open, unsubscribe on session close)

**Acceptance Criteria**:
- E2E test: send a message → message appears in chat
- E2E test: agent reply streams in → message updates in real time
- E2E test: rewind/checkpoint → message list reflects correct state
- All existing chat E2E tests continue to pass
- `bun run typecheck` and `bun run lint` pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5: Clean Up StateManager Manual Broadcasts

**Agent**: coder
**Priority**: normal
**Depends on**: Task 4

**Description**:
Remove the ~400 lines of manual broadcast code from `StateManager` for DB-backed state. After Tasks 3 and 4, these methods are unused.

**Removals from `packages/daemon/src/lib/state-manager.ts`**:
- Remove `broadcastSessionsDelta()`
- Remove `broadcastSessionsChange()`
- Remove `broadcastSDKMessagesDelta()`
- Remove `broadcastSDKMessagesChange()`
- Remove `broadcastSessionUpdateFromCache()` DB fields portion (keep processing state portion)
- Remove EventBus listeners for `session.created`, `session.updated`, `session.deleted` that only existed to trigger removed broadcasts
- Simplify remaining `broadcastSessionStateChange()` to only handle agent processing state and errors (non-DB state)

**Keep (non-DB state)**:
- `broadcastSystemChange()` — auth, config, health
- `broadcastSettingsChange()` — settings (or migrate to LiveQuery in a follow-up)
- Processing state part of `broadcastSessionStateChange()` — streaming, idle, errors

**Acceptance Criteria**:
- `broadcastSessionsDelta`, `broadcastSessionsChange`, `broadcastSDKMessagesDelta`, `broadcastSDKMessagesChange` are removed
- `StateManager` is simplified to ~270 lines or fewer (down from ~670)
- Full E2E test suite passes (all session + message tests)
- Unit tests pass for remaining StateManager methods
- `bun run typecheck`, `bun run lint`, `bun run check` all pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Dependency Graph

```
Task 1 (Wire JobQueue)
    │
    └──> Task 2 (LiveQuery RPC + Client Channel)
              │
              └──> Task 3 (Migrate Sessions)
                        │
                        └──> Task 4 (Migrate SDK Messages)
                                  │
                                  └──> Task 5 (Cleanup StateManager)
```

Tasks are strictly sequential. Each builds on the previous.

---

## Testing Strategy

Each task must include:
1. **Unit tests** for new/changed server-side code (Bun native tests in `packages/daemon/tests/unit/`)
2. **Online/integration tests** for new RPC endpoints and LiveQuery flows
3. **E2E tests** (Playwright) for any user-visible behavior change

Run tests with:
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
| Task 2 | Low — not used until Task 3 |
| Task 3 | Medium — clients need refresh after revert |
| Task 4 | Medium — clients need refresh after revert |
| Task 5 | High — must restore removed code; do only after 3+4 stable for 1+ week |
