# Milestone 5: Database Cleanup Job and Stale Job Reclamation

## Goal

Add a self-scheduling `job_queue.cleanup` job that runs daily to remove old completed/dead jobs. Verify stale job reclamation works correctly on restart.

## Scope

- Create `job_queue.cleanup` handler
- Schedule initial cleanup job on daemon start
- Verify `reclaimStale()` reclaims stuck processing jobs on restart

## Tasks

### Task 5.1: Create cleanup handler and wire into app lifecycle

**Description:** Create the `job_queue.cleanup` handler that removes old completed/dead jobs and self-schedules for the next day. Wire it into the daemon startup.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root
2. Create `packages/daemon/src/lib/job-handlers/cleanup.handler.ts`:
   - Handler calls `jobQueue.cleanup(Date.now() - maxAge)` where `maxAge` defaults to 7 days
   - In `finally` block: dedup-check then enqueue next cleanup job with `runAt: Date.now() + 24 * 60 * 60 * 1000` (24 hours)
   - Return `{ deletedJobs, nextRunAt }`
3. In `packages/daemon/src/app.ts` (or a new init function):
   - **BEFORE `jobProcessor.start()`** (step 4 in the startup ordering table — see `00-overview.md`), register the `job_queue.cleanup` handler on `jobProcessor`
   - Then check if a pending `job_queue.cleanup` job already exists; if not, enqueue one with `runAt: Date.now()` (run immediately on first boot, then daily)
   - This ordering is critical: if a cleanup job is pending from a previous run and the processor starts before the handler is registered, the job will fail with "No handler registered" and consume retry attempts
4. Create unit test `packages/daemon/tests/unit/job-handlers/cleanup-handler.test.ts`:
   - Test cleanup deletes old jobs
   - Test self-scheduling
   - Test dedup (does not create duplicate cleanup jobs)
5. Run tests and `bun run check`

**Acceptance criteria:**
- Cleanup handler removes completed/dead jobs older than 7 days
- Self-schedules next run in 24 hours
- Dedup prevents multiple pending cleanup jobs
- Registered and initial job enqueued on daemon start
- Unit tests pass

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 5.2: Verify stale job reclamation on restart (with eager reclaim)

**Description:** Add tests verifying that jobs stuck in `processing` status are reclaimed **immediately** on daemon restart (via the eager `reclaimStale()` added in Task 1.2), ensuring no 60-second delay for crash recovery.

**Note on timing:** `JobQueueProcessor.checkStaleJobs()` has a `STALE_CHECK_INTERVAL = 60_000ms` that normally delays reclamation. However, Task 1.2 added an eager `reclaimStale()` call in `start()` — this test must verify that eager reclamation works correctly, not just the periodic check.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/unit/storage/job-queue-stale-reclamation.test.ts`
2. Test scenarios:
   - Enqueue a job, mark it as processing with a `startedAt` older than `staleThresholdMs` (simulate mid-execution crash)
   - Create a new `JobQueueProcessor`, start it
   - Verify the stale job is reclaimed **immediately on startup** (within the first poll tick, not after 60s)
   - Verify reclaimed job is re-processed by its handler
3. Test that non-stale processing jobs are NOT reclaimed (within threshold)
4. Test that the eager reclaim on startup does not interfere with jobs that are genuinely still processing (started recently)
5. Run tests

**Acceptance criteria:**
- Stale jobs are reclaimed **immediately on startup** (not after 60s delay)
- Reclaimed jobs are re-processed
- Non-stale processing jobs left alone
- Tests verify the eager reclaim path specifically
- Tests pass

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
