# Plan: Complete and Adopt Persistent Job Queue for Codebase

## Goal

The database-backed persistent job queue (`JobQueueRepository` + `JobQueueProcessor`) is fully implemented but not wired up or used by any daemon code. The goal is to adopt it across all background/async operations currently using in-memory patterns, replacing them with durable persistent jobs that survive daemon restarts.

## Current State

### Implemented (ready to use)
- `packages/daemon/src/storage/repositories/job-queue-repository.ts` — CRUD on `job_queue` SQLite table
- `packages/daemon/src/storage/job-queue-processor.ts` — background polling loop with handler registry, retry/backoff, stale reclaim
- Comprehensive unit tests in `packages/daemon/tests/unit/storage/`

### Full inventory of in-memory patterns and disposition

| Pattern | File | Disposition |
|---------|------|-------------|
| `pendingBackgroundTasks` Set (title generation + branch rename) | `session-manager.ts` | **Migrate** to `session.title_generation` queue |
| GitHub polling `setInterval` + in-memory etag/repo-list state | `polling-service.ts` | **Migrate** to `github.poll` queue; restore state from DB on startup |
| GitHub event pipeline (event-bus chain, no idempotency) | `github-service.ts`, `webhook-handler.ts` | **Migrate** to `github.event` queue |
| Room runtime `setInterval` heartbeat + `scheduleTick()` (`queueMicrotask`) | `room-runtime.ts` | **Migrate** to `room.tick` queue |
| WebSocket stale connection checker `setInterval` | `websocket-server-transport.ts` | **Intentionally ephemeral** — process-local connection management; no persistence value; keep as-is |
| `triggerBackgroundRefresh` fire-and-forget (model cache) | `model-service.ts` | **Intentionally ephemeral** — best-effort cache warming; keep as-is |
| Event-bus emissions with `.catch(() => {})` in room/message handlers | various `rpc-handlers/` | **Intentionally ephemeral** — in-process fanout; keep as-is |
| `JobQueueProcessor` not wired to `ReactiveDatabase` change notifier | `app.ts` | **Wire up** in Task 1 |

## Idempotency Key Design (cross-cutting, delivered in Task 1)

All queue handlers must be idempotent. Agreed per-queue strategy:

| Queue | Idempotency key | Strategy |
|-------|-----------------|----------|
| `session.title_generation` | `sessionId` | Handler queries DB; skip if `session.title IS NOT NULL` |
| `github.poll` | n/a (singleton) | Dedup: skip enqueue if a `pending`/`processing` job already exists |
| `github.event` | `eventId` (GitHub delivery ID) | Check `github_processed_events` table before processing; insert on success |
| `room.tick` | `roomId` | Dedup: skip enqueue if a `pending`/`processing` job for this `roomId` exists |

## Processor Configuration (reconciled with ADR-0002)

```typescript
new JobQueueProcessor(db.getJobQueueRepo(), {
  pollIntervalMs: 1000,      // 1 second (ADR default)
  maxConcurrent: 3,          // 3 concurrent jobs (ADR default)
  staleThresholdMs: 300_000, // 5 minutes (ADR recommendation; room ticks may take >1s)
})
```

---

## Tasks

### Task 1: Wire Up JobQueueProcessor in DaemonApp (Foundation)

**Agent**: coder
**Dependencies**: none
**Priority**: high

**Description**:
Initialize and start the `JobQueueProcessor` in `packages/daemon/src/app.ts`. This is the foundational plumbing all subsequent tasks depend on.

**Important**: `createDaemonApp` is a factory function, not a class with `start()`/`stop()` methods. The lifecycle entry point for shutdown is a `cleanup()` closure defined inside the factory. All processor lifecycle hooks must follow this existing pattern.

Steps:
1. Instantiate `JobQueueProcessor` using `db.getJobQueueRepo()`:
   ```typescript
   const jobQueueProcessor = new JobQueueProcessor(db.getJobQueueRepo(), {
     pollIntervalMs: 1000,
     maxConcurrent: 3,
     staleThresholdMs: 300_000,
   });
   ```
2. Connect the processor's change notifier to `ReactiveDatabase` so job completions/failures trigger live query updates:
   ```typescript
   jobQueueProcessor.setChangeNotifier((table) => reactiveDb.notifyChange(table));
   ```
3. Call `jobQueueProcessor.start()` inline after all subsystems are wired.
4. Add `await jobQueueProcessor.stop()` to the existing `cleanup()` closure **before** `await roomRuntimeService.stop()` and `await sessionManager.cleanup()` — this ordering ensures in-flight jobs (including room ticks) finish before dependent services are torn down.
5. Pass `jobQueueProcessor` via constructor injection to subsystems that need it (`SessionManager`, `GitHubService`, `RoomRuntimeService`), consistent with how `db` is passed today. Do not expose it as a separate context getter.
6. Each subsystem registers its own queue handlers in a `start()` lifecycle method, called by `createDaemonApp` after `jobQueueProcessor.start()`.
7. Define queue name constants in `packages/daemon/src/lib/job-queue-constants.ts`:
   ```typescript
   export const QUEUES = {
     SESSION_TITLE_GENERATION: 'session.title_generation',
     GITHUB_POLL: 'github.poll',
     GITHUB_EVENT: 'github.event',
     ROOM_TICK: 'room.tick',
     JOB_QUEUE_CLEANUP: 'job_queue.cleanup',
   } as const;
   ```
8. Document the idempotency strategy (table above) as a comment in `job-queue-constants.ts`.

**Acceptance criteria**:
- `JobQueueProcessor` is instantiated and `jobQueueProcessor.start()` is called in `createDaemonApp`.
- `await jobQueueProcessor.stop()` is in the `cleanup()` closure, before other service teardowns.
- Change notifier connected to `ReactiveDatabase`.
- Queue name constants exported from `job-queue-constants.ts` with idempotency strategy documented.
- `jobQueueProcessor` injected via constructor into `SessionManager`, `GitHubService`, `RoomRuntimeService`.
- Unit test verifies processor start/stop lifecycle and that `stop()` is called before other cleanup.
- All existing `JobQueueRepository` and `JobQueueProcessor` unit tests still pass.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2: Migrate Session Background Tasks to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace the fire-and-forget title generation + git branch rename in `SessionManager` with a persistent job on the `session.title_generation` queue.

**Files to modify**:
- `packages/daemon/src/lib/session/session-manager.ts` — enqueue a `session.title_generation` job instead of spawning a Promise; remove `pendingBackgroundTasks` Set; register the queue handler in `SessionManager.start()`
- `packages/daemon/src/lib/session/session-lifecycle.ts` — wrap the existing `generateTitleAndRenameBranch` method (already a method on `SessionLifecycle`, no extraction needed) into a job handler

**Handler registration** via constructor injection:
```typescript
class SessionManager {
  constructor(private readonly jobQueueProcessor: JobQueueProcessor, ...) {}

  start(): void {
    this.jobQueueProcessor.register(QUEUES.SESSION_TITLE_GENERATION, async (job) => {
      const { sessionId } = job.payload as { sessionId: string };
      // Idempotency: skip if title already set
      const session = this.sessionRepo.getSession(sessionId);
      if (!session || session.title !== null) return;
      await this.sessionLifecycle.generateTitleAndRenameBranch(sessionId, ...);
    });
  }
}
```

**Enqueue point**: In the `message.persisted` event handler where the current fire-and-forget Promise is spawned:
```typescript
this.jobQueueProcessor.getRepo().enqueue({
  queue: QUEUES.SESSION_TITLE_GENERATION,
  payload: { sessionId, userMessageText },
  maxRetries: 2,
});
```

Job payload: `{ sessionId: string, userMessageText: string }`

**Idempotency**: Handler queries DB; if `session.title IS NOT NULL`, returns immediately (safe to retry multiple times).

**Acceptance criteria**:
- `pendingBackgroundTasks` Set removed from `SessionManager`.
- Title generation enqueues a persistent job; handler runs via `JobQueueProcessor`.
- If daemon restarts after enqueue but before handler runs, job is picked up on next start.
- Idempotency: handler called twice for same session produces correct result (no double-rename).
- Unit tests cover: enqueue on first message, idempotency guard (title already set), handler success, handler failure + retry (max 2 retries), dead-letter after max retries.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3: Migrate GitHub Event Processing to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace the in-memory GitHub event pipeline with a persistent job queue so events are durable and idempotent across restarts. Persist polling state and restore repository registrations on startup.

**Schema addition** — new migration adds `github_processed_events` table:
```sql
CREATE TABLE github_processed_events (
  event_id TEXT PRIMARY KEY,  -- GitHub delivery ID
  processed_at INTEGER NOT NULL
);
CREATE INDEX idx_github_processed_events_at ON github_processed_events(processed_at);
```
Cleanup: prune rows older than 30 days in the Task 5 scheduled maintenance job.

**Files to modify**:

1. `packages/daemon/src/lib/github/polling-service.ts`:
   - Persist etags and last-poll timestamps to `settings` table (keyed by repo) instead of in-memory
   - In `start()`, restore repository registrations by reading from `GitHubMappingRepository` (which persists room→repo mappings in `room_github_mappings`) — this ensures polled repos survive restart without manual re-registration
   - Replace `setInterval` body: enqueue a `github.poll` job (singleton dedup — skip if `pending`/`processing` already exists); schedule next poll via `runAt = now + pollIntervalMs` after each poll completes

2. `packages/daemon/src/lib/github/github-service.ts`:
   - Register `github.event` handler in `GitHubService.start()`
   - Handler runs existing filter→security→route pipeline
   - Idempotency: check `github_processed_events` table for `eventId` before processing; insert row on success

3. `packages/daemon/src/lib/github/webhook-handler.ts` (correct filename — not `webhook-service.ts`):
   - Webhook path calls `handleWebhook()` in `github-service.ts`; update to enqueue a `github.event` job instead of calling the pipeline directly

**Retry behavior**: `maxRetries: 3` for `github.event` (transient routing failures). `maxRetries: 0` for `github.poll` (failed polls are simply retried on the next scheduled interval).

**Acceptance criteria**:
- Polling etags and timestamps persist across daemon restarts.
- Repository registrations are restored from `GitHubMappingRepository` on startup — no manual re-registration needed.
- Same GitHub event (by delivery ID) cannot be processed twice, verified by `github_processed_events` table.
- Events enqueued but not yet processed survive daemon restart and are processed on next start.
- Unit tests cover: enqueue on poll, idempotency (event already in `github_processed_events`), filter/route pipeline via handler, retry on transient error, webhook path enqueues job.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4: Migrate Room Runtime Tick to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace **both** the `setInterval` heartbeat and the `scheduleTick()` (`queueMicrotask`) immediate-trigger in `RoomRuntime` with persistent `room.tick` jobs.

**`RoomRuntime` has two tick trigger paths** — both must be migrated:
1. `setInterval(() => this.tick(), this.tickInterval)` (~line 205) — periodic heartbeat
2. `scheduleTick()` (~line 1550): `queueMicrotask(() => this.tick())` — event-driven immediate trigger with 9+ call sites (goal created, task updated, worker/leader terminal states, leader tool calls, etc.)

**Migration approach**:
- Remove `setInterval`, `tickTimer` field, and `queueMicrotask` from `RoomRuntime`
- Replace all `this.scheduleTick()` call sites with a shared `enqueueRoomTick(roomId, priority)` helper that checks dedup before enqueueing:
  ```typescript
  function enqueueRoomTick(repo: JobQueueRepository, roomId: string, priority = 0): void {
    const existing = repo.listJobs({ queue: QUEUES.ROOM_TICK, status: ['pending', 'processing'] })
      .find(j => (j.payload as any).roomId === roomId);
    if (!existing) {
      repo.enqueue({ queue: QUEUES.ROOM_TICK, payload: { roomId }, priority });
    }
    // Note: listJobs is an O(n) scan; acceptable at current room scale.
    // Future optimization: unique constraint on (queue, payload_roomId_hash) if needed.
  }
  ```
- After each tick handler completes, enqueue next heartbeat job with `runAt = Date.now() + 30_000`
- Register handler in `RoomRuntimeService.start()`:
  ```typescript
  processor.register(QUEUES.ROOM_TICK, async (job) => {
    const { roomId } = job.payload as { roomId: string };
    const runtime = this.runtimes.get(roomId);
    if (!runtime) return; // Room removed mid-flight; tolerate gracefully
    await runtime.tick();
  });
  ```

**Shutdown ordering** (enforced in `app.ts` cleanup closure):
1. `await jobQueueProcessor.stop()` — drains in-flight tick jobs
2. `await roomRuntimeService.stop()` — clears `runtimes` map
3. `await sessionManager.cleanup()` — cleans up agent sessions

This ordering prevents the tick handler from referencing a cleared `runtimes` map.

**Deduplication note**: The `listJobs` scan for dedup is O(n) with no composite index on `(queue, status, payload.roomId)`. At expected scale (tens of rooms), this is acceptable. If room count grows significantly, add a unique constraint or dedicated column. A comment documenting this trade-off must be included in the implementation.

**Acceptance criteria**:
- `setInterval`, `tickTimer`, and `queueMicrotask` removed from `RoomRuntime`.
- All `scheduleTick()` call sites replaced with `enqueueRoomTick()`.
- No duplicate `room.tick` jobs accumulate for the same room (dedup verified in tests).
- Heartbeat re-scheduling: after each tick, a new job is enqueued with `runAt = now + 30_000`.
- Handler tolerates a missing runtime (room deleted during flight) — returns without error.
- Shutdown ordering enforced in `app.ts` cleanup closure.
- Unit tests cover: enqueue on event, dedup (second enqueue skipped), heartbeat re-schedule, handler for unknown `roomId`, graceful tick execution.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5: Integration Tests, Cleanup, and Scheduled Maintenance

**Agent**: coder
**Dependencies**: Tasks 2, 3, 4
**Priority**: normal

**Description**:
Add integration/online tests validating crash-recovery and idempotency, add a scheduled DB maintenance job, add an E2E test for UI-observable reconnection, and clean up remaining in-memory patterns.

**Online/integration tests** (`packages/daemon/tests/online/`), using `daemon-server.ts` spawned-process mode for restart simulation:
1. **Session title generation recovery**: enqueue a `session.title_generation` job, stop the processor, restart it, verify the title is generated exactly once
2. **GitHub event idempotency**: enqueue the same `github.event` job twice; verify it is processed exactly once (check `github_processed_events` table)
3. **Room tick recovery**: enqueue a `room.tick` job, stop the processor, restart it, verify the room state progresses correctly

**E2E test** (`packages/e2e/tests/`):
- Verify UI reconnects and displays correct state after WebSocket close and restore (using existing `closeWebSocket()` / `restoreWebSocket()` helpers from `connection-helpers.ts`)
- This is the correct E2E-compliant mechanism (pure browser-based Playwright, no RPC/internal state access)
- Server-restart crash-recovery is covered by the online tests above, not E2E

**Scheduled DB maintenance job** (`QUEUES.JOB_QUEUE_CLEANUP`):
- Register handler in `createDaemonApp` that runs `jobQueueRepo.cleanup(Date.now() - 7 * 24 * 60 * 60 * 1000)` (prune `job_queue` rows older than 7 days) and prunes `github_processed_events` rows older than 30 days
- Self-rescheduling pattern: after handler completes, enqueue next run with `runAt = Date.now() + 24 * 60 * 60 * 1000`
- On daemon startup, enqueue first run with `runAt = now` if no pending/processing cleanup job exists

**Cleanup scope** — patterns explicitly removed by this task:
- `pendingBackgroundTasks` Set in `session-manager.ts` (removed in Task 2; confirm no references remain)
- `scheduleTick()` method and `tickTimer` field in `room-runtime.ts` (removed in Task 4)
- Any `void somePromise` usages replaced by queue jobs in Tasks 2–4

**Intentionally kept** (not in cleanup scope):
- `triggerBackgroundRefresh` in `model-service.ts` — cache warming, ephemeral by design
- WebSocket stale checker `setInterval` in `websocket-server-transport.ts` — process-local connection management
- Event-bus `.catch(() => {})` emissions in `rpc-handlers/` — in-process fanout

**Acceptance criteria**:
- At least 3 online tests covering crash-recovery/idempotency for the three migrated subsystems.
- E2E test confirms UI recovers after WebSocket close/restore using `closeWebSocket()` / `restoreWebSocket()`.
- Scheduled cleanup job runs daily; self-rescheduling logic verified by unit test.
- No stale `pendingBackgroundTasks`, `scheduleTick()`, or `setInterval`-based tick patterns remain in production code.
- `bun run check` passes (lint + typecheck + knip).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Dependency Graph

```
Task 1 (Foundation — wiring, DI, constants, idempotency design)
  ├── Task 2 (Session title generation)  ──┐
  ├── Task 3 (GitHub events + polling)   ──┼── Task 5 (Integration tests + cleanup)
  └── Task 4 (Room runtime tick)         ──┘
```

Tasks 2, 3, and 4 are independent and can run in parallel after Task 1 is merged. Task 5 waits for all three.

---

## Key Files Reference

| File | Relevance |
|------|-----------|
| `packages/daemon/src/app.ts` | Factory function with cleanup closure — Task 1 |
| `packages/daemon/src/storage/job-queue-processor.ts` | Existing processor — all tasks |
| `packages/daemon/src/storage/repositories/job-queue-repository.ts` | Existing repository — all tasks |
| `packages/daemon/src/lib/job-queue-constants.ts` | New queue name constants — Task 1 |
| `packages/daemon/src/lib/session/session-manager.ts` | Task 2 |
| `packages/daemon/src/lib/session/session-lifecycle.ts` | Task 2 |
| `packages/daemon/src/lib/github/polling-service.ts` | Task 3 |
| `packages/daemon/src/lib/github/github-service.ts` | Task 3 |
| `packages/daemon/src/lib/github/webhook-handler.ts` | Task 3 (correct filename) |
| `packages/daemon/src/lib/room/runtime/room-runtime.ts` | Task 4 |
| `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` | Task 4 |
| `docs/adr/0002-job-queue-migration.md` | Reference ADR |
