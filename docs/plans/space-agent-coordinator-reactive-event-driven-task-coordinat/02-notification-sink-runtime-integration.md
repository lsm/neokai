# Milestone 2: Notification Sink Interface & SpaceRuntime Integration

## Goal

Define a `NotificationSink` interface that SpaceRuntime uses to push structured event notifications after mechanical tick processing. Integrate it into SpaceRuntime's `processCompletedTasks()` and `cleanupTerminalExecutors()` flows so that judgment-requiring events are surfaced without polling.

## Scope

- `NotificationSink` interface with typed event payloads
- SpaceRuntime integration: emit notifications after mechanical state changes
- Timeout detection for stuck tasks
- No LLM involvement -- this milestone is purely the mechanical notification plumbing

---

### Task 2.1: Define NotificationSink interface and event types

**Description:** Create the `NotificationSink` interface and structured event types that SpaceRuntime will use to push notifications. Events are typed so consumers (Space Agent prompt, tests) can handle them consistently.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/src/lib/space/runtime/notification-sink.ts` with:
   - `SpaceNotificationEvent` discriminated union type with event kinds: `task_needs_attention`, `workflow_run_needs_attention`, `task_timeout`, `workflow_run_completed`
   - Each event kind has a typed payload (taskId, runId, spaceId, reason, timestamp, etc.)
   - `NotificationSink` interface with `notify(event: SpaceNotificationEvent): Promise<void>`
   - `NullNotificationSink` implementation (no-op, for tests and default)
2. Export the types from the space runtime module
3. Write unit tests for event type construction and NullNotificationSink

**Acceptance criteria:**
- `SpaceNotificationEvent` is a discriminated union with all four event kinds
- `NotificationSink` interface is clean and testable (single `notify` method)
- `NullNotificationSink` is available for testing and default wiring
- Types are well-documented with JSDoc

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.2: Integrate NotificationSink into SpaceRuntime tick loop

**Description:** Add `NotificationSink` to `SpaceRuntimeConfig`, wire it into the tick loop, and emit notifications for events that require judgment after mechanical processing is complete.

**Agent type:** coder

**Subtasks:**
1. Add `notificationSink?: NotificationSink` to `SpaceRuntimeConfig` (defaults to `NullNotificationSink`). Also add a `setNotificationSink(sink: NotificationSink): void` setter on `SpaceRuntime` for post-construction wiring (needed because `SpaceRuntimeService` is instantiated before the global agent session exists).
2. In `processRunTick()`: after detecting a `WorkflowTransitionError` (gate blocked, run status set to `needs_attention`), emit a `workflow_run_needs_attention` event.
3. **`task_needs_attention` detection (P0 clarification):** The current `processRunTick()` checks `if (run.status === 'needs_attention') return` at the top (line ~435), which handles run-level `needs_attention`. For **task-level** `needs_attention` within an active run: add an explicit check `if (stepTasks.some(t => t.status === 'needs_attention'))` BEFORE the existing `if (!stepTasks.every(t => t.status === 'completed')) return` early-return. When detected, emit a `task_needs_attention` event for each such task, then return early (do not advance). This is a new code path — the current code silently waits.
4. **Deduplication for workflow-bound tasks:** Add a `notifiedTaskSet: Set<string>` (keyed by `taskId:status`) to `SpaceRuntime` to prevent re-notification across ticks. When a workflow-bound task enters `needs_attention` and stays there across multiple ticks (the run is still `in_progress`), only notify once. Clear the entry when the task leaves `needs_attention`. This uses the same dedup mechanism as standalone tasks (Task 2.3), so define the shared dedup logic here.
5. In `cleanupTerminalExecutors()`: when a run transitions to `completed`, emit a `workflow_run_completed` event before removing the executor.
6. Add timeout detection: in `processRunTick()`, check if any `in_progress` task for the current step has exceeded a configurable timeout threshold. Read from `Space.config.taskTimeoutMs` (typed via the new `SpaceConfig` interface from Task 1.1, default: no timeout / `undefined`). If exceeded, emit a `task_timeout` event.
7. Add `setNotificationSink()` setter to `SpaceRuntimeService` that delegates to the underlying `SpaceRuntime` instance(s). Update `SpaceRuntimeServiceConfig` — do NOT add `notificationSink` to the constructor config (it will be set after construction).
8. Write unit tests using a `MockNotificationSink` (collects events in an array) to verify:
   - Gate-blocked run emits `workflow_run_needs_attention`
   - Task with `needs_attention` status emits `task_needs_attention`
   - Same task in `needs_attention` across two ticks emits only ONE notification (dedup)
   - Completed run emits `workflow_run_completed`
   - Timed-out task emits `task_timeout`
   - Normal advancement (no judgment needed) emits NO notifications

**Acceptance criteria:**
- SpaceRuntime emits structured notifications for all four event types
- Mechanical transitions (advance, unblock, complete) produce zero notifications
- `task_needs_attention` is detected via an explicit `stepTasks.some(t => t.status === 'needs_attention')` check — NOT inferred from `WorkflowTransitionError`
- Deduplication prevents repeated notifications for the same task+status across ticks
- Timeout detection uses typed `Space.config.taskTimeoutMs` and defaults to disabled
- `setNotificationSink()` setter available on both `SpaceRuntime` and `SpaceRuntimeService`
- All existing SpaceRuntime tests continue to pass (NullNotificationSink default)
- New tests verify each notification type, dedup, and the no-notification case

**Dependencies:** Task 2.1, Task 1.1 (needs `SpaceConfig` type for `taskTimeoutMs`)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.3: Add needs_attention detection for non-workflow (standalone) tasks

**Description:** Extend SpaceRuntime's tick loop to also check standalone tasks (tasks without a workflowRunId) for `needs_attention` status and timeout, emitting notifications for those as well.

**Agent type:** coder

**Subtasks:**
1. In `executeTick()`, after processing workflow runs, query standalone tasks (no workflowRunId) with `needs_attention` status from the task repository
2. Emit `task_needs_attention` events for standalone tasks, using the shared dedup `Set<string>` from Task 2.2 (keyed by `taskId:status`, cleared when task leaves `needs_attention`)
3. Check standalone in-progress tasks for timeout using the same configurable threshold (`Space.config.taskTimeoutMs`)
4. **Restart contract:** On daemon restart, the in-memory dedup set starts empty. Tasks already in `needs_attention` will be re-notified once on the first tick post-restart. This is correct behavior: the Space Agent session is also new after restart and needs to learn about outstanding issues. No DB persistence for dedup state is needed. Document this contract in code comments.
5. Write unit tests for standalone task notification, timeout detection, and restart re-notification behavior

**Acceptance criteria:**
- Standalone tasks with `needs_attention` trigger notifications
- Standalone task timeouts trigger notifications
- Duplicate notifications are suppressed (same task+status not re-notified until status changes)
- After simulated restart (empty dedup set), already-`needs_attention` tasks are re-notified once
- Unit tests cover standalone notification, dedup, timeout, and restart behavior

**Dependencies:** Task 2.2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
