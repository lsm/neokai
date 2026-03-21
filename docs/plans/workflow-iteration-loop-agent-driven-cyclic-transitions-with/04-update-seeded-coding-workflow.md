# Milestone 4: Update Seeded Coding Workflow with Verify Step

## Goal

Update the built-in "Coding Workflow" template to include a "Verify & Test" step after the Code step, with cyclic `task_result` transitions that loop back to Plan on failure and complete the workflow on success.

## Scope

- Add a Verify step using the `general` agent role (no `reviewer` preset exists — only `planner`, `coder`, and `general` are seeded)
- Add cyclic transitions with `task_result` conditions
- Set `maxIterations` on the workflow template
- Only affects newly created spaces (existing spaces with already-seeded workflows are not modified — this is by design, see overview)

## Tasks

### Task 4.1: Add Verify step to Coding Workflow template

**Description:** Extend the `CODING_WORKFLOW` template in `built-in-workflows.ts` to include a Verify & Test step with cyclic transitions.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`:
   - Add new step ID constants: `CODING_VERIFY_STEP = 'tpl-coding-verify'` and `CODING_DONE_STEP = 'tpl-coding-done'`.
   - Add a "Verify & Test" step to `CODING_WORKFLOW.steps` using `'general'` as the `agentId` placeholder (the existing preset agent roles are `planner`, `coder`, and `general` — there is no `reviewer` preset).
   - Add step instructions: `'Review the completed work. Run tests, check for issues. Set result to "passed" if everything looks good, or "failed: <reason>" if problems are found.'`
2. Update the transitions array:
   - Keep the existing Plan -> Code transition (with `human` condition).
   - Add Code -> Verify transition with `always` condition (order: 0).
   - Add Verify -> Plan transition with `task_result` condition, expression: `'failed'`, order: 0, **`isCyclic: true`** (this flags it for iteration counting). The `description` field goes on the `condition` object (not the transition root): `condition: { type: 'task_result', expression: 'failed', description: 'Loop back to planning when verification fails' }`.
   - Add Verify -> Done transition (Done is a new terminal step with no outgoing transitions) with `task_result` condition, expression: `'passed'`, order: 1, `isCyclic` not set (defaults to `undefined`/`false`). Condition: `{ type: 'task_result', expression: 'passed', description: 'Complete workflow when verification passes' }`.
3. Set `maxIterations: 3` on `CODING_WORKFLOW` using the first-class `maxIterations` field added in Milestone 2 (NOT in `config`).
4. Update the step ID constants and transition wiring to reflect the new graph: Plan -> Code -> Verify -[failed]-> Plan, Verify -[passed]-> Done.
5. Verify the `neededRoles` set in `seedBuiltInWorkflows` will include any new agent role used by the Verify step.
6. Run `bun run typecheck`.

**Acceptance criteria:**
- The Coding Workflow template has 4 steps: Plan, Code, Verify, Done.
- Transitions form a directed graph with a cycle: Verify -> Plan on failure.
- The workflow completes when Verify passes and reaches the terminal Done step.
- `maxIterations` is set to 3 on the template.
- `seedBuiltInWorkflows` correctly resolves agent IDs for all steps (including `general` for the Verify step).
- Existing seeded workflows are unaffected: `seedBuiltInWorkflows` is a no-op when `workflowManager.listWorkflows(spaceId).length > 0`. Only newly created spaces get the updated 4-step Coding Workflow. Updating existing spaces is explicitly out of scope for this plan.

**Depends on:** Task 1.1 (task_result type), Task 2.1 (maxIterations on SpaceWorkflow)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
