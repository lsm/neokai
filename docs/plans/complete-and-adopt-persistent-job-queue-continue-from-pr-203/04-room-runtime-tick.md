# Milestone 4: Migrate Room Runtime Tick

## Goal

Replace the `setInterval` + `scheduleTick()` + `queueMicrotask` pattern in `RoomRuntime` with persistent `room.tick` jobs. This is the highest-risk migration because room runtime manages agent sessions and task execution.

## Scope

- Create `room.tick` job handler
- Replace `setInterval` in `RoomRuntime.start()` with job-based scheduling
- Replace all 17 `scheduleTick()` call sites with `enqueueRoomTick()`
- Replace `queueMicrotask` tick drain with job enqueueing
- Fix `stopRuntime()` to call `runtimes.delete(roomId)`
- Add `stoppedRooms` tracking for liveness checks
- Wire handler through `RoomRuntimeService`

## Key Files

- `packages/daemon/src/lib/room/runtime/room-runtime.ts` -- 3474 lines; `tickTimer` at line 157, `setInterval` at line 422, `scheduleTick()` at line 3418, `queueMicrotask` at line 2241, `scheduleTickAfterRateLimitReset()` at line 3428
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` -- `stopRuntime()` at line 124, `startRuntime()` at line 135, `runtimes` Map at line 51

## Tasks

### Task 4.1: Create room.tick handler and enqueueRoomTick helper

**Description:** Create the `room.tick` job handler and a helper function `enqueueRoomTick()` that deduplicates tick jobs per room. The handler calls `runtime.tick()` and re-schedules the next tick.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root
2. Create `packages/daemon/src/lib/job-handlers/room-tick.handler.ts`:
   - Handler extracts `{ roomId }` from job payload
   - Looks up runtime from a `getRuntimeForRoom` callback
   - If runtime not found or state is not 'running', return `{ skipped: true }`
   - Call `await runtime.tick()`
   - In `finally` block: check if room is still active, if so call `enqueueRoomTick(roomId)` with delay
3. Create `enqueueRoomTick(roomId, jobQueue, delayMs?)` helper function:
   - Check for existing pending/processing `room.tick` jobs for this room using `jobQueue.listJobs({ queue: QUEUES.ROOM_TICK, status: ['pending', 'processing'], limit: 1000 })`
   - Filter by `payload.roomId === roomId`
   - Only enqueue if no matching job with `runAt > now` exists
   - Default delay is 30,000ms (30s tick interval)
4. Create unit test `packages/daemon/tests/unit/job-handlers/room-tick-handler.test.ts`:
   - Mock RoomRuntime with tick() stub
   - Test handler calls tick and re-schedules
   - Test handler skips when runtime not found
   - Test handler skips when runtime not running
   - Test enqueueRoomTick dedup logic
   - Test error in tick() still allows re-scheduling
5. Run tests and `bun run check`

**Acceptance criteria:**
- Handler exists and correctly calls `runtime.tick()`
- `enqueueRoomTick` deduplicates by roomId
- Handler re-schedules next tick after completion
- Errors in tick do not break the scheduling chain
- Unit tests pass

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.2: Replace setInterval and scheduleTick in RoomRuntime

**Description:** Remove `setInterval` from `RoomRuntime.start()`, remove the `scheduleTick()` method, and replace all 17 call sites with `enqueueRoomTick()`. This is the core migration task for the room runtime.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`:
   - Add `jobQueue?: JobQueueRepository` to `RoomRuntimeConfig` interface
   - Store `jobQueue` in the constructor
   - In `start()` (line 420-424): Remove `this.tickTimer = setInterval(...)`, replace with `enqueueRoomTick(this.roomId, this.jobQueue, 0)` for immediate first tick
   - In `stop()` (line 435-447): Remove `clearInterval(this.tickTimer)` and `this.tickTimer = null`
   - Remove the `tickTimer` field (line 157)
   - Replace `scheduleTick()` method (line 3418-3422) body: instead of `queueMicrotask(() => this.tick())`, call `enqueueRoomTick(this.roomId, this.jobQueue, 0)` for immediate re-tick
   - Replace `scheduleTickAfterRateLimitReset()` (line 3428-3452): instead of `setTimeout(() => this.scheduleTick(), delayMs)`, call `enqueueRoomTick(this.roomId, this.jobQueue, delayMs)`
   - Update line 2241 (`queueMicrotask(() => this.tick())`) to use `enqueueRoomTick(this.roomId, this.jobQueue, 0)`
   - Replace all 17 `this.scheduleTick()` call sites (lines 259, 423, 432, 553, 560, 665, 1024, 1149, 1287, 1315, 1588, 1700, 1815, 3364, 3410, 3432, 3451) -- some become `enqueueRoomTick`, some are in the replaced methods
2. Ensure `RoomRuntime.tick()` remains the same public method signature -- it is now only called by the job handler
3. Run existing room runtime tests to check for breakage
4. Run `bun run check`

**Acceptance criteria:**
- No `setInterval` in `RoomRuntime`
- No `tickTimer` field
- `scheduleTick()` uses job queue instead of `queueMicrotask`
- `scheduleTickAfterRateLimitReset()` uses job queue with delay instead of `setTimeout`
- All 17 `scheduleTick()` call sites updated
- `tick()` method signature unchanged
- TypeScript compiles without errors

**Depends on:** Task 4.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.3: Wire handler into RoomRuntimeService and fix stopRuntime bug

**Description:** Register the `room.tick` handler in `RoomRuntimeService`, fix `stopRuntime()` to delete from the `runtimes` map, and pass `jobQueue` to `RoomRuntime` instances.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`:
   - Add `jobQueue` and `jobProcessor` to `RoomRuntimeServiceConfig`
   - In `start()`: register the `room.tick` handler on `jobProcessor`
   - The handler needs access to `this.runtimes` map for runtime lookup
   - Pass `jobQueue` to all `RoomRuntime` constructor calls (in `createOrGetRuntime`)
2. Fix `stopRuntime()` (line 124-129): after `runtime.stop()`, add `this.runtimes.delete(roomId)` so that the heartbeat liveness check works correctly
3. In `packages/daemon/src/app.ts`:
   - Pass `jobQueue` and `jobProcessor` to `RoomRuntimeServiceConfig`
4. Update `packages/daemon/src/lib/rpc-handlers/index.ts` to forward `jobQueue` and `jobProcessor` to `RoomRuntimeService`
5. Update existing room runtime tests
6. Add unit test verifying:
   - Handler is registered on `start()`
   - `stopRuntime()` removes from runtimes map
   - `startRuntime()` creates runtime with jobQueue
7. Run `bun run check` and all daemon tests

**Acceptance criteria:**
- `room.tick` handler registered in `RoomRuntimeService.start()`
- `stopRuntime()` calls `this.runtimes.delete(roomId)`
- `jobQueue` passed to all `RoomRuntime` instances
- Existing room tests pass
- New tests verify handler registration and stopRuntime fix

**Depends on:** Task 4.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.4: Online test for room tick via job queue

**Description:** Create an online test verifying room ticks work end-to-end through the job queue, including dedup and recovery for stopped rooms.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/online/room/room-tick-job.test.ts`
2. Use `createDaemonServer()` and create a room
3. Verify:
   - `room.tick` job is enqueued when room runtime starts
   - Job processes and re-schedules
   - No duplicate tick jobs for the same room
   - Stopping a room prevents further tick scheduling
   - Restarting a room resumes tick scheduling
4. Run with `NEOKAI_USE_DEV_PROXY=1`

**Acceptance criteria:**
- Online test verifies end-to-end room tick via job queue
- Dedup verified (one pending tick per room)
- Stop/restart lifecycle verified
- Test runs with dev proxy

**Depends on:** Task 4.3

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
