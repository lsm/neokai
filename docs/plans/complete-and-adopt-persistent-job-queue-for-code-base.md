# Plan: Complete and Adopt Persistent Job Queue for Code Base

## Goal

Replace all in-memory job scheduling in the NeoKai daemon with the existing database-backed
`JobQueueProcessor` / `JobQueueRepository` infrastructure. This improves reliability: task
dispatch and goal orchestration survive daemon restarts without requiring manual recovery.

## Background

The persistent job queue (`packages/daemon/src/storage/`) is fully implemented but **dormant** —
no code calls `enqueue()` or starts `JobQueueProcessor`. The primary in-memory scheduling
lives in:

1. `RoomRuntime` — `setInterval`-driven 30s tick + `queueMicrotask(() => this.tick())` in
   `scheduleTick()`. Both are lost on crash.
2. `RoomRuntimeService.subscribeToEvents()` — in-memory DaemonHub subscriptions that call
   `runtime.onGoalCreated()` / `runtime.onTaskStatusChanged()` synchronously.

The `MessageQueue` in `lib/agent/message-queue.ts` is a streaming protocol buffer for the
Claude SDK, **not** a job scheduling queue; it is explicitly out of scope.

`GitHubPollingService` (`lib/github/polling-service.ts`) also uses `setInterval`, but it is a
polling-based integration driver, not a job queue. It is intentionally deferred from this plan.

## Missing Scheduling Paths (Identified During Review)

Beyond the main tick mechanism, several task creation paths do not currently trigger dispatch:

1. **`task.create` RPC**: emits `room.overview` only, not `room.task.update`. Tasks created
   directly as `pending` (e.g., by planner-tools) never trigger the `room.task.update` event.
2. **`goal.reactivate` RPC**: emits `goal.updated` (not `goal.created`). Reactivated goals
   would not enqueue a planning job under a `goal.created`-only subscription.
3. **Dependency unlock**: when a task completes, its dependents become eligible but the current
   `scheduleTick()` may not fire if no active session triggers it.

These gaps are addressed in Task 3 of this plan.

## Target Architecture

```
createDaemonApp()
  ├─ JobQueueProcessor (started AFTER all handlers registered)
  │    ├─ queue: 'room.goal.plan'     → planGoalHandler({roomId, goalId})
  │    ├─ queue: 'room.task.execute'  → executeTaskHandler({roomId, taskId})
  │    └─ queue: 'room.tick'          → roomTickHandler({roomId})
  └─ cleanup(): processor.stop() → rpcHandlerCleanup() → sessionManager.cleanup() → db.close()

RoomRuntimeService
  ├─ goal.created / goal.reactivated  → enqueue(room.goal.plan) + processor.tick()
  ├─ room.task.update (pending)       → enqueue(room.task.execute) + processor.tick()
  └─ startup scan: re-enqueue pending goals/tasks not already queued and without active groups

RoomRuntime.scheduleTick()
  └─ enqueue(room.tick, {roomId}) + processor.tick()  [replaces queueMicrotask]

RoomRuntime.tick()
  └─ dispatches task/goal work directly (unchanged)
```

**Queue design**: All queues use a single name (`room.tick`, `room.task.execute`,
`room.goal.plan`) with `roomId` / `taskId` / `goalId` in the job payload. This avoids
per-room handler registration, which the processor's static handler model does not support
(no `unregister()` API) and which would accumulate handlers indefinitely as rooms are created.

**Immediate wake-up**: After every `enqueue()` call, `processor.tick()` is called inline to
trigger near-zero-latency dispatch (eliminating the up-to-500ms polling lag).

**Deduplication**: Before enqueueing, a `listJobs` check filters duplicates. This is best-effort
in the single-process model (no DB-level unique constraint). Bun's single-threaded event loop
makes TOCTOU races very unlikely in practice. Acceptable for the current deployment model.

---

## Tasks

### Task 1 — Wire `JobQueueProcessor` into `DaemonApp` (foundation)

**Agent**: coder
**Dependencies**: none
**Branch**: `feature/job-queue-init`

#### What to do

1. In `packages/daemon/src/storage/index.ts`, verify `JobQueueProcessor`, `JobQueueRepository`,
   and all their types are exported. Add any missing exports.

2. Add `jobQueueProcessor: JobQueueProcessor` and `jobQueueRepo: JobQueueRepository` to the
   `RPCHandlerDependencies` interface in `packages/daemon/src/lib/rpc-handlers/index.ts`.

3. In `packages/daemon/src/app.ts` (`createDaemonApp`):
   - After `db.initialize()`, create the processor:
     ```ts
     const jobQueueRepo = db.getJobQueueRepo();
     const jobQueueProcessor = new JobQueueProcessor(jobQueueRepo, {
       pollIntervalMs: 500,
       maxConcurrent: 5,
     });
     jobQueueProcessor.setChangeNotifier((table) => reactiveDb.notifyChange(table));
     ```
   - Pass `jobQueueProcessor` and `jobQueueRepo` to `setupRPCHandlers(...)`.
   - **Do NOT call `processor.start()` here** — it must be called only after all handlers are
     registered (done in Task 2 after `RoomRuntimeService.start()` resolves).
   - Add `jobQueueProcessor` and `jobQueueRepo` to `DaemonAppContext`.

4. Daily cleanup timer — assign to variable, clear in `cleanup()`:
   ```ts
   const jobCleanupTimer = setInterval(
     () => jobQueueRepo.cleanup(Date.now() - 7 * 24 * 60 * 60 * 1000),
     24 * 60 * 60 * 1000
   );
   // In cleanup(): clearInterval(jobCleanupTimer);
   ```

5. Explicit cleanup order in `cleanup()`:
   ```ts
   // 1. Stop job queue processor (drains in-flight jobs, no new work)
   await jobQueueProcessor.stop();
   // 2. Clear cleanup timer
   clearInterval(jobCleanupTimer);
   // 3. Stop RPC handlers (includes RoomRuntimeService.stop())
   rpcHandlerCleanup();
   // 4. Stop GitHub service
   if (gitHubService) gitHubService.stop();
   // 5. Stop agent sessions
   await sessionManager.cleanup();
   // 6. Close database (must be last — processor and runtime are stopped)
   db.close();
   ```

#### Acceptance criteria

- `createDaemonApp` returns `jobQueueProcessor` and `jobQueueRepo` in `DaemonAppContext`.
- Processor is NOT started in this task (started in Task 2 after handlers registered).
- Cleanup order is: `processor.stop()` → `clearInterval(timer)` → `rpcHandlerCleanup()` →
  `sessionManager.cleanup()` → `db.close()`.
- Daily cleanup timer is assigned to a variable and cleared in `cleanup()`.
- `bun run typecheck && bun run lint && make test:daemon` pass with no regressions.
- Unit tests: processor instantiated with correct options, change notifier wired, cleanup order
  verified via spies, cleanup timer cleared on shutdown.
- Changes on branch `feature/job-queue-init` with PR created via `gh pr create` targeting `dev`.

---

### Task 2 — Migrate `RoomRuntimeService` + `RoomRuntime` to persistent job queue (atomic migration)

**Agent**: coder
**Dependencies**: Task 1
**Branch**: `feature/room-runtime-job-queue`

> Tasks 2 (service-level dispatch) and 3 (scheduleTick replacement) from the original plan are
> combined here. Merging them as separate PRs would land an intermediate state where jobs are
> enqueued but their handlers call `queueMicrotask` internally, undermining durability end-to-end.

#### What to do

**A. Update `RoomRuntimeServiceConfig`**

Add `jobQueueProcessor: JobQueueProcessor` and `jobQueueRepo: JobQueueRepository` to the
config interface. Update `setupRPCHandlers` in `rpc-handlers/index.ts` to pass these from
`RPCHandlerDependencies`.

**B. Await `RoomRuntimeService.start()` and start processor after**

In `rpc-handlers/index.ts`, change the non-awaited `roomRuntimeService.start().catch(...)` to
be properly awaited. Because `setupRPCHandlers` currently returns a cleanup function (sync),
this requires returning a `{ cleanup, ready: Promise<void> }` shape, or making the caller
(`createDaemonApp`) await a separate `init` method. Then call `jobQueueProcessor.start()` in
`app.ts` after `roomRuntimeService.start()` has resolved.

**C. Register job handlers in `RoomRuntimeService.start()`**

Register before calling `processor.start()`:

```ts
// Plan a goal
this.ctx.jobQueueProcessor.register('room.goal.plan', async (job) => {
  const { roomId, goalId } = job.payload as { roomId: string; goalId: string };
  const runtime = this.runtimes.get(roomId);
  if (!runtime || runtime.getState() !== 'running') return;
  await runtime.onGoalCreated(goalId);
});

// Execute a specific task
this.ctx.jobQueueProcessor.register('room.task.execute', async (job) => {
  const { roomId, taskId } = job.payload as { roomId: string; taskId: string };
  const runtime = this.runtimes.get(roomId);
  if (!runtime || runtime.getState() !== 'running') return;

  if (runtime.isAtCapacity()) {
    // Re-enqueue with short delay; return without error (job completes successfully)
    this.ctx.jobQueueRepo.enqueue({
      queue: 'room.task.execute',
      payload: { roomId, taskId },
      runAt: Date.now() + 1000,
      maxRetries: 0,
    });
    return;
  }

  try {
    await runtime.dispatchTask(taskId);
  } catch (err) {
    // Explicitly fail the task so it is not stranded in 'pending' forever
    const taskManager = new TaskManager(this.ctx.db.getDatabase(), roomId);
    const msg = err instanceof Error ? err.message : String(err);
    const failed = await taskManager.failTask(taskId, msg);
    void this.ctx.daemonHub.emit('room.task.update', {
      sessionId: `room:${roomId}`,
      roomId,
      task: failed,
    });
    throw err; // propagate so processor marks job as dead (maxRetries: 0)
  }
});

// Room-level tick
this.ctx.jobQueueProcessor.register('room.tick', async (job) => {
  const { roomId } = job.payload as { roomId: string };
  const runtime = this.runtimes.get(roomId);
  if (!runtime || runtime.getState() !== 'running') return;
  await runtime.tick();
});
```

**D. Add `isAtCapacity()` and `dispatchTask()` to `RoomRuntime`**

- `isAtCapacity(): boolean` — returns true when active session groups >= `maxConcurrentGroups`.
- `dispatchTask(taskId: string): Promise<void>` — extracts per-task dispatch logic from the
  existing `tick()` loop into a targeted method. `tick()` continues to work by calling
  `dispatchTask()` internally for each eligible task.

**E. Replace event subscriptions in `subscribeToEvents()`**

Replace direct `runtime.onGoalCreated()` / `runtime.onTaskStatusChanged()` calls with job
enqueues + immediate `processor.tick()`:

```ts
// goal.created → enqueue planning job
this.ctx.daemonHub.on('goal.created', (event) => {
  if (this.isDuplicateJob('room.goal.plan', { goalId: event.goalId })) return;
  this.ctx.jobQueueRepo.enqueue({
    queue: 'room.goal.plan',
    payload: { roomId: event.roomId, goalId: event.goalId },
    maxRetries: 1,
  });
  void this.ctx.jobQueueProcessor.tick();
});

// room.task.update (pending) → enqueue execution job
this.ctx.daemonHub.on('room.task.update', (event) => {
  if (event.task.status !== 'pending') return;
  if (this.isDuplicateJob('room.task.execute', { taskId: event.task.id })) return;
  this.ctx.jobQueueRepo.enqueue({
    queue: 'room.task.execute',
    payload: { roomId: event.roomId, taskId: event.task.id },
    maxRetries: 0,
  });
  void this.ctx.jobQueueProcessor.tick();
});
```

`isDuplicateJob(queue, keyPayload)` — private helper that calls `listJobs` for pending and
processing statuses and checks for payload key match. Document as best-effort (single-process,
event-loop-safe).

**F. Replace `scheduleTick()` in `RoomRuntime`**

```ts
private scheduleTick(): void {
  if (this.state !== 'running') return;
  if (!this.jobQueueRepo) {
    // Fallback for test contexts without job queue wiring
    queueMicrotask(() => this.tick());
    return;
  }
  if (this.isDuplicateTickJob()) return;  // dedup check
  this.jobQueueRepo.enqueue({
    queue: 'room.tick',
    payload: { roomId: this.room.id },
    maxRetries: 0,
  });
  void this.jobQueueProcessor?.tick();
}
```

Add optional `jobQueueRepo?: JobQueueRepository` and `jobQueueProcessor?: JobQueueProcessor`
to `RoomRuntimeConfig` (preserves testability without full job queue setup).

The existing `setInterval` periodic safety net remains (30s), but its role is reduced to a
secondary fallback. Explicitly keep it for crash-recovery edge cases.

**G. Startup recovery in `initializeExistingRooms()`**

After `recoverRoomRuntime()` for each room:

1. Get active session groups via `groupRepo.getActiveGroups(roomId)` — collect task IDs with
   active groups (already being processed, skip them).
2. For each `pending` task NOT in the active-group set and with no existing pending/processing
   `room.task.execute` job: enqueue `room.task.execute`.
3. For each `active` goal with no active planning group and no pending/processing
   `room.goal.plan` job: enqueue `room.goal.plan`.
4. Call `processor.tick()` once after all startup enqueues.

#### Acceptance criteria

- `goal.created` event enqueues `room.goal.plan` job instead of calling `onGoalCreated` directly.
- `room.task.update` (pending) enqueues `room.task.execute` with `maxRetries: 0`.
- `scheduleTick()` enqueues `room.tick` + calls `processor.tick()` (replaces `queueMicrotask`).
- Duplicate events for same `goalId`/`taskId` (pending job exists) produce no additional job.
- `room.task.execute` handler re-enqueues with 1s delay when at capacity (no error thrown).
- `room.task.execute` handler failure explicitly transitions task to `failed` and emits event.
- Startup recovery skips tasks with active session groups; enqueues jobs for orphaned tasks.
- Processor is started only after `RoomRuntimeService.start()` resolves and handlers are registered.
- `bun run typecheck && bun run lint && make test:daemon` pass.
- Unit tests for: handler registration, each event subscription, capacity re-enqueue, task
  failure path, startup recovery (with/without active groups), dedup guard, `scheduleTick` path.
- Online tests: goal → job → `onGoalCreated` invoked; pending task → job → group dispatched.
- Changes on branch `feature/room-runtime-job-queue` with PR via `gh pr create` targeting `dev`.

---

### Task 3 — Fix missing scheduling triggers

**Agent**: coder
**Dependencies**: Task 2
**Branch**: `feature/job-queue-missing-triggers`

#### What to do

**A. `task.create` RPC (`packages/daemon/src/lib/rpc-handlers/task-handlers.ts`)**

After creating a task with `status: 'pending'`, emit `room.task.update` so the subscription
in `RoomRuntimeService` enqueues an execution job:

```ts
// Existing: emits room.overview for all new tasks
// Add: emit room.task.update if status is 'pending'
if (task.status === 'pending') {
  void emitTaskUpdate(deps.daemonHub, roomId, task);
}
```

Tasks created as `draft` must NOT emit `room.task.update` (only `room.overview` as today).

**B. `goal.reactivate` RPC (`packages/daemon/src/lib/rpc-handlers/goal-handlers.ts`)**

After reactivating a goal, emit `goal.created` so the existing `RoomRuntimeService` subscription
triggers a planning job:

```ts
void deps.daemonHub.emit('goal.created', {
  sessionId: `room:${roomId}`,
  roomId,
  goalId: goal.id,
});
```

**C. Dependency unlock in `RoomRuntime`**

After a task transitions to `completed`, call a new helper
`enqueueUnblockedDependents(completedTaskId)`:

1. List all `pending` tasks in the room with `dependsOn` containing `completedTaskId`.
2. For each: call `areDependenciesMet()`. If true and no active group or queued job exists,
   enqueue `room.task.execute` + call `processor.tick()`.

Wire this helper into the task completion path in `RoomRuntime` (after `completeTask()` calls).

#### Acceptance criteria

- Task created via `task.create` with `status: 'pending'` triggers `room.task.execute` job.
- Task created with `status: 'draft'` does NOT trigger execution job.
- Goal reactivated via `goal.reactivate` triggers `room.goal.plan` job.
- Completing task A enqueues `room.task.execute` for dependent task B iff all of B's deps met.
- `bun run typecheck && bun run lint && make test:daemon` pass.
- Unit tests for each of the three trigger paths.
- Changes on branch `feature/job-queue-missing-triggers` with PR via `gh pr create` targeting `dev`.

---

### Task 4 — Add job queue monitoring RPC handlers

**Agent**: coder
**Dependencies**: Task 1 (can run in parallel with Tasks 2–3)
**Branch**: `feature/job-queue-rpc`

#### What to do

1. Create `packages/daemon/src/lib/rpc-handlers/job-queue-handlers.ts`:
   - `job_queue.list` — params: `{ queue?: string, status?: JobStatus, limit?: number }` →
     returns `Job[]` via `jobQueueRepo.listJobs(...)`.
   - `job_queue.stats` — params: `{ queue: string }` → returns counts per status via
     `jobQueueRepo.countByStatus(queue)`.

2. Add `setupJobQueueHandlers(messageHub, jobQueueRepo)` call in `rpc-handlers/index.ts`.

#### Acceptance criteria

- `job_queue.list` returns jobs filtered by queue/status/limit correctly.
- `job_queue.stats` returns correct status counts for the given queue.
- `bun run typecheck && bun run lint && make test:daemon` pass.
- Unit tests for both handlers.
- Changes on branch `feature/job-queue-rpc` with PR via `gh pr create` targeting `dev`.

---

### Task 5 — Comprehensive integration tests for job queue

**Agent**: coder
**Dependencies**: Tasks 2, 3
**Branch**: `feature/job-queue-integration-tests`

> Note: `tests/unit/storage/job-queue-repository.test.ts` and `job-queue-processor.test.ts`
> already provide comprehensive coverage of the base infrastructure. This task focuses only on
> the new integration behavior introduced in Tasks 2 and 3.

#### What to do

1. Add `packages/daemon/tests/unit/room/job-queue-integration.test.ts`:
   - Startup recovery: orphaned `pending` task (no active group, no queued job) → verify
     `room.task.execute` job enqueued after `initializeExistingRooms()`.
   - Startup recovery: `pending` task WITH active group → verify no duplicate job enqueued.
   - Dedup: `goal.created` emitted twice for same `goalId` → only one queued job.
   - Capacity re-enqueue: handler called when at capacity → task stays `pending`, new job
     scheduled with `runAt > Date.now()`.
   - Task failure propagation: handler throws → task transitions to `failed`, `room.task.update`
     emitted.
   - Dependency unlock: task A completes → dependent task B job enqueued (deps met).
   - Dependency unlock: task A completes → B NOT enqueued when B has another unmet dep C.

2. Add `packages/daemon/tests/online/room-job-queue.test.ts` (mock SDK):
   - Goal created → `room.goal.plan` job enqueued → handler invoked → `onGoalCreated` called.
   - Task made pending → `room.task.execute` job → `dispatchTask` called.
   - Stale job reclaim: inject a `processing` job with old `started_at` → verify `reclaimStale`
     returns it to `pending` and it is processed on next tick.

3. Verify `bun run typecheck && bun run lint && make test:daemon` pass with no regressions.

#### Acceptance criteria

- All new unit tests in `tests/unit/room/job-queue-integration.test.ts` pass.
- All new online tests in `tests/online/room-job-queue.test.ts` pass (mock SDK).
- `bun run typecheck && bun run lint && make test:daemon` pass with no regressions.
- Changes on branch `feature/job-queue-integration-tests` with PR via `gh pr create` targeting `dev`.

---

## Task Dependencies

```
Task 1 (Wire processor, shutdown ordering, cleanup timer)
  ├─ Task 2 (Atomic migration: RoomRuntimeService + RoomRuntime)
  │       └─ Task 3 (Missing triggers: task.create, goal.reactivate, dep unlock)
  │                       └─ Task 5 (Integration tests)
  └─ Task 4 (Monitoring RPC) ← parallel with Tasks 2–3
```

---

## Key Files

| File | Role |
|------|------|
| `packages/daemon/src/app.ts` | DaemonApp factory — processor, shutdown order (Task 1) |
| `packages/daemon/src/lib/rpc-handlers/index.ts` | `RPCHandlerDependencies`, await start (Tasks 1, 2) |
| `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` | Handler registration, subscriptions, startup scan (Task 2) |
| `packages/daemon/src/lib/room/runtime/room-runtime.ts` | `scheduleTick`, `dispatchTask`, `isAtCapacity` (Task 2) |
| `packages/daemon/src/lib/rpc-handlers/task-handlers.ts` | `task.create` emit fix (Task 3) |
| `packages/daemon/src/lib/rpc-handlers/goal-handlers.ts` | `goal.reactivate` emit fix (Task 3) |
| `packages/daemon/src/lib/rpc-handlers/job-queue-handlers.ts` | New monitoring RPC (Task 4) |
| `packages/daemon/tests/unit/room/job-queue-integration.test.ts` | New integration unit tests (Task 5) |
| `packages/daemon/tests/online/room-job-queue.test.ts` | New online tests (Task 5) |

---

## Design Notes and Constraints

- **Processor start timing**: `processor.start()` must be called only after `RoomRuntimeService.start()`
  resolves (handlers must be registered before polling begins). In `rpc-handlers/index.ts`,
  `roomRuntimeService.start()` is currently not awaited. Task 2 must fix this.

- **`maxRetries` at enqueue sites**:
  - `room.goal.plan`: `maxRetries: 1` (one retry with backoff; planning is idempotent).
  - `room.task.execute`: `maxRetries: 0` (fail immediately; handler explicitly fails the task).
  - `room.tick`: `maxRetries: 0` (idempotent; next tick recovers).

- **`setInterval` fallback**: the existing 30s periodic tick in `RoomRuntime` is retained as a
  secondary safety net. Its role is reduced (primary path is now job queue), but it provides
  a last resort for edge cases the job queue might miss.

- **No E2E tests required**: this plan has no UI changes. All testing is unit + online.

- **Code style**: no `console.*` in application code (use `Logger`). All new code must pass
  `bun run lint && bun run typecheck`.
