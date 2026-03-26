# Milestone 4: QA Agent Node

## Goal and Scope

Add a dedicated QA agent as the 5th node in the CODING_WORKFLOW_V2. QA verifies: (a) test coverage for changes, (b) GitHub CI pipeline passing, (c) PR in mergeable state. QA replaces the old Verify concept entirely — there is no Verify node in V2.

## Updated Workflow Graph (M4 — 5 nodes)

```
Plan ---[human gate]--> Code ---[always gate]--> Review ---[task_result gate: passed]--> QA ---[task_result gate: passed]--> Done
                                              ^                    |                          |
                                              |                    | [task_result: failed]     | [task_result: failed]
                                              +--------------------+                          |
                                              |                                               |
                                              +-----------------------------------------------+
                                                      [QA feedback to coder via channel]
```

### Feedback Topology (Explicit)

When QA fails, feedback goes **directly to Code** (not through Review). The rationale:
- QA issues are typically code-level (broken tests, CI failures, merge conflicts) that the Coder can fix directly.
- Sending QA feedback through Review would add latency without value — the Reviewer already approved the code's design/logic.
- After the Coder fixes QA issues, the **full re-review cycle runs**: Code → Review → QA → Done. This ensures the Reviewer verifies the fix didn't introduce new issues.

### Iteration Counter

The global `maxIterations` counter (defined in M2) now tracks traversals of both cyclic channels:
- Review → Code (reviewer rejection)
- QA → Code (QA failure)

Both increment the same global counter. When `maxIterations` is reached, the run fails with `maxIterationsReached` (behavior defined in M2).

## Tasks

### Task 4.1: Create QA Agent System Prompt

**Description**: Build a specialized system prompt for the QA agent that checks test coverage, runs tests, verifies CI status, and checks PR mergeability.

**Subtasks**:
1. Add `buildQaNodeAgentPrompt()` in `custom-agent.ts` for agents with role `'qa'`
2. Include instructions for:
   - Running test suites (`bun test`, `bunx vitest run`, etc.) — adapt to the project's test commands
   - Checking CI status via `gh pr checks` or `gh pr view --json statusCheckRollup`
   - Verifying PR mergeability via `gh pr view --json mergeable,mergeStateStatus`
   - Checking for merge conflicts (`git fetch origin && git merge --no-commit --no-ff origin/main`)
   - Reporting result as 'passed' (all green) or 'failed: <reason>' (specific issues)
3. Include the structured output format for QA results:
   ```
   ---QA_RESULT---
   status: passed | failed
   tests: <summary of test results>
   ci: <CI pipeline status>
   mergeable: true | false
   issues: <list of issues found, or "none">
   summary: <1-2 sentence summary for the coder>
   ---END_QA_RESULT---
   ```
4. Add instructions for `gh` CLI authentication verification: if `gh auth status` fails, report it as a 'failed' with reason "GitHub CLI not authenticated" rather than silently failing

**Acceptance Criteria**:
- QA agent has a comprehensive prompt covering all verification areas
- QA agent reports structured results via `report_done`
- QA agent handles `gh` auth failure gracefully (reports it, not crashes)
- Unit tests cover the prompt builder

**Depends on**: nothing

**Agent type**: coder

---

### Task 4.2: Add QA Preset Agent and Update V2 Workflow

**Description**: Add 'qa' as a preset agent role, seed it at space creation, and update CODING_WORKFLOW_V2 to include the QA node between Review and Done.

**Subtasks**:
1. Add QA to `PRESET_AGENTS` in `seed-agents.ts`:
   - Role: `'qa'`
   - Tools: `['Read', 'Bash', 'Grep', 'Glob']` (read-only + bash for running tests)
   - Description: "QA agent. Verifies test coverage, CI pipeline status, and PR mergeability."
2. Update `CODING_WORKFLOW_V2` template (modify, don't create V3):
   - Add QA node with `agentId: 'qa'` between Review and Done
   - Add channel: Review → QA (`task_result` gate, expression: `passed`)
   - Add channel: QA → Done (`task_result` gate, expression: `passed`)
   - Add channel: QA → Code (`task_result` gate, expression: `failed`, `isCyclic: true`, description: "Route QA failures back to Coder for fixes")
   - The Review → Done channel is replaced by Review → QA → Done
   - Verify that the QA → Code cyclic channel is explicitly marked `isCyclic: true` for iteration counter tracking
3. Update `seedBuiltInWorkflows` to use the updated template (new spaces only; existing spaces keep their workflows)
4. Add QA agent system prompt check in `createCustomAgentInit()` for role 'qa'
5. Unit test: validate the updated 5-node workflow structure and QA agent seeding

**Acceptance Criteria**:
- QA agent is seeded at space creation alongside Coder, General, Planner, Reviewer
- Updated workflow template has 5 nodes: Plan, Code, Review, QA, Done
- Channel gates properly route: Review (passed) → QA, QA (failed) → Code (cyclic), QA (passed) → Done
- No Verify node exists anywhere in V2
- Unit tests validate the workflow structure and agent seeding

**Depends on**: Task 4.1, Task 2.1

**Agent type**: coder

---

### Task 4.3: Implement QA-to-Coder Feedback Loop

**Description**: When the QA agent finds issues (result contains 'failed'), the channel router routes a message back to the Coder with the specific issues. The Coder then addresses them and the workflow loops through Review → QA again.

**Subtasks**:
1. Verify the QA → Code cyclic channel works with `task_result: failed` gate and `isCyclic: true`
2. Clarify the QA feedback mechanism: the QA agent calls `report_done` with `result: 'failed: <reason>'`. The `task_result: failed` gate on the QA → Code channel evaluates this result and routes the message to the Coder. The QA agent's `---QA_RESULT---` structured output is included in the channel message payload so the Coder has full context.
   - **Note on mechanism consistency**: M2's Reviewer → Coder feedback uses `send_message` (peer-to-peer DM). M4's QA → Coder feedback uses channel routing (gate-evaluated). This distinction is intentional: `send_message` is for ad-hoc peer communication (reviewer wants to give specific feedback), while channel routing is for structured state-driven transitions (QA result triggers the next workflow step). Both mechanisms exist in the channel router; the difference is in how the message is initiated.
3. Test the full re-review cycle: Code → Review (pass) → QA (fail) → Code → Review (pass) → QA (pass) → Done
4. Verify the global iteration counter is incremented on the QA → Code cycle (shared with Review → Code counter)
5. Test that QA → Code feedback does NOT skip the Review step — **QA activates only after Review reports `passed` on the re-review, not directly after Coder's `report_done`**. The Review → QA → Done path is gated on Review's passed result. The cyclic QA → Code channel feeds back to the Coder, which then must go through Code → Review → QA again.
6. Add unit test for the QA feedback loop including iteration counting

**Acceptance Criteria**:
- QA can route failure feedback to Coder via the QA → Code cyclic channel
- Coder receives QA feedback with full context
- After Coder fixes QA issues, the full Code → Review → QA cycle runs
- Global iteration counter increments on both Review→Code and QA→Code cycles
- Unit test covers the QA feedback loop

**Depends on**: Task 4.2

**Agent type**: coder
