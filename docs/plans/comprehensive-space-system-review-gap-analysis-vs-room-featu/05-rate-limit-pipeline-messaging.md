# M5: Rate Limit Full Pipeline + Human Message Routing

> **⚠️ Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Acceptance Criteria

- [ ] Full error classification pipeline watches for API errors in Space sessions.
- [ ] Automatic rate limit detection with status transition and backoff.
- [ ] Fallback model switching works.
- [ ] Deferred resume after backoff.
- [ ] Humans can route messages to specific Space step agent sessions.

---

## Task 2-Full: Rate Limit Detection Full Pipeline

- **Priority:** HIGH
- **Agent Type:** coder
- **Dependencies:** Task 2 from M1 (transition map fixed -- see `01-foundation.md`)
- **Description:** Build the full error classification, model fallback, and deferred resume pipeline for Space. The transition map prerequisite was fixed in Milestone 1.

- **Files to create:**
  - `packages/daemon/src/lib/space/runtime/space-error-classifier.ts`

- **Files to modify:**
  - `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- error subscription and handling
  - `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- deferred resume scheduling

- **Implementation approach:**
  1. **Create `SpaceErrorClassifier`** -- Import and reuse Room's `classifyError()` and `parseRateLimitReset()` from `room/runtime/error-classifier.ts` and `room/runtime/rate-limit-utils.ts`. No extraction needed -- direct imports within the same package.
     ```ts
     // space-error-classifier.ts
     import { classifyError, ErrorClassification } from '../room/runtime/error-classifier';
     import { createRateLimitBackoff, parseRateLimitReset } from '../room/runtime/rate-limit-utils';

     export function classifySpaceError(message: string): ErrorClassification | null {
       return classifyError(message);
     }
     ```
  2. **Error detection in TaskAgentManager** -- Subscribe to session error events. Room does this inline in `onWorkerTerminalState`. For Space, the equivalent is detecting errors in step agent sessions. Options:
     - (a) Subscribe to `session.updated` events for terminal states, then classify the session's last output.
     - (b) Use SDK message mirroring (not currently implemented for Space).
     - Recommended: (a) -- use the existing `DaemonHub` event `session.updated` with a terminal status filter.
  3. **Rate limit handling** (follow Room's pattern from `room-runtime.ts` lines ~690-770):
     ```ts
     if (errorClass.class === 'rate_limit') {
       await taskManager.setTaskStatus(taskId, 'rate_limited', {
         error: `Rate limited. Resets at ${new Date(errorClass.resetsAt!).toISOString()}`
       });
       // Attempt model fallback
       await trySwitchToFallbackModel(sessionId);
       // Schedule deferred resume
       const delayMs = Math.max(0, (errorClass.resetsAt! - Date.now()) + 5000);
       scheduleImmediateTick(delayMs); // from Task 7 (M2)
     }
     ```
  4. **Model fallback** -- Read `settings.fallbackModels` from `GlobalSettings`. Walk the fallback chain: get current model → find next in chain → call `messageHub.request('session.model.switch', { sessionId, model, provider })`. Follow Room's `trySwitchToFallbackModel()` pattern exactly.
  5. **Deferred resume** -- After the backoff expires, transition the task back to `in_progress`. This requires a timed callback. If Task 7 (JobQueue) is done, use `enqueueSpaceTick(spaceId, jobQueue, delayMs)`. If not, use a `setTimeout` with cleanup on shutdown.

- **Edge cases:**
  - Fallback chain exhausted -- set task to `needs_attention` with error "All fallback models exhausted".
  - Backoff time in the past (already expired) -- resume immediately.
  - Multiple sessions in the same task hitting rate limits -- debounce, only handle the first.
  - `usage_limit` (not 429) -- no backoff, attempt fallback immediately.

- **Testing:**
  - Unit test file: `packages/daemon/tests/unit/space/space-error-classifier.test.ts`
  - Test scenarios: (a) classify 429 as rate_limit, (b) classify 400 as terminal, (c) classify 500 as recoverable, (d) parse rate limit reset time, (e) model fallback chain walks correctly, (f) exhausted fallback chain sets needs_attention
  - Online test file: `packages/daemon/tests/online/space/space-rate-limit.test.ts` (create)
  - Online scenario: Use dev proxy to mock a 429 response, verify task transitions to rate_limited and resumes after backoff.

- **Acceptance Criteria:** Space tasks auto-transition to `rate_limited` on 429. Fallback works. Tasks resume after backoff.

---

## Task 10: Human Message Routing to Space Step Agents

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** Task 4 (review UI -- see `03-goal-integration-hitl-ui.md`)
- **Description:** Add RPC handler for routing human messages to Space step agent sessions.

- **Files to modify:**
  - `packages/daemon/src/lib/rpc-handlers/space-task-message-handlers.ts` -- add inject handler (file already exists)
  - `packages/daemon/src/lib/rpc-handlers/index.ts` -- register new handler

- **New RPC methods:**
  ```ts
  // space.task-message.inject
  // Params: { spaceId: string, taskId: string, sessionId: string, message: string }
  // Action: Validates session belongs to Space task, injects message via TaskAgentManager
  ```

- **Implementation approach:**
  1. Add `spaceTaskMessage.inject` handler in `space-task-message-handlers.ts`.
  2. Validation: Look up the session via `SpaceSessionGroupRepository.getGroupsByTask(spaceId, taskId)`, verify the `sessionId` is a member of one of the task's groups.
  3. Injection: Call `taskAgentManager.injectSubSessionMessage(sessionId, message)`.
  4. Session discovery: Add `space.task.sessions` RPC that returns session groups for a task (or reuse existing `space.sessionGroup.list` with a task filter).

- **Edge cases:**
  - Session is not found or doesn't belong to the task -- return error.
  - Session is in a terminal state (completed/failed) -- return error.
  - Task Agent is not running -- return error.

- **Testing:**
  - Unit test: verify handler validation rejects invalid session IDs, accepts valid ones.
  - Test file: `packages/daemon/tests/unit/space/space-task-message-handler.test.ts`

- **Acceptance Criteria:** Humans can send messages to Space step agent sessions via RPC. Handler validates session ownership.
