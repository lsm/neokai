# Milestone 1: Foundation -- Wire JobQueueProcessor into DaemonApp

## Goal

Make the persistent job queue operational by wiring `JobQueueProcessor` into the daemon lifecycle, extending `listJobs` to support status arrays, creating queue name constants, and connecting the change notifier to `ReactiveDatabase`.

## Scope

- Extend `JobQueueRepository.listJobs()` to accept `status` as `JobStatus | JobStatus[]`
- Create `packages/daemon/src/lib/job-queue-constants.ts` with queue name constants
- Instantiate `JobQueueProcessor` in `app.ts`
- Connect `setChangeNotifier` to `ReactiveDatabase`
- Add `jobProcessor` and `jobQueue` to `DaemonAppContext`
- Hook `jobProcessor.stop()` into cleanup (before `messageHub.cleanup()`)
- Pass `jobQueue` and `jobProcessor` through `RPCHandlerDependencies`

## Tasks

### Task 1.1: Extend listJobs to accept status arrays

**Description:** Modify `JobQueueRepository.listJobs()` to accept `status` as either a single `JobStatus` string or an array of `JobStatus` values. When an array is provided, generate `IN (?,?,...)` SQL with dynamic placeholders. Empty array returns no rows.

**Agent type:** coder

**Subtasks:**
1. Read `packages/daemon/src/storage/repositories/job-queue-repository.ts` lines 128-147
2. Change the `status` field type in the filter parameter from `status?: JobStatus` to `status?: JobStatus | JobStatus[]`
3. Update the SQL generation: if array, build `AND status IN (?,?,...)`; if string, keep existing `AND status = ?`; if empty array, return `[]` early
4. Update `packages/daemon/tests/unit/storage/job-queue-repository.test.ts` with tests for:
   - `status: ['pending', 'processing']` returns jobs matching either status
   - `status: 'pending'` (string) still works as before
   - `status: []` (empty array) returns empty results
5. Run `cd packages/daemon && bun test tests/unit/storage/job-queue-repository.test.ts` to verify
6. Run `bun run check` to verify no lint/type errors

**Acceptance criteria:**
- `listJobs({ status: ['pending', 'processing'] })` returns jobs with either status
- `listJobs({ status: 'pending' })` still works (backward compatible)
- `listJobs({ status: [] })` returns empty array
- All existing job-queue-repository tests pass
- New tests cover the array status filter

**Depends on:** none

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 1.2: Create job queue constants and wire processor into app.ts

**Description:** Create the queue name constants file and wire `JobQueueProcessor` into the `DaemonApp` lifecycle. This includes instantiation, ReactiveDatabase change notification, cleanup ordering, and exposing via `DaemonAppContext`.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root
2. Create `packages/daemon/src/lib/job-queue-constants.ts` with constants:
   ```
   SESSION_TITLE_GENERATION = 'session.title_generation'
   GITHUB_POLL = 'github.poll'
   ROOM_TICK = 'room.tick'
   JOB_QUEUE_CLEANUP = 'job_queue.cleanup'
   ```
3. In `packages/daemon/src/app.ts`:
   - Import `JobQueueRepository` from `./storage/repositories/job-queue-repository`
   - Import `JobQueueProcessor` from `./storage/job-queue-processor`
   - After `liveQueries` creation (~line 101), instantiate:
     ```
     const jobQueue = new JobQueueRepository(db.getDatabase());
     const jobProcessor = new JobQueueProcessor(jobQueue, { pollIntervalMs: 1000, maxConcurrent: 3, staleThresholdMs: 5 * 60 * 1000 });
     ```
   - Call `jobProcessor.setChangeNotifier((table) => { reactiveDb.notifyChange(table); });`
   - Before `gitHubService.start()` (~line 341), call `jobProcessor.start()` with log message
   - In `cleanup()`, add `await jobProcessor.stop()` BEFORE `messageHub.cleanup()` (~line 394) with log message
4. Add `jobProcessor: JobQueueProcessor` and `jobQueue: JobQueueRepository` to `DaemonAppContext` interface and return object
5. Add `jobProcessor` and `jobQueue` to `RPCHandlerDependencies` in `packages/daemon/src/lib/rpc-handlers/index.ts` (interface only, no handler changes yet)
6. Pass `jobProcessor` and `jobQueue` from `app.ts` to `setupRPCHandlers()`
7. Run `bun run check` to verify no lint/type errors
8. Create unit test `packages/daemon/tests/unit/app/job-queue-lifecycle.test.ts` that verifies:
   - `DaemonAppContext` includes `jobProcessor` and `jobQueue`
   - Cleanup stops the processor before messageHub

**Acceptance criteria:**
- `JobQueueProcessor` is instantiated in `app.ts` with `maxConcurrent: 3`
- Change notifier wired to `reactiveDb.notifyChange`
- `jobProcessor.start()` called before server starts serving
- `jobProcessor.stop()` called in cleanup BEFORE `messageHub.cleanup()`
- `jobProcessor` and `jobQueue` available in `DaemonAppContext`
- `RPCHandlerDependencies` interface includes both fields
- Constants file exists with all 4 queue names
- All existing tests pass

**Depends on:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 1.3: Unit tests for processor lifecycle integration

**Description:** Add comprehensive unit tests verifying the processor integrates correctly with the app lifecycle, including start/stop ordering and change notification flow.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/unit/storage/job-queue-processor-lifecycle.test.ts`
2. Test that `start()` begins polling and processes enqueued jobs
3. Test that `stop()` waits for in-flight jobs to complete
4. Test that `setChangeNotifier` is called when jobs complete
5. Test that processor handles handler errors gracefully (retries, then marks dead)
6. Test that stale job reclamation works after threshold
7. Run `cd packages/daemon && bun test tests/unit/storage/job-queue-processor-lifecycle.test.ts`

**Acceptance criteria:**
- Tests cover start/stop lifecycle
- Tests cover change notification callback
- Tests cover error handling and retry behavior
- Tests cover stale job reclamation
- All tests pass

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
