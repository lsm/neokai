# Milestone 4: QA Agent Node

## Goal and Scope

Add a dedicated QA agent step to the extended coding workflow. The QA agent verifies: (a) test coverage for changes, (b) GitHub CI pipeline passing, (c) PR in mergeable state. If issues are found, it sends feedback to the Coder who fixes them, then the flow loops back through Review -> QA again.

## Updated Workflow Graph

```
Plan --[human]--> Code --[always]--> Review --[passed]--> QA --[passed]--> Done
                        ^               |              |
                        |               | [failed]     | [failed]
                        +---------------+              +---+
                                [QA sends feedback to Coder]
```

Additional cycles:
- QA -> Code: task_result gate on 'failed' (QA found issues)
- QA -> Done: task_result gate on 'passed' (QA confirmed green)
- Verify step is removed/replaced by QA (QA subsumes the Verify role)

## Tasks

### Task 4.1: Create QA Agent System Prompt

**Description**: Build a specialized system prompt for the QA agent that checks test coverage, runs tests, verifies CI status, and checks PR mergeability.

**Subtasks**:
1. Add `buildQaNodeAgentPrompt()` in `custom-agent.ts` for agents with role `'qa'`
2. Include instructions for:
   - Running test suites (`bun test`, `bunx vitest run`, etc.)
   - Checking CI status via `gh pr checks` or `gh pr view --json statusCheckRollup`
   - Verifying PR mergeability via `gh pr view --json mergeable,mergeStateStatus`
   - Checking for merge conflicts
   - Reporting result as 'passed' (all green) or 'failed: <reason>' (specific issues)
3. Include the structured output format for QA results:
   ```
   ---QA_RESULT---
   status: passed | failed
   tests: <summary of test results>
   ci: <CI pipeline status>
   mergeable: true | false
   issues: <list of issues found, or "none">
   summary: <1-2 sentence summary>
   ---END_QA_RESULT---
   ```

**Acceptance Criteria**:
- QA agent has a comprehensive prompt covering all verification areas
- QA agent reports structured results via `report_done`
- Unit tests cover the prompt builder

**Depends on**: nothing

**Agent type**: coder

---

### Task 4.2: Add QA Preset Agent and Update Workflow

**Description**: Add 'qa' as a preset agent role, seed it at space creation, and update the coding workflow to include the QA step.

**Subtasks**:
1. Add QA to `PRESET_AGENTS` in `seed-agents.ts`:
   - Role: `'qa'`
   - Tools: `['Read', 'Bash', 'Grep', 'Glob']` (read-only + bash for running tests)
   - Description: "QA agent. Verifies test coverage, CI pipeline status, and PR mergeability."
2. Update `CODING_WORKFLOW_V2` template to include QA node:
   - Remove Verify node
   - Add QA node with `agentId: 'qa'`
   - Add channel: Review -> QA (task_result: passed gate)
   - Add channel: QA -> Code (task_result: failed gate, cyclic)
   - Add channel: QA -> Done (task_result: passed gate)
3. Update `seedBuiltInWorkflows` to use the updated template (new spaces only)
4. Add a dedicated QA agent system prompt check in `createCustomAgentInit()` for role 'qa'

**Acceptance Criteria**:
- QA agent is seeded at space creation alongside Coder, General, Planner, Reviewer
- Updated workflow template has QA step in the correct position
- Channel gates properly route: Review (passed) -> QA, QA (failed) -> Code, QA (passed) -> Done
- Unit tests validate the workflow structure and agent seeding

**Depends on**: Task 4.1, Task 2.1

**Agent type**: coder

---

### Task 4.3: Implement QA-to-Coder Feedback Loop

**Description**: When the QA agent finds issues (result contains 'failed'), the channel router should create a message back to the Coder with the specific issues. The Coder then addresses them and the workflow loops through Review -> QA again.

**Subtasks**:
1. Verify the QA -> Code cyclic channel works with `task_result: failed` gate
2. Ensure the QA agent's failure message includes enough context for the Coder to fix issues
3. Test the loop: Code -> Review (pass) -> QA (fail) -> Code -> Review (pass) -> QA (pass) -> Done
4. Verify iteration counter is properly incremented on the QA -> Code cycle
5. Add unit test for the QA feedback loop

**Acceptance Criteria**:
- QA can route failure feedback to Coder via channel
- Coder receives and addresses QA feedback
- Multiple QA cycles work within the iteration cap
- Unit test covers the QA feedback loop

**Depends on**: Task 4.2

**Agent type**: coder
