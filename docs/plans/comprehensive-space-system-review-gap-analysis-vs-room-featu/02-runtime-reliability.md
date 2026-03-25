# M2: Runtime Reliability

> **Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Goal

Add automatic failure detection, persistent tick scheduling, and error classification so that workflow execution continues reliably across daemon restarts, API failures, and rate limits. After this milestone, the runtime will detect infinite loops, persist its tick loop across restarts, and automatically handle rate limits and usage limits.

## Milestone Acceptance Criteria

- [ ] Dead loop detection catches condition gate bounce loops and fails the run with a diagnostic message.
- [ ] Space ticks are persistent across daemon restarts via JobQueue.
- [ ] Full error classification pipeline watches for API errors in Space sessions with automatic recovery.

---

## Task 4: Dead Loop Detection for Space Workflow Gates

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** When a condition-type gate on a transition repeatedly fails (e.g., a shell expression that always returns non-zero), the workflow run stays in `needs_attention` indefinitely, burning API credits on every tick. Port dead loop detection from Room's `DeadLoopDetector` to Space.

- **Files to create:**
  - `packages/daemon/src/lib/space/runtime/dead-loop-detector.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `processRunTick()` where `WorkflowTransitionError` is caught (around line 786)

- **Interface design** (adapted from Room's `room/runtime/dead-loop-detector.ts`):
  ```ts
  interface SpaceGateFailureRecord {
    workflowRunId: string;
    stepNodeId: string;
    reason: string;
    timestamp: number;
  }

  interface SpaceDeadLoopConfig {
    maxFailures: number;          // default: 5
    rapidFailureWindow: number;   // default: 5 * 60 * 1000 (5 min)
    reasonSimilarityThreshold: number; // default: 0.75
  }

  function checkSpaceDeadLoop(
    failures: SpaceGateFailureRecord[],
    config?: SpaceDeadLoopConfig
  ): { isDeadLoop: boolean; reason: string; failureCount: number; gateName: string } | null;
  ```

- **Implementation approach:**
  1. Reuse Room's Levenshtein similarity algorithm. Import directly from `room/runtime/dead-loop-detector.ts` (same package).
  2. Store gate failure history in the `config` JSON column on `space_workflow_runs` (key: `gateFailures`). No schema migration needed.
  3. In `SpaceRuntime.processRunTick()`, when a `WorkflowTransitionError` is caught, record the failure and check for dead loops before emitting the notification.
  4. On dead loop detection: fail the workflow run with status `needs_attention`, emit a diagnostic `workflow_run_completed` event.

- **Integration point:** `space-runtime.ts` line ~786, the `WorkflowTransitionError` catch block.

- **Edge cases:**
  - Failures across different gates should NOT be counted together (filter by `stepNodeId`).
  - Similarity threshold prevents counting genuinely different failures as a loop.
  - Race condition: two ticks processing the same run simultaneously. Mitigation: use the run's `updated_at` timestamp as an optimistic lock.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/dead-loop-detector.test.ts`
  - Test scenarios: (a) < threshold failures -- no dead loop, (b) >= threshold failures with high similarity -- dead loop detected, (c) >= threshold failures with low similarity -- no dead loop, (d) diagnostic message format verification, (e) failures across different gates are independent

- **Acceptance Criteria:** Workflow runs that bounce 5+ times on the same condition gate within 5 minutes (Levenshtein similarity >= 0.75) are detected and failed with a diagnostic message. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 5: JobQueue Integration for Space Tick Loop

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Space's tick loop uses `setInterval` in `SpaceRuntime.start()` (line 227). If the daemon restarts, the interval is lost and workflow runs stop advancing until the next daemon start. Replace with the persistent JobQueue system that Room already uses.

- **Files to create:**
  - `packages/daemon/src/lib/job-handlers/space-tick.handler.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/job-queue-constants.ts` -- add `SPACE_TICK = 'space.tick'`
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `start()` and `stop()` methods
  - `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` -- handler registration, config interface, `start()` method

- **Implementation approach:**
  1. **Config interface change** -- Add optional fields to `SpaceRuntimeServiceConfig` (at `space-runtime-service.ts:25`):
     ```ts
     export interface SpaceRuntimeServiceConfig {
       // ... existing fields ...
       jobQueue?: JobQueueRepository;
       jobProcessor?: JobQueueProcessor;
     }
     ```
  2. **Handler pattern** -- Follow `packages/daemon/src/lib/job-handlers/room-tick.handler.ts` exactly:
     ```ts
     export const DEFAULT_SPACE_TICK_INTERVAL_MS = 10_000; // 10s

     export function enqueueSpaceTick(
       spaceId: string,
       jobQueue: JobQueueRepository,
       delayMs: number = DEFAULT_SPACE_TICK_INTERVAL_MS
     ): void;

     export function cancelPendingSpaceTickJobs(
       spaceId: string,
       jobQueue: JobQueueRepository
     ): void;

     export function createSpaceTickHandler(
       getRuntime: () => SpaceRuntime | null,
       jobQueue: JobQueueRepository,
       tickIntervalMs: number = DEFAULT_SPACE_TICK_INTERVAL_MS
     ): JobHandler;
     ```
  3. **Registration** -- In `SpaceRuntimeService.start()`, register the handler when `jobQueue` and `jobProcessor` are provided.
  4. **Replace setInterval** -- In `SpaceRuntime.start()`, when JobQueue is available, use `enqueueSpaceTick()` instead of `setInterval`.
  5. **Event-driven wake-up** -- Add `scheduleImmediateTick()` method that enqueues with `delayMs: 0`. Call from `SpaceTaskManager.setTaskStatus()` and human gate resolution.

- **Edge cases:**
  - SpaceRuntime is shared (one instance for all spaces). The tick handler calls `runtime.executeTick()` which processes ALL spaces.
  - If SpaceRuntime is null (not yet initialized), the handler should re-enqueue with a retry delay.
  - On shutdown, call `cancelPendingSpaceTickJobs()` for all active spaces.
  - Backward compatibility: when `jobQueue` is not provided, fall back to `setInterval`.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-tick-handler.test.ts`
  - Test scenarios: (a) handler enqueues next tick after execution, (b) at most one pending tick per space, (c) cancel removes pending ticks, (d) handler re-enqueues when runtime is null, (e) tick fires across simulated restart

- **Acceptance Criteria:** Space ticks are persistent across daemon restarts. Event-driven wake-up reduces reaction latency. Unit tests pass. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 6: Error Classification Pipeline for Space

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** Task 1 (transition map fix -- see `01-workflow-execution-foundation.md`)
- **Description:** Build the full error classification and auto-recovery pipeline for Space. When a step agent session encounters an API error, the runtime should classify it (terminal/rate_limit/usage_limit/recoverable) and take appropriate action.

- **Files to create:**
  - `packages/daemon/src/lib/space/runtime/space-error-classifier.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- error detection in sub-session lifecycle
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- deferred resume scheduling

- **Implementation approach:**
  1. **Create `SpaceErrorClassifier`** -- Import and reuse Room's `classifyError()` from `room/runtime/error-classifier.ts` and `parseRateLimitReset()` from `room/runtime/rate-limit-utils.ts`. Direct imports within the same package, no extraction needed.
     ```ts
     // space-error-classifier.ts
     import { classifyError } from '../room/runtime/error-classifier';
     import { parseRateLimitReset } from '../room/runtime/rate-limit-utils';
     ```
  2. **Error detection** -- Subscribe to `session.updated` DaemonHub events for sub-sessions in terminal states. When a sub-session errors, get the session's last output and classify it.
  3. **Rate limit handling** (follow Room's pattern):
     ```ts
     if (errorClass.class === 'rate_limit') {
       await taskManager.setTaskStatus(taskId, 'rate_limited', {
         error: `Rate limited. Resets at ${new Date(errorClass.resetsAt!).toISOString()}`
       });
       // Attempt model fallback
       await trySwitchToFallbackModel(sessionId);
       // Schedule deferred resume
       const delayMs = Math.max(0, (errorClass.resetsAt! - Date.now()) + 5000);
       scheduleImmediateTick(delayMs);
     }
     ```
  4. **Model fallback** -- Read `settings.fallbackModels` from `GlobalSettings`. Walk the fallback chain. Follow Room's `trySwitchToFallbackModel()` pattern.
  5. **Usage limit handling** -- No backoff, attempt fallback immediately. If no fallback available, set to `needs_attention`.
  6. **Terminal errors** -- Set task to `needs_attention` with the error message.

- **Edge cases:**
  - Fallback chain exhausted -- set task to `needs_attention` with error "All fallback models exhausted".
  - Backoff time in the past (already expired) -- resume immediately.
  - Multiple sessions in the same task hitting rate limits -- debounce, only handle the first.
  - `usage_limit` -- no backoff, attempt fallback immediately.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-error-classifier.test.ts`
  - Test scenarios: (a) classify 429 as rate_limit, (b) classify 400 as terminal, (c) classify 500 as recoverable, (d) parse rate limit reset time, (e) model fallback chain walks correctly, (f) exhausted fallback chain sets needs_attention

- **Acceptance Criteria:** Space tasks auto-transition to `rate_limited` on 429. Fallback model switching works. Tasks resume after backoff. Unit tests pass. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
