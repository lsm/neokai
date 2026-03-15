# Task 2: Measurable Missions -- Structured Metrics and Adaptive Replanning

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: [Task 1](./task-1-schema-types.md)

## Description

Implement the measurable mission type with structured KPI tracking and adaptive replanning.

### 1. Metrics in GoalManager

- `recordMetric(goalId, metricName, value, timestamp)`: Update `current` in `structured_metrics` JSON AND insert into `mission_metric_history`. Also derive and write legacy `metrics` field (`Record<string, number>` with `{[name]: current}`) for backward compatibility.
- `getMetricHistory(goalId, metricName, timeRange)`: Query `mission_metric_history` by `(goal_id, metric_name, recorded_at)` index
- `checkMetricTargets(goalId)`: Compare each metric's `current` against `target` using `direction`, return pass/fail
- Progress for measurable missions depends on metric direction:
  - `increase` (default): `progress = average(min(current / target, 1.0) * 100)` — higher is better
  - `decrease`: `progress = average(min(baseline / max(current, target), 1.0) * 100)` where progress = 100% when `current <= target`. Requires `baseline` to compute meaningful progress percentage.
- Validation: reject `target <= 0` for `increase` direction, reject missing `baseline` for `decrease` direction, guard against divide-by-zero
- **Backward compatibility**: If a goal has legacy `metrics` but no `structured_metrics`, treat as one-shot (no targets, existing behavior preserved)

### 2. Runtime behavior for measurable missions in `RoomRuntime`

- After all linked tasks complete, call `checkMetricTargets()`
- If all targets met -> complete mission
- If targets not met AND `planning_attempts < getEffectiveMaxPlanningAttempts()` -> trigger replanning with metric context
- If targets not met AND attempts exhausted -> set status to `needs_human`
- Replanning context includes: current metric values, historical trend, completed tasks, failed task errors

### 3. Planner agent context for measurable missions

- Include metric targets and current values in planning prompt
- Include history of previous planning attempts and their outcomes

### 4. MCP tool updates for room agent

- `record_metric(goal_id, metric_name, value)`: Agents can report metric progress
- `get_metrics(goal_id)`: View current metric state and targets

## Acceptance Criteria

- `structured_metrics` is the authoritative source for measurable missions; legacy `metrics` is derived read-only
- Metrics can be recorded, queried, and compared against targets
- Measurable missions auto-replan when tasks complete but targets aren't met
- Replanning stops after max attempts and escalates to `needs_human`
- Both `increase` and `decrease` metric directions work correctly (progress, target checking)
- Validation rejects `target <= 0` for increase, missing `baseline` for decrease
- Unit tests for metric CRUD, target checking (both directions), replan triggering, attempt cap, legacy derivation, validation edge cases
- Online tests for the full measure -> replan -> re-execute loop
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
