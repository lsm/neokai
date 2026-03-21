# Complete and Adopt Persistent Job Queue -- Continue from PR #203

## Goal

Wire the existing but unused `JobQueueRepository` and `JobQueueProcessor` into the daemon lifecycle, then migrate all `setInterval`-based background tasks to the persistent job queue. This makes background work durable across daemon restarts and centralizes scheduling.

## Background

PR #203 produced a comprehensive ADR (`docs/adr/0002-job-queue-migration.md`) over 13 review iterations. The plan is well-specified but zero production code has been implemented. The existing infrastructure includes:

- `JobQueueRepository` (complete, 203 lines) -- CRUD, dequeue, retry, cleanup
- `JobQueueProcessor` (complete, 123 lines) -- poll-based processor with handler registration
- `job_queue` SQLite table with indexes
- Comprehensive unit tests for both

The subsystems to migrate:
1. **Session background tasks** -- fire-and-forget title generation tracked in `pendingBackgroundTasks` Set
2. **GitHub polling** -- `setInterval` in `GitHubPollingService` (60s cycle)
3. **Room runtime tick** -- `setInterval` in `RoomRuntime.start()` (30s cycle, 17 `scheduleTick()` call sites)

## Approach

Continue on the existing PR #203 branch (`plan/persistent-job-queue-adoption`). Implement in 6 milestones, each producing a PR-ready commit. All work targets the `dev` branch.

**Key design decisions:**
- Handlers self-schedule the next run (no dedicated scheduler service for now)
- `listJobs` must be extended to accept `status` as an array for deduplication queries
- Room tick deduplication uses application-level checks (not DB unique index) for simplicity
- `stopRuntime()` must call `runtimes.delete(roomId)` to fix the liveness check bug

## Milestones

1. **Foundation -- Wire JobQueueProcessor into DaemonApp** -- Instantiate processor in `app.ts`, add constants file, extend `listJobs` to accept status arrays, connect change notifier to ReactiveDatabase, hook into start/stop lifecycle.

2. **Migrate Session Background Tasks** -- Replace `pendingBackgroundTasks` Set in `SessionManager` with a `session.title_generation` job queue handler. Add `SessionManager.start()` method.

3. **Migrate GitHub Polling** -- Replace `setInterval` in `GitHubPollingService` with self-scheduling `github.poll` jobs. Expose `triggerPoll()` method, register handler, add dedup logic in finally block.

4. **Migrate Room Runtime Tick** -- Replace `setInterval` + `scheduleTick()` + `queueMicrotask` in `RoomRuntime` with `room.tick` jobs. Fix `stopRuntime()` to delete from runtimes map. Handle 17 `scheduleTick()` call sites.

5. **Database Cleanup Job and Stale Job Reclamation** -- Add a self-scheduling `job_queue.cleanup` job that runs daily. Remove old completed/dead jobs. Verify stale job reclamation works across restarts.

6. **Integration Tests and E2E Validation** -- Online tests for crash-recovery scenarios across all migrated subsystems. Verify job processing resumes after daemon restart.

## Cross-Milestone Dependencies

```
Milestone 1 (Foundation)
  +-- Milestone 2 (Session tasks)
  +-- Milestone 3 (GitHub polling)
  +-- Milestone 4 (Room tick)
  +-- Milestone 5 (Cleanup job)
       |
       +-- Milestone 6 (Integration tests) -- depends on Milestones 2, 3, 4, 5
```

Milestones 2, 3, 4, and 5 can proceed in parallel after Milestone 1 is complete. Milestone 6 depends on all prior milestones.

## Total Estimated Task Count

18 tasks across 6 milestones.
