# Milestone 3: Migrate GitHub Polling

## Goal

Replace the `setInterval`-based polling loop in `GitHubPollingService` with self-scheduling `github.poll` jobs. Polling becomes durable and recoverable after daemon restarts.

## Scope

- Expose a `triggerPoll()` method on `GitHubPollingService`
- Create `github.poll` job handler with self-scheduling
- Add deduplication in the finally block to prevent duplicate poll chains
- Remove `setInterval` from `GitHubPollingService.start()`
- Wire handler registration through `GitHubService`

## Key Files

- `packages/daemon/src/lib/github/polling-service.ts` -- line 76 (`setInterval`), `start()/stop()` methods, `pollAllRepositories()` (private)
- `packages/daemon/src/lib/github/github-service.ts` -- orchestrator, `start()/stop()` lifecycle
- `packages/daemon/src/app.ts` -- GitHub service creation and startup

## Tasks

### Task 3.1: Expose triggerPoll and create github.poll handler

**Description:** Add a public `triggerPoll()` method to `GitHubPollingService` that calls the existing private `pollAllRepositories()`. Create a `github.poll` job handler that calls `triggerPoll()` and self-schedules the next poll.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root
2. In `packages/daemon/src/lib/github/polling-service.ts`:
   - Add public `async triggerPoll(): Promise<void>` that calls `this.pollAllRepositories()`
   - Add a guard: if `this.isPolling` is true, skip (reuse existing mutex)
3. Create `packages/daemon/src/lib/job-handlers/github-poll.handler.ts`:
   - Handler calls `pollingService.triggerPoll()`
   - In a `finally` block, check for existing pending/processing `github.poll` jobs using `jobQueue.listJobs({ queue: QUEUES.GITHUB_POLL, status: ['pending', 'processing'], limit: 1000 })`
   - Only enqueue next poll job (with `runAt: Date.now() + intervalMs`) if no future-scheduled pending job exists (i.e., no job with `runAt > now`)
   - Return `{ polled: true, nextRunAt }` on success
4. Create unit test `packages/daemon/tests/unit/job-handlers/github-poll-handler.test.ts`:
   - Mock `GitHubPollingService.triggerPoll()`
   - Test handler calls triggerPoll
   - Test self-scheduling enqueues next job
   - Test dedup: if pending future job exists, skip enqueue
   - Test error in triggerPoll still schedules next job (finally block)
5. Run tests and `bun run check`

**Acceptance criteria:**
- `GitHubPollingService` has a public `triggerPoll()` method
- Handler calls triggerPoll and self-schedules
- Dedup prevents duplicate poll chains
- Errors in polling do not break the scheduling chain
- Unit tests pass

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 3.2: Remove setInterval and wire handler into GitHubService

**Description:** Remove the `setInterval` from `GitHubPollingService.start()` and wire the `github.poll` handler registration through `GitHubService`. The initial poll job is enqueued when `GitHubService.start()` is called.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/github/polling-service.ts`:
   - Remove `setInterval` from `start()` -- `start()` becomes a state flag setter only
   - Remove `clearInterval` from `stop()` -- `stop()` becomes a state flag setter
   - Keep the `pollingInterval` field removal or rename to clarify it's no longer used
2. In `packages/daemon/src/lib/github/github-service.ts`:
   - Accept `jobQueue` and `jobProcessor` in `GitHubServiceOptions`
   - In `start()`: register the `github.poll` handler on `jobProcessor`, then enqueue the initial `github.poll` job with `runAt: Date.now()` (immediate first poll)
   - In `stop()`: no need to deregister -- processor stop handles this
3. In `packages/daemon/src/app.ts`:
   - Pass `jobQueue` and `jobProcessor` to `createGitHubService()`
4. Update existing GitHub polling tests to account for removal of setInterval
5. Add integration-style unit test verifying the full flow: GitHubService.start() -> enqueue -> handler -> triggerPoll -> self-schedule
6. Run `bun run check` and all daemon tests

**Acceptance criteria:**
- No `setInterval` in `GitHubPollingService`
- `GitHubService.start()` enqueues initial `github.poll` job
- Handler is registered on `jobProcessor`
- Existing GitHub tests pass or are updated
- Full flow unit test passes

**Depends on:** Task 3.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 3.3: Online test for GitHub polling via job queue

**Description:** Create an online test verifying GitHub polling works end-to-end through the job queue, including self-scheduling and recovery after restart.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/online/features/github-poll-job.test.ts`
2. Use `createDaemonServer()` with GitHub config enabled
3. Verify:
   - `github.poll` job is enqueued on startup
   - Job transitions through pending -> processing -> completed
   - Next poll job is automatically scheduled
   - No duplicate poll jobs exist simultaneously
4. Run with `NEOKAI_USE_DEV_PROXY=1`

**Acceptance criteria:**
- Online test verifies end-to-end GitHub polling via job queue
- Self-scheduling chain is verified
- Dedup is verified (no duplicate pending jobs)
- Test runs with dev proxy

**Depends on:** Task 3.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
