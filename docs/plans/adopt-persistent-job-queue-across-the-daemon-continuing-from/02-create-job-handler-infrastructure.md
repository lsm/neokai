# Milestone 2: Create Job Handler Infrastructure

## Goal

Create a structured handler module system under `packages/daemon/src/lib/job-handlers/` with type definitions, a registration pattern, and the first concrete handler (cleanup). This establishes the pattern all subsequent handlers will follow.

## Scope

- Create `types.ts` with `JobHandler`, `JobHandlerContext`, and `JobHandlerRegistration` interfaces
- Create `cleanup.handler.ts` as the first real handler
- Create `register-handlers.ts` to centralize handler registration with the processor
- Wire handler registration into `app.ts`
- Schedule an initial cleanup job on startup

## Tasks

### Task 2.1: Create job handler types and cleanup handler

**Description:** Create the job handler module directory with type definitions and the cleanup handler. The cleanup handler removes old completed/dead jobs from the `job_queue` table on a daily schedule using the self-rescheduling pattern.

**Agent type:** coder

**Depends on:** Task 1.1

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/src/lib/job-handlers/types.ts`:
   - Define `JobHandlerContext` interface with fields: `jobQueue: JobQueueRepository`, `db: Database`, and any other shared dependencies.
   - Re-export `JobHandler` type from `job-queue-processor.ts` (or define it here and update processor to import from here).
   - Define `JobHandlerRegistration` interface: `{ queue: string; handler: JobHandler }`.
3. Create `packages/daemon/src/lib/job-handlers/cleanup.handler.ts`:
   - `createCleanupHandler(jobQueue: JobQueueRepository): JobHandler`
   - Handler calls `jobQueue.cleanup(Date.now() - maxAge)` where `maxAge` defaults to 7 days (from `payload.maxAgeMs` or default).
   - After cleanup, handler self-reschedules: enqueue a new `cleanup` job with `runAt: Date.now() + 24h`.
   - Returns `{ deletedJobs, nextRunAt }`.
4. Create `packages/daemon/src/lib/job-handlers/register-handlers.ts`:
   - Export `registerJobHandlers(processor: JobQueueProcessor, deps: { jobQueue: JobQueueRepository })`.
   - Registers the cleanup handler: `processor.register('cleanup', createCleanupHandler(deps.jobQueue))`.
   - This function will be extended in later milestones to register additional handlers.
5. Wire into `packages/daemon/src/app.ts`:
   - Import and call `registerJobHandlers(jobProcessor, { jobQueue })` after processor creation and before `jobProcessor.start()`.
   - After `jobProcessor.start()`, enqueue the initial cleanup job if none exists: check `jobQueue.listJobs({ queue: 'cleanup', status: 'pending' })` and enqueue if empty with `runAt: Date.now() + 24 * 60 * 60 * 1000`.
6. Add unit tests at `packages/daemon/tests/unit/job-handlers/cleanup-handler.test.ts`:
   - Test cleanup handler deletes old jobs and self-reschedules.
   - Test handler respects `maxAgeMs` from payload.
   - Test handler uses 7-day default when `maxAgeMs` not provided.
7. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- `packages/daemon/src/lib/job-handlers/` directory exists with `types.ts`, `cleanup.handler.ts`, and `register-handlers.ts`.
- Cleanup handler deletes old completed/dead jobs and self-reschedules for next day.
- Handler is registered with processor in `app.ts`.
- Initial cleanup job is seeded on startup if none exists.
- Unit tests pass.
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 2.2: Add online test for cleanup handler end-to-end

**Description:** Verify the cleanup handler works end-to-end in a real daemon instance -- it processes a cleanup job, deletes old entries, and self-reschedules.

**Agent type:** coder

**Depends on:** Task 2.1

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/tests/online/job-queue/cleanup-handler.test.ts`:
   - Spin up a daemon via `createDaemonServer()`.
   - Seed the `job_queue` table with several old completed/dead jobs (set `completed_at` to >7 days ago).
   - Enqueue a cleanup job with `runAt: Date.now()` (immediate).
   - Wait for the job to complete.
   - Assert old jobs were deleted.
   - Assert a new cleanup job is now pending with `runAt` ~24h from now.
3. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- End-to-end test demonstrates cleanup handler lifecycle.
- Old jobs are deleted, new cleanup job is scheduled.
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
