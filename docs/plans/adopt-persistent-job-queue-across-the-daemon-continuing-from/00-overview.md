# Plan: Adopt Persistent Job Queue Across the Daemon

## Goal

Wire the existing but unused `JobQueueProcessor` and `JobQueueRepository` into the daemon lifecycle and migrate background tasks from raw `setInterval` patterns to the persistent job queue. This brings persistence across restarts, retry with exponential backoff, stale job reclamation, priority ordering, and live query observability.

## Approach

Follow the phased migration plan from ADR 0002 (`docs/adr/0002-job-queue-migration.md`). Each phase is an incremental, independently deployable change with its own rollback path. The phases build on each other but each leaves the system in a working state.

## Milestones

1. **Wire Processor to App Lifecycle** -- Add `JobQueueProcessor` and `JobQueueRepository` to `DaemonAppContext`, start on boot, stop on shutdown. Connect `ReactiveDatabase` change notifications. No behavior change.
2. **Create Job Handler Infrastructure** -- Create `packages/daemon/src/lib/job-handlers/` with handler types, registration pattern, and a cleanup handler as the first real handler.
3. **Migrate GitHub Polling** -- Replace `setInterval` in `GitHubPollingService` with job-based self-rescheduling. Expose `triggerPoll()` for on-demand polling.
4. **Migrate Room Runtime Tick** -- Replace `setInterval` in `RoomRuntime` with job-based tick scheduling via a `RoomTickScheduler`. Ensure single-tick-per-room guarantee.
5. **Observability and Cleanup** -- Add RPC handlers for job queue status queries, wire live query subscriptions for job status, and schedule recurring cleanup jobs.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (processor must be wired before handlers can be registered)
- Milestone 3 depends on Milestone 2 (handler infrastructure must exist)
- Milestone 4 depends on Milestone 2 (handler infrastructure must exist)
- Milestones 3 and 4 are independent of each other and can be done in either order
- Milestone 5 depends on Milestones 1-2 (needs processor and handler infra)

## Key Sequencing Decisions

- GitHub polling migration (Phase 3) is lower risk and serves as a validation of the job-based pattern before tackling the high-risk room tick migration (Phase 4).
- The cleanup handler is created in Milestone 2 as a simple, low-risk first handler to validate the registration and execution pattern end-to-end.
- Room tick migration preserves the existing tick mutex in `RoomRuntime` as a defense-in-depth measure alongside job deduplication.

## Total Estimated Tasks

17 tasks across 5 milestones

## PR Target

All PRs target the `dev` branch.
