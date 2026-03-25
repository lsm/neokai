# M5: Human-in-the-Loop

> **Design Revalidation:** Before implementing any task in this milestone, revalidate the referenced file paths, interfaces, and integration points against the current codebase. The codebase is under active development and patterns may have changed since the analysis date.

---

## Milestone Goal

Enable humans to send messages directly to step agent sessions during execution, allowing real-time guidance, course correction, and interactive collaboration with the workflow agents.

## Milestone Acceptance Criteria

- [ ] Humans can route messages to specific Space step agent sessions via the UI.
- [ ] Message routing validates session ownership and rejects invalid targets.
- [ ] Messages appear in the task conversation view in real time.

---

## Task 13: Human Message Routing to Space Step Agents

- **Priority:** MEDIUM
- **Agent Type:** coder
- **Dependencies:** Task 8 (review UI -- see `03-monitoring-debugging.md`)
- **Description:** Add the ability for humans to send messages directly to step agent sessions. Currently, `TaskAgentManager` has `injectMessageIntoSession()` for internal use (e.g., `[STEP_COMPLETE]` notifications), but there is no RPC handler or UI for humans to inject messages. Room has `HumanMessageRouting` that routes to workers or leaders; Space needs equivalent functionality.

- **Files to modify:**
  - `packages/daemon/src/lib/rpc-handlers/space-task-message-handlers.ts` -- add inject handler (file already exists)
  - `packages/web/src/components/space/SpaceTaskDetail.tsx` -- add message input area (created in Task 7)

- **New RPC method:**
  ```ts
  // space.task-message.inject
  // Params: { spaceId: string, taskId: string, sessionId: string, message: string }
  // Action: Validates session belongs to Space task, injects message via TaskAgentManager
  ```

- **Implementation approach:**
  1. Add `spaceTaskMessage.inject` handler in `space-task-message-handlers.ts`.
  2. **Validation:** Look up the session via `SpaceSessionGroupRepository.getGroupsByTask(spaceId, taskId)`, verify the `sessionId` is a member of one of the task's groups.
  3. **Injection:** Call `taskAgentManager.injectSubSessionMessage(sessionId, message)` (private method -- may need to expose a public wrapper).
  4. **Session discovery:** Add `space.task.sessions` RPC that returns session groups for a task (or reuse existing `space.sessionGroup.list` with a task filter).
  5. **UI integration:** In `SpaceTaskDetail.tsx` (from Task 7), add a message input area at the bottom of the conversation view. The input area should have a session selector (dropdown of active step agent sessions for the task) and a text input.

- **Edge cases:**
  - Session is not found or does not belong to the task -- return error.
  - Session is in a terminal state (completed/failed) -- return error with clear message.
  - Task Agent is not running -- return error.
  - Multiple step agent sessions -- user must select which one to message.

- **Testing:**
  - Unit test: verify handler validation rejects invalid session IDs, accepts valid ones.
  - Test file: extend `packages/daemon/tests/unit/rpc-handlers/space-task-message-handlers.test.ts`
  - E2E test: send a message to a step agent session via UI, verify it appears in the conversation.

- **Acceptance Criteria:** Humans can send messages to Space step agent sessions via RPC and UI. Handler validates session ownership. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
