# Milestone 4: Migrate Room Runtime Tick

## Goal

Replace the `setInterval`-based tick loop in `RoomRuntime` with job-based tick scheduling. This is the highest-risk migration because room runtime manages agent session execution. The approach preserves the existing tick mutex as defense-in-depth alongside job-level deduplication.

## Scope

- Create `room-tick.handler.ts` job handler
- Create `RoomTickScheduler` class for managing per-room tick job lifecycle
- Refactor `RoomRuntime` to remove `setInterval` and accept external tick triggering
- Wire scheduler into `RoomRuntimeService`
- Register handler in `register-handlers.ts`
- Unit and online tests with concurrency validation

## Tasks

### Task 4.1: Create RoomTickScheduler and room tick handler

**Description:** Create the `RoomTickScheduler` that manages per-room tick job scheduling with deduplication, and the `room-tick.handler.ts` that invokes `RoomRuntime.tick()` and reschedules via the scheduler.

**Agent type:** coder

**Depends on:** Task 2.1

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/src/lib/job-handlers/room-tick-scheduler.ts`:
   - `RoomTickScheduler` class with constructor accepting `jobQueue: JobQueueRepository`.
   - `scheduleForRoom(roomId: string, delayMs?: number)`: Check for existing pending/processing `room_tick` job for this `roomId` (query `jobQueue.listJobs({ queue: 'room_tick', status: 'pending' })` and filter by `payload.roomId`). If none, enqueue. Default delay: 30000ms.
   - `cancelForRoom(roomId: string)`: No direct cancel needed (jobs expire naturally), but track state so `scheduleForRoom` can be called after room stops/restarts.
   - `scheduleImmediate(roomId: string)`: Enqueue with `runAt: Date.now()` for event-driven ticks (goal created, task status changed).
   - Private `hasPendingJob(roomId: string): boolean` helper to check for existing pending job.
3. Create `packages/daemon/src/lib/job-handlers/room-tick.handler.ts`:
   - `createRoomTickHandler(getRuntimeService: () => RoomRuntimeService, scheduler: RoomTickScheduler): JobHandler`
   - Note: use a getter function for `RoomRuntimeService` to break circular dependency (handler is registered before runtime service starts).
   - Handler extracts `roomId` from `job.payload`.
   - Gets runtime via `getRuntimeService().getRuntime(roomId)`.
   - If runtime exists and state is `'running'`: call `await runtime.tick()`, then `scheduler.scheduleForRoom(roomId)` to reschedule.
   - If runtime not found or not running: return `{ skipped: true, reason }` (do NOT reschedule).
   - Returns `{ roomId, ticked: true/false }`.
4. Add unit tests at `packages/daemon/tests/unit/job-handlers/room-tick-scheduler.test.ts`:
   - Test `scheduleForRoom` enqueues a job.
   - Test `scheduleForRoom` does NOT enqueue duplicate if pending job exists.
   - Test `scheduleImmediate` enqueues with `runAt: Date.now()`.
5. Add unit tests at `packages/daemon/tests/unit/job-handlers/room-tick-handler.test.ts`:
   - Test handler calls `runtime.tick()` and reschedules.
   - Test handler skips when runtime not found.
   - Test handler skips when runtime is paused/stopped (does not reschedule).
6. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- `RoomTickScheduler` prevents duplicate pending jobs per room.
- Handler calls `tick()` and reschedules only for running runtimes.
- Handler gracefully handles missing runtimes.
- Unit tests pass.
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 4.2: Wire room tick handler and remove setInterval from RoomRuntime

**Description:** Register the room tick handler, update `RoomRuntime` to remove its internal `setInterval`, and update `RoomRuntimeService` to use `RoomTickScheduler` for scheduling ticks when runtimes start/stop.

**Agent type:** coder

**Depends on:** Task 4.1

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Update `packages/daemon/src/lib/job-handlers/register-handlers.ts`:
   - Accept `getRuntimeService` getter and `roomTickScheduler` dependencies.
   - Register: `processor.register('room_tick', createRoomTickHandler(getRuntimeService, roomTickScheduler))`.
3. Update `packages/daemon/src/app.ts`:
   - Create `RoomTickScheduler` instance.
   - Pass to `registerJobHandlers()`.
   - The `getRuntimeService` getter must resolve lazily since `RoomRuntimeService` is created in `setupRPCHandlers()`.
4. Update `packages/daemon/src/lib/room/runtime/room-runtime.ts`:
   - Remove `tickTimer` field, `setInterval` in `start()`, and `clearInterval` in `stop()`.
   - Keep the `tick()` method public -- it is now called externally by the job handler.
   - Keep the tick mutex (`tickLocked`/`tickQueued`) as defense-in-depth.
   - Keep `scheduleTick()` method but change it to call a callback/event instead of `queueMicrotask(() => this.tick())`. This callback is set by `RoomRuntimeService` and triggers `scheduler.scheduleImmediate(roomId)`.
   - Add `onScheduleTick?: (roomId: string) => void` config field.
   - Update `scheduleTick()` to: `this.onScheduleTick?.(this.room.id)` (or fall back to `queueMicrotask(() => this.tick())` for backward compatibility during transition).
   - Update `scheduleTickAfterRateLimitReset()` to use `setTimeout` that calls `this.onScheduleTick` (preserving the delay behavior).
5. Update `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`:
   - Accept `RoomTickScheduler` in the config.
   - When creating a `RoomRuntime`, pass `onScheduleTick` callback that calls `scheduler.scheduleImmediate(roomId)`.
   - When a runtime starts (`start()`): call `scheduler.scheduleForRoom(roomId)` to seed the first tick job.
   - When a runtime stops (`stop()`): no action needed (handler will see runtime is stopped and not reschedule).
6. Update event handlers in `RoomRuntime` that currently call `this.scheduleTick()` (goal created, task status changed) -- these should now trigger `this.onScheduleTick?.(this.room.id)` which translates to an immediate job via the scheduler.
7. Update existing room runtime unit tests that mock or verify the tick timer:
   - Remove assertions about `setInterval`/`clearInterval`.
   - Verify `onScheduleTick` callback is invoked in appropriate scenarios.
8. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- `RoomRuntime` no longer uses `setInterval` for ticking.
- Ticks are scheduled via `RoomTickScheduler` through the job queue.
- Event-driven ticks (goal created, task changed) trigger immediate jobs.
- Rate-limit delayed ticks still use `setTimeout` + scheduler callback.
- Tick mutex is preserved as defense-in-depth.
- All existing room runtime tests pass (updated as needed).
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 4.3: Online test for room tick via job queue

**Description:** Add an online integration test verifying room tick jobs are created, processed, and rescheduled correctly when a room runtime is active.

**Agent type:** coder

**Depends on:** Task 4.2

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/tests/online/job-queue/room-tick-lifecycle.test.ts`:
   - Spin up daemon with dev proxy.
   - Create a room via RPC.
   - Create a goal for the room (triggers runtime start).
   - Verify a `room_tick` job appears in the queue.
   - Wait for the tick job to process.
   - Verify the job completed and a new `room_tick` job is pending.
   - Stop the room (delete goal or archive room).
   - Verify no new `room_tick` jobs are scheduled after the existing one processes.
3. Add a concurrency test:
   - Enqueue multiple `room_tick` jobs for the same room manually.
   - Verify the tick mutex prevents concurrent execution (only one tick runs at a time).
4. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- Room tick jobs are created when runtime starts.
- Jobs reschedule while runtime is running.
- Jobs stop rescheduling when runtime stops.
- No concurrent ticks for the same room.
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 4.4: Update existing room runtime tests for job-based ticking

**Description:** Audit and update all existing room runtime unit and online tests to work correctly with the new job-based tick scheduling instead of setInterval. Some tests may directly call `tick()` or rely on timer behavior that has changed.

**Agent type:** coder

**Depends on:** Task 4.2

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Search all test files for references to `tick`, `tickTimer`, `setInterval`, `clearInterval` in the room runtime test directory.
3. For each affected test:
   - If the test directly calls `runtime.tick()`: no change needed (tick is still public).
   - If the test asserts timer creation/cleanup: update to verify `onScheduleTick` callback behavior instead.
   - If the test relies on automatic tick timing: ensure the test either calls `tick()` directly or triggers a job.
4. Run the full test suite: `make test-daemon` and verify all tests pass.
5. Run `bun run check` for lint/type issues.

**Acceptance criteria:**
- All existing room runtime tests pass with the new tick architecture.
- No tests rely on `setInterval` being present in `RoomRuntime`.
- Test coverage for tick behavior is maintained or improved.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
