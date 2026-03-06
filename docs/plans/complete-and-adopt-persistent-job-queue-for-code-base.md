# Plan: Complete and Adopt Persistent Job Queue for Code Base

## Goal

Replace all in-memory job scheduling in the NeoKai daemon with the existing database-backed
`JobQueueProcessor` / `JobQueueRepository` infrastructure. This improves system reliability:
task dispatch and goal orchestration survive daemon restarts without manual recovery.

## Background

The persistent job queue (`packages/daemon/src/storage/`) is fully implemented but **dormant** —
no code calls `enqueue()` or starts the `JobQueueProcessor`. The primary in-memory scheduling
lives in `RoomRuntime` (a `setInterval`-driven tick + in-memory flags) and
`RoomRuntimeService` (in-memory event subscriptions that trigger immediate dispatch).

The `MessageQueue` in `lib/agent/message-queue.ts` is a streaming protocol queue used by the
Claude SDK, **not** a job scheduling queue; it is out of scope for this plan.

## Current Architecture

```
RoomRuntimeService
  └─ subscribeToEvents()           ← in-memory DaemonHub subscriptions
       ├─ goal.created  → createOrGetRuntime(room)
       └─ room.task.update → runtime.onTaskStatusChanged(taskId)

RoomRuntime
  ├─ setInterval(tick, 30s)        ← in-memory timer (lost on crash)
  ├─ scheduleTick()                ← in-memory "debounce" flag (lost on crash)
  └─ tick()
       ├─ find goals needing planning → spawnPlanningGroup(goalId)
       └─ find pending tasks          → spawnExecutionGroup(taskId)
```

If the daemon crashes between "task becomes pending" and "session group is spawned", the task
stays `pending` with no active group until the next restart + recovery scan (30s polling gap).

## Target Architecture

```
createDaemonApp()
  └─ JobQueueProcessor (wired, started, gracefully stopped)
       ├─ queue: 'room.goal.plan'   → planGoalHandler(job)
       └─ queue: 'room.task.execute' → executeTaskHandler(job)

RoomRuntimeService
  ├─ goal.created  → jobRepo.enqueue({queue:'room.goal.plan', payload:{roomId, goalId}})
  ├─ room.task.update (→ pending) → jobRepo.enqueue({queue:'room.task.execute', ...})
  └─ startup: scan pending goals/tasks, enqueue missing jobs (idempotent)

RoomRuntime
  ├─ scheduleTick() → jobRepo.enqueue({queue:'room.tick.{roomId}', ...}) [dedup]
  └─ fallback setInterval stays as safety net (30s), but primary path is job queue
```

---

## Tasks

### Task 1 — Wire `JobQueueProcessor` into `DaemonApp` (foundation)

**Agent**: coder
**Dependencies**: none
**Branch**: `feature/job-queue-init`

#### What to do

1. In `packages/daemon/src/app.ts` (`createDaemonApp`):
   - Import `JobQueueProcessor` from `./storage`.
   - After `reactiveDb` is created, instantiate:
     ```ts
     const jobQueueProcessor = new JobQueueProcessor(db.getJobQueueRepo(), {
       pollIntervalMs: 500,
       maxConcurrent: 5,
     });
     jobQueueProcessor.setChangeNotifier((table) => reactiveDb.notifyChange(table));
     ```
   - Start the processor after all services are initialized (before returning context).
   - In the `cleanup()` function, call `await jobQueueProcessor.stop()` before closing the DB.

2. Add `jobQueueProcessor: JobQueueProcessor` to the `DaemonAppContext` interface so downstream
   services can register handlers.

3. Export `JobQueueProcessor` and related types cleanly from `packages/daemon/src/storage/index.ts`
   (verify they are already exported; add if missing).

#### Acceptance criteria

- `createDaemonApp` returns a `jobQueueProcessor` in context.
- Processor starts on daemon startup and stops gracefully on shutdown.
- No regressions in existing unit tests.
- Unit tests covering: processor is started, change notifier is wired, cleanup stops processor.
- Changes on branch `feature/job-queue-init` with PR created via `gh pr create` targeting `dev`.

---

### Task 2 — Adopt job queue in `RoomRuntimeService` for goal/task dispatch

**Agent**: coder
**Dependencies**: Task 1
**Branch**: `feature/room-runtime-job-queue`

#### What to do

1. Update `RoomRuntimeServiceConfig` to accept `jobQueueProcessor: JobQueueProcessor` and
   `jobQueueRepo: JobQueueRepository`.

2. In `RoomRuntimeService.start()`, register two job handlers on the processor:
   - `room.goal.plan` — payload: `{ roomId, goalId }` → calls
     `runtime.onGoalCreated(goalId)` (or the internal planning dispatch).
   - `room.task.execute` — payload: `{ roomId, taskId }` → calls the existing pending-task
     dispatch logic inside `RoomRuntime.tick()` scoped to that task.

3. Replace direct in-memory dispatch calls in `subscribeToEvents()`:
   - `goal.created` handler → `jobQueueRepo.enqueue({ queue: 'room.goal.plan', ... })` instead
     of calling `runtime.onGoalCreated()` directly.
   - `room.task.update` handler (when status becomes `pending`) → enqueue
     `room.task.execute` job.

4. In `initializeExistingRooms()` (startup recovery), after `recoverRoomRuntime()` completes,
   scan for any `pending` tasks and `goals` with no active group that have no pending/processing
   job in the queue, and enqueue them (idempotent guard: check
   `jobRepo.listJobs({queue, status:'pending'})` before enqueuing).

5. Implement deduplication: before enqueuing a job, check whether a `pending` or `processing`
   job with the same payload key (`goalId` / `taskId`) already exists. If yes, skip.

6. Update `RoomRuntimeService.stop()` to not stop the processor (owned by `DaemonApp`).

7. Wire `RoomRuntimeService` in the app / `setupRPCHandlers` with the new config fields.

#### Acceptance criteria

- A goal created while the daemon is running enqueues a `room.goal.plan` job instead of
  calling `onGoalCreated` directly.
- A task transitioning to `pending` enqueues a `room.task.execute` job.
- On startup with pre-existing pending tasks, jobs are re-enqueued so tasks proceed without
  waiting for a manual trigger.
- Deduplication works: creating the same goal twice results in only one queued job.
- Unit tests covering: handler registration, goal enqueue, task enqueue, startup recovery,
  deduplication guard.
- Online tests: end-to-end job processing with real database (mock SDK).
- Changes on branch `feature/room-runtime-job-queue` with PR via `gh pr create` targeting `dev`.

---

### Task 3 — Replace `RoomRuntime` in-memory tick scheduling with job queue ticks

**Agent**: coder
**Dependencies**: Task 2
**Branch**: `feature/room-runtime-tick-job`

#### What to do

1. Pass `jobQueueRepo: JobQueueRepository` to `RoomRuntimeConfig`.

2. Modify `RoomRuntime.scheduleTick()`:
   - Enqueue a `room.tick.{roomId}` job **only if** no pending/processing job exists for that
     queue (dedup by checking `listJobs`).
   - Keep `tickQueued` flag as an in-memory fast-path dedup guard to avoid a DB round-trip on
     every call.

3. Register a handler for `room.tick.{roomId}` in `RoomRuntimeService` that calls
   `runtime.tick()`.

4. Keep the `setInterval` fallback at 30s as a safety net but reduce the tick interval from
   30s to 60s (or remove it — evaluate based on whether job queue polling covers recovery).

5. Update `RoomRuntime.stop()` to avoid scheduling ticks after stop.

#### Acceptance criteria

- Calling `scheduleTick()` enqueues at most one pending tick job (deduplication).
- A daemon restart with a pending tick job processes it within `pollIntervalMs` (500ms).
- Existing tick behavior is preserved (goals planned, tasks dispatched correctly).
- Unit tests: dedup guard, tick job enqueue, tick job handler.
- Changes on branch `feature/room-runtime-tick-job` with PR via `gh pr create` targeting `dev`.

---

### Task 4 — Add job queue monitoring RPC handlers

**Agent**: coder
**Dependencies**: Task 1
**Branch**: `feature/job-queue-rpc`

#### What to do

1. Add two RPC handlers in `packages/daemon/src/lib/rpc-handlers/`:
   - `job_queue.list` — params: `{ queue?: string, status?: JobStatus, limit?: number }` →
     returns `Job[]` via `jobQueueRepo.listJobs(...)`.
   - `job_queue.stats` — params: `{ queue: string }` → returns counts per status via
     `jobQueueRepo.countByStatus(queue)`.

2. Register these handlers in `setupRPCHandlers` (receive `jobQueueRepo` via the handler
   setup context).

3. Add shared types for `Job`, `JobStatus` to `@neokai/shared` if needed for frontend use
   (if not needed by frontend yet, keep in daemon only and export via `DaemonAppContext`).

4. Wire periodic cleanup: in `app.ts`, after processor starts, schedule a daily cleanup via
   `setInterval(() => db.getJobQueueRepo().cleanup(Date.now() - 7 * 24 * 60 * 60 * 1000), 86400_000)`.

#### Acceptance criteria

- `job_queue.list` returns correct jobs filtered by queue/status.
- `job_queue.stats` returns correct counts per status.
- Periodic cleanup removes old completed/dead jobs.
- Unit tests for both RPC handlers and cleanup logic.
- Changes on branch `feature/job-queue-rpc` with PR via `gh pr create` targeting `dev`.

---

### Task 5 — Online integration tests for end-to-end job queue lifecycle

**Agent**: coder
**Dependencies**: Tasks 2, 3
**Branch**: `feature/job-queue-integration-tests`

#### What to do

1. In `packages/daemon/tests/online/`, add `job-queue-integration.test.ts`:
   - Test: goal created → job enqueued → handler called → session group spawned.
   - Test: task made pending → execute job enqueued → handler called.
   - Test: daemon restart simulation (stop processor, re-scan DB, restart processor) →
     orphaned pending task jobs are re-enqueued and processed.
   - Test: deduplication — enqueue same task twice → only one job processed.
   - Test: `reclaimStale` — mock a stale processing job → verify it is reclaimed and
     re-processed.

2. Add unit tests in `packages/daemon/tests/unit/` for:
   - `JobQueueRepository`: enqueue, dequeue, complete, fail (retry + dead), reclaimStale,
     cleanup, listJobs, countByStatus.
   - `JobQueueProcessor`: start/stop, tick dequeues and processes, stale check interval,
     concurrent limit.
   - These may already exist — check and extend coverage.

#### Acceptance criteria

- All online tests pass with `NEOKAI_TEST_ONLINE=true` (mock SDK by default).
- All new unit tests pass with `bun test`.
- No regressions in existing test suite (`make test:daemon`).
- Changes on branch `feature/job-queue-integration-tests` with PR via `gh pr create` targeting `dev`.

---

## Task Dependencies

```
Task 1 (Wire processor in app.ts)
  └─ Task 2 (RoomRuntimeService job adoption)
       └─ Task 3 (Tick scheduling via job queue)
            └─ Task 5 (Integration tests)
  └─ Task 4 (Monitoring RPC) — can run in parallel with Task 2
```

Tasks 2 and 4 can start in parallel after Task 1 completes.
Task 3 starts after Task 2 completes.
Task 5 starts after Tasks 2 and 3 complete.

## Key Files

| File | Role |
|------|------|
| `packages/daemon/src/app.ts` | DaemonApp factory — wire processor here (Task 1) |
| `packages/daemon/src/storage/job-queue-processor.ts` | Processor implementation |
| `packages/daemon/src/storage/repositories/job-queue-repository.ts` | DB repository |
| `packages/daemon/src/storage/index.ts` | Storage exports |
| `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` | Service to modify (Tasks 2, 3) |
| `packages/daemon/src/lib/room/runtime/room-runtime.ts` | Runtime to modify (Task 3) |
| `packages/daemon/src/lib/rpc-handlers/` | RPC layer (Task 4) |
| `packages/daemon/tests/online/` | Online tests (Task 5) |
| `packages/daemon/tests/unit/` | Unit tests (all tasks) |

## Notes

- The `MessageQueue` in `lib/agent/message-queue.ts` is a streaming protocol buffer for the
  Claude SDK, not a job scheduling queue. It is **out of scope** for this plan.
- `maxRetries` for `room.task.execute` jobs should be set to `0` — task dispatch failures
  should fail the task immediately rather than silently retrying.
- For `room.goal.plan` jobs, `maxRetries: 1` with a short delay is reasonable.
- All new code must follow the project code style (Biome, Oxlint, no `console.*` in app code).
- All changes require unit tests and, where appropriate, online tests.
- No E2E tests are required for this plan (no UI changes).
