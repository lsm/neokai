# Milestone 4: Update Seeded Coding Workflow with Verify Step

## Goal

Update the built-in "Coding Workflow" template to include a "Verify & Test" step after the Code step, with cyclic `task_result` transitions that loop back to Plan on failure and complete the workflow on success.

## Scope

- Add a Verify step and a reviewer agent reference to `built-in-workflows.ts`
- Add cyclic transitions with `task_result` conditions
- Set `maxIterations` on the workflow template
- Update seeding logic for the new agent role

## Tasks

### Task 4.1: Add Verify step to Coding Workflow template

**Description:** Extend the `CODING_WORKFLOW` template in `built-in-workflows.ts` to include a Verify & Test step with cyclic transitions.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`:
   - Add a new step ID constant: `CODING_VERIFY_STEP = 'tpl-coding-verify'`.
   - Add a "Verify & Test" step to `CODING_WORKFLOW.steps` using the `'reviewer'` agent role as `agentId` placeholder. If a `reviewer` preset agent does not already exist, use `'general'` instead (check existing preset agent seeding to determine which roles are available).
   - Add step instructions: `'Review the completed work. Run tests, check for issues. Set result to "passed" if everything looks good, or "failed: <reason>" if problems are found.'`
2. Update the transitions array:
   - Keep the existing Plan -> Code transition (with `human` condition).
   - Add Code -> Verify transition with `always` condition (order: 0).
   - Add Verify -> Plan transition with `task_result` condition, expression: `'failed'`, order: 0, description: `'Loop back to planning when verification fails'`.
   - Add Verify -> (no target / terminal) -- since the workflow graph uses "no outgoing transitions" for terminal state, the `'passed'` case needs a different approach. Add a Verify -> Done step (a new terminal step with no outgoing transitions), with `task_result` condition, expression: `'passed'`, order: 1, description: `'Complete workflow when verification passes'`. Alternatively, if the "no target" pattern is preferred, add a dedicated "Done" step that is terminal (no outgoing transitions).
3. Set `maxIterations: 3` on `CODING_WORKFLOW` (the `config` field or the new top-level `maxIterations` field added in Milestone 2).
4. Update the step ID constants and transition wiring to reflect the new graph: Plan -> Code -> Verify -[failed]-> Plan, Verify -[passed]-> Done.
5. Verify the `neededRoles` set in `seedBuiltInWorkflows` will include any new agent role used by the Verify step.
6. Run `bun run typecheck`.

**Acceptance criteria:**
- The Coding Workflow template has 4 steps: Plan, Code, Verify, Done.
- Transitions form a directed graph with a cycle: Verify -> Plan on failure.
- The workflow completes when Verify passes and reaches the terminal Done step.
- `maxIterations` is set to 3 on the template.
- `seedBuiltInWorkflows` correctly resolves agent IDs for all steps.
- Existing seeded workflows are unaffected (idempotency: spaces with workflows already seeded are not modified).

**Depends on:** Task 1.1 (task_result type), Task 2.1 (maxIterations on SpaceWorkflow)

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
