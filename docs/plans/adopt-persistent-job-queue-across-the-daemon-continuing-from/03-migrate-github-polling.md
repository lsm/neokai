# Milestone 3: Migrate GitHub Polling

## Goal

Replace the `setInterval`-based polling loop in `GitHubPollingService` with a job-based self-rescheduling pattern. The polling service will expose a `triggerPoll()` method and delegate scheduling to the job queue.

## Scope

- Create `github-poll.handler.ts` job handler
- Refactor `GitHubPollingService` to expose `triggerPoll()` (make `pollAllRepositories()` accessible)
- Remove `setInterval` from `GitHubPollingService.start()`
- Update `GitHubService` to seed the initial poll job
- Register handler in `register-handlers.ts`
- Unit and online tests

## Tasks

### Task 3.1: Create GitHub poll handler and expose triggerPoll

**Description:** Create the `github-poll.handler.ts` job handler and refactor `GitHubPollingService` to expose `triggerPoll()` so the handler can invoke polling externally. The handler follows the self-rescheduling pattern: after polling completes, it enqueues the next poll job with `runAt` set to `Date.now() + intervalMs`.

**Agent type:** coder

**Depends on:** Task 2.1

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/github/polling-service.ts`:
   - Add a public `async triggerPoll(): Promise<void>` method that calls the existing `pollAllRepositories()`.
   - Keep `pollAllRepositories()` as private -- `triggerPoll()` is the public entry point.
   - Add a public `getInterval(): number` method that returns `this.config.interval`.
3. Create `packages/daemon/src/lib/job-handlers/github-poll.handler.ts`:
   - `createGitHubPollHandler(pollingService: GitHubPollingService, jobQueue: JobQueueRepository): JobHandler`
   - Handler calls `pollingService.triggerPoll()`.
   - After poll completes, check for existing pending `github_poll` jobs before scheduling next (prevent duplicates).
   - Self-reschedule: `jobQueue.enqueue({ queue: 'github_poll', payload: {}, runAt: Date.now() + pollingService.getInterval() })`.
   - Returns `{ polled: true, nextRunAt }`.
4. Add unit tests at `packages/daemon/tests/unit/job-handlers/github-poll-handler.test.ts`:
   - Test handler calls `triggerPoll()` on the polling service.
   - Test handler self-reschedules with correct interval.
   - Test handler does not create duplicate pending jobs.
   - Test handler error propagation (poll failure triggers retry via job queue).
5. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- `GitHubPollingService` has a public `triggerPoll()` method.
- `github-poll.handler.ts` exists and follows self-rescheduling pattern.
- Unit tests cover handler behavior including deduplication.
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 3.2: Wire GitHub poll handler and remove setInterval

**Description:** Register the GitHub poll handler with the processor, update `GitHubService` to seed the initial poll job instead of starting `setInterval`, and remove the `setInterval` from `GitHubPollingService.start()`.

**Agent type:** coder

**Depends on:** Task 3.1

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Update `packages/daemon/src/lib/job-handlers/register-handlers.ts`:
   - Accept optional `gitHubService` (or `pollingService`) dependency.
   - If GitHub service is available, register: `processor.register('github_poll', createGitHubPollHandler(pollingService, deps.jobQueue))`.
3. Update `packages/daemon/src/app.ts`:
   - Pass `gitHubService` (or its polling service) to `registerJobHandlers()`.
   - After `gitHubService.start()`, seed the initial `github_poll` job: enqueue with `runAt: Date.now()` if no pending `github_poll` job exists.
4. Update `packages/daemon/src/lib/github/polling-service.ts`:
   - Remove `setInterval` from `start()`. The `start()` method now only sets state (marks service as started).
   - Remove `clearInterval` from `stop()`. The `stop()` method marks state as stopped.
   - Keep the `isRunning()` check based on a boolean flag instead of the timer reference.
   - Keep the `isPolling` mutex guard in `triggerPoll()`/`pollAllRepositories()` to prevent concurrent polls.
5. Update `packages/daemon/src/lib/github/github-service.ts`:
   - In `GitHubService.start()`, after creating the polling service, do NOT call `pollingService.start()` (the job queue handles scheduling).
   - Or: call `pollingService.start()` only for state tracking, knowing it no longer creates a timer.
6. Add/update unit tests:
   - Test `GitHubPollingService.start()` no longer creates a timer.
   - Test that initial `github_poll` job is seeded on daemon startup when GitHub is configured.
7. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- GitHub polling is driven entirely by job queue (no `setInterval`).
- Initial poll job is seeded on startup.
- Handler self-reschedules after each poll.
- `GitHubPollingService.stop()` is a clean no-op for timer (just state).
- All GitHub-related tests pass.
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

### Task 3.3: Online test for GitHub poll job lifecycle

**Description:** Add an online integration test verifying the full GitHub poll job lifecycle: seed, process, reschedule.

**Agent type:** coder

**Depends on:** Task 3.2

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/tests/online/job-queue/github-poll-lifecycle.test.ts`:
   - Spin up daemon with GitHub polling configured (mock token, dev proxy).
   - Verify initial `github_poll` job is created.
   - Wait for the job to be processed (poll `getJob()` status).
   - Assert job completed successfully.
   - Assert a new pending `github_poll` job exists with future `runAt`.
   - Verify no duplicate `github_poll` jobs.
3. Run `bun run check` and `make test-daemon`.

**Acceptance criteria:**
- Online test demonstrates full poll job lifecycle.
- Job self-reschedules correctly.
- No duplicate jobs.
- No regressions.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
