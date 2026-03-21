# Milestone 1: Wire Processor to App Lifecycle

## Goal

Add `JobQueueProcessor` and `JobQueueRepository` to the daemon's `DaemonAppContext`, start the processor on boot, stop it on shutdown, and connect it to `ReactiveDatabase` for change notifications. This is a zero-behavior-change foundation milestone.

## Scope

- Extend `DaemonAppContext` interface with `jobProcessor` and `jobQueue` fields
- Instantiate both in `createDaemonApp()`
- Start processor before server starts, stop in cleanup
- Wire `setChangeNotifier` to `reactiveDb.notifyChange()`
- Add unit and integration tests

## Tasks

### Task 1.1: Add JobQueueProcessor and JobQueueRepository to DaemonAppContext

**Description:** Wire `JobQueueProcessor` and `JobQueueRepository` into the daemon's app context, start the processor on boot, stop it during graceful shutdown, and connect the change notifier to `ReactiveDatabase`.

**Agent type:** coder

**Depends on:** (none)

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/app.ts`:
   - Add imports for `JobQueueRepository` and `JobQueueProcessor`.
   - Add `jobProcessor: JobQueueProcessor` and `jobQueue: JobQueueRepository` to the `DaemonAppContext` interface.
   - After `liveQueries` initialization, create `jobQueue = new JobQueueRepository(db.getDatabase())` and `jobProcessor = new JobQueueProcessor(jobQueue, { pollIntervalMs: 1000, maxConcurrent: 3, staleThresholdMs: 5 * 60 * 1000 })`.
   - Wire change notifier: `jobProcessor.setChangeNotifier((table) => { reactiveDb.notifyChange(table); })`.
   - Call `jobProcessor.start()` after GitHub service start (near end of `createDaemonApp`).
   - In the `cleanup()` function, call `await jobProcessor.stop()` before `liveQueries.dispose()`.
   - Add `jobProcessor` and `jobQueue` to the returned context object.
3. Add a unit test at `packages/daemon/tests/unit/app/job-queue-lifecycle.test.ts`:
   - Test that `DaemonAppContext` includes `jobProcessor` and `jobQueue` after creation.
   - Test that `cleanup()` completes without error (processor stops cleanly).
   - Test that the change notifier fires `reactiveDb.notifyChange('job_queue')` when a job completes.
4. Run `bun run check` (lint + typecheck + knip) and fix any issues.
5. Run `make test-daemon` to verify all existing tests still pass.

**Acceptance criteria:**
- `DaemonAppContext` has `jobProcessor` and `jobQueue` fields.
- Processor starts on daemon boot and stops on cleanup.
- `reactiveDb.notifyChange('job_queue')` is called when jobs complete/fail.
- All existing daemon tests continue to pass.
- New unit tests pass.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 1.2: Validate processor lifecycle in online test environment

**Description:** Add an online integration test that verifies the job queue processor starts, processes a simple job, and stops cleanly within a real daemon server instance.

**Agent type:** coder

**Depends on:** Task 1.1

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/tests/online/job-queue/processor-lifecycle.test.ts`:
   - Use `createDaemonServer()` test helper to spin up a real daemon.
   - Register a test handler for queue `test_queue` on the processor.
   - Enqueue a job via `jobQueue.enqueue({ queue: 'test_queue', payload: { foo: 'bar' } })`.
   - Wait for job to complete (poll `jobQueue.getJob()` or use a Promise-based wait).
   - Assert job status is `completed` and result contains expected data.
   - Verify cleanup shuts down cleanly.
3. Run `bun run check` and `make test-daemon` to verify everything passes.

**Acceptance criteria:**
- Online test demonstrates end-to-end job lifecycle: enqueue -> process -> complete.
- Test uses `NEOKAI_USE_DEV_PROXY=1` pattern for CI compatibility.
- No regressions in existing tests.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
