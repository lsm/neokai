# Fix Goal Lifecycle: Reset, Invalidate Stale Planning, Fix isTerminal

## Summary

When a goal's description is updated mid-planning, the planner keeps working on the old description. After cancelling the planning task, the goal gets stuck in `needs_human` with stale state (`linkedTaskIds` referencing archived tasks, `planning_attempts` blocking replanning). This plan addresses four issues:

1. Missing `archived` in `isTerminal()` check within `getNextGoalForPlanning()`
2. No way to reset a goal to its initial state without archiving
3. Goal description updates do not invalidate in-progress planning
4. `planning_attempts` is not writable via `update_goal`

## Approach

All four fixes target three existing files with well-established patterns. A new `reset_goal` MCP tool follows the same two-layer pattern (handler + schema) as existing tools. The `isTerminal` fix is a one-line change. The invalidation hook adds logic to the existing `update_goal` handler. Tests cover all changes using existing in-memory DB test patterns.

---

## Task 1: Fix `isTerminal()` and add `resetGoal()` to GoalManager

**Description:** Fix the `isTerminal` helper in `getNextGoalForPlanning()` to include `archived`, and add a `resetGoal()` method to `GoalManager` that clears linked tasks, resets counters, and sets status to `active`.

**Agent type:** coder

**Depends on:** (none)

**Subtasks:**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`, locate `getNextGoalForPlanning()` around line 3543. Change the `isTerminal` lambda from:
   ```ts
   const isTerminal = (status: string) =>
       status === 'needs_attention' || status === 'cancelled';
   ```
   to:
   ```ts
   const isTerminal = (status: string) =>
       status === 'needs_attention' || status === 'cancelled' || status === 'archived';
   ```
3. In `packages/daemon/src/lib/room/managers/goal-manager.ts`, add a new `resetGoal(goalId: string)` method that:
   - Fetches the goal (throw if not found)
   - Calls `this.goalRepo.updateGoal(goalId, { linkedTaskIds: [], planning_attempts: 0, consecutiveFailures: 0, status: 'active' })`
   - Returns the updated `RoomGoal`
4. Add unit tests in `packages/daemon/tests/unit/room/goal-manager.test.ts`:
   - Test `resetGoal` clears `linkedTaskIds`, resets `planning_attempts` to 0, resets `consecutiveFailures` to 0, and sets status to `active`
   - Test `resetGoal` throws for non-existent goal ID
5. Add a unit test that verifies `isTerminal` treats `archived` as terminal: in `packages/daemon/tests/unit/room/` (new file or existing edge-cases file), create a test that exercises the replanning logic with archived tasks. At minimum, add a focused test in `mission-system-edge-cases.test.ts` verifying that when all linked tasks are `archived`, the goal is eligible for replanning.
6. Run `make test-daemon` to verify all tests pass.
7. Run `bun run check` to verify lint, typecheck, and knip pass.
8. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `isTerminal` in `getNextGoalForPlanning()` returns `true` for `archived` status
- `GoalManager.resetGoal()` exists and resets all four fields
- Unit tests cover both the reset method and the isTerminal fix
- All daemon tests pass; lint and typecheck pass

---

## Task 2: Add `reset_goal` MCP tool and expose `planning_attempts` in `update_goal`

**Description:** Add a new `reset_goal` MCP tool to `room-agent-tools.ts` and update `update_goal` to accept `planning_attempts` as an optional field. The `reset_goal` tool cancels all in-progress linked tasks via the runtime and then calls `GoalManager.resetGoal()`.

**Agent type:** coder

**Depends on:** Task 1

**Subtasks:**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/tools/room-agent-tools.ts`, in `createRoomAgentToolHandlers()`, add a new `reset_goal` handler:
   - Takes `{ goal_id: string }` as input
   - Fetches the goal; return error if not found
   - Iterates `goal.linkedTaskIds`, for each task that is in a non-terminal status (`pending`, `in_progress`, `draft`, `review`, `rate_limited`, `usage_limited`):
     - If `runtimeService` is available and returns a runtime, call `runtime.cancelTask(taskId)`
     - Otherwise fall back to `taskManager.cancelTaskCascade(taskId)`
   - Calls `goalManager.resetGoal(goal_id)`
   - If `daemonHub` is available, emit `goal.updated` event and call `runtime.scheduleTick()` (if runtime exists) so the runtime picks up the reset goal for fresh planning
   - Returns success with the updated goal
3. Register `reset_goal` in the `createRoomAgentMcpServer()` function with a Zod schema:
   ```ts
   tool(
     'reset_goal',
     'Reset a goal to its initial state: cancels all linked tasks, clears linkedTaskIds, resets planning_attempts and consecutiveFailures to 0, and sets status to active. Use when a goal is stuck or needs a fresh start.',
     { goal_id: z.string().describe('ID of the goal to reset') },
     (args) => handlers.reset_goal(args)
   )
   ```
4. Do NOT add `reset_goal` to `createLeaderContextMcpServer()`.
5. In `update_goal` handler, add `planning_attempts` as an optional field:
   - Add `planning_attempts?: number` to the handler args type
   - Add `planning_attempts` to the "no fields provided" guard check
   - Add `planning_attempts` to the `hasPatchFields` check
   - Add `if (args.planning_attempts !== undefined) patch.planning_attempts = args.planning_attempts;` in the patch-building block
6. In `update_goal` schema registration, add:
   ```ts
   planning_attempts: z.number().int().min(0).optional().describe('Reset or set the planning attempts counter')
   ```
7. Update the tool list comment at top of file to include `reset_goal`.
8. Add unit tests for the `reset_goal` handler and the `planning_attempts` field in `update_goal`. Create a new test file `packages/daemon/tests/unit/room/room-agent-tools-goal.test.ts` that:
   - Mocks `GoalManager`, `TaskManager`, `SessionGroupRepository`, and optionally `DaemonHub`/`RoomRuntime`
   - Tests `reset_goal` successfully cancels linked tasks and resets the goal
   - Tests `reset_goal` returns error for non-existent goal
   - Tests `update_goal` with `planning_attempts` field
9. Run `make test-daemon` to verify all tests pass.
10. Run `bun run check` to verify lint, typecheck, and knip pass.
11. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `reset_goal` MCP tool is registered in `createRoomAgentMcpServer` but NOT in `createLeaderContextMcpServer`
- `reset_goal` cancels in-progress linked tasks before resetting
- `reset_goal` triggers a runtime tick after reset
- `update_goal` accepts and persists `planning_attempts`
- Unit tests cover all new functionality
- All daemon tests pass; lint and typecheck pass

---

## Task 3: Goal description update invalidates in-progress planning

**Description:** When `update_goal` changes `title` or `description` and the goal has an in-progress planning task, auto-cancel that planning task and reset `planning_attempts` to 0 so a fresh planner picks it up with the updated context.

**Agent type:** coder

**Depends on:** Task 1, Task 2

**Subtasks:**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/tools/room-agent-tools.ts`, in the `update_goal` handler, after the patch is applied (after `goalManager.patchGoal()`), add invalidation logic:
   - Check if `args.title !== undefined || args.description !== undefined`
   - If so, get the goal's `linkedTaskIds` and find tasks where `taskType === 'planning'` and status is non-terminal (not `completed`, `cancelled`, `archived`)
   - For each such planning task:
     - If `runtimeService` is available, call `runtime.cancelTask(taskId)`
     - Otherwise fall back to `taskManager.cancelTaskCascade(taskId)`
   - Reset `planning_attempts` to 0 via `goalManager.patchGoal(goalId, { planning_attempts: 0 })`
   - If runtime exists, call `runtime.scheduleTick()` to trigger fresh planning
3. Add unit tests in `packages/daemon/tests/unit/room/room-agent-tools-goal.test.ts`:
   - Test that updating `title` cancels in-progress planning tasks and resets `planning_attempts`
   - Test that updating `description` cancels in-progress planning tasks and resets `planning_attempts`
   - Test that updating only `priority` does NOT cancel planning tasks
   - Test that when no planning tasks are in progress, no cancellation occurs
4. Run `make test-daemon` to verify all tests pass.
5. Run `bun run check` to verify lint, typecheck, and knip pass.
6. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Changing `title` or `description` via `update_goal` auto-cancels in-progress planning tasks
- `planning_attempts` is reset to 0 after invalidation
- A runtime tick is scheduled after invalidation
- Non-title/description updates do NOT trigger invalidation
- Unit tests cover all scenarios
- All daemon tests pass; lint and typecheck pass

---

## Task 4: Online integration test for goal lifecycle reset

**Description:** Add an online test that exercises the full goal lifecycle: create goal, spawn planning, update description mid-planning (triggering invalidation), and reset goal.

**Agent type:** coder

**Depends on:** Task 1, Task 2, Task 3

**Subtasks:**

1. Run `bun install` at the worktree root.
2. Identify the existing online test pattern in `packages/daemon/tests/online/` for room/goal-related tests.
3. Create a new online test file `packages/daemon/tests/online/room/goal-lifecycle-reset.test.ts` that:
   - Sets up a daemon server with a room using the existing test helpers
   - Creates a goal via the MCP tool or RPC
   - Verifies the goal is in `active` status
   - Simulates updating the goal description
   - Verifies planning invalidation behavior (planning_attempts reset)
   - Calls `reset_goal` and verifies all fields are cleared
   - Verifies the goal returns to `active` status and is eligible for replanning
4. Run the new test with `NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/goal-lifecycle-reset.test.ts` to verify it passes.
5. Run `bun run check` to verify lint, typecheck, and knip pass.
6. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Online test exercises the full reset and invalidation flow
- Test passes with `NEOKAI_USE_DEV_PROXY=1`
- All checks pass
