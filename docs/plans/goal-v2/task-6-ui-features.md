# Task 6: UI Features -- Type-Specific Creation and Detail Views

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: [Task 2](./task-2-measurable.md), [Task 3](./task-3-recurring.md), [Task 4](./task-4-semi-autonomous.md), [Task 5](./task-5-ui-copy-rename.md)

## Description

Add type-specific UI for mission creation and detail views. Depends on backend tasks because the create/update RPCs (`goal.create`, `goal.update`) must accept and persist the new fields (`missionType`, `structuredMetrics`, `schedule`, `autonomyLevel`) before the forms can function end-to-end.

### 1. Mission creation form enhancements

- Mission type selector (one-shot, measurable, recurring)
- Conditional fields:
  - Measurable: metric name, target value, unit (add/remove multiple)
  - Recurring: schedule preset dropdown or custom cron, timezone selector
- Autonomy level selector (supervised, semi-autonomous) with descriptions

### 2. Mission detail view -- type-specific displays

- One-shot: task progress bar (current behavior)
- Measurable: metric current vs target, progress percentage per metric
- Recurring: next execution time, execution history list with status/summary
- Autonomy level indicator badge

### 3. Dashboard updates

- Group or filter missions by type
- Show schedule/next-run for recurring missions
- Show metric progress for measurable missions
- Notification feed for auto-completed tasks (from `goal.task.auto_completed` events)

## Acceptance Criteria

- Mission creation supports all three types with conditional fields
- Detail view shows type-specific information
- Dashboard displays type-specific details
- E2E tests for: creating a measurable mission with metrics, creating a recurring mission with schedule
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
