# Plan: Complete and Adopt Persistent Job Queue

## Goal

Replace all in-memory / setInterval-based background task execution in the NeoKai daemon with the existing persistent SQLite-backed job queue. This improves reliability (jobs survive daemon restarts), observability (job status is queryable), and correctness (retry/backoff semantics, deduplication).

## Current State

| Component | File | Status |
|-----------|------|--------|
| `JobQueueRepository` | `packages/daemon/src/storage/repositories/job-queue-repository.ts` | Complete |
| `JobQueueProcessor` | `packages/daemon/src/storage/job-queue-processor.ts` | Complete, NOT wired to `app.ts` |
| `job_queue` table | DB schema | Created with indexes |
| Unit tests | `tests/unit/storage/job-queue-*.test.ts` | Comprehensive |
| GitHub polling | `packages/daemon/src/lib/github/polling-service.ts` | Uses `setInterval` |
| Room runtime tick | `packages/daemon/src/lib/room/runtime/room-runtime.ts` | Uses `setInterval` |
| WebSocket stale check | `packages/daemon/src/lib/websocket-server-transport.ts` | Uses `setInterval` — **explicitly out of scope** (see note below) |

> **WebSocket stale-connection checker scope decision:** `WebSocketServerTransport.checkStaleConnections()` is a transport-layer concern (detecting dead TCP connections), not a business logic background task. It runs every 30s and only closes connections with no activity for >2 min. Migrating it to a DB-backed queue adds latency and persistence overhead that provides no benefit for a purely in-process I/O operation. It stays as `setInterval` in the transport layer.

## Architectural Decisions

### A. How `jobProcessor`/`jobQueue` reach `RoomRuntimeService`

`RoomRuntimeService` is instantiated inside `setupRPCHandlers()`, not in `app.ts`. Rather than lifting `RoomRuntimeService` out (large refactor), we **add `jobProcessor` and `jobQueue` to `RPCHandlerDependencies`** so they are passed into `setupRPCHandlers()`. This is a minimal, low-risk change.

```ts
// packages/daemon/src/lib/rpc-handlers/index.ts
export interface RPCHandlerDependencies {
  // ...existing...
  jobProcessor: JobQueueProcessor;  // ADD
  jobQueue: JobQueueRepository;     // ADD
}
```

`RoomRuntimeService` (already receiving dependencies via the dependency object) can then receive `jobQueue` for scheduling ticks.

### B. Atomic deduplication strategy

Both `github_poll` and `room_tick` require "at most one pending job" semantics. We add an **`enqueueIfNotPending(params)`** method to `JobQueueRepository` that performs an atomic INSERT with a subquery guard:

```sql
INSERT INTO job_queue (...)
SELECT ... WHERE NOT EXISTS (
  SELECT 1 FROM job_queue
  WHERE queue = ? AND status IN ('pending', 'processing')
  -- For room_tick: also filter by json_extract(payload, '$.roomId') = ?
);
```

This runs in a single SQLite statement with no TOCTOU gap.

### C. Recurring-job resurrection on failure

Recurring jobs (`github_poll`, `room_tick`) must survive handler failures. The next-interval re-enqueue happens in the handler's **`finally` block**, not only on success. This guarantees the chain never dies regardless of the handler outcome. The job-queue's own retry/dead mechanism handles transient handler errors during the *current* execution; the `finally` re-enqueue ensures the *next* scheduled interval always exists.

```ts
async (job) => {
  try {
    // do work
  } finally {
    // always schedule next run
    jobQueue.enqueueIfNotPending({ queue: job.queue, payload: job.payload, runAt: Date.now() + intervalMs });
  }
}
```

### D. `github_poll` payload contract

The `github_poll` job payload carries **no repository list**. The handler calls `pollingService.pollAllRepositories()` directly — the `GitHubPollingService` already maintains its own repository registry (`addRepository`/`getRepositories`). The payload is `{}`. This means no stale repo lists survive daemon restarts; the polling service is always the source of truth.

Startup reconciliation: when `gitHubService.start()` is called, it enqueues a `github_poll` job (runAt = now) if no pending/processing job already exists (using `enqueueIfNotPending`).

### E. `scheduleTick()` dual-purpose model (P2 clarification)

`RoomRuntime.scheduleTick()` uses `queueMicrotask()` for **event-driven, immediate** ticks (e.g., after a task completes or a leader tool returns). These remain as-is — they are synchronous in-process signals, not scheduled background tasks. Only the **periodic timer** (`setInterval` in `start()`) is replaced by job-based scheduling. The two mechanisms are complementary: jobs handle the heartbeat, `scheduleTick()` handles reactive state transitions.

## Tasks

---

### Task 1: Wire `JobQueueProcessor` into `DaemonApp` lifecycle and extend `RPCHandlerDependencies`

**Agent:** coder
**Risk:** Low
**Dependencies:** None

**Description:**

Instantiate `JobQueueProcessor` and `JobQueueRepository` in `packages/daemon/src/app.ts`, add them to `DaemonAppContext`, and pass them into `setupRPCHandlers()`.

**Implementation details:**

1. **`packages/daemon/src/app.ts`:**
   - Import `JobQueueRepository` and `JobQueueProcessor`.
   - After `db.initialize()`:
     ```ts
     const jobQueue = new JobQueueRepository(db.getDatabase());
     const jobProcessor = new JobQueueProcessor(jobQueue, {
       pollIntervalMs: 1000,
       maxConcurrent: 3,
       staleThresholdMs: 5 * 60 * 1000,
     });
     jobProcessor.setChangeNotifier((table) => reactiveDb.notifyChange(table));
     jobProcessor.start();
     ```
   - Add `jobProcessor` and `jobQueue` to `DaemonAppContext` interface.
   - Pass `jobProcessor` and `jobQueue` into `setupRPCHandlers()`.
   - In `cleanup()`, call `await jobProcessor.stop()` before `sessionManager.cleanup()`.

2. **`packages/daemon/src/lib/rpc-handlers/index.ts`:**
   - Add `jobProcessor: JobQueueProcessor` and `jobQueue: JobQueueRepository` to `RPCHandlerDependencies`.
   - Thread them into `RoomRuntimeService` construction (future tasks will use them; wire them now even if not yet consumed).

**Acceptance criteria:**
- `DaemonAppContext` exposes `jobProcessor` and `jobQueue`.
- `RPCHandlerDependencies` includes `jobProcessor` and `jobQueue`.
- Daemon starts and stops cleanly; `jobProcessor.stop()` is awaited before DB close.
- `setChangeNotifier` wired to `reactiveDb.notifyChange`.
- Unit test: processor starts/stops cleanly; cleanup awaits in-flight jobs.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2: Add `enqueueIfNotPending()` to `JobQueueRepository` and create handler type infrastructure

**Agent:** coder
**Risk:** Low
**Dependencies:** Task 1

**Description:**

Add the atomic deduplication helper and establish the shared handler type infrastructure.

**Implementation details:**

1. **`packages/daemon/src/storage/repositories/job-queue-repository.ts`:**
   - Add `enqueueIfNotPending(params: EnqueueParams & { dedupeKey?: string }): Job | null`.
   - The method performs a single atomic `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM job_queue WHERE queue = ? AND status IN ('pending', 'processing'))`.
   - For room ticks, accept an optional `dedupeKey` (e.g., roomId) to scope the uniqueness check to `json_extract(payload, '$.roomId') = ?`.
   - Returns the created `Job` or `null` if skipped.

2. **`packages/daemon/src/lib/job-handlers/types.ts`:**
   - Re-export `JobHandler` from `../../storage/job-queue-processor` (no redefinition).
   - Export `JobHandlerContext` interface with typed dependencies (`db`, `jobQueue`, etc.).

3. **`packages/daemon/src/lib/job-handlers/cleanup.handler.ts`:**
   - Handler deletes completed/dead jobs older than 7 days (configurable via `payload.maxAgeMs`).
   - In `finally` block, re-enqueues `cleanup` at `runAt: Date.now() + 24 * 60 * 60 * 1000`.
   - Register in `app.ts` and enqueue initial job at startup (24h from now).

**Acceptance criteria:**
- `enqueueIfNotPending()` is atomic (single SQL statement); unit-tested with concurrent calls.
- `types.ts` re-exports `JobHandler` from processor, no type drift.
- Cleanup handler deletes old jobs and always re-enqueues the next cleanup run (in `finally`).
- Unit tests: `enqueueIfNotPending` idempotency, cleanup handler with mock `JobQueueRepository`.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3: Migrate GitHub polling from `setInterval` to job queue

**Agent:** coder
**Risk:** Medium
**Dependencies:** Task 2

**Description:**

Replace `setInterval` in `GitHubPollingService.start()` with a job-based approach. The handler calls `triggerPoll()` and re-enqueues the next interval unconditionally.

**Implementation details:**

1. **`packages/daemon/src/lib/github/polling-service.ts`:**
   - Add `triggerPoll(): Promise<void>` as a public method (calls existing `this.pollAllRepositories()`).
   - Remove `setInterval` from `start()`. `start()` keeps state tracking (`this.running = true`) but no longer owns a timer.
   - `stop()` sets `this.running = false`.

2. **`packages/daemon/src/lib/github/github-service.ts`:**
   - Add `getPollingService(): GitHubPollingService` public accessor (returns `this.pollingService`).
   - Modify `start()`: after starting the polling service state, enqueue the first `github_poll` job immediately using `jobQueue.enqueueIfNotPending({ queue: 'github_poll', payload: {}, runAt: Date.now() })`.
   - `GitHubService.start()` receives `jobQueue` as a constructor/init parameter (passed from `app.ts`).

3. **`packages/daemon/src/lib/job-handlers/github-poll.handler.ts`:**
   ```ts
   export function createGitHubPollHandler(
     pollingService: GitHubPollingService,
     jobQueue: JobQueueRepository,
     intervalMs: number,
   ): JobHandler {
     return async (job) => {
       try {
         await pollingService.triggerPoll();
         return { polled: pollingService.getRepositories().length };
       } finally {
         // Unconditional reschedule — chain never dies
         jobQueue.enqueueIfNotPending({
           queue: 'github_poll',
           payload: {},
           runAt: Date.now() + intervalMs,
         });
       }
     };
   }
   ```
   - `intervalMs` comes from `config.githubPollingInterval` (respects configured value, not hardcoded 60s).

4. **`packages/daemon/src/app.ts`:**
   - Pass `jobQueue` to `createGitHubService(...)`.
   - After creating `gitHubService`, register handler:
     ```ts
     jobProcessor.register('github_poll',
       createGitHubPollHandler(gitHubService.getPollingService(), jobQueue, config.githubPollingInterval ?? 60_000)
     );
     ```

**Acceptance criteria:**
- `GitHubPollingService` no longer uses `setInterval`.
- `getPollingService()` exists on `GitHubService`.
- Handler uses `config.githubPollingInterval`, not hardcoded 60s.
- Handler re-enqueues in `finally` block (runs even on failure).
- `enqueueIfNotPending` prevents duplicate pending jobs.
- Startup enqueues initial `github_poll` job.
- Unit tests: handler calls `triggerPoll`, schedules next job in `finally`, `enqueueIfNotPending` called with correct `runAt`.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4: Migrate room runtime tick from `setInterval` to job queue

**Agent:** coder
**Risk:** High
**Dependencies:** Task 2

**Description:**

Replace the periodic `setInterval` in `RoomRuntime.start()` with per-room `room_tick` jobs. The event-driven `scheduleTick()` (using `queueMicrotask`) is **not changed** — it continues to trigger immediate in-process ticks for reactive state transitions.

**Implementation details:**

1. **`packages/daemon/src/lib/room/runtime/room-runtime.ts`:**
   - Remove `tickTimer` field and `setInterval(() => this.tick(), this.tickInterval)` from `start()`.
   - `start()` still sets `this.state = 'running'` and calls `this.scheduleTick()` (immediate first tick).
   - `stop()` still sets `this.state = 'stopped'`. Remove `clearInterval(this.tickTimer)`.
   - `scheduleTick()` is unchanged (uses `queueMicrotask`, only fires if `state === 'running'`).

2. **`packages/daemon/src/lib/job-handlers/room-tick.handler.ts`:**
   ```ts
   export function createRoomTickHandler(
     runtimeService: RoomRuntimeService,
     jobQueue: JobQueueRepository,
     intervalMs: number,
   ): JobHandler {
     return async (job) => {
       const { roomId } = job.payload as { roomId: string };
       const runtime = runtimeService.getRuntime(roomId);
       try {
         if (!runtime || runtime.getState() !== 'running') {
           return { skipped: true, reason: 'runtime_not_running' };
         }
         await runtime.tick();
         return { ticked: true };
       } finally {
         // Always reschedule if room is still active
         const stillActive = runtimeService.getRuntime(roomId)?.getState() === 'running';
         if (stillActive) {
           jobQueue.enqueueIfNotPending({
             queue: 'room_tick',
             payload: { roomId },
             runAt: Date.now() + intervalMs,
             dedupeKey: roomId,
           });
         }
       }
     };
   }
   ```

3. **`packages/daemon/src/lib/room/runtime/room-runtime-service.ts`:**
   - Accept `jobQueue: JobQueueRepository` and `tickIntervalMs: number` (from config, default 30s).
   - In `startRuntime(roomId)`: after `runtime.start()`, call:
     ```ts
     this.jobQueue.enqueueIfNotPending({
       queue: 'room_tick',
       payload: { roomId },
       runAt: Date.now() + this.tickIntervalMs,
       dedupeKey: roomId,
     });
     ```
   - In `stopRuntime(roomId)` and the `room.deleted` / `room.archived` event handler: cancel orphaned jobs:
     ```ts
     this.jobQueue.cancelPendingJobs('room_tick', roomId);
     ```

4. **`packages/daemon/src/storage/repositories/job-queue-repository.ts`:**
   - Add `cancelPendingJobs(queue: string, dedupeKey: string): number` method.
   - Deletes (or marks `cancelled`) all `pending` jobs in `queue` where `json_extract(payload, '$.roomId') = dedupeKey`.

5. **`packages/daemon/src/lib/rpc-handlers/index.ts`:**
   - Pass `jobQueue` and `tickIntervalMs` into `RoomRuntimeService` constructor.

**Startup reconciliation:** On daemon restart, `reclaimStale` in `JobQueueProcessor` re-queues stale `room_tick` jobs. The handler checks `runtimeService.getRuntime(roomId)?.getState() === 'running'` before executing; stale jobs for deleted/stopped rooms are silently skipped and not rescheduled (the `finally` block checks `stillActive`).

**Acceptance criteria:**
- `RoomRuntime` no longer uses `setInterval` for periodic ticks.
- `scheduleTick()` / `queueMicrotask` path is unchanged.
- `RoomRuntimeService.stopRuntime()` cancels pending `room_tick` jobs for the room.
- Handler skips and does not reschedule if room is not in `running` state.
- `enqueueIfNotPending` with `dedupeKey` prevents duplicate pending ticks per room.
- Unit tests: handler tick + reschedule, handler skip on stopped room, no double-enqueue.
- Integration tests: multiple rooms tick independently; stop one room, its jobs stop.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5: Add RPC handlers for job queue introspection

**Agent:** coder
**Risk:** Low
**Dependencies:** Task 1

**Description:**

Expose read-only job queue data via RPC for observability.

**RPC methods** (new file `packages/daemon/src/lib/rpc-handlers/jobs.ts`):

| Method | Params | Returns |
|--------|--------|---------|
| `jobs.list` | `{ queue?: string; status?: string; limit?: number }` | `Job[]` |
| `jobs.get` | `{ jobId: string }` | `Job \| null` |
| `jobs.countByStatus` | `{ queue: string }` | `Record<string, number>` |

Register in `setupRPCHandlers()` using the `jobQueue` from `RPCHandlerDependencies`.

**Acceptance criteria:**
- All three RPC methods registered and return correct data.
- Unit tests for each handler.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task Dependencies

```
Task 1 (Wire processor + extend RPCHandlerDependencies)
  ├── Task 2 (enqueueIfNotPending + handler types + cleanup handler)
  │     ├── Task 3 (GitHub polling migration)       [parallel with Task 4]
  │     └── Task 4 (Room runtime tick migration)    [parallel with Task 3]
  └── Task 5 (RPC introspection)                    [parallel with Task 2/3/4]
```

## Testing Strategy

- All tasks: unit tests with in-memory SQLite DB.
- Task 2: concurrent call test for `enqueueIfNotPending` atomicity.
- Tasks 3 & 4: integration tests — full dispatch → execute → reschedule cycle.
- Task 4: test that stopping a room cancels pending ticks; test stale job recovery skips deleted rooms.
- All: verify no `setInterval` left in migrated files (lint rule or grep assertion).

## Rollback Plan

Each task is independently reversible:
- Task 1: Remove `jobProcessor`/`jobQueue` from `app.ts` and `RPCHandlerDependencies`.
- Task 2: Delete handler files; remove `enqueueIfNotPending` / `cancelPendingJobs`.
- Task 3: Restore `setInterval` in `GitHubPollingService`; delete `github_poll` jobs.
- Task 4: Restore `setInterval` in `RoomRuntime`; delete `room_tick` jobs.
- Task 5: Unregister RPC handlers.
