# M2: Workflow Reliability

> **Design revalidation notice:** Before implementing any task, revalidate file paths, function signatures, and integration points against the current codebase.

**Milestone goal:** After this milestone, workflows survive daemon restarts, detect and recover from dead loops, handle API rate limits gracefully, and classify errors for automatic or semi-automatic recovery.

**Scope:** Transition map fix (data-model prerequisite), dead loop detection, persistent tick recovery, rate limit handling, error classification, and runtime recreation hardening.

---

## Task 2.1: Fix Missing Task Status Transitions

**Priority:** P0 (blocks Task 2.2 -- rate limit handling requires this transition)
**Agent type:** coder
**Depends on:** nothing

### Description

The `VALID_SPACE_TASK_TRANSITIONS` map in `packages/daemon/src/lib/space/managers/space-task-manager.ts:26` does NOT include `in_progress -> rate_limited` or `in_progress -> usage_limited` as valid transitions. Even if the error classification pipeline (Task 2.5) is built and correctly identifies a rate-limited error, attempting to transition a task to `rate_limited` will throw an `Invalid status transition` error. This is a data-model-level prerequisite that must be fixed before any error handling task.

### Subtasks

1. Read `VALID_SPACE_TASK_TRANSITIONS` in `space-task-manager.ts` to confirm the current state.
2. Add `rate_limited` and `usage_limited` to the valid transitions FROM `in_progress`:
   - `in_progress -> rate_limited`
   - `in_progress -> usage_limited`
3. Verify the existing outbound transitions from `rate_limited` and `usage_limited` are correct (they should allow returning to `pending` or `in_progress` for retry).
4. Add unit tests for each new transition.
5. Document the transition map in a code comment for future maintainers.

### Files to modify

- `packages/daemon/src/lib/space/managers/space-task-manager.ts` -- Update `VALID_SPACE_TASK_TRANSITIONS`

### Implementation approach

This is a one-line change per transition in the transition map. The map is a `Record<SpaceTaskStatus, SpaceTaskStatus[]>`. Verify that `rate_limited` and `usage_limited` are already defined as valid `SpaceTaskStatus` values in the shared types.

### Edge cases

- Invalid status values -- TypeScript will catch at compile time.
- Existing tasks in these statuses (if any) -- verify they can transition to valid next states.

### Testing

- Unit test: `setTaskStatus(taskId, 'rate_limited')` succeeds when task is `in_progress`.
- Unit test: `setTaskStatus(taskId, 'usage_limited')` succeeds when task is `in_progress`.
- Unit test: `setTaskStatus(taskId, 'rate_limited')` throws when task is `pending`.
- Unit test: Existing transitions are not affected.

### Acceptance criteria

- [ ] `in_progress -> rate_limited` is a valid transition
- [ ] `in_progress -> usage_limited` is a valid transition
- [ ] Outbound transitions from `rate_limited`/`usage_limited` allow retry
- [ ] Unit tests cover all new transitions
- [ ] Existing transitions are not affected
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 2.2: Dead Loop / Infinite Bounce Detection

**Priority:** P0
**Agent type:** coder
**Depends on:** nothing

### Description

Add detection for workflows that bounce between the same nodes repeatedly without making progress. The current `maxIterations` cap only applies to edges explicitly marked `isCyclic: true`. If a user creates a cycle without this flag, or a DAG with repeated gate failures, the run enters `needs_attention` but the notification system fires repeatedly (the notification dedup set is cleared on status changes), potentially causing notification storms.

### Subtasks

1. Add a `bounceCounter` to `SpaceWorkflowRun` (DB column + type): tracks how many times `advance()` has been called on the same node sequence (e.g., A -> B -> A -> B). Increment when `currentNodeId` returns to a previously-visited node within a window.
2. Add `maxBounces` to `SpaceWorkflow` (config, default 10): threshold beyond which the run is escalated to `needs_attention` with a descriptive reason.
3. In `WorkflowExecutor.advance()`, after updating `currentNodeId`, check if the new node was recently visited (maintain a ring buffer of the last N node IDs in `run.config._nodeHistory`). If a cycle is detected and `bounceCounter >= maxBounces`, set `needs_attention`.
4. Emit a `workflow_run_needs_attention` notification with `reason: "Dead loop detected: cycle A -> B -> A detected after N bounces"`.

### Files to modify/create

- `packages/shared/src/types/space.ts` -- Add `bounceCounter` to `SpaceWorkflowRun`
- `packages/daemon/src/storage/repositories/space-workflow-run-repository.ts` -- Add `bounceCounter` column
- `packages/daemon/src/storage/schema/migrations.ts` -- Add migration for new column
- `packages/daemon/src/lib/space/runtime/workflow-executor.ts` -- Add bounce detection in `advance()`
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- Emit notification on bounce detection

### Implementation approach

Store a `nodeHistory` ring buffer (last 10 node IDs) in `run.config._nodeHistory`. On each `advance()`, append the new `currentNodeId` and check if the last 4 entries form a cycle. If cycle detected, increment `bounceCounter`. If `bounceCounter >= maxBounces`, escalate.

The `nodeHistory` and `bounceCounter` are persisted in the DB so they survive daemon restarts. The ring buffer is compact and O(1) per advance.

### Edge cases

- Legitimate iterative workflows (e.g., Plan -> Code -> Verify -> Plan) -- these should use `isCyclic: true` on the Verify -> Plan edge, which uses the existing `maxIterations` cap. The bounce detector should NOT interfere with explicitly-marked cycles.
- Single-node self-loops (edge from A to A) -- detected immediately.
- DAG merge paths (e.g., A -> B, A -> C, B -> D, C -> D) -- these revisit D but it is a merge, not a cycle. The ring buffer check should verify a repeated PATTERN, not just a repeated node.

### Testing

- Unit test: Dead loop detected after N bounces (not marked isCyclic).
- Unit test: Explicitly-marked cycles still use maxIterations (not bounceCounter).
- Unit test: DAG merge paths do not trigger bounce detection.
- Unit test: bounceCounter persists across daemon restart (rehydrate from DB).

### Acceptance criteria

- [ ] Unmarked cycles are detected within `maxBounces` advances
- [ ] Run is set to `needs_attention` with descriptive reason
- [ ] Notification is emitted to Space Agent
- [ ] Explicitly-marked `isCyclic` cycles are NOT affected by bounce detection
- [ ] DAG merge paths do NOT trigger false positives
- [ ] Bounce counter persists across daemon restart
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 2.3: Rate Limit / Usage Limit Handling at Workflow Level

**Priority:** P1
**Agent type:** coder
**Depends on:** Task 2.1 (transition map fix), Task 2.5 (error classification)

### Description

When a step agent hits rate limits or usage limits, the error is surfaced as a session error and the group member is marked `failed`. However, the workflow run does not have a mechanism to automatically retry or signal that the error is transient. Add rate limit detection and automatic retry-with-backoff for transient API errors.

### Subtasks

1. In `TaskAgentManager`, subscribe to `session.error` events for step agent sub-sessions (already partially done -- see `registerCompletionCallback` in task-agent-manager.ts which handles `session.error`).
2. Use the error classifier from Task 2.5 to classify the error. If `category === 'rate_limited'`:
   - Set the step task status to `rate_limited` (now valid after Task 2.1).
3. Add a retry-after mechanism: when a step task is `rate_limited`, the `SpaceRuntime.processRunTick()` should:
   - Skip the task (do not escalate to `needs_attention`)
   - Wait until a configurable `retryAfterMs` has elapsed (default 60s)
   - Reset the task to `in_progress` so it gets re-spawned on the next tick
4. Add `retryAfterMs` to the task's config (stored in `task.error` as a JSON payload for backward compatibility).
5. Emit a `task_timeout`-style notification for rate-limited tasks so the Space Agent is aware.

### Files to modify

- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- Error classification in error handler
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- Rate-limited task handling in `processRunTick()`
- `packages/daemon/src/lib/space/managers/space-task-manager.ts` -- Status transitions (Task 2.1 adds the map entries)

### Implementation approach

The `session.error` handler in `TaskAgentManager.registerCompletionCallback()` already marks the member as `failed`. Enhance it to use the error classifier (Task 2.5) and set task status to `rate_limited` when appropriate. The `processRunTick()` method in SpaceRuntime already checks for `needs_attention` and `in_progress` tasks -- add a `rate_limited` branch that checks the elapsed time and resets to `pending` for re-spawn.

### Edge cases

- Rate limit during multi-agent parallel step -- only reset the affected task, not the entire step. The step only advances when ALL tasks complete.
- Persistent rate limiting (days) -- cap retry attempts and escalate to `needs_attention` after N retries (e.g., 5).
- Rate limit on the Task Agent itself (not a step agent) -- this should be handled at the session level, not the workflow level.

### Testing

- Unit test: Rate limit error on step agent sets task to `rate_limited`
- Unit test: Non-rate-limit error still marks task as `needs_attention`
- Unit test: Rate-limited task is retried after `retryAfterMs` elapses
- Unit test: Rate limit retry cap (5 attempts) escalates to `needs_attention`
- Unit test: Multi-agent step: only affected task is retried, others continue

### Acceptance criteria

- [ ] Rate limit errors are classified correctly
- [ ] Rate-limited tasks are automatically retried after backoff period
- [ ] Retry count is capped and escalates to `needs_attention`
- [ ] Non-rate-limit errors still escalate immediately
- [ ] Multi-agent steps handle partial rate limiting correctly
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 2.4: Pending Run Recovery and Runtime Recreation Hardening

**Priority:** P1
**Agent type:** coder
**Depends on:** nothing

### Description

Ensure that `SpaceRuntimeService` reliably recreates all active runtimes on daemon startup and that orphaned runs (created but never started) are recovered. This combines two related reliability concerns: (a) orphaned run recovery when the daemon crashes between run creation and task creation, and (b) runtime recreation health checks with retry logic.

### Subtasks

1. **Orphaned run recovery** -- In `SpaceRuntime.rehydrateExecutors()`, after rehydrating executors, scan for `in_progress` runs that have zero tasks in `space_tasks`. For these orphaned runs:
   - Create the initial task(s) using the workflow's start node (same logic as `startWorkflowRun`).
   - Log a warning about the recovery.
2. **Stuck run detection** -- In `processRunTick()`, if the current step has zero tasks and the run has been `in_progress` for more than 60 seconds (stuck), attempt to create the missing tasks.
3. **Runtime recreation retry** -- Audit `SpaceRuntimeService.createOrGetRuntime()` for error handling. Wrap creation in retry logic with exponential backoff (3 attempts, 1s/2s/4s). If all retries fail, log the error but do not crash daemon startup.
4. **Startup health check** -- After creating all runtimes on startup, iterate `workflowRunRepo.getRehydratableRuns()` for each space and verify that each run has an executor in the runtime's executor map. Log discrepancies and attempt recovery.
5. **Missing executor recovery** -- If a run is missing an executor after the health check, attempt to create the runtime for that space and re-run the executor creation. If that also fails, mark the run as `needs_attention` with reason "Runtime recreation failed after daemon restart."

### Files to modify

- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- Add orphaned run recovery in `rehydrateExecutors()` and `processRunTick()`
- `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` -- Add retry logic and health check

### Implementation approach

After the existing `rehydrateExecutors()` loop, add a second pass that checks each rehydrated executor for zero tasks. If found, call the same task-creation logic used in `startWorkflowRun()`. The `startWorkflowRun` method is idempotent in terms of task creation -- it creates tasks for the `startNodeId` and the `currentNodeId` will match after rehydration.

For runtime recreation, wrap `createOrGetRuntime()` in a retry loop. The health check runs after all runtimes are created during daemon startup.

### Edge cases

- Run's workflow was deleted while the run was in progress -- skip the run, log warning.
- Run's start node was deleted from the workflow definition -- cancel the run.
- Run already has tasks but they are all `cancelled` -- this is a legitimate state, do not create more tasks.
- Database is locked or corrupted during health check -- fail gracefully, log error, do not crash daemon startup.
- Hundreds of spaces -- health check should be fast (single indexed query + Map lookup).

### Testing

- Unit test: Orphaned run (in_progress, no tasks) gets initial tasks created on rehydrate.
- Unit test: Run with deleted workflow is skipped with warning.
- Unit test: Run with tasks is not affected.
- Unit test: Missing executor is detected and recreated after retry.
- Unit test: Runtime creation failure marks run as needs_attention.
- Unit test: Health check is fast (< 100ms for 100 spaces).
- Integration test: Simulate crash between run creation and task creation, verify recovery.

### Acceptance criteria

- [ ] Orphaned runs get their initial tasks created automatically
- [ ] Recovery logs a warning for visibility
- [ ] Runs with deleted workflows are skipped safely
- [ ] Existing runs with tasks are not affected
- [ ] Runtime creation has retry logic with exponential backoff
- [ ] Health check runs on daemon startup
- [ ] Missing executors are recreated automatically
- [ ] Unrecoverable runs are marked needs_attention
- [ ] Daemon startup is not blocked by individual runtime failures
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 2.5: Error Classification Pipeline

**Priority:** P1
**Agent type:** coder
**Depends on:** nothing

### Description

Create a centralized error classification pipeline that categorizes step agent errors into actionable categories: transient (retry), permanent (escalate), and rate-limited (backoff). This pipeline is consumed by both the notification system and the automatic retry logic.

### Subtasks

1. Create `packages/daemon/src/lib/space/runtime/error-classifier.ts`:
   - `classifyError(error: Error): ErrorCategory` function
   - Categories: `transient` (network timeouts, 5xx), `rate_limited` (429, rate limit), `permanent` (auth errors, invalid requests), `unknown`
   - Each category carries a suggested action: `retry`, `backoff`, `escalate`, `log_and_continue`
2. Integrate into `TaskAgentManager`'s `session.error` handler to replace the current hardcoded `failed` marking.
3. Integrate into `SpaceRuntime.processRunTick()` to apply the suggested action per category.

### Files to modify/create

- `packages/daemon/src/lib/space/runtime/error-classifier.ts` -- NEW
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- Use classifier in error handler
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- Apply suggested actions in tick

### Implementation approach

The classifier uses string matching on error messages (the SDK does not provide structured error codes for all providers). Pattern matching should cover:
- `rate_limit_error`, `429` -> `rate_limited`
- `overloaded_error`, `503`, `529` -> `transient`
- `authentication_error`, `401`, `403` -> `permanent`
- Everything else -> `unknown` (default to `escalate`)

### Edge cases

- Error message is null or empty -> `unknown`.
- Error from non-Anthropic provider (e.g., GLM) with different error format -> `unknown`.
- Multiple errors in rapid succession -> classifier is stateless, each error is classified independently.

### Testing

- Unit test: Rate limit error classified as `rate_limited`.
- Unit test: 5xx error classified as `transient`.
- Unit test: Auth error classified as `permanent`.
- Unit test: Unknown error classified as `unknown`.
- Unit test: Null/empty error classified as `unknown`.

### Acceptance criteria

- [ ] Error classifier correctly categorizes common API errors
- [ ] TaskAgentManager uses classifier instead of hardcoded `failed`
- [ ] SpaceRuntime applies suggested actions in tick loop
- [ ] Classifier is stateless and testable in isolation
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
