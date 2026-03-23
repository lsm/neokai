# Milestone 3: Measurable Missions -- Structured Metrics and Adaptive Replanning

## Milestone Goal

Implement the measurable mission type with structured KPI tracking, progress calculation from metric targets, runtime auto-replan logic when targets are not met after task completion, and MCP tools for agents to report metric progress.

## Tasks

### Task 3.1: Measurable Mission Logic in GoalManager and RoomRuntime

**Agent**: coder
**Description**: Add metric management methods to `GoalManager`, update progress calculation for measurable missions, integrate metric-aware replanning into `RoomRuntime`, and expose agent MCP tools for metric reporting.

**Subtasks** (ordered implementation steps):

1. In `packages/daemon/src/lib/room/managers/goal-manager.ts`, add `recordMetric(goalId, metricName, value, timestamp?)`:
   - Insert a row into `mission_metric_history` (via the repository method from Milestone 2)
   - Update `structuredMetrics[metric_name].current` in the `structured_metrics` JSON column
   - Derive and write the legacy `metrics` field (`Record<string, number>` as `{[name]: current}`) for backward compatibility with any existing callers that read `goal.metrics`
   - One writer only -- the only path that mutates `structuredMetrics` goes through `recordMetric`

2. Add `getMetricHistory(goalId, metricName, timeRange?)` wrapper (thin delegation to `GoalRepository`).

3. Add `checkMetricTargets(goalId)` -- returns `{ allMet: boolean; results: Array<{name, met, current, target, direction}> }`:
   - For `direction = 'increase'` (default): `met = current >= target`
   - For `direction = 'decrease'`: `met = current <= target`
   - Validation: reject `target <= 0` for `increase`; reject missing `baseline` or `baseline <= target` for `decrease`; guard against divide-by-zero

4. Add `calculateMeasurableProgress(goal)`:
   - For `increase`: `min(current / target, 1.0) * 100`, averaged across all metrics
   - For `decrease`: `min((baseline - current) / (baseline - target), 1.0) * 100`, averaged across all metrics
   - Returns 0 if no `structuredMetrics` or empty array
   - Called from the existing `calculateProgressFromTasks` when `missionType === 'measurable'`

5. Update `calculateProgressFromTasks` in `GoalManager` to delegate to `calculateMeasurableProgress` when `goal.missionType === 'measurable'` and `goal.structuredMetrics` is non-empty. Existing task-based progress aggregation runs unchanged for `one_shot` missions.

6. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`, update the section that runs after all linked tasks have completed (around the `checkGoalCompletion` area):
   a. If `missionType === 'measurable'`:
      - Call `goalManager.checkMetricTargets(goalId)`
      - If all targets met: complete the mission (existing completion path)
      - If targets not met AND `planning_attempts < getEffectiveMaxPlanningAttempts(goal, roomConfig)`: call `triggerReplan(goalId, replanContext)` with a context that includes current metric values, historical trend summary (last N data points), completed task IDs, and any failed task errors
      - If targets not met AND attempts exhausted: set goal status to `needs_human`
   b. For `one_shot` missions: existing behavior unchanged

7. Update the planner agent context builder (`buildPlannerTaskMessage` in `packages/daemon/src/lib/room/agents/planner-agent.ts`) to include metric targets and current values in the planning prompt when the mission is measurable. Also include a brief history of previous planning attempts and their outcomes if available.

8. In `packages/daemon/src/lib/room/tools/room-agent-tools.ts`, add two new MCP tools:
   - `record_metric(goal_id, metric_name, value)`: calls `GoalManager.recordMetric`; agents report metric progress during or after task execution
   - `get_metrics(goal_id)`: returns current `structuredMetrics` state and targets; agents can query current KPI status

9. Write unit tests in `packages/daemon/tests/unit/room/`:
   - `goal-manager.test.ts`: `recordMetric` dual-write, `checkMetricTargets` both directions, validation rejections, `calculateMeasurableProgress` with `increase` and `decrease` directions, zero-division guard
   - `room-runtime.test.ts` (or new file `room-runtime-measurable.test.ts`): measurable mission completes when all targets met, triggers replan when targets not met and attempts remain, escalates to `needs_human` when attempts exhausted

10. Write an online integration test at `packages/daemon/tests/online/room/room-measurable-mission.test.ts` covering the full measure -> replan -> re-execute loop.

**Acceptance Criteria**:
- `structured_metrics` is the authoritative source; legacy `metrics` is derived automatically on each `recordMetric` call
- Metrics are inserted into `mission_metric_history` on each `recordMetric` call
- `checkMetricTargets` works for both `increase` and `decrease` directions
- Validation rejects `target <= 0` (increase), missing `baseline` (decrease), `baseline <= target` (decrease)
- Measurable missions auto-replan when tasks complete but targets are not met
- Replanning stops after max attempts and escalates to `needs_human`
- `record_metric` and `get_metrics` MCP tools are exposed to room agents
- All unit tests and online tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Depends on**: Milestone 1 (types), Milestone 2 (schema and repository methods)
