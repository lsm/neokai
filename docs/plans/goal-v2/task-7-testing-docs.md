# Task 7: Integration Testing and Documentation

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: [Task 2](./task-2-measurable.md), [Task 3](./task-3-recurring.md), [Task 4](./task-4-semi-autonomous.md), [Task 6](./task-6-ui-features.md)

## Description

Comprehensive testing and documentation. Test scope follows repo rules: E2E covers user-facing flows only; daemon tests cover scheduler edge cases, autonomy internals, and recovery scenarios.

### 1. Daemon online integration tests (not E2E)

- Full lifecycle per mission type:
  - One-shot: create -> plan -> execute -> complete
  - Measurable: create -> plan -> execute -> measure -> replan -> complete
  - Recurring: create -> schedule -> trigger -> execute -> next trigger
- Semi-autonomous flow: Leader completes coder task without human approval
- Escalation: consecutive failures trigger `needs_human`
- Migration: existing goals work as one-shot missions with `supervised` autonomy

### 2. Daemon unit tests for edge cases

- Scheduler: overlap prevention, daemon restart catch-up, room state interaction
- Execution identity: recovery from group metadata after restart
- Per-execution isolation: `planning_attempts` reset, `linkedTaskIds` scoped
- Metrics: dual-write derivation, target checking, history queries
- Autonomy gate: planner exclusion, approval source recording

### 3. E2E tests (user-facing flows only)

- Create each mission type through UI
- View mission progress for measurable missions
- View execution history for recurring missions
- No E2E for: merge failures, scheduler internals, autonomy gate logic

### 4. Documentation

- Update `CLAUDE.md` with mission system terminology
- Coverage target: new mission code paths >= 80% line coverage

## Acceptance Criteria

- All daemon integration and unit tests pass
- E2E tests cover three mission types via UI
- CLAUDE.md updated with mission terminology
- New mission code has >= 80% line coverage
- No regressions in existing test suite
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
