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
1. Add `notificationSink?: NotificationSink` to `SpaceRuntimeConfig` (defaults to `NullNotificationSink`)
2. In `processRunTick()`: after detecting a `WorkflowTransitionError` (gate blocked, run status set to `needs_attention`), emit a `workflow_run_needs_attention` event
3. In `processRunTick()`: after detecting task status is `needs_attention` (check tasks for current step), emit a `task_needs_attention` event
4. In `cleanupTerminalExecutors()`: when a run transitions to `completed`, emit a `workflow_run_completed` event before removing the executor
5. Add timeout detection: in `processRunTick()`, check if any in-progress task for the current step has exceeded a configurable timeout threshold (from `Space.config.taskTimeoutMs`, default: no timeout). If so, emit a `task_timeout` event
6. Update `SpaceRuntimeService` to accept and pass through the `NotificationSink`
7. Write unit tests using a `MockNotificationSink` (collects events in an array) to verify:
   - Gate-blocked run emits `workflow_run_needs_attention`
   - Task with `needs_attention` status emits `task_needs_attention`
   - Completed run emits `workflow_run_completed`
   - Timed-out task emits `task_timeout`
   - Normal advancement (no judgment needed) emits NO notifications

**Acceptance criteria:**
- SpaceRuntime emits structured notifications for all four event types
- Mechanical transitions (advance, unblock, complete) produce zero notifications
- Timeout detection is configurable and defaults to disabled
- All existing SpaceRuntime tests continue to pass (NullNotificationSink default)
- New tests verify each notification type and the no-notification case

**Dependencies:** Task 2.1, Task 1.1 (needs Space.config access for timeout config)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.3: Add needs_attention detection for non-workflow (standalone) tasks

**Description:** Extend SpaceRuntime's tick loop to also check standalone tasks (tasks without a workflowRunId) for `needs_attention` status and timeout, emitting notifications for those as well.

**Agent type:** coder

**Subtasks:**
1. In `executeTick()`, after processing workflow runs, query standalone tasks (no workflowRunId) with `needs_attention` status from the task repository
2. Emit `task_needs_attention` events for standalone tasks that have transitioned to `needs_attention` since the last tick (use a simple "already notified" tracking set keyed by taskId + status, cleared when task leaves `needs_attention`)
3. Check standalone in-progress tasks for timeout using the same configurable threshold
4. Write unit tests for standalone task notification and timeout detection

**Acceptance criteria:**
- Standalone tasks with `needs_attention` trigger notifications
- Standalone task timeouts trigger notifications
- Duplicate notifications are suppressed (same task+status not re-notified until status changes)
- Unit tests cover both standalone notification and dedup behavior

**Dependencies:** Task 2.2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
