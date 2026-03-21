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
4. Wire `task_result` through the `advance_workflow` MCP tool so the Task Agent's `step_result` argument is forwarded to the executor. Update the Task Agent system prompt to instruct it to pass `step_result` on verify steps.
5. Update the seeded "Coding Workflow" to include a Verify step with cyclic transitions.
6. Comprehensive unit and integration tests for all new behavior.

## Key Design Decisions

- **Migration strategy:** Migrations 30–33 already add columns to Space tables via `ALTER TABLE` after migration 29's consolidated schema. This plan follows the same pattern: migration 34 for iteration tracking, migration 35 for goalId on tasks, migration 36 for goalId on runs, migration 37 for maxIterations on workflows. Milestones 1/3 may run in parallel — the coder must use the next available migration number and reconcile if numbers collide during merge.
- **Iteration counting semantics:** `iterationCount` counts **logical cycles**, not individual step revisits. A cycle is counted once when the transition targets a step that has already been visited — specifically, only the **first revisited step** in a loop-back increments the counter (i.e., the transition target that creates the cycle). Subsequent steps in the same iteration do not increment again because they are new visits from the perspective of the current iteration.
- **`maxIterations` persistence:** `maxIterations` is a first-class typed field on both `SpaceWorkflow` (template, persisted in DB) and `SpaceWorkflowRun` (instance, copied from template at creation).
- **Seeded workflow idempotency:** `seedBuiltInWorkflows` is a no-op when workflows already exist (`if (existing.length > 0) return`). Only newly created spaces will get the updated Coding Workflow with the Verify step. Updating existing spaces is explicitly out of scope — a future migration can handle that if needed.
- **UI for iteration count:** Displaying `iterationCount` in the frontend is out of scope for this plan. The field is available via the existing `SpaceWorkflowRun` type and will be visible through RPC responses (`space.workflowRun.get`).
- **Agent role for Verify step:** The existing preset agent roles are `planner`, `coder`, and `general`. There is no `reviewer` preset. The Verify step uses `'general'` as the `agentId` placeholder.

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

## Migration Number Assignment

To avoid collisions when milestones are worked in parallel:
- **Migration 34:** `iteration_count` + `max_iterations` on `space_workflow_runs` (Milestone 2, Task 2.1)
- **Migration 35:** `goal_id` on `space_tasks` (Milestone 3, Task 3.1)
- **Migration 36:** `goal_id` on `space_workflow_runs` (Milestone 3, Task 3.2)
- **Migration 37:** `max_iterations` on `space_workflows` (Milestone 2, Task 2.1)

If milestones are merged in a different order, reconcile migration numbers before merging.
