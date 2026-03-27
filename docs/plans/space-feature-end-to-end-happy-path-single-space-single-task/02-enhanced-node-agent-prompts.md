# Milestone 2: Enhanced Node Agent Prompts

## Goal and Scope

Upgrade the system prompts for planner, coder, reviewer, and QA node agents in the Space system. Prompts must include git workflow, PR management, review posting, and — critically — instructions for interacting with gate data stores via `read_gate`/`write_gate` MCP tools.

## Tasks

### Task 2.1: Enhance Coder Node Agent System Prompt

**Description**: Update `buildCustomAgentSystemPrompt()` in `packages/daemon/src/lib/space/agents/custom-agent.ts` to include full git workflow instructions, PR creation, and gate data writing — mirroring the Room system's `buildCoderSystemPrompt()`.

**Subtasks**:
1. Read `packages/daemon/src/lib/room/agents/coder-agent.ts` (`buildCoderSystemPrompt()`) and identify all prompt sections
2. Add bypass markers section (RESEARCH_ONLY, VERIFICATION_COMPLETE, etc.) for role 'coder'
3. Add review feedback handling: how to fetch GitHub reviews, verify feedback, push fixes
4. Add PR creation flow with duplicate prevention (`gh pr list --head`)
5. **Add gate interaction instructions**: After creating a PR, the coder must call `write_gate` to write PR data (`{ prUrl, prNumber, branch }`) to the Code PR Gate. This unblocks the reviewer channel.
6. Add instructions for reading upstream gate data: the coder should call `read_gate` on the Plan PR Gate to understand the plan before coding

**Acceptance Criteria**:
- Coder agents produce same quality git/PR workflow as Room coder agents
- Coder writes PR data to gate after creating PR (triggers reviewer activation)
- Coder reads plan gate data to understand the plan
- Unit tests pass for updated prompt builder

**Depends on**: Milestone 1 (gate MCP tools must exist)

**Agent type**: coder

---

### Task 2.2: Enhance Planner Node Agent System Prompt

**Description**: Create a specialized planner prompt that includes plan document creation, PR management, and gate data writing.

**Subtasks**:
1. Add `buildPlannerNodeAgentPrompt()` in `custom-agent.ts` for role 'planner'
2. Include plan document creation instructions (explore codebase, write plan, create PR)
3. **Add gate interaction instructions**: After creating a plan PR, the planner must call `write_gate` to write PR data to the Plan PR Gate. This unblocks the plan review channel.
4. Add instructions for `send_message` to communicate with plan reviewers
5. Ensure the prompt works with `injectWorkflowContext` flag

**Acceptance Criteria**:
- Planner creates plan documents on feature branches with PRs
- Planner writes PR data to Plan PR Gate (triggers plan review activation)
- Unit tests cover the new prompt builder

**Depends on**: Milestone 1 (gate MCP tools)

**Agent type**: coder

---

### Task 2.3: Enhance Reviewer Node Agent System Prompt

**Description**: Create a specialized reviewer prompt for posting PR reviews with severity classification and writing votes to the Aggregate Gate.

**Subtasks**:
1. Add `buildReviewerNodeAgentPrompt()` in `custom-agent.ts` for role 'reviewer'
2. Include PR review process: read changed files, evaluate correctness/completeness/security
3. Add review posting via REST API (`GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews`)
4. Add structured output format: `---REVIEW_POSTED---` block with URL, recommendation, severity counts
5. **Add gate interaction instructions**: Reviewer reads the Code PR Gate to find the PR URL, then after reviewing, writes its vote to the Aggregate Gate via `write_gate({ votes: { [agentId]: 'approve' | 'reject' } })`
6. When 3 reviewers all write 'approve', the Aggregate Gate passes and QA is activated

**Acceptance Criteria**:
- Reviewer reads PR URL from gate data
- Reviewer posts proper PR reviews with severity classification
- Reviewer writes vote to Aggregate Gate
- Unit tests cover the prompt builder

**Depends on**: Milestone 1 (gate MCP tools)

**Agent type**: coder

---

### Task 2.4: Create QA Agent System Prompt

**Description**: Build a specialized system prompt for the QA agent that checks test coverage, runs tests, verifies CI status, and writes results to the Task Result Gate.

**Subtasks**:
1. Add `buildQaNodeAgentPrompt()` in `custom-agent.ts` for role 'qa'
2. Include instructions for:
   - Test command detection (package.json scripts, Makefile targets, fallback commands)
   - Checking CI status via `gh pr checks` or `gh pr view --json statusCheckRollup`
   - Verifying PR mergeability via `gh pr view --json mergeable,mergeStateStatus`
   - Checking for merge conflicts
3. **Add gate interaction instructions**: QA reads the Code PR Gate to find the PR, then writes result to Task Result Gate via `write_gate({ result: 'passed' | 'failed', summary: '...' })`
4. Include structured output format for QA results
5. Add `gh` CLI auth verification instructions

**Acceptance Criteria**:
- QA agent has comprehensive verification prompt
- QA reads PR URL from gate data
- QA writes result to Task Result Gate
- Unit tests cover the prompt builder

**Depends on**: Milestone 1 (gate MCP tools)

**Agent type**: coder
