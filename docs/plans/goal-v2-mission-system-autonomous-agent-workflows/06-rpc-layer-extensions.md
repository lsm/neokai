# Milestone 6: RPC Layer Extensions

## Milestone Goal

Extend the existing `goal.create` and `goal.update` RPC handlers to accept and persist the new mission V2 fields (`missionType`, `autonomyLevel`, `structuredMetrics`, `schedule`, `schedulePaused`). Add two new RPCs: `goal.update_kpi` and `goal.trigger_replan`. Update `DaemonEventMap` and `GoalManagerLike` to include the new operations.

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
   - If goal is `needs_human`, reactivates it to `active` first
   - Resets planning context so the runtime will spawn a new planning group on the next tick
   - Emits `goal.updated` event
   - Returns `{ goal, queued: true }`
   - Note: this does NOT directly spawn a planning group; it puts the goal back into a state that the runtime tick will act on. The actual replanning logic lives in `RoomRuntime`.

5. Update `GoalManagerLike` type alias in `goal-handlers.ts` to include any new manager methods referenced by the new handlers (e.g., `recordMetric`, `updateGoalFields` if added).

6. Update `DaemonEventMap` in `packages/daemon/src/lib/daemon-hub.ts` -- add the `goal.task.auto_completed` event if not already added in Milestone 5 (consolidate here if Milestone 5 was done separately).

7. Export the two new RPC names from the shared MessageHub type registry if the project uses a typed RPC registry (check `packages/shared/src/message-hub/` for an RPC name registry or type map and add `goal.update_kpi` and `goal.trigger_replan` if applicable).

8. Update `packages/daemon/tests/unit/rpc-handlers/goal-handlers.test.ts`:
   - `goal.create` with `missionType = 'measurable'` and `structuredMetrics` passes validation and calls `createGoal` with correct params
   - `goal.create` with `missionType = 'recurring'` and valid cron passes; invalid cron throws
   - `goal.update` with new V2 fields passes them through correctly
   - `goal.update_kpi`: happy path, missing goalId error, non-finite value error
   - `goal.trigger_replan`: happy path, goal not found error, already archived error
   - Existing handler tests still pass

**Acceptance Criteria**:
- `goal.create` accepts and persists `missionType`, `autonomyLevel`, `structuredMetrics`, `schedule`, `schedulePaused`
- `goal.update` accepts and persists all V2 fields
- `goal.update_kpi` records a KPI data point and emits a progress update
- `goal.trigger_replan` reactivates and queues replanning, emits `goal.updated`
- Input validation rejects invalid cron expressions, non-finite KPI values, and archived goals
- `goal.task.auto_completed` is in `DaemonEventMap`
- All new and existing handler tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Milestone 1 (types), Milestone 2 (GoalManager methods), Milestone 3 (recordMetric), Milestone 4 (cron validation), Milestone 5 (DaemonEventMap entry)
