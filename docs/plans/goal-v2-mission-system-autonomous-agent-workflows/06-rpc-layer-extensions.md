# Milestone 6: RPC Layer Extensions

## Milestone Goal

Extend the existing `goal.create` and `goal.update` RPC handlers to accept and persist the new mission V2 fields (`missionType`, `autonomyLevel`, `structuredMetrics`, `schedule`, `schedulePaused`). Add three new RPCs: `goal.update_kpi`, `goal.trigger_replan`, and `goal.list_executions`. Update `DaemonEventMap` and `GoalManagerLike` to include the new operations. This milestone is the sole owner of `DaemonEventMap` additions for mission V2 to avoid merge conflicts with Milestones 3–5.

## Tasks

### Task 6.1: Extend Existing RPCs and Add New Goal RPCs

**Agent**: coder
**Description**: Update `packages/daemon/src/lib/rpc-handlers/goal-handlers.ts` to pass new fields through to the storage layer, add `goal.update_kpi` and `goal.trigger_replan` handlers, and update the `GoalManagerLike` type and `DaemonEventMap`.

**Subtasks** (ordered implementation steps):

1. In `packages/daemon/src/lib/rpc-handlers/goal-handlers.ts`, update the `goal.create` handler:
   - Extend the params type to include: `missionType?: MissionType`, `autonomyLevel?: AutonomyLevel`, `structuredMetrics?: MissionMetric[]`, `schedule?: CronSchedule`, `schedulePaused?: boolean`
   - Validate `missionType` if provided (must be one of the allowed values; default to `'one_shot'` if absent)
   - If `missionType === 'measurable'` and `structuredMetrics` provided, validate each metric entry (non-empty name, positive target for `increase`, presence of `baseline` for `decrease`)
   - If `missionType === 'recurring'` and `schedule` provided, validate the cron expression via the `cron-utils` module
   - Pass all new fields through to `goalManager.createGoal()`

2. Update the `goal.update` handler:
   - Extend `updates` type to include the same new fields plus `consecutiveFailures?: number`
   - Dispatch updates to `goalManager.updateGoalStatus()` for status changes, or to a new generic `goalManager.updateGoalFields()` method for the V2 fields (title, description, priority, missionType, autonomyLevel, structuredMetrics, schedule, schedulePaused, nextRunAt, maxConsecutiveFailures, maxPlanningAttempts)
   - **`schedulePaused = false` side effect**: whenever `updates.schedulePaused` is explicitly `false` (resume), the handler MUST recalculate `next_run_at` from `Date.now()` using the goal's existing `schedule.expression` and `schedule.timezone` (via `nextRunAt()` from `cron-utils`), and include the updated `nextRunAt` in the write. This prevents a resumed mission from firing immediately if `next_run_at` is stale/in-the-past. Apply this same rule in all write paths (MCP `resume_schedule` tool in Milestone 4 already does this; this RPC handler must match).
   - Emit `goal.updated` event after successful update

3. Add `goal.update_kpi` handler:
   ```
   Params: { roomId: string; goalId: string; metricName: string; value: number; timestamp?: number }
   ```
   - Validates: roomId, goalId, metricName (non-empty), value (finite number)
   - Calls `goalManager.recordMetric(goalId, metricName, value, timestamp ?? Date.now())`
   - Emits `goal.progressUpdated` event with updated progress
   - Returns `{ goal }` (full updated goal object)

4. Add `goal.trigger_replan` handler:
   ```
   Params: { roomId: string; goalId: string; reason?: string }
   ```
   - Validates: roomId, goalId
   - Fetches the goal; validates it is `active` or `needs_human` (not `completed` or `archived`)
   - Performs the following **exact field mutations** (all in a single `goalManager.updateGoal()` call):
     - `status`: if currently `needs_human`, set to `'active'`; otherwise leave unchanged
     - `replanCount`: increment by 1 (e.g., `(goal.replanCount ?? 0) + 1`)
     - `planningAttempts`: reset to `0` (so the runtime's replanning guard allows a fresh attempt). For recurring missions with an active execution, also call `goalManager.updateExecutionPlanningAttempts(executionId, 0)` to reset `mission_executions.planning_attempts`.
   - How the runtime picks it up: the runtime tick's `getNextGoalForPlanning()` already checks `goal.status === 'active'` and `goal.planningAttempts < maxPlanningAttempts`. Resetting `planningAttempts` to 0 and ensuring `status = 'active'` is sufficient — no additional flag is needed.
   - Emits `goal.updated` event
   - Returns `{ goal, queued: true }`
   - Note: this does NOT directly spawn a planning group; it puts the goal back into a state the runtime tick will act on next cycle.

5. Add `goal.list_executions` handler:
   ```
   Params: { roomId: string; goalId: string; limit?: number }
   ```
   - Validates: roomId, goalId; `limit` defaults to 20, max 100
   - Calls `goalManager.listExecutions(goalId, limit)` (available from Milestone 2 repository layer)
   - Returns `{ executions: MissionExecution[] }` ordered by `execution_number DESC`
   - Registers the RPC name in the shared MessageHub type registry alongside other new RPC names

6. Update `GoalManagerLike` type alias in `goal-handlers.ts` to include any new manager methods referenced by the new handlers (e.g., `recordMetric`, `updateGoalFields`, `listExecutions`, `updateExecutionPlanningAttempts` if added).

7. Update `DaemonEventMap` in `packages/daemon/src/lib/daemon-hub.ts` — this is the **sole location** for all mission V2 event additions:
   ```ts
   'goal.task.auto_completed': {
     sessionId: string;  // 'room:${roomId}'
     roomId: string;
     goalId: string;
     taskId: string;
     taskTitle: string;
     prUrl?: string;
     approvalSource: 'leader_semi_auto';
   };
   ```
   (Milestone 5 emits this event but does not register it in `DaemonEventMap` — that is done here only.)

8. Export all three new RPC names from the shared MessageHub type registry (check `packages/shared/src/message-hub/` for an RPC name registry or type map and add `goal.update_kpi`, `goal.trigger_replan`, and `goal.list_executions`).

9. Update `packages/daemon/tests/unit/rpc-handlers/goal-handlers.test.ts`:
   - `goal.create` with `missionType = 'measurable'` and `structuredMetrics` passes validation and calls `createGoal` with correct params
   - `goal.create` with `missionType = 'recurring'` and valid cron passes; invalid cron throws
   - `goal.update` with `schedulePaused = false` recalculates and persists `nextRunAt`
   - `goal.update` with new V2 fields passes them through correctly
   - `goal.update_kpi`: happy path, missing goalId error, non-finite value error
   - `goal.trigger_replan`: happy path resets `planningAttempts` to 0, increments `replanCount`, sets status to `active` when `needs_human`; archived error
   - `goal.list_executions`: returns ordered list, respects limit cap
   - Existing handler tests still pass

**Acceptance Criteria**:
- `goal.create` accepts and persists `missionType`, `autonomyLevel`, `structuredMetrics`, `schedule`, `schedulePaused`
- `goal.update` accepts and persists all V2 fields; `schedulePaused = false` always recalculates `nextRunAt` from current time
- `goal.update_kpi` records a KPI data point and emits a progress update
- `goal.trigger_replan` sets `status = 'active'` (if `needs_human`), increments `replanCount`, resets `planningAttempts` to 0, emits `goal.updated`
- `goal.list_executions` returns `MissionExecution[]` ordered by execution number descending
- Input validation rejects invalid cron expressions, non-finite KPI values, and archived goals
- `goal.task.auto_completed` is in `DaemonEventMap` (defined here, emitted from Milestone 5)
- All new and existing handler tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Milestone 1 (types), Milestone 2 (GoalManager methods), Milestone 3 (recordMetric), Milestone 4 (cron validation and `croner` package), Milestone 5 (semi-auto logic)
