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
| `github.poll` | n/a (singleton, payload `{}`) | Dedup: skip enqueue if a `pending`/`processing` job already exists |
| `github.event` | `eventId` (stable deterministic ID — see Task 3) | Check `github_processed_events` table before processing; insert on success |
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

**Important architectural notes**:

1. **`createDaemonApp` is a factory function, not a class.** There are no `start()`/`stop()` methods. The shutdown entry point is the `cleanup()` closure defined inside the factory (line ~321 of `app.ts`).

2. **`RoomRuntimeService` lives inside `setupRPCHandlers`, not `createDaemonApp` directly.** It is constructed at `packages/daemon/src/lib/rpc-handlers/index.ts` line 105. The plan accounts for this by passing `jobQueueProcessor` and `jobQueueRepo` as additional fields in the `deps` object passed to `setupRPCHandlers`. `setupRPCHandlers` passes them to the `RoomRuntimeService` constructor. No lifting of `RoomRuntimeService` into `createDaemonApp` is required.

3. **Startup ordering**: `setupRPCHandlers` (which instantiates and starts `RoomRuntimeService`) is called before `jobQueueProcessor.start()`. This ensures handler registration happens before the processor begins polling. However, `roomRuntimeService.start()` is currently fire-and-forget (called with `.catch()` inside `setupRPCHandlers`) and the recovery pass may not be complete when the processor starts. The tick handler in Task 4 addresses this with a re-enqueue-on-miss strategy (see Task 4).

4. **Shutdown ordering**: In the `cleanup()` closure, add `await jobQueueProcessor.stop()` **before** the `rpcHandlerCleanup()` call at line 375 of `app.ts`. `rpcHandlerCleanup()` internally calls `roomRuntimeService.stop()`, so this ordering ensures all in-flight tick jobs drain before the runtimes map is cleared.

**API extensions required** (implement alongside wiring):

a. Extend `JobQueueRepository.listJobs()` to accept `status?: JobStatus | JobStatus[]`. When an array is passed, generate `AND status IN (?,?)` SQL. This is needed for the room tick dedup query in Task 4.

b. `JobQueueProcessor` has no `getRepo()` accessor. Rather than adding one, inject the repository separately: each subsystem receives both `jobQueueProcessor` (for `register()`) and `jobQueueRepo` (for `enqueue()` and `listJobs()`). Both are available from the `db` facade via `db.getJobQueueRepo()`.

**Steps**:
1. Obtain `jobQueueRepo = db.getJobQueueRepo()` and instantiate:
   ```typescript
   const jobQueueRepo = db.getJobQueueRepo();
   const jobQueueProcessor = new JobQueueProcessor(jobQueueRepo, {
     pollIntervalMs: 1000,
     maxConcurrent: 3,
     staleThresholdMs: 300_000,
   });
   ```
2. Connect change notifier to `ReactiveDatabase`:
   ```typescript
   jobQueueProcessor.setChangeNotifier((table) => reactiveDb.notifyChange(table));
   ```
3. Add `jobQueueProcessor` and `jobQueueRepo` to the `deps` object passed to `setupRPCHandlers`.
4. Call `jobQueueProcessor.start()` after `setupRPCHandlers` returns (handlers registered before polling begins).
5. Add `await jobQueueProcessor.stop()` to the `cleanup()` closure before `rpcHandlerCleanup()`:
   ```typescript
   // cleanup():
   await jobQueueProcessor.stop(); // drain in-flight jobs first
   rpcHandlerCleanup();            // stops RoomRuntimeService (via rpc-handlers cleanup)
   await sessionManager.cleanup();
   ```
6. Define queue name constants in `packages/daemon/src/lib/job-queue-constants.ts` with the idempotency strategy documented in comments:
   ```typescript
   export const QUEUES = {
     SESSION_TITLE_GENERATION: 'session.title_generation',
     GITHUB_POLL: 'github.poll',
     GITHUB_EVENT: 'github.event',
     ROOM_TICK: 'room.tick',
     JOB_QUEUE_CLEANUP: 'job_queue.cleanup',
   } as const;
   ```
7. Each subsystem registers queue handlers in its own `start()` method, called after `jobQueueProcessor.start()`.

**Acceptance criteria**:
- `JobQueueProcessor` is instantiated; `jobQueueProcessor.start()` is called after `setupRPCHandlers`.
- `await jobQueueProcessor.stop()` is in the `cleanup()` closure before `rpcHandlerCleanup()`.
- Change notifier connected to `ReactiveDatabase`.
- `listJobs` extended to accept `status?: JobStatus | JobStatus[]`.
- `jobQueueProcessor` and `jobQueueRepo` injected into `setupRPCHandlers` via the `deps` object.
- Queue name constants exported from `job-queue-constants.ts`.
- Unit test verifies processor starts and stops correctly; confirms `stop()` is awaited before `rpcHandlerCleanup()`.
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
- `packages/daemon/src/lib/session/session-manager.ts` — enqueue a `session.title_generation` job; remove `pendingBackgroundTasks` Set; register handler in `SessionManager.start()` (called by `createDaemonApp` after `jobQueueProcessor.start()`)
- `packages/daemon/src/lib/session/session-lifecycle.ts` — wrap the existing `generateTitleAndRenameBranch` method (no extraction needed; already a method on `SessionLifecycle`) in the job handler

**Behavioral change**: Currently the `message.persisted` event handler does `await titleGenTask` (line 162 of `session-manager.ts`), blocking until title generation completes. After this migration the handler enqueues a job synchronously and returns immediately. This is the intended change — the handler must NOT await title generation; the job queue provides durability instead.

**Handler registration** via constructor injection (`SessionManager` receives `jobQueueProcessor` and `jobQueueRepo`):
```typescript
start(): void {
  this.jobQueueProcessor.register(QUEUES.SESSION_TITLE_GENERATION, async (job) => {
    const { sessionId } = job.payload as { sessionId: string };
    // Idempotency: skip if title already set
    const session = this.sessionRepo.getSession(sessionId);
    if (!session || session.title !== null) return;
    // Note: generateTitleAndRenameBranch requires the session in the in-memory cache.
    // On restart, if the session is not cached, fall back to DB-only title generation
    // (set title from userMessageText without renaming the branch).
    await this.sessionLifecycle.generateTitleAndRenameBranch(sessionId, ...);
  });
}
```

**Cache miss handling**: `generateTitleAndRenameBranch` reads from `sessionCache`. After a daemon restart the session may not be cached. The handler must check if the session is in cache; if not, apply a graceful fallback (title generation without branch rename, which is safe to retry).

Job payload: `{ sessionId: string, userMessageText: string }`

**Enqueue point** (replaces the `pendingBackgroundTasks` pattern):
```typescript
jobQueueRepo.enqueue({
  queue: QUEUES.SESSION_TITLE_GENERATION,
  payload: { sessionId, userMessageText },
  maxRetries: 2,
});
// Return immediately — no await
```

**Idempotency**: Handler queries `session.title`; if non-null, returns immediately.

**Acceptance criteria**:
- `pendingBackgroundTasks` Set removed from `SessionManager`.
- `message.persisted` handler returns immediately after enqueue (no `await` on title generation).
- Title generation enqueues a persistent job; handler runs via `JobQueueProcessor`.
- Cache miss fallback: handler completes gracefully even if session is not in memory.
- If daemon restarts after enqueue but before handler runs, job is picked up on next start.
- Idempotency: handler called twice for same session produces correct result (no double-rename).
- Unit tests cover: enqueue on first message, idempotency (title already set), handler success, cache miss fallback, failure + retry (max 2 retries), dead-letter after max retries.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3: Migrate GitHub Event Processing to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace the in-memory GitHub event pipeline with a persistent job queue so events are durable and idempotent across restarts. Persist polling state, restore repository registrations on startup, and assign stable event IDs to polled events.

**Schema additions** (new migration):

1. `github_processed_events` table (idempotency for `github.event` jobs):
   ```sql
   CREATE TABLE github_processed_events (
     event_id TEXT PRIMARY KEY,
     processed_at INTEGER NOT NULL
   );
   CREATE INDEX idx_github_processed_events_at ON github_processed_events(processed_at);
   ```

2. `github_poll_state` table (replaces in-memory etags/timestamps; the existing `global_settings` table is a single JSON blob and is not suitable for per-repo structured state):
   ```sql
   CREATE TABLE github_poll_state (
     repo_full_name TEXT PRIMARY KEY,
     etag TEXT,
     last_poll_at INTEGER NOT NULL DEFAULT 0
   );
   ```

**Stable event IDs for polled events**: The current `generateEventId()` in `event-normalizer.ts` produces a UUID, which is non-stable across restarts — the same polled event gets a different ID on re-poll, making `github_processed_events` ineffective. Task 3 must update `normalizePollingEvent` (and the individual `normalizeIssuePolling`, `normalizeCommentPolling`, `normalizePullRequestPolling` functions) to generate deterministic IDs:
- Issues: `{fullName}/issues/{issueNumber}/{updatedAt}`
- Comments: `{fullName}/comments/{commentId}/{updatedAt}`
- Pull requests: `{fullName}/pulls/{prNumber}/{updatedAt}`

Webhook events already have a stable `X-GitHub-Delivery` ID via `normalizeWebhookEvent`; no change needed there.

**Files to modify**:

1. `packages/daemon/src/lib/github/event-normalizer.ts`:
   - Replace UUID generation with deterministic stable IDs for polling normalizers

2. `packages/daemon/src/lib/github/polling-service.ts`:
   - Replace in-memory etag/timestamp state with reads/writes to `github_poll_state` table
   - In `start()`, restore repo registrations by reading from `GitHubMappingRepository` (`room_github_mappings` table)
   - Replace `setInterval` with a self-rescheduling `github.poll` job (singleton dedup)
   - Re-scheduling uses a `finally` block to guarantee next poll is always enqueued regardless of handler success or failure:
     ```typescript
     handler = async (job) => {
       try {
         await runPollCycle();
       } finally {
         // Always schedule next poll, even on failure
         jobQueueRepo.enqueue({
           queue: QUEUES.GITHUB_POLL,
           payload: {},
           runAt: Date.now() + POLL_INTERVAL_MS,
           maxRetries: 0,
         });
       }
     };
     ```
   - On daemon startup, enqueue first `github.poll` job with `runAt = now` if none pending/processing

3. `packages/daemon/src/lib/github/github-service.ts`:
   - Register `github.event` handler in `GitHubService.start()` (receives `jobQueueProcessor` and `jobQueueRepo` via constructor)
   - Handler checks `github_processed_events` for `eventId`; if found, returns (idempotent)
   - Handler runs existing filter→security→route pipeline
   - On success: inserts row into `github_processed_events`

4. `packages/daemon/src/lib/github/webhook-handler.ts`:
   - Update webhook path to enqueue a `github.event` job instead of calling the pipeline directly

Job payloads:
- `github.poll`: `{}` (singleton sentinel)
- `github.event`: `{ eventType: string, eventId: string, payload: Record<string, unknown> }`

**Retry behavior**: `maxRetries: 3` for `github.event`. `maxRetries: 0` for `github.poll` (re-scheduling handled in `finally` block; processor retry not needed).

**Acceptance criteria**:
- Polled events use deterministic stable IDs (verified by unit test: normalizing same data twice produces same ID).
- Per-repo poll state (etags, timestamps) stored in `github_poll_state` table, survives restart.
- Repository registrations restored from `GitHubMappingRepository` on `start()`.
- Same event cannot be processed twice (idempotency via `github_processed_events`).
- `github.poll` re-scheduling uses `finally` block — polling never permanently stalls after handler error.
- Enqueued `github.event` jobs survive daemon restart.
- Unit tests cover: stable ID generation, idempotency check, poll re-scheduling on success and on error, webhook path enqueues job.
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
3. `runtime-recovery.ts` calls `runtime.tick()` directly during recovery — this must also be replaced with `enqueueRoomTick()` so the tick mutex and dedup guarantees apply during recovery.

**`jobQueueProcessor` and `jobQueueRepo` injection**: `RoomRuntimeService` receives them via the `deps` object passed to `setupRPCHandlers` (wired in Task 1). No refactoring of `RoomRuntimeService` out of `setupRPCHandlers` is required.

**Migration approach**:
- Remove `setInterval`, `tickTimer` field, and `queueMicrotask` from `RoomRuntime`
- Add an `enqueueRoomTick(repo: JobQueueRepository, roomId: string, priority = 0)` helper function:
  ```typescript
  function enqueueRoomTick(repo: JobQueueRepository, roomId: string, priority = 0): void {
    // Dedup: skip if pending or processing job exists for this room
    // listJobs now supports status array (extended in Task 1)
    const existing = repo.listJobs({
      queue: QUEUES.ROOM_TICK,
      status: ['pending', 'processing'],
    }).find(j => (j.payload as any).roomId === roomId);
    if (!existing) {
      repo.enqueue({ queue: QUEUES.ROOM_TICK, payload: { roomId }, priority });
    }
    // Note: listJobs is an O(n) scan with no index on payload contents.
    // Acceptable at current scale (tens of rooms). Future optimization:
    // add unique constraint or dedicated column if room count grows significantly.
  }
  ```
- Replace all `this.scheduleTick()` call sites and the `runtime.tick()` call in `runtime-recovery.ts` with `enqueueRoomTick(repo, roomId, priority)`
- After each tick handler completes, enqueue next heartbeat with `runAt = Date.now() + 30_000`
- Register handler in `RoomRuntimeService.start()`:
  ```typescript
  this.jobQueueProcessor.register(QUEUES.ROOM_TICK, async (job) => {
    const { roomId } = job.payload as { roomId: string };
    const runtime = this.runtimes.get(roomId);
    if (!runtime) {
      // Runtime not ready yet (recovery in progress) or room deleted.
      // Re-enqueue with a short delay so recovery has time to complete.
      this.jobQueueRepo.enqueue({
        queue: QUEUES.ROOM_TICK,
        payload: { roomId },
        runAt: Date.now() + 5_000,
      });
      return;
    }
    await runtime.tick();
    // Heartbeat: schedule next tick
    this.jobQueueRepo.enqueue({
      queue: QUEUES.ROOM_TICK,
      payload: { roomId },
      runAt: Date.now() + 30_000,
    });
  });
  ```

**Startup and recovery ordering**: `roomRuntimeService.start()` is called with `.catch()` (fire-and-forget) inside `setupRPCHandlers`. Because recovery may not be complete when the first tick jobs fire, the handler uses re-enqueue-on-miss (above) rather than silent drop. This ensures rooms always receive their tick once recovery completes, without requiring strict startup sequencing between the processor and recovery.

**Shutdown ordering** (in `app.ts` cleanup closure — see Task 1 step 5):
1. `await jobQueueProcessor.stop()` — drains in-flight tick jobs
2. `rpcHandlerCleanup()` — stops `RoomRuntimeService` (clears `runtimes` map)
3. `await sessionManager.cleanup()`

The re-enqueue-on-miss tick handler avoids the risk of processing a tick after `runtimes` is cleared, because `jobQueueProcessor.stop()` drains all in-flight jobs before `rpcHandlerCleanup()` runs.

**Acceptance criteria**:
- `setInterval`, `tickTimer`, and `queueMicrotask` removed from `RoomRuntime`.
- All `scheduleTick()` call sites replaced with `enqueueRoomTick()`.
- `runtime-recovery.ts` uses `enqueueRoomTick()` instead of `runtime.tick()`.
- Re-enqueue-on-miss: handler re-enqueues with `runAt = now + 5_000` if runtime not found.
- Dedup: no duplicate `room.tick` jobs accumulate for the same room.
- Heartbeat re-scheduling: after each successful tick, new job enqueued with `runAt = now + 30_000`.
- Shutdown ordering enforced in `app.ts` cleanup closure.
- Unit tests cover: enqueue on event, dedup, heartbeat re-schedule, re-enqueue-on-miss (runtime not found), graceful tick execution.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5: Integration Tests, Cleanup, and Scheduled Maintenance

**Agent**: coder
**Dependencies**: Tasks 2, 3, 4
**Priority**: normal

**Description**:
Add integration/online tests validating job persistence and idempotency, add a scheduled DB maintenance job, add an E2E test for UI-observable reconnection, and clean up remaining stale patterns.

**Online/integration tests** (`packages/daemon/tests/online/`):

Note: `packages/daemon/tests/helpers/daemon-server.ts` provides only an in-process `createDaemonApp()` wrapper — there is no spawned-process mode for real kill/restart simulation. The crash-recovery scenarios below are validated by stopping and restarting the `JobQueueProcessor` within a single process, which is sufficient to verify that jobs persist across processor stop/start cycles (SQLite persistence is process-independent).

1. **Session title generation persistence**: enqueue a `session.title_generation` job, stop and restart the processor in-process, verify the job is picked up and the title is set exactly once.
2. **GitHub event idempotency**: enqueue the same `github.event` job payload twice (same `eventId`); verify it is processed exactly once (check `github_processed_events` table has one row).
3. **Room tick re-enqueue-on-miss**: enqueue a `room.tick` job for a roomId not in the `runtimes` map; verify the job is re-enqueued with a 5-second delay and not silently dropped.

**E2E test** (`packages/e2e/tests/`):
- Verify UI reconnects and displays correct state after WebSocket close and restore, using `closeWebSocket()` / `restoreWebSocket()` helpers from `connection-helpers.ts`.
- This is the correct E2E-compliant mechanism (pure browser-based, no RPC/internal state access).
- Server-restart crash-recovery is covered by online tests above, not E2E.

**Scheduled DB maintenance job** (`QUEUES.JOB_QUEUE_CLEANUP`):
- Register handler in `createDaemonApp` that: (1) calls `jobQueueRepo.cleanup(Date.now() - 7 * 24 * 60 * 60 * 1000)` to prune old `job_queue` rows; (2) deletes `github_processed_events` rows older than 30 days
- Self-rescheduling `finally` block (same pattern as `github.poll`):
  ```typescript
  finally {
    jobQueueRepo.enqueue({
      queue: QUEUES.JOB_QUEUE_CLEANUP,
      payload: {},
      runAt: Date.now() + 24 * 60 * 60 * 1000,
      maxRetries: 3, // retry transient failures; prevents permanent schedule stall
    });
  }
  ```
- On daemon startup: enqueue first run with `runAt = now` if no pending/processing cleanup job exists

**Cleanup scope** — patterns explicitly removed by this task:
- `pendingBackgroundTasks` Set in `session-manager.ts` (removed in Task 2; confirm no remaining references)
- `scheduleTick()` method and `tickTimer` field in `room-runtime.ts` (removed in Task 4)
- Any `void somePromise` usages replaced by queue jobs in Tasks 2–4

**Intentionally kept** (not in cleanup scope):
- `triggerBackgroundRefresh` in `model-service.ts` — cache warming, ephemeral by design
- WebSocket stale checker `setInterval` in `websocket-server-transport.ts` — process-local connection management
- Event-bus `.catch(() => {})` emissions in `rpc-handlers/` — in-process fanout

**Acceptance criteria**:
- At least 3 online tests covering job persistence and idempotency across processor restart.
- E2E test verifies UI recovers after WebSocket close/restore using `closeWebSocket()` / `restoreWebSocket()`.
- Scheduled cleanup job self-reschedules via `finally` block with `maxRetries: 3`; verified by unit test.
- No stale `pendingBackgroundTasks`, `scheduleTick()`, or `setInterval`-based tick patterns remain in production code.
- `bun run check` passes (lint + typecheck + knip).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Dependency Graph

```
Task 1 (Foundation — wiring, DI, constants, API extensions, idempotency design)
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
| `packages/daemon/src/lib/rpc-handlers/index.ts` | `setupRPCHandlers` — where `RoomRuntimeService` is created; Task 1 adds `jobQueueProcessor`/`jobQueueRepo` to deps |
| `packages/daemon/src/storage/job-queue-processor.ts` | Existing processor — all tasks |
| `packages/daemon/src/storage/repositories/job-queue-repository.ts` | Existing repository; `listJobs` extended for array status — Task 1 |
| `packages/daemon/src/lib/job-queue-constants.ts` | New queue name constants — Task 1 |
| `packages/daemon/src/lib/session/session-manager.ts` | Task 2 |
| `packages/daemon/src/lib/session/session-lifecycle.ts` | Task 2 |
| `packages/daemon/src/lib/github/event-normalizer.ts` | Deterministic stable IDs for polled events — Task 3 |
| `packages/daemon/src/lib/github/polling-service.ts` | Task 3 |
| `packages/daemon/src/lib/github/github-service.ts` | Task 3 |
| `packages/daemon/src/lib/github/webhook-handler.ts` | Task 3 |
| `packages/daemon/src/lib/room/runtime/room-runtime.ts` | Task 4 |
| `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` | Task 4 |
| `packages/daemon/src/lib/room/runtime/runtime-recovery.ts` | Task 4 — replace direct `tick()` call with `enqueueRoomTick()` |
| `docs/adr/0002-job-queue-migration.md` | Reference ADR |
