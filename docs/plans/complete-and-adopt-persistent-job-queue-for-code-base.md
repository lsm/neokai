# Plan: Complete and Adopt Persistent Job Queue for Codebase

## Goal

The database-backed persistent job queue (`JobQueueRepository` + `JobQueueProcessor`) is fully implemented but not wired up or used by any daemon code. The goal is to adopt it across all background/async operations currently using in-memory patterns (fire-and-forget Promises, `setInterval` schedulers, in-memory state), replacing them with durable persistent jobs that survive daemon restarts.

## Current State

### Implemented (ready to use)
- `packages/daemon/src/storage/repositories/job-queue-repository.ts` — CRUD operations on `job_queue` SQLite table
- `packages/daemon/src/storage/job-queue-processor.ts` — Background polling loop with handler registry, retry/backoff, stale reclaim
- Comprehensive unit tests in `packages/daemon/tests/unit/storage/`

### Not yet adopted (in-memory patterns to replace)
- **Session background tasks**: Title generation + git branch rename are fire-and-forget Promises tracked only in a `Set` (`pendingBackgroundTasks` in `session-manager.ts`)
- **GitHub event processing pipeline**: Polling state (etags, timestamps) is in-memory only; events are processed via an event-bus chain with no durability; restart causes reprocessing or missed events
- **Room runtime tick scheduling**: Room orchestration uses `setInterval` to drive the state machine; a crash mid-tick leaves worker/leader routing in inconsistent state
- **`app.ts` has no `JobQueueProcessor` wiring**: The processor is never instantiated or started

## Tasks

### Task 1: Wire Up JobQueueProcessor in DaemonApp (Foundation)

**Agent**: coder
**Dependencies**: none
**Priority**: high

**Description**:
Initialize and start the `JobQueueProcessor` in `packages/daemon/src/app.ts`. This is the foundational plumbing that all subsequent tasks depend on.

Steps:
1. Add `JobQueueProcessor` instantiation to `DaemonApp` in `app.ts`, using the existing `Database` facade (`db.getJobQueueRepo()`).
2. Define a `QUEUES` constants object (e.g. in `packages/daemon/src/lib/job-queue-constants.ts`) enumerating all queue names: `session.title_generation`, `github.event`, `room.tick`.
3. Call `processor.start()` in `DaemonApp.start()` and `await processor.stop()` in `DaemonApp.stop()` for graceful shutdown.
4. Expose `getJobQueueProcessor(): JobQueueProcessor` on `DaemonApp` so subsystems can register handlers and enqueue jobs.
5. Configure processor options: `pollIntervalMs: 500`, `maxConcurrent: 5`, `staleThresholdMs: 30_000`.

**Acceptance criteria**:
- `JobQueueProcessor` is created, started, and stopped as part of `DaemonApp` lifecycle.
- Queue name constants are co-located and re-exported.
- Existing unit tests for `JobQueueRepository` and `JobQueueProcessor` still pass.
- New unit test verifies processor lifecycle integration in `DaemonApp`.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2: Migrate Session Background Tasks to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace the fire-and-forget title generation + git branch rename in `SessionManager` with a persistent job on the `session.title_generation` queue.

Files to modify:
- `packages/daemon/src/lib/session/session-manager.ts` — enqueue a job instead of spawning a Promise; remove `pendingBackgroundTasks` Set
- `packages/daemon/src/lib/session/session-lifecycle.ts` — extract `generateTitleAndRenameBranch` into a standalone function usable as a queue handler
- Register handler on `session.title_generation` queue in the session subsystem startup

Job payload: `{ sessionId: string, userMessageText: string }`

Handler behavior:
- Load session from DB; skip if title already set (idempotent)
- Call existing `generateTitleAndRenameBranch` logic
- On success: mark complete; on failure: let the retry/dead-letter mechanism handle it (max 2 retries)

**Acceptance criteria**:
- `pendingBackgroundTasks` Set removed from `SessionManager`.
- Title generation enqueues a persistent job; handler runs via `JobQueueProcessor`.
- If daemon restarts after enqueue but before handler runs, job is picked up on next start.
- Unit tests cover: enqueue on first message, idempotency (title already set), handler success and failure/retry paths.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3: Migrate GitHub Event Processing to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace the in-memory GitHub event pipeline with a persistent job queue so events are durable and processing is idempotent across restarts.

Files to modify:
- `packages/daemon/src/lib/github/polling-service.ts` — persist polling state (etags, last-poll timestamps) to DB settings; enqueue a `github.event` job for each new event instead of emitting directly
- `packages/daemon/src/lib/github/github-service.ts` — register a handler on `github.event` queue that runs the existing filter→security→route pipeline; add idempotency check by storing processed event IDs in the `settings` table or a new `github_processed_events` table
- `packages/daemon/src/lib/github/webhook-service.ts` (if it exists) — enqueue jobs instead of direct pipeline calls

Job payload: `{ eventType: string, eventId: string, payload: Record<string, unknown> }`

Handler behavior:
- Skip if event ID already processed (idempotency)
- Run filter → security → route pipeline
- On success: mark processed; on failure: retry up to 3 times before dead-letter

**Acceptance criteria**:
- Polling state (etags, timestamps) survives daemon restart.
- Same GitHub event cannot be processed twice (idempotency by event ID).
- Events enqueued but not yet processed survive daemon restart and are picked up on next start.
- Unit tests cover: enqueue on poll, idempotency, filter/route pipeline via handler, retry on transient error.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4: Migrate Room Runtime Tick to Persistent Queue

**Agent**: coder
**Dependencies**: Task 1
**Priority**: normal

**Description**:
Replace the `setInterval`-based room runtime tick with persistent job scheduling so room state machine operations are durable and crash-safe.

Files to modify:
- `packages/daemon/src/lib/room/runtime/room-runtime.ts` — remove `setInterval`; on each relevant event (goal created, task updated, worker/leader state change), enqueue a `room.tick` job with `{ roomId }` payload instead of calling `tick()` directly; also schedule a periodic `room.tick` job via `runAt` for heartbeat
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` — register handler on `room.tick` queue; handler calls the existing `tick()` logic for the given roomId

Key considerations:
- Deduplication: if a `room.tick` job for a given roomId is already `pending` or `processing`, skip enqueueing a duplicate (check via `listJobs`)
- Heartbeat: schedule a `room.tick` job with `runAt = now + 30_000` after each tick completes (replaces `setInterval`)
- Idempotency: `tick()` handlers already claim idempotency; ensure they hold under job-queue retry

**Acceptance criteria**:
- `setInterval` removed from `RoomRuntime`; tick driven by job queue.
- On daemon restart, pending `room.tick` jobs are picked up and rooms resume operation.
- No duplicate `room.tick` jobs accumulate for the same room.
- Unit tests cover: tick enqueue on event, deduplication, heartbeat re-scheduling, handler execution.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5: Integration Tests, Cleanup, and E2E Validation

**Agent**: coder
**Dependencies**: Tasks 2, 3, 4
**Priority**: normal

**Description**:
Add integration and E2E tests validating crash-recovery scenarios, and clean up any remaining in-memory patterns.

Steps:
1. **Online/integration tests** (in `packages/daemon/tests/online/`):
   - Session title generation: simulate daemon restart mid-job; verify title is generated after restart
   - GitHub event durability: enqueue event, restart processor, verify event is processed exactly once
   - Room tick recovery: enqueue tick, stop processor, restart it, verify room state progresses
2. **E2E test** (`packages/e2e/tests/`): verify that after a simulated server restart, a pending session operation (title generation) completes correctly in the UI
3. **Cleanup**: remove any obsolete fire-and-forget patterns, unused `pendingBackgroundTasks` references, or dead code revealed by this migration
4. **Job queue maintenance**: add a scheduled `cleanup` job that runs `jobQueueRepo.cleanup()` daily to prune old completed/dead jobs from the DB

**Acceptance criteria**:
- At least 3 online tests covering crash-recovery scenarios across the three migrated subsystems.
- E2E test confirms UI recovers gracefully from server restart during background operations.
- No stale in-memory queue patterns remain in production code.
- `bun run check` passes (lint + typecheck + knip).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task Dependencies

```
Task 1 (Foundation)
  └── Task 2 (Session tasks)    ──┐
  └── Task 3 (GitHub events)    ──┼── Task 5 (Integration + Cleanup)
  └── Task 4 (Room runtime)     ──┘
```

Tasks 2, 3, and 4 can be worked on in parallel after Task 1 is merged. Task 5 waits for Tasks 2–4.

## Key Files Reference

| File | Relevance |
|------|-----------|
| `packages/daemon/src/app.ts` | DaemonApp wiring (Task 1) |
| `packages/daemon/src/storage/job-queue-processor.ts` | Existing processor (all tasks) |
| `packages/daemon/src/storage/repositories/job-queue-repository.ts` | Existing repository (all tasks) |
| `packages/daemon/src/lib/session/session-manager.ts` | Task 2 |
| `packages/daemon/src/lib/session/session-lifecycle.ts` | Task 2 |
| `packages/daemon/src/lib/github/polling-service.ts` | Task 3 |
| `packages/daemon/src/lib/github/github-service.ts` | Task 3 |
| `packages/daemon/src/lib/room/runtime/room-runtime.ts` | Task 4 |
| `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` | Task 4 |
