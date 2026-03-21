# Milestone 6: Integration Tests and E2E Validation

## Goal

Comprehensive integration tests verifying crash-recovery, job resumption after restart, and end-to-end validation that all migrated subsystems work together through the job queue.

## Scope

- Online integration tests for crash-recovery across all migrated subsystems
- Verify job processing resumes correctly after daemon restart
- Verify no regressions in existing functionality
- Clean up any remaining stale in-memory patterns

## Tasks

### Task 6.1: Integration test -- job queue crash recovery

**Description:** Create integration tests that simulate daemon crash/restart scenarios and verify all job types resume correctly.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root
2. Create `packages/daemon/tests/online/features/job-queue-crash-recovery.test.ts`
3. Test scenarios:
   - **Session title gen recovery:** Enqueue a title gen job, stop daemon before completion, restart daemon, verify job is reclaimed and processed
   - **GitHub poll chain recovery:** Start daemon with GitHub polling, stop daemon mid-poll, restart, verify poll chain resumes without manual intervention
   - **Room tick recovery:** Create a room, start ticking, stop daemon, restart, verify room ticks resume
   - **Cleanup job recovery:** Enqueue cleanup job, stop daemon before it runs, restart, verify cleanup runs
4. Each test uses `createDaemonServer()`, enqueues jobs, then creates a fresh daemon against the same database
5. Run with `NEOKAI_USE_DEV_PROXY=1`

**Acceptance criteria:**
- All four crash-recovery scenarios pass
- Jobs transition correctly through status changes
- No lost jobs after restart
- Self-scheduling chains resume correctly

**Depends on:** Task 2.2, Task 3.2, Task 4.3, Task 5.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 6.2: Cleanup stale in-memory patterns and final verification

**Description:** Remove any remaining dead code from the pre-migration patterns. Run the full test suite to verify no regressions.

**Agent type:** coder

**Subtasks:**
1. Search for remaining `setInterval` patterns in daemon code that should now use job queue:
   - Confirm `GitHubPollingService` has no `setInterval`
   - Confirm `RoomRuntime` has no `setInterval` or `tickTimer`
   - Confirm `SessionManager` has no `pendingBackgroundTasks`
2. Run `bun run check` (lint + typecheck + knip) to catch dead exports
3. Run `make test-daemon` for full daemon test suite
4. Run `make test-web` for full web test suite
5. Fix any failures found
6. Create a summary of all changes made across the milestone

**Acceptance criteria:**
- No `setInterval` for background tasks in migrated subsystems
- No `pendingBackgroundTasks` in SessionManager
- `bun run check` passes (no lint, type, or dead export errors)
- All daemon tests pass
- All web tests pass

**Depends on:** Task 6.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 6.3: E2E test for job queue health indicator (optional)

**Description:** If time permits, add a minimal E2E test that verifies background tasks continue working from the user's perspective -- sessions get titles, rooms tick, etc.

**Agent type:** coder

**Subtasks:**
1. Create `packages/e2e/tests/features/job-queue-background-tasks.e2e.ts`
2. Test via UI:
   - Create a session, send a message, verify the session title updates (title gen job worked)
   - If room UI is available: create a room, verify it shows activity (ticks are happening)
3. All assertions through visible DOM state per E2E rules

**Acceptance criteria:**
- E2E test verifies background tasks work from user perspective
- Session title generation visible in UI
- All assertions via DOM state

**Depends on:** Task 6.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
