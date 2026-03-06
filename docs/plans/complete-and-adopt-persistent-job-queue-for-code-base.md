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

## Tasks

---

### Task 1: Wire `JobQueueProcessor` into `DaemonApp` lifecycle

**Agent:** coder
**Risk:** Low
**Dependencies:** None

**Description:**

Instantiate `JobQueueProcessor` and `JobQueueRepository` in `packages/daemon/src/app.ts` and add them to the `DaemonAppContext`. The processor should start before the server begins serving requests and be stopped gracefully during cleanup (after in-flight jobs drain).

Also wire the change notifier so `ReactiveDatabase` is notified when jobs are completed or failed, enabling Live Query support for job status.

**Implementation details:**

In `app.ts`:
1. Import `JobQueueRepository` and `JobQueueProcessor`.
2. After `db.initialize()`, create:
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
3. Add `jobProcessor` and `jobQueue` to `DaemonAppContext` interface.
4. In `cleanup()`, call `await jobProcessor.stop()` before `sessionManager.cleanup()`.
5. Return both in the context object.

**Acceptance criteria:**
- `DaemonAppContext` exposes `jobProcessor: JobQueueProcessor` and `jobQueue: JobQueueRepository`.
- Daemon starts and stops cleanly with the processor running.
- `setChangeNotifier` wired to `reactiveDb.notifyChange`.
- Unit test: processor starts and stops cleanly as part of `createDaemonApp`.
- Integration test: cleanup waits for in-flight jobs before closing DB.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2: Create job handler infrastructure and the `cleanup` handler

**Agent:** coder
**Risk:** Low
**Dependencies:** Task 1

**Description:**

Create the shared handler type definitions and the database cleanup handler. This establishes the pattern all future handlers will follow.

**Files to create:**
- `packages/daemon/src/lib/job-handlers/types.ts` — `JobHandler` type alias and `JobHandlerContext` interface.
- `packages/daemon/src/lib/job-handlers/cleanup.handler.ts` — Deletes old completed/dead jobs from `job_queue` (and optionally other tables). Schedules next cleanup job (every 24h).

**Handler registration in `app.ts`:**
```ts
import { createCleanupHandler } from './lib/job-handlers/cleanup.handler';
jobProcessor.register('cleanup', createCleanupHandler(jobQueue, db));
// Enqueue initial cleanup job on startup
jobQueue.enqueue({ queue: 'cleanup', payload: {}, runAt: Date.now() + 24 * 60 * 60 * 1000 });
```

**Acceptance criteria:**
- `types.ts` exports `JobHandler` and `JobHandlerContext`.
- Cleanup handler deletes completed/dead jobs older than 7 days (configurable via payload).
- Cleanup handler re-enqueues itself for the next 24h run.
- Unit tests for the cleanup handler with mock dependencies.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3: Migrate GitHub polling from `setInterval` to job queue

**Agent:** coder
**Risk:** Medium
**Dependencies:** Task 2

**Description:**

Replace `setInterval` in `GitHubPollingService.start()` with a job-based approach. The handler triggers the actual poll and then re-enqueues the next poll job 60 seconds in the future.

**Implementation details:**

1. In `packages/daemon/src/lib/github/polling-service.ts`:
   - Add a `triggerPoll(): Promise<void>` public method that calls `this.pollAllRepositories()`.
   - Remove `setInterval` from `start()`. Keep `start()`/`stop()` for state management but they should no longer own the timer.

2. Create `packages/daemon/src/lib/job-handlers/github-poll.handler.ts`:
   - Handler calls `pollingService.triggerPoll()`.
   - After success, re-enqueues `github_poll` with `runAt: Date.now() + 60_000`.
   - Payload: `{ repositories: Array<{ owner: string; repo: string }> }`.

3. In `app.ts`, after creating `gitHubService`:
   ```ts
   if (gitHubService) {
     jobProcessor.register('github_poll', createGitHubPollHandler(gitHubService.getPollingService(), jobQueue));
     jobQueue.enqueue({ queue: 'github_poll', payload: {}, runAt: Date.now() });
   }
   ```

**Concurrency:** Only one `github_poll` job should run at a time. The handler checks for existing pending jobs before re-enqueueing.

**Acceptance criteria:**
- `GitHubPollingService` no longer uses `setInterval`.
- `triggerPoll()` is publicly callable.
- `github-poll.handler.ts` exists with correct re-scheduling logic.
- Handler is registered in `app.ts`; initial job enqueued on startup.
- Unit tests: handler triggers poll, schedules next job, no-ops if pending job exists.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4: Migrate room runtime tick from `setInterval` to job queue

**Agent:** coder
**Risk:** High
**Dependencies:** Task 2

**Description:**

Replace `setInterval` in `RoomRuntime.start()` with a per-room job-based tick. Each active room gets a `room_tick` job scheduled. After each tick completes, the next tick is scheduled 30 seconds later.

**Implementation details:**

1. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`:
   - Remove `tickTimer` field and `setInterval(() => this.tick(), this.tickInterval)` from `start()`.
   - Keep `start()` for state transitions (`this.state = 'running'`).
   - Keep the `tick()` method unchanged (it still has the mutex protection).

2. In `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` (or equivalent service that manages `RoomRuntime` instances):
   - After calling `runtime.start()`, enqueue the first tick job.

3. Create `packages/daemon/src/lib/job-handlers/room-tick.handler.ts`:
   - Receives `{ roomId: string }` payload.
   - Looks up the `RoomRuntime` from the runtime registry.
   - Calls `await runtime.tick()`.
   - After tick, if room is still active, re-enqueues `room_tick` with `runAt: Date.now() + 30_000`.
   - Deduplicates: checks for existing pending `room_tick` job for the same `roomId` before enqueueing.

4. Register the handler in `app.ts` (or wherever runtimes are initialized):
   ```ts
   jobProcessor.register('room_tick', createRoomTickHandler(roomRuntimeRegistry, jobQueue));
   ```

5. When a room is stopped/deleted, cancel/ignore pending `room_tick` jobs for that room (handler checks if runtime is still active before ticking).

**Concurrency:** The existing `tickLocked`/`tickQueued` mutex in `RoomRuntime.tick()` prevents overlapping ticks within the same room. The deduplication check prevents multiple `room_tick` jobs from being enqueued for the same room.

**Acceptance criteria:**
- `RoomRuntime` no longer uses `setInterval`.
- `room-tick.handler.ts` exists; correctly ticks and reschedules.
- Stopped/deleted rooms do not enqueue further ticks.
- Unit tests: tick handler, reschedule logic, deduplication, stopped-room skip.
- Integration tests: multiple rooms tick independently.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5: Add RPC handler for job queue introspection

**Agent:** coder
**Risk:** Low
**Dependencies:** Task 1

**Description:**

Expose `job_queue` data via RPC so the frontend (and future UI) can observe background task status. This enables operators and developers to see what is running without needing direct DB access.

**RPC methods to add** (in a new or existing rpc-handlers file):

| Method | Params | Returns |
|--------|--------|---------|
| `jobs.list` | `{ queue?: string; status?: string; limit?: number }` | `Job[]` |
| `jobs.get` | `{ jobId: string }` | `Job \| null` |
| `jobs.countByStatus` | `{ queue: string }` | `Record<status, number>` |

Wire these handlers in `setupRPCHandlers()` using the `jobQueue` from context.

**Acceptance criteria:**
- `jobs.list`, `jobs.get`, and `jobs.countByStatus` RPC methods are registered and return correct data.
- Unit tests for each RPC handler.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task Dependencies

```
Task 1 (Wire processor to app.ts)
  └── Task 2 (Handler infra + cleanup handler)
        ├── Task 3 (GitHub polling migration)
        └── Task 4 (Room runtime tick migration)
  └── Task 5 (RPC introspection) [independent of 2/3/4]
```

Tasks 3 and 4 are independent of each other and can run in parallel after Task 2 completes. Task 5 can start as soon as Task 1 is done.

## Testing Strategy

- All tasks: unit tests with in-memory SQLite DB.
- Tasks 3 & 4: integration tests verifying the full job dispatch → execution → reschedule cycle.
- Task 4: load test verifying no duplicate ticks under concurrent job dispatch.

## Rollback Plan

Each task is independently reversible:
- Task 1: Remove processor/jobQueue from `app.ts`.
- Task 2: Delete handler files.
- Task 3: Restore `setInterval` in `GitHubPollingService`; delete `github_poll` jobs.
- Task 4: Restore `setInterval` in `RoomRuntime`; delete `room_tick` jobs.
- Task 5: Unregister RPC handlers.
