# Milestone 3 — API Compatibility Layer

## Goal

Update all RPC handlers for tasks and goals to (a) return `shortId` in responses, and (b) accept either a UUID or short ID wherever an ID is received as input. Also update URL route regexes in the web frontend to accept short ID formats.

## Context

RPC handlers in `packages/daemon/src/lib/rpc-handlers/`:
- `task-handlers.ts` — handles `task.create`, `task.get`, `task.list`, `task.cancel`, `task.setStatus`, `task.reject`, `task.getGroup`, `task.sendHumanMessage`, `task.updateDraft`
- `goal-handlers.ts` — handles `goal.create`, `goal.list`, `goal.get`, `goal.update`, `goal.delete`, `goal.listExecutions`
- `room-handlers.ts` — handles `room.overview` (which embeds task and goal summaries)

The input resolution pattern: create a `resolveTaskId(input, roomId, taskRepo)` helper that checks if the input looks like a UUID (`isUUID(input)`); if not, looks it up via `getTaskByShortId(roomId, input)`. Returns the UUID, or throws `404 Not Found` if neither resolves.

URL routing in `packages/web/src/lib/router.ts` uses patterns like `/room/:roomId/task/:taskId` where `:taskId` matches `[a-f0-9-]+` (UUID-only regex). This must be extended to also match short ID format.

## Tasks

---

### Task 3.1 — ID Resolution Helpers

**Description**: Create `packages/daemon/src/lib/id-resolution.ts` with helper functions for resolving either UUID or short ID to a UUID, for use in all RPC handlers.

**Subtasks**:
1. Create `packages/daemon/src/lib/id-resolution.ts`
2. Implement `resolveTaskId(input: string, roomId: string, taskRepo: TaskRepository): string`:
   - If `isUUID(input)`, return `input` directly (UUID pass-through)
   - Otherwise call `taskRepo.getTaskByShortId(roomId, input)` and return the task's UUID
   - Throw `new Error('Task not found')` with a 404-equivalent message if neither resolves
3. Implement `resolveGoalId(input: string, roomId: string, goalRepo: GoalRepository): string` — same pattern for goals
4. Export both helpers
5. Write unit tests for both resolvers, testing UUID pass-through, short ID resolution, and not-found error

**Acceptance Criteria**:
- `resolveTaskId('d8a578c6-...', roomId, repo)` returns the UUID without DB lookup
- `resolveTaskId('t-42', roomId, repo)` looks up by short ID and returns the UUID
- `resolveTaskId('t-9999', roomId, repo)` throws when task not found
- Unit tests pass

**Depends on**: Milestone 2 complete

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 3.2 — Task RPC Handlers: Return shortId and Accept Short IDs

**Description**: Update `task-handlers.ts` to include `shortId` in all task responses and use `resolveTaskId` for all input IDs.

**Subtasks**:
1. Identify all handler functions in `task-handlers.ts` that receive a task ID as input: `task.get`, `task.cancel`, `task.setStatus`, `task.reject`, `task.getGroup`, `task.sendHumanMessage`, `task.updateDraft`, `task.interruptSession`
2. For each handler that accepts `taskId`, wrap the raw input: `const resolvedId = resolveTaskId(rawTaskId, roomId, taskRepo)` before using it for DB lookup
3. Confirm that `task.list` responses already return full `NeoTask` objects — since `rowToTask()` now maps `short_id`, the `shortId` field will be included automatically
4. For `task.get`, ensure the response includes the `shortId` field
5. Write unit tests for two handlers: `task.get` (assert response contains `shortId`) and `task.cancel` with a short ID input (assert the correct task is cancelled)

**Acceptance Criteria**:
- `task.get` with a short ID input (`t-1`) returns the correct task
- `task.get` response includes `shortId` field
- `task.list` response items include `shortId` field
- Unit tests pass

**Depends on**: Task 3.1

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 3.3 — Goal RPC Handlers: Return shortId and Accept Short IDs

**Description**: Update `goal-handlers.ts` analogously to Task 3.2 for goals.

**Subtasks**:
1. Identify all handler functions in `goal-handlers.ts` that receive a goal ID as input: `goal.get`, `goal.update`, `goal.delete`, `goal.listExecutions`
2. For each handler, use `resolveGoalId` to accept either UUID or short ID
3. Confirm `goal.list` and `goal.get` responses include `shortId` (comes from `rowToGoal()` mapping)
4. Write unit tests for `goal.get` with short ID input and `goal.update` with short ID

**Acceptance Criteria**:
- `goal.get` with `g-1` input returns the correct goal
- `goal.list` response items include `shortId`
- Unit tests pass

**Depends on**: Task 3.1

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 3.4 — Update URL Route Patterns to Accept Short IDs

**Description**: The web router in `packages/web/src/lib/router.ts` uses strict UUID regex patterns for route matching. These must be relaxed to also accept short ID formats (`t-42`, `g-7`, etc.).

**Subtasks**:
1. Open `packages/web/src/lib/router.ts` and locate all route pattern constants:
   - `ROOM_TASK_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/task\/([a-f0-9-]+)$/`
   - `ROOM_SESSION_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)\/session\/([a-f0-9-]+)$/`
   - `SESSION_ROUTE_PATTERN = /^\/session\/([a-f0-9-]+)$/`
   - `ROOM_ROUTE_PATTERN = /^\/room\/([a-f0-9-]+)$/`
   - Other patterns with `[a-f0-9-]+`
2. Update the task/goal ID capture groups to also accept short ID format: change `([a-f0-9-]+)` to `([a-f0-9-]+|[a-z]-\d+)` for segments that can be task or goal IDs. Keep room/session/space ID segments as UUID-only (they are not user-facing short IDs in this milestone).
3. Run `make test-web` to confirm no routing tests break
4. Write unit tests for the updated patterns verifying both UUID and short ID URLs are matched

**Acceptance Criteria**:
- `/room/04062505-.../task/t-42` is matched by `ROOM_TASK_ROUTE_PATTERN`
- `/room/04062505-.../task/d8a578c6-...` still matches (backward compat)
- `make test-web` passes
- Unit tests for updated patterns pass

**Depends on**: Task 3.2, Task 3.3 (conceptually; can be done in parallel but should be shipped together)

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 3.5 — Room Overview Handler: Include shortId in Task and Goal Summaries

**Description**: The `room.overview` RPC handler assembles a `RoomOverview` object containing task and goal summaries. Ensure `shortId` is included in `TaskSummary` and that goal summaries also carry short IDs.

**Subtasks**:
1. Locate `RoomOverview` and `TaskSummary` types in `packages/shared/src/types/neo.ts`
2. Add `shortId?: string` to `TaskSummary` if not already present
3. In `room-handlers.ts` (or `room-manager.ts` where `RoomOverview` is assembled), ensure the `shortId` from each `NeoTask` is propagated into the summary
4. Run `bun run typecheck` to confirm no regressions
5. Verify with a unit test that `room.overview` response task items include `shortId`

**Acceptance Criteria**:
- `room.overview` response contains tasks with `shortId` populated for new tasks
- `TaskSummary` type includes optional `shortId` field
- `bun run typecheck` passes

**Depends on**: Task 3.2, Task 3.3

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.
