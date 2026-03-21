# Milestone 5: Observability and Cleanup

## Goal

Add RPC handlers for querying job queue status, wire live query subscriptions for real-time job status monitoring, and ensure the recurring cleanup job is properly configured. This milestone makes the job queue observable from the frontend.

## Scope

- Add `jobQueue.status` and `jobQueue.list` RPC handlers
- Wire live query subscription for `job_queue` table changes
- Add a simple status indicator component (optional, frontend)
- Final integration validation

## Tasks

### Task 5.1: Add job queue RPC handlers

**Description:** Create RPC handlers that allow the frontend (or debugging tools) to query job queue status: list jobs by queue/status, get job counts, and manually trigger job enqueueing.

**Agent type:** coder

**Depends on:** Task 1.1

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/src/lib/rpc-handlers/job-queue-handlers.ts`:
   - `jobQueue.list` handler: accepts `{ queue?: string, status?: JobStatus, limit?: number }`, returns job list via `jobQueue.listJobs()`.
   - `jobQueue.status` handler: accepts `{ queue: string }`, returns status counts via `jobQueue.countByStatus()`.
   - `jobQueue.enqueue` handler (admin/debug): accepts `{ queue, payload, priority?, runAt? }`, enqueues a job. Guard with a debug/admin check if possible.
3. Register handlers in `packages/daemon/src/lib/rpc-handlers/index.ts`:
   - Import and call `setupJobQueueHandlers()` from the new file.
   - Pass `jobQueue` (and optionally `jobProcessor`) from the deps.
4. Update `RPCHandlerDependencies` type to include `jobQueue: JobQueueRepository`.
5. Update `setupRPCHandlers()` call in `app.ts` to pass `jobQueue`.
6. Add unit tests at `packages/daemon/tests/unit/rpc-handlers/job-queue-handlers.test.ts`:
   - Test `jobQueue.list` returns filtered jobs.
   - Test `jobQueue.status` returns correct counts.
   - Test `jobQueue.enqueue` creates a job.
7. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- `jobQueue.list`, `jobQueue.status`, and `jobQueue.enqueue` RPC handlers work.
- Handlers are registered in the RPC handler setup.
- Unit tests pass.
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 5.2: Wire live query subscription for job queue changes

**Description:** Ensure the `LiveQueryEngine` receives `job_queue` table change notifications so that frontend clients can subscribe to real-time job status updates via the existing live query infrastructure.

**Agent type:** coder

**Depends on:** Task 5.1

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Verify that the `reactiveDb.notifyChange('job_queue')` call from Task 1.1 propagates correctly to `LiveQueryEngine`:
   - The `setChangeNotifier` wired in Phase 1 should already trigger this.
   - Write a unit test that: registers a live query on `job_queue`, enqueues and processes a job, asserts the live query callback fires.
3. If the live query subscription does not already support `job_queue` as a watched table, add it to the `LiveQueryEngine` configuration.
4. Add integration test at `packages/daemon/tests/unit/storage/job-queue-live-query.test.ts`:
   - Create a `ReactiveDatabase` and `LiveQueryEngine`.
   - Subscribe to a query on `job_queue`.
   - Enqueue a job, process it (mark complete).
   - Fire `notifyChange('job_queue')`.
   - Assert subscription callback receives updated data.
5. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- `job_queue` table changes propagate through `ReactiveDatabase` to `LiveQueryEngine`.
- Live query subscriptions on `job_queue` fire when jobs are enqueued, processed, or completed.
- Integration test validates the full notification path.
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 5.3: Final integration validation and documentation

**Description:** Run the complete test suite, verify all job queue migrations work together, update the ADR status, and add inline code documentation.

**Agent type:** coder

**Depends on:** Task 5.1, Task 5.2, Task 3.3, Task 4.3

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Run the full test suite: `make test-daemon` and `make test-web`.
3. Run `bun run check` (lint + typecheck + knip).
4. Update `docs/adr/0002-job-queue-migration.md`:
   - Change status from "Proposed" to "Accepted".
   - Add a "Decision" section noting which open questions were resolved and how.
   - Document any deviations from the original plan.
5. Verify knip does not flag any new unused exports (the old `setInterval` code should be fully removed).
6. Do a final review of all `setInterval` usage in the daemon to confirm only intentional ones remain (WebSocket stale check is left as-is per the ADR scope).

**Acceptance criteria:**
- All daemon and web tests pass.
- Lint, typecheck, and knip checks pass.
- ADR 0002 is updated to "Accepted" status.
- No stale `setInterval` patterns remain for migrated services.
- Code is clean and well-documented.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
