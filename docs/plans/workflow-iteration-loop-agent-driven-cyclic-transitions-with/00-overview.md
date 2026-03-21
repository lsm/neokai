# Workflow Iteration Loop -- Agent-Driven Cyclic Transitions with Verification

## Goal

Enable Space workflows to self-iterate through a verify-and-loop pattern. A new `task_result` condition type lets transitions evaluate the result of the most recently completed task on a step. Combined with iteration tracking and a safety cap (`maxIterations`), workflows can express cyclic patterns like:

```
Plan -> Code -> Verify -[failed]-> Plan (loop back)
                       -[passed]-> Done
```

Each iteration creates new tasks under the same workflow run, producing a clear audit trail:
`Plan(1) -> Code(1) -> Verify(1:failed) -> Plan(2) -> Code(2) -> Verify(2:passed) -> Done`

## High-Level Approach

1. Extend the type system and executor to support a `task_result` condition type that matches against the completed task's `result` field.
2. Add iteration tracking columns to `space_workflow_runs` so cyclic transitions increment a counter and a `maxIterations` cap prevents infinite loops.
3. Add `goalId` to `SpaceTask` so tasks can be queried by goal across workflow runs.
4. Wire `task_result` through the `advance_workflow` MCP tool so the Task Agent's `step_result` argument is forwarded to the executor.
5. Update the seeded "Coding Workflow" to include a Verify step with cyclic transitions.
6. Comprehensive unit and integration tests for all new behavior.

## Milestones

1. **task_result condition type** -- Add `task_result` to `WorkflowConditionType`, implement evaluation in `WorkflowExecutor.evaluateCondition()`, and wire the `step_result` argument from `advance_workflow` through to the executor.
2. **Iteration tracking** -- Add `iteration_count` and `max_iterations` columns to `space_workflow_runs`, increment on cyclic transitions, and cap at `maxIterations` with `needs_attention` escalation.
3. **goalId on SpaceTask** -- Add `goal_id` column to `space_tasks`, update types, repository, and propagation through task creation.
4. **Update seeded coding workflow** -- Add a "Verify & Test" step with cyclic `task_result` transitions to the built-in Coding Workflow template.
5. **Tests** -- Unit tests for `task_result` evaluation, iteration counting, cyclic workflows, `goalId` propagation; integration test for end-to-end verify-fail-loop-pass cycle.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (iteration detection uses `task_result` transitions to identify cycles).
- Milestone 4 depends on Milestones 1 and 2 (the seeded workflow uses `task_result` conditions and `maxIterations`).
- Milestone 5 depends on all prior milestones.
- Milestones 1 and 3 are independent and can be worked in parallel.

## Estimated Total Tasks

13 tasks across 5 milestones.
