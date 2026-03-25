# M2: Runtime Reliability -- Error Detection + Dead Loops + Tick Persistence

> **⚠️ Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Acceptance Criteria

- [ ] Dead loop detection catches condition gate bounce loops.
- [ ] Space ticks are persistent across daemon restarts via JobQueue.
- [ ] Event-driven tick wake-up reduces reaction latency.

---

## Task 3: Dead Loop Detection for Space Workflow Gates

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Port dead loop detection from Room to Space. Track condition gate failures per workflow run, detect repeated failures with similar reasons.

- **Files to create:**
  - `packages/daemon/src/lib/space/runtime/dead-loop-detector.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `processRunTick()` where `WorkflowTransitionError` is caught

- **Interface design** (adapted from Room's `DeadLoopDetector`):
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
  1. Reuse Room's Levenshtein similarity algorithm from `room/runtime/dead-loop-detector.ts`. Extract to a shared utility or import directly (both are in the same monorepo package).
  2. Store gate failure history in `SpaceWorkflowRunRepository` via the `config` JSON column on `space_workflow_runs` (key: `gateFailures`). This avoids schema migrations.
  3. In `SpaceRuntime.processRunTick()`, when a `WorkflowTransitionError` is caught (the block that currently emits `workflow_run_needs_attention`), record the failure and check for dead loops before emitting the notification.
  4. On dead loop detection: fail the workflow run with status `needs_attention`, emit a diagnostic `workflow_run_completed` event with a clear message.

- **Integration point:** `space-runtime.ts`, in `processRunTick()` around the `WorkflowTransitionError` catch block (currently at approximately line 770). The error's `message` property contains the gate failure reason.

- **Edge cases:**
  - Failures across different gates should NOT be counted together (filter by `stepNodeId`).
  - Similarity threshold prevents counting genuinely different failures as a loop.
  - Race condition: two ticks processing the same run simultaneously. Mitigation: use the run's `updated_at` timestamp as an optimistic lock.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/dead-loop-detector.test.ts`
  - Test scenarios: (a) < threshold failures → no dead loop, (b) >= threshold failures with high similarity → dead loop detected, (c) >= threshold failures with low similarity → no dead loop (different issues), (d) diagnostic message format verification, (e) failures across different gates are independent

- **Acceptance Criteria:** Workflow runs that bounce ≥5 times on the same condition gate within 5 minutes (Levenshtein similarity ≥0.75) are detected and failed with a diagnostic message containing the gate name, bounce count, and last failure reason.

---

## Task 7: JobQueue Integration for Space Tick Loop

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** None
- **Description:** Replace Space's `setInterval`-based tick loop with the persistent JobQueue system.

- **Files to create:**
  - `packages/daemon/src/lib/job-handlers/space-tick.handler.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/job-queue-constants.ts` -- add `SPACE_TICK = 'space.tick'`
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- `start()` and `stop()` methods, add `scheduleImmediateTick()` method
  - `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` -- handler registration, config interface, `start()` method
  - `packages/daemon/src/lib/rpc-handlers/index.ts` -- bootstrap seeding

- **Implementation approach:**
  1. **Config interface change** -- Add `jobQueue` and `jobProcessor` to `SpaceRuntimeServiceConfig` (at `space-runtime-service.ts:25`). Currently the interface has `db`, `spaceManager`, `spaceAgentManager`, `spaceWorkflowManager`, `workflowRunRepo`, `taskRepo`, `taskAgentManager?`, `tickIntervalMs?`, `notificationSink?`. Add:
     ```ts
     export interface SpaceRuntimeServiceConfig {
       // ... existing fields ...
       jobQueue?: JobQueueRepository;       // NEW: for persistent tick scheduling
       jobProcessor?: JobQueueProcessor;     // NEW: for handler registration
     }
     ```
     Both fields are optional to maintain backward compatibility during migration. The `start()` method should only register the JobQueue handler when `jobQueue` and `jobProcessor` are provided.
  2. **Handler pattern** -- Follow `packages/daemon/src/lib/job-handlers/room-tick.handler.ts` exactly:
     ```ts
     // space-tick.handler.ts
     export const DEFAULT_SPACE_TICK_INTERVAL_MS = 10_000; // 10s (Space uses faster ticks than Room's 30s)

     export function enqueueSpaceTick(
       spaceId: string,
       jobQueue: JobQueueRepository,
       delayMs: number = DEFAULT_SPACE_TICK_INTERVAL_MS
     ): void;
     // Maintains at most one pending tick per space.

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
  3. **Registration** -- In `SpaceRuntimeService.start()`, register the handler:
     ```ts
     this.jobProcessor.register(SPACE_TICK, createSpaceTickHandler(
       () => this.spaceRuntime,
       this.jobQueue
     ));
     ```
  4. **Replace setInterval** -- In `SpaceRuntime.start()`, replace the `setInterval` with a single `enqueueSpaceTick()` call. The handler's re-enqueue loop replaces the polling loop.
  5. **Event-driven wake-up** -- Add a `scheduleImmediateTick()` method that enqueues a tick with `delayMs: 0`. Call this from:
     - `SpaceTaskManager.setTaskStatus()` (via a callback in `SpaceRuntimeConfig`)
     - `SpaceWorkflowRunRepository.updateStatus()` (via a callback)
     - Human gate resolution in `WorkflowExecutor`
  6. **Bootstrap seeding** -- In `rpc-handlers/index.ts`, seed ticks for all active spaces on startup, subscribe to `space.created` for new spaces.

- **Edge cases:**
  - SpaceRuntime is shared (one instance for all spaces). The tick handler calls `runtime.executeTick()` which processes ALL spaces. Per-space isolation comes from the JobQueue job key (each space gets its own pending job).
  - If SpaceRuntime is null (not yet initialized), the handler should re-enqueue with a retry delay.
  - On shutdown, call `cancelPendingSpaceTickJobs()` for all active spaces.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-tick-handler.test.ts`
  - Test scenarios: (a) handler enqueues next tick after execution, (b) at most one pending tick per space, (c) cancel removes pending ticks, (d) handler re-enqueues when runtime is null (retry), (e) tick fires across simulated restart (Job is persistent in DB)

- **Acceptance Criteria:** (a) Space ticks are persistent across daemon restarts. (b) Event-driven wake-up reduces reaction latency from 5s to near-immediate. (c) Per-space job isolation. (d) Unit tests pass.
